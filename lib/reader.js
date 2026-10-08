/**
 * Universal page reader — Reddit / StackOverflow / HN / Discourse / generic.
 * No API keys anywhere.
 *
 * Strategy chain per URL:
 *   1. Reddit → Arctic Shift (post lookup + top comments, no key) with a
 *      best-effort legacy `.json` attempt (reddit.com now 403s
 *      unauthenticated JSON, so Arctic is the real path). Subreddit homepages
 *      return a recent-posts digest instead of failing.
 *   2. StackOverflow question → StackExchange API (question + top answers).
 *   3. HackerNews item → Firebase API (story + top comments).
 *   4. Discourse topic (.json) → topic title + cooked posts as text
 *   4b. Google News redirect → publisher article via the headline remembered
 *      at search time (news.google.com pages are JS shells; the CBM article
 *      id is opaque server-side, so same-process memory bridges it)
 *   5. Direct HTML fetch → readability-lite extraction (title + article text)
 *   6. Optional Jina reader fallback (https://localhost:29395/http://…) for 403/429/blocked pages.
 *      Privacy note: the fallback sends the requested URL to the public
 *      reader proxy (r.jina.ai) — disable with jinaFallback:false for
 *      sensitive URLs.
 *
 * SSRF guard blocks private/local targets (IPv4 + IPv6 ranges, CGNAT,
 * 0.0.0.0, .localhost/.local/.internal, dotless hosts) and re-validates
 * every redirect hop. Limitation: no raw-socket DNS pinning without extra
 * deps, so DNS-rebinding inside a short TTL window is mitigated by short
 * timeouts, not eliminated — see README.
 *
 * Session page cache: cleaned pages are cached by canonical URL (10 min,
 * max 50 entries) so follow-up questions skip re-fetching. Pair with `offset`
 * to page through long articles: output says "continue with offset=N".
 *
 * Lean options (flat primitives for any agent):
 *   query — when set with view:'highlights', returns query-focused excerpts
 *   view — 'text' (default, full) or 'highlights' (extractive excerpts)
 *   tokenBudget — max tokens; enforced as min(maxChars, budget*4)
 *   withLinksSummary — true appends a ## Links list (default false)
 *   offset — start reading at this char offset into the extracted text
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REDDIT_UA = 'Mozilla/5.0 (compatible; scout-reader/0.3.0)';
const MAX_BYTES = 2_500_000;

import { estimateTokens, extractHighlights, truncateLean } from './lean.js';

// Session page cache: canonical URL → { title, content, engine, statusCode, at }.
// Follow-up questions (new query, new offset) reuse the cleaned source text
// instead of paying for another fetch + extraction.
const PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_CACHE_MAX = 50;
// Source extraction cap: one fetch yields up to this much text; paging and
// lean views slice windows out of it. Matches the max maxChars (50000).
const SOURCE_WINDOW = 50000;
const pageCache = new Map();
export function pageCacheKey(url) {
  try {
    const u = new URL(String(url));
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (!/^(utm_|fb_|gclid|msclkid|fbclid|si|ref$)/i.test(k)) params.append(k, v);
    }
    const qs = params.toString();
    return `https://${host}${u.pathname.replace(/\/$/, '') || '/'}${qs ? '?' + qs : ''}`;
  } catch {
    return String(url);
  }
}
function pageCacheGet(url) {
  const hit = pageCache.get(pageCacheKey(url));
  if (!hit) return null;
  if (Date.now() - hit.at > PAGE_CACHE_TTL_MS) {
    pageCache.delete(pageCacheKey(url));
    return null;
  }
  return hit;
}
function pageCacheSet(url, entry) {
  pageCache.set(pageCacheKey(url), { ...entry, at: Date.now() });
  while (pageCache.size > PAGE_CACHE_MAX) {
    pageCache.delete(pageCache.keys().next().value);
  }
}

export async function freeRead(rawUrl, options = {}) {
  const view = normalizeView(options.view);
  const query = String(options.query ?? '').trim();
  const tokenBudget = options.tokenBudget ?? options.token_budget;
  const withLinksSummary = options.withLinksSummary === true || options.with_links_summary === true;
  // Lean default: 8000 chars (~2000 tokens). Full range still 1000–50000.
  const maxChars = clampInt(options.maxChars ?? 8000, 500, 50000);
  const offset = Math.max(0, Number(options.offset ?? 0) || 0);
  const timeoutMs = clampInt(options.timeoutMs ?? 15000, 1000, 60000);
  const jinaFallback = options.jinaFallback !== false;
  const signal = options.signal;

  const url = normalizeInputUrl(rawUrl);
  assertPublicUrl(url);

  try {
    // Source window vs page: fetch/extract a generous SOURCE_WINDOW once
    // (cached), then page through it in output-capped windows. Without the
    // wider source, offset paging could never reach page 2 — the source
    // would end exactly where page 1 did.
    const pageCap = effectiveCap(maxChars, tokenBudget);
    const windowCap = view === 'highlights' ? Math.min(SOURCE_WINDOW, Math.max(pageCap, 8000)) : Math.min(SOURCE_WINDOW, pageCap);
    let full = pageCacheGet(url);
    let cached = !!full;
    if (full) {
      full = { ...full, url };
    } else {
      full = await readFull(url, { ...options, maxChars: SOURCE_WINDOW, timeoutMs, jinaFallback, signal });
      pageCacheSet(url, { url, title: full.title, content: full.content, engine: full.engine, statusCode: full.statusCode });
    }
    const sourceLen = String(full.content).length;
    const { window } = slicePage(full.content, offset, windowCap);
    if (!window.trim()) {
      throw new Error(`offset ${offset} is past the end of this page (${sourceLen} chars) — nothing left to read`);
    }
    const out = applyLeanView({ ...full, content: window }, { view, query, maxChars, tokenBudget, withLinksSummary });
    out.offset = offset;
    out.cached = cached;
    if (sourceLen > offset + window.length && !full.truncated) {
      out.nextOffset = offset + window.length;
    } else if (sourceLen >= SOURCE_WINDOW && full.truncated && offset + window.length >= sourceLen) {
      // Source itself hit the window cap: more may exist server-side, but
      // Scout can't see it — say so instead of pointing at a dead offset.
      out.sourceCapped = true;
    }
    return out;
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    throw actionableReadError(e, url, { jinaFallback });
  }
}

/**
 * Pure paging slice (L2-testable): windows taken in order reconstruct the
 * source exactly — no gaps, no duplicates. freeRead() slices through this;
 * the nextOffset/sourceCapped bookkeeping stays in freeRead (it needs the
 * truncation state), but every offset it emits comes from here.
 */
