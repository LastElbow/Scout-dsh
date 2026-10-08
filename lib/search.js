/**
 * Free multi-backend web search — zero dependencies, no API keys.
 *
 * Free-first provider ladder (queried in parallel, failures never fail the
 * whole search):
 *   keyed (optional, skipped when unset):
 *   0. Brave Search API  — recommended keyed primary, slots in first
 *   0b. Google CSE        — LEGACY ONLY (closed to new customers,
 *      discontinued 2027-01-01; pre-existing keys only), else News RSS
 *   keyless (always on):
 *   1. Google News RSS — Google coverage, free + keyless (news/current;
 *      google.com HTML is a JS shell with no server-side results, so it
 *      cannot be scraped without a JS engine — News RSS is the honest
 *      free Google backend)
 *   2. DuckDuckGo HTML  — general web (handles `site:` queries natively)
 *   3. Bing RSS         — general web, no key, unofficial public endpoint
 *      (NOT the retired keyed Bing Search API); also powers the
 *      reddit-biased pass
 *   4. Bing RSS (reddit-biased) — same query + `site:reddit.com` when the user
 *      didn't already scope to a site; this is how reddit threads stay covered
 *      now that reddit.com blocks unauthenticated /search.json (HTTP 403).
 *   5. Wikipedia OpenSearch — encyclopedic grounding
 *   6. HackerNews Algolia — HN stories (free, no key)
 *   7. StackExchange API   — StackOverflow answers (free quota, no key)
 *   8. Arctic Shift        — reddit full-text, only when a subreddit is named
 *      (r/foo, subreddit:foo, or site:reddit.com/r/foo); the API requires a
 *      subreddit/author filter for text queries.
 *
 * Results are de-duplicated by canonical URL (tracking params, www.,
 * http/https, AMP variants merged), fused by Reciprocal Rank Fusion
 * (agreement across engines), relevance-reranked (diversity-preserving),
 * snippet-trimmed, and capped at maxResults.
 *
 * Lean options (all optional, flat primitives for any agent):
 *   includeDomains / excludeDomains — comma-separated hosts ("github.com, *.substack.com")
 *   rerank — false keeps raw interleave order (default true: RRF + heuristic)
 *   snippetChars — per-snippet cap 80–500 (default 220, was 300)
 *   recency — day|week|month|year|all (default all; undated results are kept)
 *   redditBias — auto|on|off (default auto: extra reddit pass for opinion queries)
 *   brave — { key } slots Brave Search API in first when configured
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

import { applyDomainFilters, rerankResults, trimSnippets, fuseRRF, filterRecency, sanitizeUntrusted, toISODate } from './lean.js';

// --- Backend health: circuit breakers + quota --------------------------------
// Keyless HTML/RSS endpoints throttle aggressively. A tripped backend is
// skipped for a few minutes instead of paying a backoff on every search.
const breakers = new Map();
function breakerBlocked(name) {
  const until = breakers.get(name);
  if (!until) return false;
  if (Date.now() > until) {
    breakers.delete(name);
    return false;
  }
  return true;
}
function breakerTrip(name, ms = 3 * 60 * 1000) {
  breakers.set(name, Date.now() + ms);
}
function breakerNote(e, name) {
  if (/HTTP (429|5\d\d)|timeout|challenge/i.test(String(e?.message))) breakerTrip(name);
}
// Google CSE free tier: 100 queries/day (legacy keys only). Local counter
// avoids burning the quota after restarts/config churn; resets daily (UTC).
// News RSS covers us.
const cseQuota = { day: '', count: 0 };
function cseQuotaOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (cseQuota.day !== today) {
    cseQuota.day = today;
    cseQuota.count = 0;
  }
  return cseQuota.count < 95;
}
function cseQuotaUse() {
  const today = new Date().toISOString().slice(0, 10);
  if (cseQuota.day !== today) {
    cseQuota.day = today;
    cseQuota.count = 0;
  }
  cseQuota.count += 1;
}

/** Opinion/experience queries earn the extra reddit-biased Bing pass. */
export function isOpinionQuery(q) {
  return /best|review|vs\.?|versus|compare|recommend|experience|opinion|worth it|should i|reddit|forum|thread|how do i\b|\?\s*$|\bhow to\b/i.test(String(q ?? ''));
}

