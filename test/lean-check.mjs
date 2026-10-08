/** Offline lean checks — no network. Run: node ./test/lean-check.mjs
 * Covers the pure helpers that break most often (URL canonicalization, rank
 * fusion, recency, sanitization, SSRF guard), so parser/refactor regressions
 * fail here instead of flaking in live-network CI.
 */
import {
  sanitizeUntrusted,
  wrapUntrusted,
  fuseRRF,
  filterRecency,
  toISODate,
  extractHighlights,
  classifySourceType,
  classifyIntent,
  parseIntentOverride,
  resolveIntent,
  selectSpecials,
} from '../lib/lean.js';
import {
  normalizeUrl,
  isOpinionQuery,
  parseDDG,
  parseBingRSS,
  parseGoogleNewsRSS,
  recallGoogleNews,
  matchesQuery,
  significantTerms,
  rankPipeline,
  parseAlternatives,
  resolveRecency,
  partitionDatedFirst,
  parseSearxng,
  freeSearch,
} from '../lib/search.js';
import { assertPublicUrl, pageCacheKey } from '../lib/reader.js';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}`);
  }
}
function throws(fn, name) {
  try {
    fn();
  } catch {
    pass++;
    return;
  }
  fail++;
  console.error(`FAIL (did not throw): ${name}`);
}

// 1. normalizeUrl merging
const k1 = normalizeUrl('https://www.example.com/a?utm_source=x&fbclid=abc');
const k2 = normalizeUrl('http://example.com/a?gclid=123');
const k3 = normalizeUrl('https://example.com/a/');
const k4 = normalizeUrl('https://example.com/a/amp');
const k5 = normalizeUrl('https://example.com/a?amp=1');
ok(k1 && k1 === k2 && k2 === k3, 'tracking params + www + http/https merge');
ok(k3 === k4 && k4 === k5, 'AMP variants merge');
ok(normalizeUrl('https://example.com/a') !== normalizeUrl('https://example.com/b'), 'distinct paths stay distinct');
ok(normalizeUrl('ftp://example.com/a') === '', 'non-http rejected');
ok(normalizeUrl('https://example.com/réd?si=xyz').length > 0, 'unicode path survives');

// 2. fuseRRF: agreement beats single-engine rank
const fused = fuseRRF([
  { name: 'ddg', items: [{ url: 'https://a.example/', title: 'A', snippet: 'short' }, { url: 'https://b.example/', title: 'B', snippet: 'x'.repeat(50) }] },
  { name: 'bing', items: [{ url: 'https://b.example/', title: 'B alt', snippet: 'x'.repeat(200) }] },
]);
ok(fused[0].url === 'https://b.example/', 'URL in two engines ranks first');
ok(fused[0]._sources.includes('ddg') && fused[0]._sources.includes('bing'), 'sources recorded');
ok(fused[0].snippet.length === 200, 'longest snippet wins');
ok(typeof fused[0]._rrf === 'number', '_rrf attached');

// 3. filterRecency (fixed now = 2026-10-08)
const NOW = Date.parse('2026-10-08T00:00:00Z');
const items = [
  { url: 'https://n1/', publishedDate: '2026-10-07' },
  { url: 'https://n2/', publishedDate: '2026-01-01' },
  { url: 'https://n3/' },
  { url: 'https://n4/', publishedDate: 'garbage' },
];
ok(filterRecency(items, 'week', NOW).map((r) => r.url).join(',') === 'https://n1/,https://n3/,https://n4/', 'week keeps fresh + undated + unparsable, drops old');
ok(filterRecency(items, 'all', NOW).length === 4, 'all keeps everything');
ok(toISODate(1727827200) === '2024-10-02', 'unix → ISO date');
ok(toISODate('2026-10-05T14:00:00Z') === '2026-10-05', 'ISO datetime → date');
ok(toISODate('nope') === null, 'garbage → null');

// 4. sanitizeUntrusted
ok(sanitizeUntrusted('a<!-- hidden -->b') === 'a b', 'HTML comments stripped');
ok(sanitizeUntrusted('a​b‮c') === 'abc', 'zero-width + bidi overrides stripped');
ok(sanitizeUntrusted('ポモドーロ・テクニックは時間管理術です') === 'ポモドーロ・テクニックは時間管理術です', 'CJK untouched');
ok(wrapUntrusted('hi').includes('START') && wrapUntrusted('hi').includes('END'), 'delimiters both sides');

// 5. SSRF guard
for (const bad of [
  'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.20.5.5/', 'http://127.0.0.1/',
  'http://0.0.0.0/', 'http://100.64.0.1/', 'http://169.254.169.254/', 'http://localhost/',
  'http://foo.local/', 'http://foo.internal/', 'http://[::1]/', 'http://[fe80::1]/',
  'http://[fc00::1]/', 'http://[ff02::1]/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/',
  'http://2130706433/', 'http://intranet/',
]) {
  throws(() => assertPublicUrl(bad), `blocked ${bad}`);
}
for (const good of ['https://example.com/', 'https://en.wikipedia.org/wiki/X', 'http://8.8.8.8/', 'https://1.1.1.1/']) {
  try {
    assertPublicUrl(good);
    pass++;
  } catch {
    fail++;
    console.error(`FAIL (wrongly blocked): ${good}`);
  }
}

// 6. pageCacheKey
ok(pageCacheKey('https://www.example.com/a?utm_source=x') === pageCacheKey('http://example.com/a'), 'cache key merges www/http/tracking');

// 7. opinion detection
ok(isOpinionQuery('best android pomodoro apps?') === true, 'best + ? is opinion');
ok(isOpinionQuery('how to focus with adhd') === true, 'how to is opinion');
ok(isOpinionQuery('capital of france') === false, 'factual is not opinion');

// 8. highlights fallback (tables/lists/numbers: thin term hits → lead section)
const { excerpts } = extractHighlights('| a | b |\n| 1 | 2 |\nSome intro sentence here about timers.', 'quantum chromodynamics');
ok(excerpts.length > 0 && excerpts[0].length > 0, 'thin hits fall back to lead');

// 9. parseDDG: normal / redirect-unwrap / ad-drop / zero / malformed
const DDG_HTML = `<html><body>
<div class="result"><a class="result__a" href="https://example.com/guide">Example Guide &amp; Tips</a><a class="result__snippet" href="https://example.com/guide">A useful guide snippet here.</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freal&amp;rut=abc">Wrapped Result</a><a class="result__snippet" href="https://example.com/real">Redirect-wrapped link.</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored junk</a><a class="result__snippet" href="https://ads.example/">Buy now.</a></div>
<div class="result"><a class="result__a" href="https://nosnip.example/">No Snippet Page</a></div>
</body></html>`;
const ddg = parseDDG(DDG_HTML);
ok(ddg.length === 3, 'DDG parses 3 results (ad click-link dropped)');
ok(ddg[0].url === 'https://example.com/guide' && ddg[0].title === 'Example Guide & Tips', 'DDG title entities decoded');
ok(ddg[0].snippet === 'A useful guide snippet here.', 'DDG snippet captured');
ok(ddg[1].url === 'https://example.com/real', 'DDG //l/?uddg= redirect unwrapped');
ok(ddg[2].url === 'https://nosnip.example/' && ddg[2].snippet === '', 'missing snippet → empty string, not crash');
ok(parseDDG('<html><body>no results here</body></html>').length === 0, 'DDG zero results → []');
ok(parseDDG('<<<not html>>>').length === 0, 'DDG malformed HTML → []');
ok(parseDDG('<a class="result__a" href="https://uni.example/caf%C3%A9">Caf&#233; &#x2615;</a>').length === 1, 'DDG unicode/numeric entities survive');

// 10. parseBingRSS: normal / skip non-http / malformed / bad date
const BING_XML = `<rss><channel>
<item><title>Example A</title><link>https://example.com/a</link><description>Desc A</description><pubDate>Mon, 06 Oct 2026 12:00:00 GMT</pubDate></item>
<item><title>FTP junk</title><link>ftp://example.com/f</link><description>x</description></item>
<item><title>No date</title><link>https://example.com/b</link><description>Desc B</description><pubDate>garbage</pubDate></item>
</channel></rss>`;
const bing = parseBingRSS(BING_XML, 'web');
ok(bing.length === 2, 'Bing RSS drops non-http link');
ok(bing[0].publishedDate === '2026-10-06', 'Bing pubDate → ISO date');
ok(bing[1].publishedDate === null, 'Bing garbage date → null (kept, not dropped)');
ok(parseBingRSS('<rss><channel></channel></rss>', 'web').length === 0, 'Bing zero items → []');
ok(parseBingRSS('this is not xml', 'web').length === 0, 'Bing malformed XML → []');

// 11. parseGoogleNewsRSS: headline split + publisher memory round-trip
const NEWS_XML = `<rss><channel><item>
<title>City opens new metro line - ExampleNews</title>
<link>https://news.google.com/articles/CBMiXmh0dHBzOi8vZXhhbXBsZS5jb20vbWV0cm8</link>
<pubDate>Tue, 07 Oct 2026 08:00:00 GMT</pubDate>
<source url="https://example.com">ExampleNews</source>
</item></channel></rss>`;
const news = parseGoogleNewsRSS(NEWS_XML, 'City opens new metro line');
ok(news.length === 1, 'News RSS parses gated item');
ok(news[0].publishedDate === '2026-10-07', 'News pubDate → ISO date');
ok(news[0].snippet.includes('ExampleNews'), 'News snippet names publisher');
const remembered = recallGoogleNews(news[0].url);
ok(remembered?.headline === 'City opens new metro line' && remembered?.publisher === 'ExampleNews', 'headline split + publisher remembered for reader bridge');
ok(parseGoogleNewsRSS(NEWS_XML, 'quantum chromodynamics').length === 0, 'News relevance gate drops off-topic item');

// 12. canonicalization matrix: 20 variants collapse, near-misses stay distinct
const canonBase = normalizeUrl('https://example.com/a?x=1');
const mustMerge = [
  'https://example.com/a?x=1',
  'http://example.com/a?x=1',
  'https://www.example.com/a?x=1',
  'https://example.com/a/?x=1',
  'https://EXAMPLE.COM/a?x=1',
  'https://example.com/a?x=1#section',
  'https://example.com/a?x=1&utm_source=news&utm_medium=social',
  'https://example.com/a?x=1&fbclid=abc&gclid=123&msclkid=zzz&si=q',
  'https://example.com/a?x=1&utm_source=n&ref=r',
  'https://example.com/amp/../a?x=1',
  'https://example.com/a/amp?x=1',
  'https://example.com/a?x=1&amp=1',
  'https://example.com/a?x=1&output=1',
];
ok(mustMerge.every((u) => normalizeUrl(u) === canonBase), '13 URL variants (scheme/www/case/slash/hash/tracking/amp) merge');
const mustSplit = [
  ['https://example.com/a?x=1', 'https://example.com/a?x=2'],
  ['https://example.com/a', 'https://example.com/b'],
  ['https://example.com/a', 'https://blog.example.com/a'],
  ['https://example.com/a', 'https://example.com:8080/a'],
  ['https://example.com/a?page=2', 'https://example.com/a?page=3'],
];
ok(mustSplit.every(([a, b]) => normalizeUrl(a) !== normalizeUrl(b)), '5 near-misses (query/path/subdomain/port/pagination) stay distinct');

// 13. rankPipeline fixtures: agreement wins, unrelated sinks
const TECH_SETTLED = [
  {
    name: 'ddg',
    items: [
      { url: 'https://developer.example.com/stateflow', title: 'StateFlow lifecycle collection guide', snippet: 'Collect StateFlow with repeatOnLifecycle.', source: 'web' },
      { url: 'https://seo.example.net/top-10', title: 'TOP 10 BEST StateFlow tricks 2026!!!', snippet: 'Number 7 will shock you.', source: 'web' },
      { url: 'https://unrelated.example.org/cats', title: 'Cats', snippet: 'All about cats.', source: 'web' },
    ],
  },
  {
    name: 'stackoverflow',
    items: [{ url: 'https://stackoverflow.com/questions/123', title: 'How to collect StateFlow with lifecycle?', snippet: 'Use repeatOnLifecycle in your UI layer.', source: 'stackoverflow' }],
  },
  {
    name: 'bing',
    items: [{ url: 'https://developer.example.com/stateflow?utm_source=x', title: 'StateFlow lifecycle collection guide', snippet: 'A longer duplicate snippet that should win the merge and carry the date.', source: 'web', publishedDate: '2026-09-01' }],
  },
];
const tech = rankPipeline(TECH_SETTLED, 'Kotlin StateFlow lifecycle collection', { maxResults: 8 });
ok(tech[0].url.includes('developer.example.com/stateflow'), 'pipeline: two-engine agreement ranks first');
ok(tech[0].snippet.length > 50 && tech[0].publishedDate === '2026-09-01', 'pipeline: longest snippet + date survive the merge');
ok(tech[tech.length - 1].url.includes('/cats'), 'pipeline: term-less result sinks last');
ok(tech.filter((r) => r.url.includes('developer.example.com')).length === 1, 'pipeline: tracking-param duplicate merged');
// 13b. provenance shape (#4): counts + domain + type + retrieval date, no internals
ok(tech[0].providerCount === 2 && tech[0].independentHostCount === 1, 'provenance: same-host two-engine hit counts providers, not hosts');
ok(tech[0].domain === 'developer.example.com' && tech[0].sourceType === 'official-docs', 'provenance: domain + coarse source type');
ok(JSON.stringify(tech[0].providers) === JSON.stringify(['ddg', 'bing']), 'provenance: serving backends recorded');
ok(/^\d{4}-\d{2}-\d{2}$/.test(tech[0].retrievedAt), 'provenance: retrieval date stamped');
ok(!('_key' in tech[0] || '_rrf' in tech[0] || '_sources' in tech[0] || '_hosts' in tech[0]), 'provenance: fusion internals not leaked');
// 13c. source taxonomy spot-checks
ok(classifySourceType('https://developer.android.com/x', 'web') === 'official-docs', 'taxonomy: developer.* docs');
ok(classifySourceType('https://docs.python.org/3/', 'ddg') === 'official-docs', 'taxonomy: docs.* host');
ok(classifySourceType('https://en.wikipedia.org/wiki/X', 'wikipedia') === 'reference', 'taxonomy: wikipedia');
ok(classifySourceType('https://www.reddit.com/r/x/comments/1/', 'reddit') === 'community', 'taxonomy: reddit');
ok(classifySourceType('https://stackoverflow.com/questions/1', 'stackoverflow') === 'community', 'taxonomy: stackoverflow');
ok(classifySourceType('https://news.ycombinator.com/item?id=1', 'hn') === 'community', 'taxonomy: HN');
ok(classifySourceType('https://news.google.com/articles/ABC', 'google') === 'aggregator', 'taxonomy: google-news redirect');
ok(classifySourceType('https://www.reuters.com/world/x', 'web') === 'news', 'taxonomy: wire news host');
ok(classifySourceType('https://random-blog.example.net/post', 'ddg') === 'unknown', 'taxonomy: unknown blog stays unknown');
ok(classifySourceType('not a url', 'web') === 'unknown', 'taxonomy: unparseable stays unknown');
const OPINION_SETTLED = [
  {
    name: 'ddg',
    items: [
      { url: 'https://seo.example.net/best-10', title: 'TOP 10 BEST pomodoro apps 2026', snippet: 'Buy our course.', source: 'web' },
      { url: 'https://www.reddit.com/r/android/comments/abc', title: 'What pomodoro app actually works for ADHD? (android)', snippet: 'I tried five android pomodoro timers, here is what stuck.', source: 'reddit' },
    ],
  },
];
const opinion = rankPipeline(OPINION_SETTLED, 'best android pomodoro apps', { maxResults: 5 });
ok(opinion[0].url.includes('reddit.com'), 'pipeline: opinion query ranks lived-experience Reddit above SEO list');
const raw = rankPipeline(TECH_SETTLED, 'Kotlin StateFlow lifecycle collection', { maxResults: 8, rerank: false });
ok(Array.isArray(raw) && raw.length > 0, 'pipeline: rerank:false interleave still returns results');

// 14. query-term helpers: site/strip, caps, stopwords
ok(JSON.stringify(significantTerms('site:reddit.com best android pomodoro r/focus')) === JSON.stringify(['android', 'pomodoro']), 'significantTerms strips site:/r/ tokens + stopwords');
ok(significantTerms('a b c d e f g h i j k l m n').length <= 8, 'significantTerms capped at 8');
ok(matchesQuery({ title: 'Android timers', snippet: '', url: 'https://x.example/' }, 'android pomodoro') === true, 'matchesQuery: one shared term suffices');
ok(matchesQuery({ title: 'BEST Definition & Meaning', snippet: 'dictionary', url: 'https://d.example/' }, 'best android pomodoro apps') === false, 'matchesQuery: dictionary junk rejected');

// 15. #3: alternatives parsing, recency:auto, dated-first, multi-variant fusion
ok(JSON.stringify(parseAlternatives('b\nc', 'a')) === JSON.stringify(['b', 'c']), 'alternatives: newline split');
ok(JSON.stringify(parseAlternatives('  b  \n\nc\r\n', 'a')) === JSON.stringify(['b', 'c']), 'alternatives: trims, drops blanks, handles CRLF');
ok(JSON.stringify(parseAlternatives('Q\nq \nQ\nx', 'Q')) === JSON.stringify(['x']), 'alternatives: primary + case-dupes dropped');
ok(JSON.stringify(parseAlternatives('q\n1\n2\n3\n4', 'q')).length > 0, 'alternatives: 4 distinct pass');
throws(() => parseAlternatives('1\n2\n3\n4\n5', 'q'), 'alternatives: 5th distinct variant throws');
ok(resolveRecency('auto', 'latest Android Studio version 2026') === 'week', 'recency:auto latest → week (before year)');
ok(resolveRecency('auto', 'today bitcoin price') === 'day', 'recency:auto today → day');
ok(resolveRecency('auto', 'Android 16 release date') === 'month', 'recency:auto release → month');
ok(resolveRecency('auto', 'bitcoin price') === 'month', 'recency:auto price → month');
ok(resolveRecency('auto', 'capital of France') === 'all', 'recency:auto factual → all');
ok(resolveRecency('auto', 'photos from 2019') === 'year', 'recency:auto year → year');
ok(resolveRecency('week', 'capital of France') === 'week', 'recency: explicit window respected');
ok(resolveRecency('bogus', 'latest phones') === 'week', 'recency: unknown value falls back to detection, never throws');
{
  const mixed = [{ url: 'https://u1/', title: 'U1' }, { url: 'https://d1/', title: 'D1', publishedDate: '2026-10-01' }, { url: 'https://u2/', title: 'U2', publishedDate: 'junk' }, { url: 'https://d2/', title: 'D2', publishedDate: '2026-10-02' }];
  const part = partitionDatedFirst(mixed);
  ok(part.map((r) => r.url).join(',') === 'https://d1/,https://d2/,https://u1/,https://u2/', 'dated-first: stable partition, garbage date counts as unknown');
}
{
  const today = new Date().toISOString().slice(0, 10);
  const settled = [{
    name: 'ddg',
    items: [
      { url: 'https://strong.example.com/guide', title: 'Kotlin StateFlow lifecycle collection complete guide', snippet: 'everything about StateFlow lifecycle collection', source: 'web' },
      { url: 'https://fresh.example.com/notes', title: 'StateFlow notes', snippet: 'short notes', source: 'web', publishedDate: today },
    ],
  }];
  const lex = rankPipeline(settled, 'Kotlin StateFlow lifecycle collection', { maxResults: 5, recency: 'all' });
  const win = rankPipeline(settled, 'Kotlin StateFlow lifecycle collection', { maxResults: 5, recency: 'week' });
  ok(lex[0].url.includes('strong.example.com'), 'recency:all keeps lexical order (strong undated first)');
  ok(win[0].url.includes('fresh.example.com'), 'recency:week lifts confirmed-fresh above date-unknown');
}
{
  // Multi-variant fusion through the injected-backend seam (offline).
  const seen = [];
  const { results: r, meta } = await freeSearch('stateflow lifecycle', {
    maxResults: 6,
    timeoutMs: 1000,
    rerank: true,
    recency: 'all',
    alternatives: 'StateFlow repeatOnLifecycle\nkotlin flow collect',
    backends: (v) => {
      seen.push(v);
      const item = (url, title, snippet) => ({ url, title, snippet, source: 'ddg' });
      if (/repeatOnLifecycle/i.test(v)) {
        return [{ name: 'fake-n3a', run: async () => [item('https://shared.example.com/s', 'StateFlow lifecycle collection', 'repeatOnLifecycle guide'), item('https://unique-a.example.com/', 'repeatOnLifecycle reference', 'API reference for repeatOnLifecycle')] }];
      }
      if (/kotlin flow/i.test(v)) {
        return [{ name: 'fake-n3a', run: async () => [item('https://shared.example.com/s', 'StateFlow lifecycle collection', 'kotlin flow collection guide'), item('https://unique-b.example.com/', 'Kotlin flow collection patterns', 'flow collection patterns')] }];
      }
      return [{ name: 'fake-n3a', run: async () => [item('https://shared.example.com/s', 'StateFlow lifecycle collection', 'primary query hit')] }];
    },
  });
  ok(seen.length === 3 && seen[0] === 'stateflow lifecycle', 'fusion: primary + 2 variants all searched');
  ok(r.length === 3, 'fusion: union deduplicated to 3 unique URLs');
  ok(r[0].url.includes('shared.example.com'), 'fusion: URL found by all variants ranks first');
  ok(meta.partial === false && meta.unavailable === false && meta.variants.length === 3, 'fusion: meta reports healthy 3-variant search');
  ok(JSON.stringify(meta.providersSucceeded) === JSON.stringify(['fake-n3a']), 'fusion: meta names the serving backend');
  ok(meta.intent === 'technical', 'fusion: meta reports primary-query intent');

// 17. #7: SearXNG JSON mapper
{
  const sear = parseSearxng({
    results: [
      { title: 'Example Guide', url: 'https://example.com/guide', content: 'A guide snippet here.' },
      { title: '', url: 'https://notitle.example/', content: 'No title here.' },
      { title: 'FTP', url: 'ftp://example.com/f', content: 'skip me' },
      { title: 'No URL', content: 'skip me' },
    ],
  }, 8);
  ok(sear.length === 2, 'searxng: non-http + missing URLs dropped');
  ok(sear[0].source === 'searxng' && sear[0].title === 'Example Guide', 'searxng: fields mapped');
  ok(sear[1].title === 'notitle.example', 'searxng: missing title falls back to host');
  ok(parseSearxng(null).length === 0 && parseSearxng({ results: [] }).length === 0, 'searxng: null/empty → []');
}

// 16. #6: intent classification, resolution, specials routing, intent-aware priors
{
  const cases = [
    ['best android pomodoro apps', 'opinion'],
    ['A17 vs A57 specs price', 'opinion'],
    ['is Obsidian better than Notion for notes', 'opinion'],
    ['how do I focus with ADHD programming', 'opinion'],
    ['should i buy a mechanical keyboard', 'opinion'],
    ['latest Android Studio version 2026', 'current'],
    ['today bitcoin price', 'current'],
    ['Android 16 release date', 'current'],
    ['Node EADDRINUSE port already in use fix', 'technical'],
    ['how to reset your password', 'technical'],
    ['Kotlin StateFlow lifecycle collection', 'technical'],
    ['stateflow lifecycle', 'technical'],
    ['Android 16 edge-to-edge enforcement', 'technical'],
    ['Python asyncio gather vs TaskGroup', 'opinion'], // vs beats code words
    ['capital of France', 'factual'],
    ['how tall is Mount Everest', 'factual'],
    ['photosynthesis chemical equation', 'factual'],
    ['study on spaced repetition effectiveness', 'research'],
    ['attention is all you need transformer paper', 'research'],
    ['arxiv paper on transformers', 'academic'],
    ['xyzzy plugh nonsense', 'generic'],
    ['', 'generic'],
  ];
  for (const [q, want] of cases) {
    ok(classifyIntent(q) === want, `intent: "${q.slice(0, 40)}" → ${want}`);
  }
  ok(resolveIntent('technical', 'auto', 'best phones') === 'technical', 'resolve: explicit intent wins');
  ok(resolveIntent('auto', 'forums', 'quiet query') === 'opinion', 'resolve: scope maps to intent');
  ok(resolveIntent('auto', 'web', 'best phones') === 'generic', 'resolve: scope web → generic');
  ok(resolveIntent('auto', 'auto', 'capital of France') === 'factual', 'resolve: auto classifies');
  ok(resolveIntent('bogus', 'bogus', 'xyzzy') === 'generic', 'resolve: double-unknown falls back, never throws');
  ok(parseIntentOverride('auto', 'auto') === null, 'override: auto/auto → null (classify)');
  const specs = {
    factual: { wikipedia: true, hn: false, stackoverflow: false },
    technical: { wikipedia: false, hn: true, stackoverflow: true },
    opinion: { wikipedia: false, hn: true, stackoverflow: false },
    research: { wikipedia: true, hn: false, stackoverflow: true },
    academic: { wikipedia: true, hn: false, stackoverflow: false },
    current: { wikipedia: false, hn: false, stackoverflow: false },
    generic: { wikipedia: false, hn: false, stackoverflow: false },
  };
  for (const [intent, want] of Object.entries(specs)) {
    ok(JSON.stringify(selectSpecials(intent)) === JSON.stringify(want), `routing: ${intent} → correct specials`);
  }
  const DUEL = [
    { name: 'stackoverflow', items: [{ url: 'https://stackoverflow.com/questions/1', title: 'Docker build fails on Apple silicon', snippet: 'docker build fails with platform error', source: 'stackoverflow' }] },
    { name: 'reddit-pass', items: [{ url: 'https://www.reddit.com/r/docker/comments/1', title: 'Docker build fails on Apple silicon, my experience', snippet: 'my docker build experience on Apple silicon', source: 'reddit' }] },
  ];
  const techTop = rankPipeline(DUEL, 'docker build fails on Apple silicon', { maxResults: 5, intent: 'technical' });
  const opinTop = rankPipeline(DUEL, 'docker build fails on Apple silicon', { maxResults: 5, intent: 'opinion' });
  ok(techTop[0].url.includes('stackoverflow.com'), 'prior: technical lifts SO above forum twin');
  ok(opinTop[0].url.includes('reddit.com'), 'prior: opinion lifts lived experience above SO twin');
  // Lexically tied twins: only the intent prior may break the tie (blog listed first).
  const FACT = [
    { name: 'ddg', items: [{ url: 'https://blog-example.com/paris', title: 'Capital of France facts', snippet: 'facts about the capital of France', source: 'web' }] },
    { name: 'wikipedia', items: [{ url: 'https://en.wikipedia.org/wiki/Paris', title: 'Capital of France facts', snippet: 'facts about the capital of France', source: 'wikipedia' }] },
  ];
  const factualTop = rankPipeline(FACT, 'capital of France', { maxResults: 5 });
  const genericTop = rankPipeline(FACT, 'capital of France', { maxResults: 5, intent: 'generic' });
  ok(factualTop[0].url.includes('wikipedia.org'), 'prior: auto-classified factual lifts reference above blog twin');
  ok(genericTop[0].url.includes('blog-example.com'), 'prior: generic keeps stable order (no prior applied)');
}
}

console.log(`\nLEAN CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