export function slicePage(source, offset, cap) {
  const text = String(source ?? '');
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const end = Math.min(text.length, start + Math.max(0, Math.floor(Number(cap) || 0)));
  return { window: text.slice(start, end), start, end, total: text.length };
}

/** Effective output cap in chars: min(maxChars, tokenBudget*4). */
function effectiveCap(maxChars, tokenBudget) {
  let cap = maxChars;
  const tb = Number(tokenBudget);
  if (Number.isFinite(tb) && tb > 0) cap = Math.min(cap, Math.floor(tb) * 4);
  return cap;
}

/** Map raw failures to actionable guidance (never bare rethrows). */
function actionableReadError(e, url, { jinaFallback }) {
  const m = String(e?.message ?? e);
  if (/blocked private target/i.test(m)) return new Error(`${m} (SSRF guard: only public http(s) URLs)`);
  if (/HTTP 403/i.test(m)) {
    return new Error(
      jinaFallback
        ? `blocked (HTTP 403) at ${url} — the public-reader fallback also failed; try another result`
        : `blocked (HTTP 403) at ${url} — try another result, or retry with jinaFallback:true (sends the URL to the public reader proxy r.jina.ai)`,
    );
  }
  if (/HTTP 429/i.test(m)) return new Error(`rate-limited (HTTP 429) at ${url} — wait a minute and retry, or try another result`);
  if (/publisher article/i.test(m)) return e;
  if (/offset \d+ is past the end/i.test(m)) return e;
  if (/page too large|unsupported content-type/i.test(m)) return new Error(`${m} — try another result`);
  if (/Could not extract readable content/i.test(m)) {
    return new Error(
      `no readable text at ${url} — the page may be JS-rendered, a file download (PDFs unsupported), or a login wall; try another result`,
    );
  }
  return e instanceof Error ? e : new Error(m);
}

function normalizeView(v) {
  const s = String(v ?? 'text').trim().toLowerCase();
  return s === 'highlights' || s === 'highlight' || s === 'excerpts' ? 'highlights' : 'text';
}

/** Query-focused lean transform: highlights-first, never highlights+full. */
function applyLeanView(full, { view, query, maxChars, tokenBudget, withLinksSummary }) {
  const links = withLinksSummary ? collectLinks(full.content).slice(0, 12) : [];
  if (view === 'highlights' && query) {
    const body = stripInlineUrls(full.content);
    const { excerpts } = extractHighlights(body, query, { maxExcerpts: 3, charsPerExcerpt: 450 });
    const picked = excerpts.length ? excerpts : [body.slice(0, 900)];
    let content = `> Query-focused excerpts for "${query}" (extractive, order preserved):\n\n` + picked.map((e) => e.trim()).join('\n\n---\n\n');
    if (links.length) content += '\n\n## Links\n' + links.map((u) => `- ${u}`).join('\n');
    content += `\n\nSource: ${full.url}`;
    const { text, truncated } = truncateLean(content, maxChars, tokenBudget);
    return { ...full, content: text, truncated: truncated || text.length < content.length, view: 'highlights', tokens: estimateTokens(text) };
  }
  let content = full.content;
  if (links.length && !/## Links/.test(content)) {
    content += '\n\n## Links\n' + links.map((u) => `- ${u}`).join('\n');
  }
  const { text, truncated } = truncateLean(content, maxChars, tokenBudget);
  return { ...full, content: text, truncated: truncated || !!full.truncated, view: 'text', tokens: estimateTokens(text) };
}

