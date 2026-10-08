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
import { extractArticle, htmlToText, resolveRedirect, slicePage, extractLinks, linksFromText, orderLinks, findInPage, isSignedUrl, tableToMarkdown, applyLeanView, readViaJina, extractPdfText, pdfToMarkdown } from '../lib/reader.js';
import { deflateSync } from 'node:zlib';
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

// 4. Table: compact markdown (header + separator + rows), cells in order
{
  const { text } = extractArticle(fix('table.html'));
  ok(text.includes('| Model | RAM | Price |'), 'table: header row preserved');
  ok(text.includes('| --- | --- | --- |'), 'table: markdown separator present');
  ok(order(text, '| A17 | 4 GB | 12000 |', '| A57 | 8 GB | 18000 |'), 'table: rows intact in order');
  const wide = `<table><tr>${'<td>x</td>'.repeat(12)}</tr><tr>${'<td>y</td>'.repeat(12)}</tr></table>`;
  ok(tableToMarkdown(wide).split('\n').filter((l) => l.startsWith('|')).every((l) => (l.match(/\|/g) || []).length === 9), 'table: capped at 8 columns');
  const tall = `<table>${'<tr><td>r</td></tr>'.repeat(30)}</table>`;
  ok(tall && tableToMarkdown(tall).split('\n').filter((l) => l.startsWith('|')).length <= 14, 'table: capped at ~13 rows');
  ok(tableToMarkdown('<table><tr></tr></table>') === '', 'table: rowless → empty string');
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

// 12. extractLinks: anchors, resolution, skips, relations, dedupe
{
  const links = extractLinks(fix('links.html'), 'https://docs-example.com/landing');
  const urls = links.map((l) => l.url);
  ok(urls.includes('https://docs-example.com/guide/install'), 'links: relative resolved');
  ok(urls.includes('https://docs-example.com/guide/config'), 'links: absolute kept');
  ok(urls.includes('https://github.com/example/repo'), 'links: external kept');
  ok(urls.filter((u) => u.includes('/guide/install')).length === 1, 'links: duplicate collapsed');
  ok(!urls.some((u) => /mailto|javascript|^.*#top/.test(u)), 'links: fragment/mailto/js skipped');
  const byUrl = Object.fromEntries(links.map((l) => [l.url, l]));
  ok(byUrl['https://docs-example.com/guide/install'].anchor === 'installation guide', 'links: anchor captured');
  ok(byUrl['https://docs-example.com/guide/install'].relation === 'internal', 'links: same host → internal');
  ok(byUrl['https://github.com/example/repo'].relation === 'external', 'links: other host → external');
}

// 13. linksFromText + orderLinks: bare URLs + query ranking
{
  const links = linksFromText('See https://a-example.com/x and https://b-example.com/y.', 'https://a-example.com/start');
  ok(links.length === 2 && links[0].relation === 'internal' && links[1].relation === 'external', 'linksFromText: bare URLs with relations');
  const ranked = orderLinks(
    [
      { anchor: 'unrelated page', url: 'https://z-example.com/other', relation: 'external' },
      { anchor: 'installation guide', url: 'https://docs-example.com/guide/install', relation: 'internal' },
    ],
    'installation steps',
  );
  ok(ranked[0].url.includes('/guide/install'), 'orderLinks: anchor-term match outranks unrelated');
  ok(orderLinks(ranked, '').map((l) => l.url).join(',') === ranked.map((l) => l.url).join(','), 'orderLinks: empty query keeps document order');
}

// 14. findInPage: sections, offsets, cursor paging, case-insensitivity
{
  const { text } = extractArticle(fix('article.html'));
  const all = (text.toLowerCase().match(/edge-to-edge/g) || []).length;
  ok(all >= 2, 'find: fixture has multiple occurrences to page through');
  const first = findInPage(text, 'edge-to-edge', { maxMatches: 1 });
  ok(first.matches.length === 1 && first.matches[0].excerpt.toLowerCase().includes('edge-to-edge'), 'find: offset points at the phrase');
  ok(first.nextCursor !== null && first.nextCursor > first.matches[0].offset, 'find: cursor advances past returned match');
  let cursor = first.nextCursor;
  let total = 1;
  let guard = 0;
  while (cursor !== null && guard++ < 20) {
    const pg = findInPage(text, 'EDGE-TO-EDGE', { cursor, maxMatches: 1 });
    total += pg.matches.length;
    if (pg.matches.length && pg.matches[0].offset < cursor) break; // overlap → fail below
    cursor = pg.nextCursor;
  }
  ok(total === all && cursor === null, `find: cursor pages every occurrence without overlap (${total}/${all})`);
  const none = findInPage(text, 'quantum chromodynamics');
  ok(none.matches.length === 0 && none.nextCursor === null, 'find: no match → empty + null cursor');
  const headed = findInPage('# Alpha\n\nbody one\n\n## Beta section\n\nbody two mentions needle here\n', 'needle');
  ok(headed.matches.length === 1 && headed.matches[0].section === 'Beta section', 'find: nearest preceding heading reported');
}

// 15. applyLeanView: links + find + includeLinks rendering (offline, canned page)
{
  const full = {
    url: 'https://docs-example.com/landing',
    title: 'Docs landing page',
    content: extractArticle(fix('links.html')).text,
    engine: 'html',
    statusCode: 200,
    links: extractLinks(fix('links.html'), 'https://docs-example.com/landing'),
  };
  const lv = applyLeanView(full, { view: 'links', query: 'installation', maxChars: 8000 });
  ok(lv.view === 'links' && lv.content.includes('installation guide — https://docs-example.com/guide/install'), 'view:links renders anchor — URL lines');
  const fv = applyLeanView(full, { find: 'installation', maxChars: 8000 });
  ok(fv.view === 'find' && fv.findMatches >= 1 && fv.content.includes('offset'), 'find view returns matches with offsets');
  ok(fv.nextFindCursor === null || Number.isInteger(fv.nextFindCursor), 'find view carries a cursor (or null when exhausted)');
  const il = applyLeanView({ ...full, content: '# T\n\nBody text here.' }, { view: 'text', maxChars: 8000, includeLinks: true });
  ok(il.content.includes('## Links') && il.content.includes('https://github.com/example/repo'), 'includeLinks appends section to text view');
  const legacy = applyLeanView({ ...full, content: '# T\n\nBody text here.' }, { view: 'text', maxChars: 8000, withLinksSummary: true });
  ok(legacy.content.includes('## Links'), 'withLinksSummary still works as alias');
}

// 16. Jina signed-URL guard: fail closed before any fetch (offline-safe)
{
  for (const bad of [
    'https://files.example.com/r?token=abc',
    'https://files.example.com/r?x=1&sig=abc',
    'https://files.example.com/r?signature=abc',
    'https://files.example.com/r?access_token=abc',
    'https://files.example.com/r?apikey=abc',
    'https://files.example.com/r?API_KEY=abc',
    'https://s3.example.com/f?X-Amz-Signature=abc&X-Amz-Expires=60',
  ]) {
    ok(isSignedUrl(bad), `signed: detected ${bad.slice(24, 40)}…`);
  }
  ok(!isSignedUrl('https://example.com/page?page=2&q=hello'), 'signed: plain query params pass');
  ok(!isSignedUrl('https://example.com/atoken/page'), 'signed: path token (not param) passes');
  try {
    await readViaJina('https://files.example.com/r?token=abc', 1000, undefined, 4000, null);
    fail++;
    console.error('FAIL (proxied signed URL): readViaJina did not refuse');
  } catch (e) {
    ok(/credential-bearing/.test(e.message), 'jina: signed URL refused with guidance, no fetch attempted');
  }
}

// 17. PDF extraction: literal/hex/array/octal text, Flate streams, honest failures
{
  const pdfDoc = (streams, extra = '', count = 1) => {
    const pages = Array.from({ length: count }, (_, i) => `${10 + i} 0 obj\n<</Type /Page /Parent 2 0 R /Contents ${20 + i} 0 R>>\nendobj`).join('\n');
    const contents = streams.map((s, i) => `${20 + i} 0 obj\n<</Length ${s.length}>>\nstream\n${s}\nendstream\nendobj`).join('\n');
    return `%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${10 + i} 0 R`).join(' ')}] /Count ${count}>>\nendobj\n${pages}\n${contents}\n${extra}trailer\n<</Root 1 0 R>>\n`;
  };
  const buf = (s) => Buffer.from(s, 'latin1');
  // Extractor ignores sub-80-char PDFs (scanned-like tripwire) — pad unit streams.
  const filler = ' (Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor) Tj';
  const t1 = extractPdfText(buf(pdfDoc([`BT /F1 12 Tf 72 720 Td (Hello PDF World) Tj${filler} ET`])));
  ok(t1.text.includes('Hello PDF World') && t1.pageCount === 1, 'pdf: literal Tj extracted, page counted');
  const t2 = extractPdfText(buf(pdfDoc([`BT [(Hello) 120 (World)] TJ${filler} ET`])));
  ok(t2.text.includes('Hello World'), 'pdf: TJ array joined');
  const t3 = extractPdfText(buf(pdfDoc([`BT <48656C6C6F> Tj${filler} ET`])));
  ok(t3.text.includes('Hello'), 'pdf: standalone hex Tj decoded');
  const t4 = extractPdfText(buf(pdfDoc(['BT (\\101\\102) Tj (filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler) Tj ET'])));
  ok(t4.text.includes('AB'), 'pdf: octal escapes decoded');
  // FlateDecode stream (binary-safe assembly).
  const flateBody = deflateSync(Buffer.from('BT (Flate Text Here) Tj (filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler) Tj ET', 'latin1'));
  const head = '%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n3 0 obj\n<</Type /Page /Parent 2 0 R /Contents 4 0 R>>\nendobj\n4 0 obj\n<</Length 0 /Filter /FlateDecode>>\nstream\n';
  const tail = '\nendstream\nendobj\ntrailer\n<</Root 1 0 R>>\n';
  const t5 = extractPdfText(Buffer.concat([Buffer.from(head, 'latin1'), flateBody, Buffer.from(tail, 'latin1')]));
  ok(t5.text.includes('Flate Text Here'), 'pdf: FlateDecode stream inflated');
  const longFiller = Array(12).fill('(Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore) Tj').join(' ');
  const t6 = extractPdfText(buf(pdfDoc([`BT (Page one text here and more words to fill) Tj ${longFiller} ET`, `BT (Page two text here and more words to fill) Tj ${longFiller} ET`], '', 2)));
  ok(t6.pageCount === 2, 'pdf: two pages counted');
  const md = pdfToMarkdown('https://example.com/doc.pdf', 'doc.pdf', t6);
  ok(md.engine === 'pdf' && md.content.includes('[p~1/2]') && md.content.includes('[p~2/2]'), 'pdf: markdown carries estimated page markers');
  throws(() => extractPdfText(buf(pdfDoc(['BT (x) Tj ET'], '/Encrypt 5 0 R\n5 0 obj\n<</Filter /Standard>>\nendobj\n'))), 'pdf: encrypted throws honestly');
  throws(() => extractPdfText(buf('just some html, not a pdf')), 'pdf: non-PDF throws honestly');
  throws(() => extractPdfText(buf(pdfDoc(['BT (hi) Tj ET']))), 'pdf: text-less (scanned-like) throws honestly');
}

console.log(`\nREADER CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