/**
 * Same-process bridge: searchGoogleNews remembers each story's headline +
 * publisher keyed by article id, so the reader can resolve a
 * news.google.com redirect URL back to the publisher article (those pages
 * are JS shells with nothing resolvable server-side). Entries live 30 min.
 */
const googleNewsCache = new Map();
export function rememberGoogleNews(id, entry) {
  if (!id) return;
  const now = Date.now();
  for (const [k, v] of googleNewsCache) {
    if (now - v.at > 30 * 60 * 1000) googleNewsCache.delete(k);
  }
  googleNewsCache.set(id, { ...entry, at: now });
  if (googleNewsCache.size > 200) {
    const first = googleNewsCache.keys().next().value;
    googleNewsCache.delete(first);
  }
}
export function recallGoogleNews(url) {
  const id = googleNewsId(url);
  const hit = id ? googleNewsCache.get(id) : undefined;
  if (!hit) return null;
  if (Date.now() - hit.at > 30 * 60 * 1000) {
    googleNewsCache.delete(id);
    return null;
  }
  return hit;
}
export function googleNewsId(url) {
  try {
    const m = /\/articles\/([^?#/]+)/.exec(String(url));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function freeSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query must be a non-empty string');
  const maxResults = clampInt(options.maxResults ?? 8, 1, 20);
  const timeoutMs = clampInt(options.timeoutMs ?? 12000, 1000, 60000);
  const signal = options.signal;
  const lower = q.toLowerCase();
  const hasSite = lower.includes('site:');
  const recency = options.recency ?? 'all';
  const redditBias = String(options.redditBias ?? 'auto').trim().toLowerCase();
  const wantRedditPass =
    !hasSite && (redditBias === 'on' || (redditBias !== 'off' && isOpinionQuery(q)));

  // Named backends: names feed RRF fusion + circuit breakers. A keyed Brave
  // provider slots in first when BRAVE_API_KEY is set (see README); the
  // Google entry is CSE-when-configured (legacy keys only) else News RSS.
  const backends = [
    // Google entry: full Search API only for pre-existing (free-tier) keys,
    // otherwise keyless Google News RSS. CSE is legacy — closed to new
    // customers, discontinued 2027-01-01 — not the primary engine.
    { name: 'google', run: () => searchGoogle(q, 8, timeoutMs, signal, options.google) },
    { name: 'ddg', run: () => searchDDG(q, 8, timeoutMs, signal) },
    { name: 'bing', run: () => searchBingRSS(q, 8, timeoutMs, signal, 'web') },
  ];
  if (options.brave?.key) {
    backends.unshift({ name: 'brave', run: () => searchBrave(q, 8, timeoutMs, signal, options.brave.key) });
  }
  if (wantRedditPass) {
    // Reddit-biased pass: only for opinion/experience queries (or explicit
    // redditBias:'on') — running it on every query doubles Bing traffic and
    // biases factual queries toward forums.
    backends.push({ name: 'reddit-pass', run: () => searchBingRSS(`${q} site:reddit.com`, 5, timeoutMs, signal, 'reddit') });
  }
  backends.push(
    { name: 'wikipedia', run: () => searchWikipedia(q, 3, timeoutMs, signal) },
    { name: 'hn', run: () => searchHN(q, 4, timeoutMs, signal) },
    { name: 'stackoverflow', run: () => searchStackExchange(q, 4, timeoutMs, signal) },
  );
  const subreddit = detectSubreddit(q);
  if (subreddit) {
    backends.push({ name: 'arctic', run: () => searchArctic(q, subreddit, 5, timeoutMs, signal) });
  }
  // Test seam (L4 chaos): injected fakes replace the whole backend list.
  // Production callers never pass `backends` — defaults above always run.
  const active = options.backends ?? backends;

  const runBackend = async (b) => {
    if (breakerBlocked(b.name)) return { name: b.name, items: [] };
    try {
      return { name: b.name, items: await runWithTimeout(b, timeoutMs) };
    } catch (e) {
      breakerNote(e, b.name);
      return { name: b.name, items: [] };
    }
  };
  const settled = await Promise.all(active.map(runBackend));
  return rankPipeline(settled, q, {
    maxResults,
    rerank: options.rerank,
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
    recency,
    snippetChars: options.snippetChars ?? 220,
  });
}

/**
 * Per-backend timeout guard (L4 chaos): a hung backend degrades to empty
 * instead of hanging the whole search. Real backends enforce their own fetch
 * timeouts; this is the backstop for injected/future backends. The `timeout`
 * message trips the circuit breaker via breakerNote, like any other stall.
 */
function runWithTimeout(b, timeoutMs) {
  const p = b.run();
  // Avoid an unhandled rejection if the timer wins the race.
  p.catch(() => {});
  const timer = sleep(timeoutMs).then(() => {
    throw new Error(`timeout (${b.name})`);
  });
  return Promise.race([p, timer]);
}

/**
 * Pure ranking tail (L1/L5-testable): canonical-key stamping → RRF fusion or
 * raw interleave → heuristic rerank → domain/recency filters → snippet trim →
 * cap + sanitize. freeSearch() runs backends then calls this; tests and the
 * future multi-query path (#3) call it directly with canned backend lists.
 */
export function rankPipeline(settled, query, opts = {}) {
  const maxResults = clampInt(opts.maxResults ?? 8, 1, 20);
  const q = String(query ?? '');
  const lists = settled ?? [];
  // Stamp merge keys BEFORE fusion (widened normalization: tracking params,
  // www., http/https, AMP variants all merge to one key).
  for (const g of lists) for (const r of g.items ?? []) r._key = normalizeUrl(r.url);

  let results;
  if (opts.rerank !== false) {
    // Agreement first (RRF: same URL in two engines = strong signal), then
    // the heuristic rerank on top (diversity-preserving).
    try {
      results = fuseRRF(lists);
      results = rerankResults(results, q);
    } catch {
      results = interleave(lists.flatMap((g) => g.items ?? []), Math.max(maxResults, 12));
    }
  } else {
    results = interleave(lists.flatMap((g) => g.items ?? []), Math.max(maxResults, 12));
  }
  // Lean layer (token-efficient, agent-friendly): domain filters → recency →
  // snippet trim + sanitize → final cap. Filters never blank a search on error.
  try {
    results = applyDomainFilters(results, opts.includeDomains, opts.excludeDomains);
  } catch {
    /* filter must never blank a search */
  }
  try {
    results = filterRecency(results, opts.recency ?? 'all');
  } catch {
    /* keep unfiltered on error */
  }
  try {
    results = trimSnippets(results, opts.snippetChars ?? 220);
  } catch {
    /* keep full snippets on trim failure */
  }
  return results.slice(0, maxResults).map((r) => ({
    ...r,
    title: sanitizeUntrusted(r.title),
    snippet: sanitizeUntrusted(r.snippet),
  }));
}

function interleave(all, max) {
  const groups = new Map();
  for (const r of all) {
    const g = r.source ?? 'web';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const order = ['google', 'ddg', 'web', 'reddit', 'stackoverflow', 'hn', 'wikipedia', 'arctic'];
  for (const g of groups.keys()) if (!order.includes(g)) order.push(g);
  const seen = new Set();
  const out = [];
  let progress = true;
  while (out.length < max && progress) {
    progress = false;
    for (const g of order) {
      const arr = groups.get(g);
      if (arr && arr.length) {
        const r = arr.shift();
        const key = normalizeUrl(r.url);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(r);
          progress = true;
          if (out.length >= max) break;
        }
      }
    }
  }
  return out;
}

function detectSubreddit(q) {
  const m = /(?:r\/([A-Za-z0-9_]+)|subreddit:([A-Za-z0-9_]+)|reddit\.com\/r\/([A-Za-z0-9_]+))/i.exec(q);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim() || null;
}

// --- Backends -------------------------------------------------------------

/**
 * Google entry — legacy keyed tier plus keyless News RSS:
 *   A. Custom Search API (full google.com results incl. `site:` support) only
 *      when a pre-existing key is configured: options.google = { key, cx }.
 *      LEGACY: closed to new customers, discontinued 2027-01-01.
 *   B. Google News RSS (keyless, no signup): real Google coverage for
 *      news/current queries. Always on.
 */
async function searchGoogle(query, limit, timeoutMs, parentSignal, googleOpts) {
  const key = googleOpts?.key?.trim();
  const cx = googleOpts?.cx?.trim();
  if (key && cx && cseQuotaOk()) {
    try {
      const results = await searchGoogleCSE(query, Math.min(limit, 10), timeoutMs, parentSignal, key, cx);
      if (results.length) return results;
    } catch {
      // Fall through to News RSS — a bad key must never blank results.
    }
  }
  return searchGoogleNews(query, Math.min(limit, 5), timeoutMs, parentSignal);
}

/** Legacy full Google Search via the Custom Search API (pre-existing free-tier keys only; closed to new customers, discontinued 2027-01-01). */
async function searchGoogleCSE(query, limit, timeoutMs, parentSignal, key, cx) {
  cseQuotaUse();
  const url =
    'https://www.googleapis.com/customsearch/v1?q=' +
    encodeURIComponent(query) +
    `&key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=${Math.min(Math.max(limit, 1), 10)}`;
  const json = await fetchJson(url, timeoutMs, parentSignal);
  if (json?.error) throw new Error(`Google CSE: ${json.error?.message ?? 'unknown error'}`);
  const items = json?.items ?? [];
  return items.slice(0, limit).map((it) => ({
    title: decodeEntities(String(it.title ?? '(untitled)')),
    url: String(it.link),
    snippet: decodeEntities(stripTags(String(it.snippet ?? it.htmlSnippet ?? ''))).trim().slice(0, 300),
    source: 'google',
  }));
}

/**
 * Brave Search API (optional keyed provider): slots in FIRST when a key is
 * configured (options.brave = { key }). Paid/keyed but cheap, with an
 * agent-grade index — the escape hatch for when keyless HTML/RSS endpoints
 * change or get blocked without notice. Failure never blanks the search.
 */
async function searchBrave(query, limit, timeoutMs, parentSignal, key) {
  const url =
    'https://api.search.brave.com/res/v1/web/search?q=' +
    encodeURIComponent(query) +
    `&count=${Math.min(Math.max(limit, 1), 10)}`;
  const json = await fetchJson(url, timeoutMs, parentSignal, {
    'X-Subscription-Token': String(key).trim(),
    Accept: 'application/json',
  });
  const items = json?.web?.results ?? [];
  return items.slice(0, limit).map((it) => ({
    title: decodeEntities(stripTags(String(it.title ?? '(untitled)'))).trim() || hostOf(String(it.url ?? '')),
    url: String(it.url ?? ''),
    snippet: decodeEntities(stripTags(String(it.description ?? ''))).trim().slice(0, 300),
    source: 'brave',
    publishedDate: toISODate(it.age ?? it.page_age ?? null),
  })).filter((r) => /^https?:\/\//i.test(r.url));
}

/**
 * Google News RSS (keyless tier): real Google coverage for news/current
 * queries with no signup. Links are news.google.com redirects (they resolve
 * in a browser); publisher + date go in the snippet.
 */
async function searchGoogleNews(query, limit, timeoutMs, parentSignal) {
  const clean = String(query).replace(/site:\S+/gi, ' ').replace(/\s+/g, ' ').trim() || query;
  const url =
    'https://news.google.com/rss/search?q=' + encodeURIComponent(clean) + '&hl=en-US&gl=US&ceid=US:en';
  const xml = await fetchText(url, timeoutMs, parentSignal, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
  });
  return parseGoogleNewsRSS(xml, query).slice(0, limit);
}

export function parseGoogleNewsRSS(xml, query) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const title = decodeEntities(stripTags(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '')).trim();
    const link = decodeEntities((/<link>([\s\S]*?)<\/link>/i.exec(body)?.[1] ?? '').trim());
    const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(body)?.[1] ?? '').trim();
    const source = decodeEntities(
      stripTags(/<source[^>]*>([\s\S]*?)<\/source>/i.exec(body)?.[1] ?? ''),
    ).trim();
    const sourceUrl = (/<source url="([^"]*)"/i.exec(body)?.[1] ?? '').trim();
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const date = pubDate ? new Date(pubDate).toISOString().slice(0, 10) : '';
    // RSS titles are "Headline - Publisher": split the headline for later
    // resolution, and remember it keyed by article id for the reader.
    let headline = title || hostOf(link);
    if (source && headline.toLowerCase().endsWith(' - ' + source.toLowerCase())) {
      headline = headline.slice(0, -(3 + source.length)).trim() || headline;
    }
    rememberGoogleNews(googleNewsId(link), { headline, publisher: source, publisherUrl: sourceUrl });
    const item = {
      title: title || hostOf(link),
      url: link,
      snippet: `${source ? `via Google News · ${source}` : 'via Google News'}${date ? ` · ${date}` : ''}`,
      source: 'google',
      publishedDate: date || null,
    };
    if (!matchesQuery(item, query)) continue;
    out.push(item);
    if (out.length >= 20) break;
  }
  return out;
}