function collectLinks(text) {
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s)>\]"']+/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    let u = m[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(u)) continue;
    if (/localhost:29395|news\.google\.com/i.test(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 20) break;
  }
  return out;
}

function stripInlineUrls(text) {
  // "Label (https://…)" → "Label" — saves tokens in highlights mode; the
  // full URL list is re-added under ## Links only when requested.
  return String(text ?? '').replace(/\s\((https?:\/\/[^\s)]+)\)/g, '');
}

async function readFull(url, options) {
  const maxChars = options.maxChars;
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  const jinaFallback = options.jinaFallback !== false;

  // 1. Reddit fast-path (Arctic Shift: post + comments, no key)
  if (isRedditUrl(url)) {
    try {
      const md = await readReddit(url, timeoutMs, signal, maxChars);
      if (md && md.content.trim().length > 80) return md;
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      // fall through to generic fetch + Jina (keeps working when Arctic 422s)
    }
  }

  // 2. StackOverflow / StackExchange fast-path (direct HTML 403s bots; the API is free)
  if (isStackExchangeUrl(url)) {
    try {
      const md = await readStackExchange(url, timeoutMs, signal, maxChars);
      if (md && md.content.trim().length > 80) return md;
    } catch (e) {
      if (isAbort(e, signal)) throw e;
    }
  }

  // 3. HackerNews fast-path (Firebase API, no key)
  if (isHNUrl(url)) {
    try {
      const md = await readHN(url, timeoutMs, signal, maxChars);
      if (md && md.content.trim().length > 80) return md;
    } catch (e) {
      if (isAbort(e, signal)) throw e;
    }
  }

  // 4. Discourse fast-path (topic URLs end in /t/slug/id or /t/id)
  if (/\/t(\/|$)/.test(new URL(url).pathname)) {
    try {
      const md = await readDiscourse(url, timeoutMs, signal, maxChars);
      if (md && md.content.trim().length > 80) return md;
    } catch (e) {
      if (isAbort(e, signal)) throw e;
    }
  }

  // 4b. Google News redirect fast-path: news.google.com article pages are JS
  // shells with nothing resolvable server-side, so resolve the publisher
  // article via the headline remembered at search time (same process).
  if (isGoogleNewsUrl(url)) {
    try {
      const md = await readGoogleNews(url, timeoutMs, signal, maxChars);
      if (md && md.content.trim().length > 80) return md;
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      // fall through to generic fetch so the error surfaces with context
      if (/publisher article/i.test(e?.message ?? '')) throw e;
    }
  }

  // 5. Direct fetch
  try {
    const direct = await readGeneric(url, timeoutMs, signal, maxChars);
    if (direct.content.trim().length > 80) return direct;
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    if (!jinaFallback) throw e;
    // 6. Jina fallback
    return readViaJina(url, timeoutMs, signal, maxChars, e);
  }

  // Thin direct result → try Jina once before giving up.
  if (jinaFallback) {
    try {
      return await readViaJina(url, timeoutMs, signal, maxChars, null);
    } catch {
      // fall through to thin direct result
    }
  }
  const thin = await readGeneric(url, timeoutMs, signal, maxChars).catch(() => null);
  if (thin) return thin;
  throw new Error(`Could not extract readable content from ${url}`);
}

// --- Reddit ---------------------------------------------------------------

function isRedditUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'reddit.com' || h.endsWith('.reddit.com') || h === 'redd.it' || h.endsWith('.redd.it');
  } catch {
    return false;
  }
}

async function readReddit(url, timeoutMs, signal, maxChars) {
  // Preferred: Arctic Shift by post id (reddit.com blocks anon .json with 403).
  const id = redditPostId(url);
  if (id) {
    try {
      return truncateResult(await readRedditViaArctic(url, id, timeoutMs, signal), maxChars);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      // fall through to legacy .json attempt below
    }
  } else {
    // Subreddit/user homepage (no thread id): recent-posts digest via Arctic.
    const sub = redditSubreddit(url);
    if (sub) {
      try {
        return truncateResult(await readSubredditDigest(url, sub, timeoutMs, signal, maxChars), maxChars);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
      }
    }
  }
  const candidates = redditJsonCandidates(url);
  let lastError;
  for (const jurl of candidates) {
    try {
      const json = await fetchJson(jurl, timeoutMs, signal, {
        'User-Agent': REDDIT_UA,
        Accept: 'application/json',
      });
      const md = redditJsonToMarkdown(url, json);
      if (md.content.length > 80) return truncateResult(md, maxChars);
      lastError = new Error('empty reddit json');
    } catch (e) {
      lastError = e;
      if (isAbort(e, signal)) throw e;
    }
  }
  throw lastError ?? new Error('reddit fetch failed');
}

