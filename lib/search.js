/**
 * Free multi-backend web search — zero dependencies, no API keys.
 *
 * Backends (queried in parallel, failures never fail the whole search):
 *   1. Google News RSS — Google coverage, free + keyless (news/current;
 *      google.com HTML is a JS shell with no server-side results, so it
 *      cannot be scraped without a JS engine — News RSS is the honest
 *      free Google backend)
 *   2. DuckDuckGo HTML  — general web (handles `site:` queries natively)
 *   3. Bing RSS         — general web, no key (also powers the reddit-biased pass)
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
 * Results are de-duplicated by normalized URL, interleaved across backends,
 * and capped at maxResults.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function freeSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query must be a non-empty string');
  const maxResults = clampInt(options.maxResults ?? 8, 1, 20);
  const timeoutMs = clampInt(options.timeoutMs ?? 12000, 1000, 60000);
  const signal = options.signal;
  const lower = q.toLowerCase();
  const hasSite = lower.includes('site:');

  const jobs = [
    // Google first: full Search API when a (free-tier) key is configured,
    // otherwise keyless Google News RSS. Google is the primary engine.
    searchGoogle(q, 8, timeoutMs, signal, options.google).catch(() => []),
    searchDDG(q, 8, timeoutMs, signal).catch(() => []),
    searchBingRSS(q, 8, timeoutMs, signal, 'web').catch(() => []),
  ];
  if (!hasSite) {
    // Reddit-biased pass: guarantees reddit/forum threads in the mix.
    jobs.push(searchBingRSS(`${q} site:reddit.com`, 5, timeoutMs, signal, 'reddit').catch(() => []));
  }
  jobs.push(
    searchWikipedia(q, 3, timeoutMs, signal).catch(() => []),
    searchHN(q, 4, timeoutMs, signal).catch(() => []),
    searchStackExchange(q, 4, timeoutMs, signal).catch(() => []),
  );
  const subreddit = detectSubreddit(q);
  if (subreddit) {
    jobs.push(searchArctic(q, subreddit, 5, timeoutMs, signal).catch(() => []));
  }

  const settled = await Promise.all(jobs);
  return interleave(settled.flat(), maxResults);
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
 * Google — the primary engine, two tiers:
 *   A. Custom Search API (full google.com results incl. `site:` support) when
 *      the free-tier key is configured: options.google = { key, cx }.
 *      The key is Google's own free tier (100 queries/day, $0) — see README.
 *   B. Google News RSS (keyless, no signup): real Google coverage for
 *      news/current queries. Always on.
 */
async function searchGoogle(query, limit, timeoutMs, parentSignal, googleOpts) {
  const key = googleOpts?.key?.trim();
  const cx = googleOpts?.cx?.trim();
  if (key && cx) {
    try {
      const results = await searchGoogleCSE(query, Math.min(limit, 10), timeoutMs, parentSignal, key, cx);
      if (results.length) return results;
    } catch {
      // Fall through to News RSS — a bad key must never blank results.
    }
  }
  return searchGoogleNews(query, Math.min(limit, 5), timeoutMs, parentSignal);
}

/** Full Google Search via the Custom Search API (free tier: 100/day). */
async function searchGoogleCSE(query, limit, timeoutMs, parentSignal, key, cx) {
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

function parseGoogleNewsRSS(xml, query) {
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
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const date = pubDate ? new Date(pubDate).toISOString().slice(0, 10) : '';
    const item = {
      title: title || hostOf(link),
      url: link,
      snippet: `${source ? `via Google News · ${source}` : 'via Google News'}${date ? ` · ${date}` : ''}`,
      source: 'google',
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

function parseDDG(html) {
  const out = [];
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = unwrapDDG(m[1]);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if (/duckduckgo\.com\/l\//i.test(href)) continue;
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

function significantTerms(query) {
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

function parseBingRSS(xml, source) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const title = decodeEntities(stripTags(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '')).trim();
    const link = decodeEntities((/<link>([\s\S]*?)<\/link>/i.exec(body)?.[1] ?? '').trim());
    const desc = decodeEntities(stripTags(/<description>([\s\S]*?)<\/description>/i.exec(body)?.[1] ?? '')).trim().slice(0, 300);
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const isReddit = /reddit\.com/i.test(link);
    out.push({
      title: title || hostOf(link),
      url: link,
      snippet: desc,
      source: isReddit ? 'reddit' : source,
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

export function normalizeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    url.hash = '';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'si', 'ref']) {
      url.searchParams.delete(p);
    }
    return url.href.replace(/\/$/, '');
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