async function searchDDG(query, limit, timeoutMs, parentSignal) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  let html;
  try {
    html = await fetchText(url, timeoutMs, parentSignal, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
  } catch (e) {
    // DDG throttles aggressively (HTTP 429/202, empty pages). One polite
    // retry after a back-off before giving up — other backends cover meanwhile.
    if (!/HTTP (429|202)/.test(String(e?.message)) || parentSignal?.aborted) throw e;
    await sleep(2500);
    html = await fetchText(url, timeoutMs, parentSignal, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
  }
  if (/are you a robot|challenge-form|js-challenge/i.test(html)) {
    throw new Error('DDG bot challenge (throttled)');
  }
  const results = parseDDG(html);
  return results.slice(0, limit).map((r) => ({ ...r, source: /reddit\.com/i.test(r.url) ? 'reddit' : 'ddg' }));
}

export function parseDDG(html) {
  const out = [];
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = unwrapDDG(m[1]);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if (/duckduckgo\.com\/l\//i.test(href)) continue;
    if (/duckduckgo\.com\/y\.js/i.test(href)) continue; // sponsored ad click-link, not a result
    const title = decodeEntities(stripTags(m[2])).trim();
    const window = html.slice(m.index, m.index + 4000);
    const snip =
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(window)?.[1] ??
      /class="result__snippet"[^>]*>([\s\S]*?)<\/(div|td)>/i.exec(window)?.[1] ??
      '';
    out.push({
      title: title || hostOf(href),
      url: href,
      snippet: decodeEntities(stripTags(snip)).trim().slice(0, 300),
    });
    if (out.length >= 20) break;
  }
  return out;
}

function unwrapDDG(href) {
  try {
    const decoded = decodeEntities(href).replace(/&amp;/g, '&');
    // Redirect links carry the real target in ?uddg= — unwrap FIRST,
    // because they also start with `//` (early-returning on `//` was
    // dropping every DDG result as a "redirect URL").
    if (/duckduckgo\.com\/l\//i.test(decoded)) {
      const absolute = decoded.startsWith('http') ? decoded : 'https:' + decoded;
      const uddg = new URL(absolute).searchParams.get('uddg');
      if (uddg) return uddg;
      return '';
    }
    if (decoded.startsWith('//')) return 'https:' + decoded;
    return decoded;
  } catch {
    return href;
  }
}

/**
 * Bing RSS (unofficial public endpoint — NOT the retired keyed Bing Search
 * API; it can change or be blocked without notice, hence failure-isolated
 * behind the circuit breaker like every keyless backend).
 */
async function searchBingRSS(query, limit, timeoutMs, parentSignal, source) {
  const url = 'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query);
  const xml = await fetchText(url, timeoutMs, parentSignal, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
  });
  const parsed = parseBingRSS(xml, source);
  // Relevance guard: Bing RSS matches weakly (often OR semantics) and
  // silently ignores `site:` operators, so unfiltered it can flood results
  // with dictionary junk ("BEST Definition…"). Drop items that share no
  // significant query term with title/snippet/url.
  const guarded = parsed.filter((r) => matchesQuery(r, query));
  return guarded.slice(0, limit);
}