function redditPostId(url) {
  try {
    const m = /\/comments\/([A-Za-z0-9]+)/.exec(new URL(url).pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function redditSubreddit(url) {
  try {
    const m = /\/r\/([A-Za-z0-9_]+)/.exec(new URL(url).pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a reddit thread via Arctic Shift (free, no key):
 * post metadata from /api/posts/ids + top comments from /api/comments/search.
 */
async function readRedditViaArctic(url, id, timeoutMs, signal) {
  const postUrl = `https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${encodeURIComponent(id)}`;
  const postJson = await fetchJson(postUrl, timeoutMs, signal).catch(async (e) => {
    await sleep(1200);
    return fetchJson(postUrl, timeoutMs, signal);
  });
  const post = postJson?.data?.[0];
  if (!post) throw new Error('arctic: post not found (yet — new posts take a while to index)');
  const lines = [];
  lines.push(`# ${post.title ?? '(untitled)'}`);
  lines.push(`r/${post.subreddit ?? '?'} · u/${post.author ?? '?'} · ⬆ ${post.score ?? '?'} · 💬 ${post.num_comments ?? '?'}`);
  if (post.created_utc) lines.push(`Posted ${new Date(post.created_utc * 1000).toISOString().slice(0, 10)}`);
  lines.push('');
  const selftext = (post.selftext ?? '').trim();
  if (selftext) lines.push(selftext);
  else if (post.url && !/reddit\.com\/r\//.test(post.url)) lines.push(`Link post → ${post.url}`);

  // Top comments by score.
  try {
    const curl = `https://arctic-shift.photon-reddit.com/api/comments/search?link_id=t3_${encodeURIComponent(id)}&limit=30&sort=desc`;
    const cjson = await fetchJson(curl, timeoutMs, signal);
    const top = (cjson?.data ?? [])
      .filter((c) => c?.body && c.body !== '[deleted]' && c.body !== '[removed]')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10);
    if (top.length) {
      lines.push('', '## Top comments', '');
      for (const c of top) {
        lines.push(`**u/${c.author ?? '?'}** (${c.score ?? '?'} pts):`);
        lines.push(String(c.body ?? '').trim().slice(0, 900));
        lines.push('');
      }
    }
  } catch {
    // Comments are a bonus — the post alone is still a good read.
  }
  lines.push(`Source: ${url}`);
  return { url, title: post.title ?? 'Reddit thread', content: lines.join('\n'), engine: 'arctic', statusCode: 200 };
}

function redditJsonCandidates(url) {
  const u = new URL(url);
  const noQuery = u.pathname.replace(/\/$/, '') || '/';
  const base1 = `https://www.reddit.com${noQuery}.json?raw_json=1`;
  const base2 = `https://old.reddit.com${noQuery}.json?raw_json=1`;
  // search/permalink pages already end in .json → keep single candidate
  if (/\.json(\?|$)/.test(url)) return [url];
  // comments page without trailing slash variants
  return [base1, base2];
}

function redditJsonToMarkdown(url, json) {
  // Listing shape: {data:{children:[...]}} (search) or [postListing, commentsListing]
  if (Array.isArray(json) && json.length >= 1) {
    const post = json[0]?.data?.children?.[0]?.data;
    const comments = json[1]?.data?.children ?? [];
    const lines = [];
    if (post) {
      lines.push(`# ${post.title ?? '(untitled)'}`);
      lines.push(`r/${post.subreddit ?? '?'} · u/${post.author ?? '?'} · ⬆ ${post.score ?? '?'} · 💬 ${post.num_comments ?? '?'}`);
      lines.push('');
      if ((post.selftext ?? '').trim()) lines.push(post.selftext.trim());
      else if (post.url && post.url !== url) lines.push(`Link post → ${post.url}`);
    }
    const top = comments
      .map((c) => c?.data)
      .filter((d) => d && d.body && d.body !== '[deleted]' && d.body !== '[removed]')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10);
    if (top.length) {
      lines.push('', '## Top comments', '');
      for (const c of top) {
        lines.push(`**u/${c.author}** (${c.score ?? '?'} pts):`);
        lines.push((c.body ?? '').trim().slice(0, 900));
        lines.push('');
      }
    }
    lines.push(`Source: ${url}`);
    return { url, title: post?.title ?? 'Reddit thread', content: lines.join('\n'), engine: 'reddit-json', statusCode: 200 };
  }
  if (json?.data?.children) {
    const lines = [`# Reddit search`, ''];
    for (const c of json.data.children.slice(0, 12)) {
      const d = c.data ?? {};
      lines.push(`- **${d.title ?? '(untitled)'}** (r/${d.subreddit ?? '?'}, ⬆ ${d.score ?? '?'}, 💬 ${d.num_comments ?? '?'})`);
      if ((d.selftext ?? '').trim()) lines.push(`  ${d.selftext.trim().slice(0, 400)}`);
      lines.push(`  https://www.reddit.com${d.permalink ?? ''}`);
    }
    return { url, title: 'Reddit search', content: lines.join('\n'), engine: 'reddit-json', statusCode: 200 };
  }
  return { url, title: 'Reddit', content: JSON.stringify(json).slice(0, 4000), engine: 'reddit-json', statusCode: 200 };
}

// --- Discourse --------------------------------------------------------------

async function readDiscourse(url, timeoutMs, signal, maxChars) {
  const u = new URL(url);
  const jurl = `https://${u.host}${u.pathname}.json`.replace(/\.json\.json$/, '.json');
  const json = await fetchJson(jurl, timeoutMs, signal, {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
  });
  const title = json?.title ?? json?.topic_title ?? 'Forum thread';
  const posts = json?.post_stream?.posts ?? [];
  const lines = [`# ${title}`, ''];
  for (const p of posts.slice(0, 10)) {
    const author = p.username ?? p.name ?? '?';
    const text = htmlToText(p.cooked ?? '').slice(0, 1200);
    lines.push(`**@${author}**:`, text, '');
  }
  if (!posts.length && json) {
    return { url, title, content: JSON.stringify(json).slice(0, 4000), engine: 'discourse-json', statusCode: 200 };
  }
  lines.push(`Source: ${url}`);
  return truncateResult({ url, title, content: lines.join('\n'), engine: 'discourse-json', statusCode: 200 }, maxChars);
}

// --- StackExchange (question + top answers via free API) ------------------------

function isStackExchangeUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return (
      h === 'stackoverflow.com' ||
      h.endsWith('.stackoverflow.com') ||
      h === 'stackexchange.com' ||
      h.endsWith('.stackexchange.com') ||
      h === 'superuser.com' ||
      h === 'serverfault.com' ||
      h === 'askubuntu.com'
    );
  } catch {
    return false;
  }
}

function stackExchangeSite(url) {
  const h = new URL(url).hostname.toLowerCase();
  if (h.includes('stackoverflow')) return 'stackoverflow';
  if (h.includes('superuser')) return 'superuser';
  if (h.includes('serverfault')) return 'serverfault';
  if (h.includes('askubuntu')) return 'askubuntu';
  const sub = h.split('.')[0];
  return sub || 'stackoverflow';
}

async function readStackExchange(url, timeoutMs, signal, maxChars) {
  const m = /\/questions\/(\d+)/.exec(new URL(url).pathname);
  if (!m) throw new Error('not a question URL');
  const site = stackExchangeSite(url);
  const qUrl =
    `https://api.stackexchange.com/2.3/questions/${m[1]}?order=desc&sort=activity&site=${site}&filter=withbody`;
  const qJson = await fetchJson(qUrl, timeoutMs, signal);
  const q = qJson?.items?.[0];
  if (!q) throw new Error('question not found');
  const lines = [`# ${decodeEntities(stripTags(q.title ?? '(untitled)'))}`, '', `Score ${q.score ?? '?'} · ${q.answer_count ?? '?'} answers${q.is_answered ? ' · ✅ answered' : ''}`, ''];
  const body = htmlToText(q.body ?? '').slice(0, 2500);
  if (body) lines.push(body, '');
  try {
    const aUrl =
      `https://api.stackexchange.com/2.3/questions/${m[1]}/answers?order=desc&sort=votes&site=${site}&filter=withbody&pagesize=5`;
    const aJson = await fetchJson(aUrl, timeoutMs, signal);
    const answers = (aJson?.items ?? []).slice(0, 5);
    if (answers.length) {
      lines.push('## Top answers', '');
      for (const a of answers) {
        lines.push(`**Score ${a.score ?? '?'}${a.is_accepted ? ' ✅ accepted' : ''}:**`);
        lines.push(htmlToText(a.body ?? '').slice(0, 1500));
        lines.push('');
      }
    }
  } catch {
    // Question alone is still a good read.
  }
  lines.push(`Source: ${url}`);
  return truncateResult({ url, title: decodeEntities(stripTags(q.title ?? 'StackExchange')), content: lines.join('\n'), engine: 'stackexchange-api', statusCode: 200 }, maxChars);
}

// --- HackerNews (Firebase API, no key) ------------------------------------------

function isHNUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'news.ycombinator.com' || h.endsWith('.ycombinator.com');
  } catch {
    return false;
  }
}

async function readHN(url, timeoutMs, signal, maxChars) {
  const id = new URL(url).searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) throw new Error('not an HN item URL');
  const item = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, timeoutMs, signal);
  if (!item) throw new Error('HN item not found');
  const lines = [`# ${item.title ?? '(untitled)'}`, ''];
  lines.push(`${item.score ?? '?'} pts · by ${item.by ?? '?'} · ${item.descendants ?? 0} comments`);
  if (item.url) lines.push(`Link → ${item.url}`);
  if (item.text) lines.push('', htmlToText(item.text).slice(0, 1500));
  const kids = (item.kids ?? []).slice(0, 8);
  if (kids.length) {
    lines.push('', '## Top comments', '');
    const comments = await Promise.all(
      kids.map((k) => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${k}.json`, timeoutMs, signal).catch(() => null)),
    );
    for (const c of comments) {
      if (!c?.text || c.deleted || c.dead) continue;
      lines.push(`**${c.by ?? '?'}:**`);
      lines.push(htmlToText(c.text).slice(0, 800));
      lines.push('');
    }
  }
  lines.push(`Source: ${url}`);
  return truncateResult({ url, title: item.title ?? 'HN thread', content: lines.join('\n'), engine: 'hn-api', statusCode: 200 }, maxChars);
}

// --- Subreddit homepage → recent-posts digest ------------------------------------

async function readSubredditDigest(url, subreddit, timeoutMs, signal, maxChars) {
  const api = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(subreddit)}&limit=15`;
  let json;
  try {
    json = await fetchJson(api, timeoutMs, signal);
  } catch {
    await sleep(1500);
    json = await fetchJson(api, timeoutMs, signal);
  }
  const posts = (json?.data ?? []).slice(0, 15);
  if (!posts.length) throw new Error('no indexed posts for r/' + subreddit);
  const lines = [`# r/${subreddit} — recent top posts`, ''];
  for (const p of posts) {
    lines.push(`- **${(p.title ?? '(untitled)').slice(0, 140)}** (⬆ ${p.score ?? '?'} · 💬 ${p.num_comments ?? '?'})`);
    if ((p.selftext ?? '').trim()) lines.push(`  ${p.selftext.trim().slice(0, 220)}`);
    lines.push(`  https://www.reddit.com${p.permalink ?? `/r/${subreddit}/comments/${p.id}/`}`);
  }
  lines.push('', `Source: ${url}`);
  return truncateResult({ url, title: `r/${subreddit}`, content: lines.join('\n'), engine: 'arctic', statusCode: 200 }, maxChars);
}

// --- Google News redirect resolution ------------------------------------------

function isGoogleNewsUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'news.google.com' || h.endsWith('.news.google.com');
  } catch {
    return false;
  }
}

