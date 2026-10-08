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
 *   5. Direct HTML fetch → readability-lite extraction (title + article text)
 *   6. Optional Jina reader fallback (https://localhost:29395/http://…) for 403/429/blocked pages
 *
 * SSRF guard blocks private/local targets. Output is capped at maxChars.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REDDIT_UA = 'Mozilla/5.0 (compatible; scout-reader/0.2.0)';
const MAX_BYTES = 2_500_000;

export async function freeRead(rawUrl, options = {}) {
  const maxChars = clampInt(options.maxChars ?? 12000, 1000, 50000);
  const timeoutMs = clampInt(options.timeoutMs ?? 15000, 1000, 60000);
  const jinaFallback = options.jinaFallback !== false;
  const signal = options.signal;

  const url = normalizeInputUrl(rawUrl);
  assertPublicUrl(url);

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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('fetch timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: combined,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} fetching ${url}`);
      err.statusCode = res.status;
      throw err;
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (/application\/json/i.test(ctype)) {
      const j = await res.json();
      const text = JSON.stringify(j, null, 2).slice(0, MAX_BYTES);
      return { html: `<html><head><title>JSON</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`, finalUrl: res.url || url, statusCode: res.status };
    }
    if (!/text|html|xml/i.test(ctype) && ctype) {
      throw new Error(`unsupported content-type ${ctype} at ${url}`);
    }
    // Size-guarded read
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`page too large (${buf.byteLength} bytes) at ${url}`);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { html, finalUrl: res.url || url, statusCode: res.status };
  } finally {
    clearTimeout(t);
  }
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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('jina timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(proxied, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain' },
      redirect: 'follow',
      signal: combined,
    });
    if (!res.ok) throw new Error(`Jina fallback HTTP ${res.status}${cause ? ` (direct: ${cause.message})` : ''}`);
    const text = (await res.text()).trim().slice(0, maxChars);
    if (!text) throw new Error('Jina fallback returned empty content');
    return truncateResult(
      { url, title: firstLine(text).slice(0, 160) || url, content: `${text}\n\nSource: ${url}`, engine: 'jina', statusCode: 200 },
      maxChars,
    );
  } finally {
    clearTimeout(t);
  }
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

function assertPublicUrl(href) {
  const u = new URL(href);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') {
    throw new Error(`blocked private target: ${host}`);
  }
  // Literal private IPv4 ranges.
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [, a, b] = m.map(Number);
    const priv =
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
    if (priv) throw new Error(`blocked private target: ${host}`);
  }
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