/**
 * True when the result shares at least one significant query term
 * (len ≥ 3, stopwords + site:/r//u/ tokens removed) with its
 * title, snippet, or URL — or when there are no significant terms.
 */
export function matchesQuery(result, query) {
  const terms = significantTerms(query);
  if (!terms.length) return true;
  const hay = `${result.title ?? ''} ${result.snippet ?? ''} ${result.url ?? ''}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

const STOPWORDS = new Set(
  'a,an,and,are,as,at,be,but,by,for,from,has,have,how,in,is,it,its,of,on,or,that,the,their,to,was,what,when,where,which,who,with,vs,app,apps,best,top,free'.split(','),
);

export function significantTerms(query) {
  return (
    String(query ?? '')
      .toLowerCase()
      .replace(/site:\S+/gi, ' ')
      .replace(/\br\/[a-z0-9_]+\b/gi, ' ')
      .replace(/\bu\/[a-z0-9_-]+\b/gi, ' ')
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .slice(0, 8)
  );
}

export function parseBingRSS(xml, source) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const title = decodeEntities(stripTags(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '')).trim();
    const link = decodeEntities((/<link>([\s\S]*?)<\/link>/i.exec(body)?.[1] ?? '').trim());
    const desc = decodeEntities(stripTags(/<description>([\s\S]*?)<\/description>/i.exec(body)?.[1] ?? '')).trim().slice(0, 300);
    const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(body)?.[1] ?? '').trim();
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const isReddit = /reddit\.com/i.test(link);
    out.push({
      title: title || hostOf(link),
      url: link,
      snippet: desc,
      source: isReddit ? 'reddit' : source,
      publishedDate: toISODate(pubDate || null),
    });
    if (out.length >= 20) break;
  }
  return out;
}

async function searchWikipedia(query, limit, timeoutMs, parentSignal) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=opensearch&search=' +
    encodeURIComponent(query) +
    `&limit=${limit}&namespace=0&format=json`;
  const res = await fetchJson(url, timeoutMs, parentSignal);
  if (!Array.isArray(res) || res.length < 4) return [];
  const [, titles, descriptions, urls] = res;
  return titles.slice(0, limit).map((t, i) => ({
    title: String(t),
    url: urls?.[i] ?? 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(t).replace(/ /g, '_')),
    snippet: String(descriptions?.[i] ?? '').slice(0, 300),
    source: 'wikipedia',
  }));
}

async function searchHN(query, limit, timeoutMs, parentSignal) {
  const url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) + `&tags=story&hitsPerPage=${limit}`;
  const json = await fetchJson(url, timeoutMs, parentSignal);
  const hits = json?.hits ?? [];
  return hits.slice(0, limit).map((h) => ({
    title: String(h.title ?? '(untitled)'),
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: `HN · ${h.points ?? 0} pts · ${h.num_comments ?? 0} comments` + (h.author ? ` · by ${h.author}` : ''),
    source: 'hn',
    publishedDate: toISODate(h.created_at ?? null),
  }));
}

async function searchStackExchange(query, limit, timeoutMs, parentSignal) {
  const url =
    'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=' +
    encodeURIComponent(query) +
    `&site=stackoverflow&pagesize=${limit}&filter=!nNPvSNdWme`;
  const json = await fetchJson(url, timeoutMs, parentSignal);
  const items = json?.items ?? [];
  return items.slice(0, limit).map((it) => ({
    title: decodeEntities(String(it.title ?? '(untitled)')),
    url: String(it.link),
    snippet: `StackOverflow · score ${it.score ?? '?'}${it.is_answered ? ' · ✅ answered' : ''} · ${it.answer_count ?? '?'} answers`,
    source: 'stackoverflow',
    publishedDate: toISODate(it.creation_date ?? null),
  }));
}

/**
 * Reddit full-text via Arctic Shift (Pushshift successor, no key).
 * Only called when the query names a subreddit — the API requires a
 * subreddit/author filter for text queries. Polite: one retry after a
 * short back-off (the API 422s when hammered).
 */
async function searchArctic(query, subreddit, limit, timeoutMs, parentSignal) {
  const clean = query.replace(/(?:r\/[A-Za-z0-9_]+|subreddit:[A-Za-z0-9_]+|site:\S+)/gi, ' ').replace(/\s+/g, ' ').trim() || query;
  const url =
    'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=' +
    encodeURIComponent(subreddit) +
    '&query=' +
    encodeURIComponent(clean) +
    `&limit=${limit}`;
  let json;
  try {
    json = await fetchJson(url, timeoutMs, parentSignal);
  } catch {
    await sleep(1500);
    json = await fetchJson(url, timeoutMs, parentSignal);
  }
  const posts = json?.data ?? [];
  return posts.slice(0, limit).map((p) => ({
    title: `${String(p.title ?? '(untitled)').slice(0, 160)} — r/${p.subreddit ?? subreddit}`,
    url: p.permalink ? 'https://www.reddit.com' + p.permalink : `https://www.reddit.com/r/${p.subreddit ?? subreddit}/comments/${p.id}/`,
    snippet: `${(p.selftext ?? '').trim().slice(0, 240) || 'link/image post'} · ⬆ ${p.score ?? '?'} · 💬 ${p.num_comments ?? '?'}`,
    source: 'arctic',
    publishedDate: toISODate(p.created_utc ?? null),
  }));
}