/**
 * Resolve a news.google.com article URL to its publisher article: the search
 * step remembers headline+publisher per article id (opaque CBM token, nothing
 * decodable server-side), so re-search the exact headline and read the first
 * non-Google result. Throws a descriptive error when unresolvable.
 */
async function readGoogleNews(url, timeoutMs, signal, maxChars) {
  const { recallGoogleNews } = await import('./search.js');
  const hit = recallGoogleNews(url);
  if (!hit?.headline) {
    throw new Error(
      `publisher article for this Google News link is not resolvable: it was not seen by scout_search in this session (open it in a browser instead): ${url}`,
    );
  }
  const where = hit.publisherUrl ? ` (publisher: ${hit.publisher ?? 'unknown'} — ${hit.publisherUrl} — search the headline there)` : '';
  const { freeSearch, significantTerms } = await import('./search.js');
  const { results: candidates } = await freeSearch(`"${hit.headline}"`, { maxResults: 6, timeoutMs, signal });
  const target = bestHeadlineMatch(candidates, hit.headline, hit.publisher, significantTerms);
  if (!target) {
    throw new Error(
      `publisher article for "${hit.headline}" is not resolvable right now: headline search found no publisher link${where || ' (try the headline in a browser)'}`,
    );
  }
  const article = await readGeneric(target.url, timeoutMs, signal, maxChars);
  return {
    ...article,
    title: article.title && article.title !== target.url ? article.title : hit.headline,
    content: `${article.content}\n\n(via Google News · ${hit.publisher ?? 'unknown publisher'})`,
  };
}

