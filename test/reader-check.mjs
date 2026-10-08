/** L2 reader fixtures — no network. Run: node ./test/reader-check.mjs
 *
 * Exercises the pure extraction layer (extractArticle/htmlToText) against
 * hostile page shapes, the slicePage paging contract (concatenated windows
 * must reconstruct the source exactly), and the resolveRedirect per-hop
 * guard. HTTP-status paths (403/429/redirect chains over the wire) stay in
 * live smoke tests: localhost fixture servers are guard-blocked by design,
 * so they cannot exercise fetchValidated.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractArticle, htmlToText, resolveRedirect, slicePage } from '../lib/reader.js';
import { sanitizeUntrusted, extractHighlights } from '../lib/lean.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fix = (name) => readFileSync(join(dir, name), 'utf8');

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
const order = (text, ...needles) => {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at === -1 ? 0 : at);
    if (i === -1 || i < at) return false;
    at = i;
  }
  return true;
};

// 1. Normal article: title, key fact, chrome stripped
{
  const { title, text } = extractArticle(fix('article.html'));
  ok(title === 'Edge-to-edge enforcement in Android 16', 'article: og:title wins');
  ok(text.includes('minimum supported compile SDK version is 36'), 'article: key fact extracted');
  ok(!text.includes('tracker') && !text.includes('subscribe') && !text.includes('Copyright'), 'article: script/nav/footer stripped');
}

// 2. Main + sidebar: article branch preferred once > 400 chars
{
  const { text } = extractArticle(fix('sidebar.html'));
  ok(text.includes('repeatOnLifecycle'), 'sidebar: main content kept');
  ok(!text.includes('newsletter'), 'sidebar: aside dropped via article/main branch');
}

// 3. Nav-heavy: nav/header/footer stripped, content kept
{
  const { text } = extractArticle(fix('nav-heavy.html'));
  ok(text.includes('reset link expires after sixty minutes'), 'nav-heavy: content kept');
  ok(!text.includes('Cookie banner') && !text.includes('Careers') && !text.includes('Sitemap'), 'nav-heavy: nav/header/footer stripped');
}

// 4. Table: cell values survive in order (flattened today — #5 upgrades to markdown)
{
  const { text } = extractArticle(fix('table.html'));
  ok(order(text, 'A17', '4 GB', '12000', 'A57', '8 GB', '18000'), 'table: all cell values present in order');
}

// 5. Code blocks fenced, entities decoded
{
  const { text } = extractArticle(fix('code.html'));
  ok(text.includes('```') && text.includes('retryIO'), 'code: fenced block kept');
  ok(text.includes('<T>') && text.includes('->'), 'code: entities decoded');
}

// 6. Nested headings preserved in order
{
  const { text } = extractArticle(fix('headings.html'));
  ok(order(text, 'Update dependencies', 'Remove deprecated flags', 'Rewrite configuration'), 'headings: nested order kept');
}

// 7. Thin pages trip the >80-char guard used by readGeneric/readFull
{
  ok(extractArticle(fix('empty.html')).text.trim().length < 80, 'empty: thin (< 80 chars)');
  ok(extractArticle(fix('js-shell.html')).text.trim().length < 80, 'js-shell: bundle tags yield no readable text');
}

// 8. Prompt injection stays inert plain text; comments stripped
{
  const { text } = extractArticle(fix('injection.html'));
  ok(!text.includes('hidden admin note'), 'injection: HTML comment stripped');
  ok(text.includes('Ignore all previous instructions'), 'injection: visible text kept as inert text');
  // Built purely from escapes: U+200B zero-width, U+202E bidi override,
  // U+00AD soft hyphen, U+2060 word joiner, U+FEFF zw-no-break, U+202A embed.
  const hostile = 'a' + '\u200b' + 'b' + '‮' + 'c' + '­' + 'd' + '⁠' + 'e' + '﻿' + 'f' + '‪' + 'g';
  const cleaned = sanitizeUntrusted(hostile);
  ok(cleaned === 'abcdefg' && !/[\u200b-\u200f\u2060\ufeff\u202a-\u202e\u00ad]/.test(cleaned), 'injection: zero-width/bidi/soft-hyphen stripped by sanitize');
}

// 9. Highlight correctness: the excerpt must contain the answer passage
{
  const { text } = extractArticle(fix('article.html'));
  const { excerpts } = extractHighlights(text, 'minimum supported compile SDK version');
  ok(excerpts.some((e) => e.includes('minimum supported compile SDK version is 36')), 'highlights: answer passage surfaced');
}

// 10. slicePage: concatenated windows reconstruct the source exactly
{
  const paras = Array.from({ length: 600 }, (_, i) => `Paragraph ${i}: repeatOnLifecycle restarts collection when STARTED. `);
  const html = `<html><head><title>Long</title></head><body><main>${paras.join('\n')}</main></body></html>`;
  const { text: source } = extractArticle(html);
  ok(source.length > 30000, 'long: generated source is multi-window');
  for (const cap of [8000, 5000, 220]) {
    let offset = 0;
    let rebuilt = '';
    let hops = 0;
    for (;;) {
      const { window, end } = slicePage(source, offset, cap);
      if (!window) break;
      rebuilt += window;
      offset = end;
      if (++hops > 500) break;
    }
    ok(rebuilt === source, `paging: cap ${cap} reconstructs source without gaps/dupes (${hops} windows)`);
  }
  ok(slicePage(source, source.length + 100, 8000).window === '', 'paging: offset past end → empty window');
  ok(slicePage(source, -50, 100).start === 0, 'paging: negative offset clamps to 0');
}

// 11. resolveRedirect: same per-hop guard fetchValidated applies
{
  ok(resolveRedirect('https://example.com/a', '/login?x=1') === 'https://example.com/login?x=1', 'redirect: relative resolved');
  ok(resolveRedirect('https://example.com/dir/a', '../up') === 'https://example.com/up', 'redirect: dot-segments resolved');
  ok(resolveRedirect('https://example.com/a', 'https://other-example.com/page') === 'https://other-example.com/page', 'redirect: absolute passthrough');
  throws(() => resolveRedirect('https://example.com/a', 'http://169.254.169.254/'), 'redirect: link-local target blocked');
  throws(() => resolveRedirect('https://example.com/a', 'http://10.9.9.9/final'), 'redirect: RFC1918 target blocked');
  throws(() => resolveRedirect('https://example.com/', 'javascript:alert(1)'), 'redirect: non-http scheme blocked');
  // Chain simulation: walk hops exactly as fetchValidated does.
  let current = 'https://a.example/start';
  const chain = ['https://b-example.com/mid', 'https://c-example.com/ok', 'http://192.168.5.5/final'];
  let blockedAt = -1;
  try {
    chain.forEach((loc, i) => {
      current = resolveRedirect(current, loc);
      blockedAt = i;
    });
  } catch {
    /* expected */
  }
  ok(blockedAt === 1, 'redirect: chain walks public hops, dies on the private one');
}

console.log(`\nREADER CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