// --- HTTP helpers ---------------------------------------------------------

async function fetchText(url, timeoutMs, parentSignal, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(url, { ...(init ?? {}), redirect: 'follow', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${hostOf(url)}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, timeoutMs, parentSignal, extraHeaders) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(extraHeaders ?? {}) },
      redirect: 'follow',
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${hostOf(url)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- Text utils -----------------------------------------------------------

const TRACKING_PARAMS = new Set(
  'utm_source,utm_medium,utm_campaign,utm_term,utm_content,utm_id,utm_name,si,ref,fbclid,gclid,gclsrc,msclkid,mc_cid,mc_eid,igshid,vero_conv,vero_id,mkt_tok,mc_cid,wbraid,gbraid,srsltid'.split(','),
);

/**
 * Canonical merge key: lowercase host, strip www., drop tracking params,
 * unify http→https, strip hash, collapse AMP variants (/amp, ?amp, ?output=1)
 * and trailing slashes. The returned `r.url` is untouched — only the key
 * changes, so duplicates merge instead of surviving as separate hits.
 */
export function normalizeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    url.hash = '';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    for (const p of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(p.toLowerCase()) || /^(utm_|fb_|gclid|msclkid)/i.test(p)) {
        url.searchParams.delete(p);
      }
    }
    let host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.slice(4);
      url.hostname = host;
    }
    // AMP variants → canonical page.
    url.pathname = url.pathname.replace(/\/amp\/?$/i, '').replace(/\/amp\//i, '/') || '/';
    if (/^(1|true)$/i.test(url.searchParams.get('amp') ?? '') || url.searchParams.get('output') === '1') {
      url.searchParams.delete('amp');
      url.searchParams.delete('output');
    }
    url.protocol = 'https:';
    return url.href.replace(/\/(\?|$)/, '$1').replace(/\/$/, '');
  } catch {
    return '';
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return 'web';
  }
}

function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