/**
 * Pick the candidate most likely to be the publisher article: same-publisher
 * host wins big, then shared headline terms. Returns null when nothing
 * scores (better honest-empty than a wrong page).
 */
function bestHeadlineMatch(candidates, headline, publisher, significantTerms) {
  const terms = significantTerms(headline);
  const pubToken = String(publisher ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => w.length >= 4);
  let best = null;
  let bestScore = 0;
  for (const c of candidates ?? []) {
    if (!/^https?:\/\//i.test(c.url) || isGoogleNewsUrl(c.url)) continue;
    let host = '';
    try {
      host = new URL(c.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    let score = 0;
    if (pubToken && host.replace(/\./g, ' ').split(' ').some((p) => p.includes(pubToken) || pubToken.includes(p))) {
      score += 10;
    }
    const hay = `${c.title ?? ''}`.toLowerCase();
    for (const t of terms) {
      if (hay.includes(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 2 ? best : null;
}

// --- Generic HTML -----------------------------------------------------------

async function readGeneric(url, timeoutMs, signal, maxChars) {
  const { html, finalUrl, statusCode } = await fetchHtml(url, timeoutMs, signal);
  const { title, text } = extractArticle(html);
  const header = title ? `# ${title}\n\n` : '';
  const body = text.trim().slice(0, maxChars);
  if (!body) throw new Error(`no readable text at ${url} (HTTP ${statusCode})`);
  return truncateResult(
    { url: finalUrl, title: title || finalUrl, content: `${header}${body}\n\nSource: ${finalUrl}`, engine: 'html', statusCode },
    maxChars,
  );
}

async function fetchHtml(url, timeoutMs, signal) {
  const { res, finalUrl } = await fetchValidated(
    url,
    timeoutMs,
    signal,
    {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
  );
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} fetching ${url}`);
      err.statusCode = res.status;
      throw err;
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (/application\/json/i.test(ctype)) {
      const j = await res.json();
      const text = JSON.stringify(j, null, 2).slice(0, MAX_BYTES);
      return { html: `<html><head><title>JSON</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`, finalUrl, statusCode: res.status };
    }
    if (!/text|html|xml/i.test(ctype) && ctype) {
      throw new Error(`unsupported content-type ${ctype} at ${url}`);
    }
    // Size-guarded read
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`page too large (${buf.byteLength} bytes) at ${url}`);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { html, finalUrl, statusCode: res.status };
}

export function extractArticle(html) {
  const title =
    /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html)?.[1] ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
    '';
  let body = String(html);
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ');
  body = body.replace(/<style[\s\S]*?<\/style\s*>/gi, ' ');
  body = body.replace(/<nav[\s\S]*?<\/nav\s*>/gi, ' ');
  body = body.replace(/<footer[\s\S]*?<\/footer\s*>/gi, ' ');
  body = body.replace(/<header[\s\S]*?<\/header\s*>/gi, ' ');
  // Prefer <article> or <main> when present.
  const article = /<article[\s\S]*?>([\s\S]*?)<\/article\s*>/i.exec(body)?.[1] ?? /<main[\s\S]*?>([\s\S]*?)<\/main\s*>/i.exec(body)?.[1];
  if (article && stripLen(article) > 400) body = article;
  const text = htmlToText(body);
  return { title: decodeEntities(stripTags(title)).trim(), text };
}

export function htmlToText(html) {
  let s = String(html ?? '');
  // Code blocks first (keep readable).
  s = s.replace(/<pre[\s\S]*?>([\s\S]*?)<\/pre\s*>/gi, (_, code) => '\n```\n' + stripTags(code).trim() + '\n```\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|section|h[1-6]|tr|blockquote|ul|ol)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, label) => {
    const t = stripTags(label).trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(href) && !t.includes(href)) return `${t} (${href})`;
    return t;
  });
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  // Drop boilerplate lines.
  const drop = /^(skip to|search|menu|login|sign in|sign up|subscribe|cookie|privacy policy|terms of service)$/i;
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((l) => l && !drop.test(l))
    .join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// --- Jina fallback ------------------------------------------------------------

async function readViaJina(url, timeoutMs, signal, maxChars, cause) {
  const proxied = 'https://localhost:29395/http://' + url.replace(/^https?:\/\//, '');
  const { res } = await fetchValidated(
    proxied,
    timeoutMs,
    signal,
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain' } },
  );
    if (!res.ok) throw new Error(`Jina fallback HTTP ${res.status}${cause ? ` (direct: ${cause.message})` : ''}`);
    const text = (await res.text()).trim().slice(0, maxChars);
    if (!text) throw new Error('Jina fallback returned empty content');
    return truncateResult(
      { url, title: firstLine(text).slice(0, 160) || url, content: `${text}\n\nSource: ${url}`, engine: 'jina', statusCode: 200 },
      maxChars,
    );
}

// --- Guards + utils -----------------------------------------------------------

function normalizeInputUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('url must be a non-empty string');
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`invalid URL: ${s}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are supported');
  return u.href;
}

export function assertPublicUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    throw new Error(`blocked private target: unparseable URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`blocked private target: ${u.protocol}`);
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') {
    throw new Error(`blocked private target: ${host}`);
  }
  for (const suf of ['.internal', '.invalid', '.test', '.example', '.lan', '.home', '.corp']) {
    if (host.endsWith(suf)) throw new Error(`blocked private target: ${host}`);
  }
  if (host.includes(':')) {
    assertPublicIPv6(host);
    return;
  }
  if (!host.includes('.')) throw new Error(`blocked private target: dotless host ${host}`);
  const v4 = parseIPv4(host);
  if (v4 !== null) {
    const n = v4 >>> 0;
    const inRange = (base, bits) => (n >>> (32 - bits)) === (base >>> (32 - bits));
    if (
      inRange(0x0a000000, 8) || // 10/8
      inRange(0x7f000000, 8) || // 127/8 loopback
      inRange(0xac100000, 12) || // 172.16/12
      inRange(0xc0a80000, 16) || // 192.168/16
      inRange(0xa9fe0000, 16) || // 169.254/16 link-local
      inRange(0x00000000, 8) || // 0/8 (incl. 0.0.0.0)
      inRange(0x64400000, 10) // 100.64/10 CGNAT
    ) {
      throw new Error(`blocked private target: ${host}`);
    }
  }
}

/** inet_aton-style parse: dotted decimal/hex/octal + single-integer forms. */
function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const vals = [];
  for (const p of parts) {
    if (!/^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*|0)$/.test(p)) return null;
    let v;
    if (/^0[xX]/.test(p)) v = parseInt(p, 16);
    else if (/^0[0-9]+$/.test(p)) v = parseInt(p, 8);
    else v = parseInt(p, 10);
    if (!Number.isFinite(v)) return null;
    vals.push(v);
  }
  if (vals.some((v) => v < 0 || v > 0xffffffff)) return null;
  if (parts.length === 4) {
    if (vals.some((v) => v > 255)) return null;
    return ((vals[0] * 256 + vals[1]) * 256 + vals[2]) * 256 + vals[3];
  }
  // Short forms: last part fills the remaining bytes (BSD inet_aton).
  const lastBits = 8 * (4 - parts.length + 1);
  if (vals[vals.length - 1] >= 2 ** lastBits) return null;
  if (vals.slice(0, -1).some((v) => v > 255)) return null;
  let n = 0;
  for (let i = 0; i < vals.length - 1; i++) n = n * 256 + vals[i];
  return n * 2 ** lastBits + vals[vals.length - 1];
}

function assertPublicIPv6(host) {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::' || h === '::ffff:0:0' || h.startsWith('::ffff:')) {
    // IPv4-mapped: check the embedded v4 address.
    const m = /::ffff:([0-9.]+)$/.exec(h);
    if (m) {
      const v4 = parseIPv4(m[1]);
      if (v4 === null) throw new Error(`blocked private target: ${host}`);
      const n = v4 >>> 0;
      if ((n >>> 24) === 0x7f || (n >>> 24) === 0x0a) throw new Error(`blocked private target: ${host}`);
      return;
    }
    throw new Error(`blocked private target: ${host}`);
  }
  if (h.startsWith('fe80') || h.startsWith('fec0') || h.startsWith('ff') || h.startsWith('fc') || h.startsWith('fd')) {
    throw new Error(`blocked private target: ${host}`);
  }
}

/**
 * Fetch with MANUAL redirect handling so every hop is SSRF-validated.
 * (fetch's built-in 'follow' would happily walk a public URL into a
 * private one via a 302 — DNS-rebinding within a short TTL is still only
 * mitigated by short timeouts, not eliminated; see README.)
 */
/**
 * Resolve one redirect hop and SSRF-validate the target (L3-testable).
 * fetchValidated() applies this to every hop; tests drive it directly with
 * redirect-to-private / redirect-chain matrices that no local fixture server
 * could exercise (localhost is guard-blocked by design, so a loopback
 * redirect target can never be fetched in the first place).
 */
export function resolveRedirect(current, loc) {
  const next = new URL(String(loc), current).href;
  assertPublicUrl(next);
  return next;
}

async function fetchValidated(startUrl, timeoutMs, signal, init, maxHops = 5) {
  let current = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    assertPublicUrl(current);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error('fetch timeout')), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      const res = await fetch(current, { ...(init ?? {}), redirect: 'manual', signal: combined });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`redirect without location at ${current} (HTTP ${res.status})`);
        current = resolveRedirect(current, loc);
        continue;
      }
      return { res, finalUrl: current };
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`too many redirects at ${startUrl}`);
}

async function fetchJson(url, timeoutMs, parentSignal, extraHeaders) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...(extraHeaders ?? {}) },
      redirect: 'follow',
      signal,
    });
    // API hosts are fixed/trusted, but a hostile 302 must not smuggle the
    // parse step onto a private target — validate where we landed.
    try {
      assertPublicUrl(res.url || url);
    } catch {
      throw new Error(`blocked redirect target for ${url}`);
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} for ${url}`);
      e.statusCode = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function truncateResult(r, maxChars) {
  if (r.content.length <= maxChars) return { ...r, truncated: false };
  return { ...r, content: r.content.slice(0, maxChars), truncated: true };
}

function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

function stripLen(s) {
  return stripTags(s).length;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return '';
      }
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function firstLine(s) {
  return String(s).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

function isAbort(e, signal) {
  return signal?.aborted || e?.name === 'AbortError';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
