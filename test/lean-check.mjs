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
} from '../lib/lean.js';
import { normalizeUrl, isOpinionQuery } from '../lib/search.js';
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

console.log(`\nLEAN CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
