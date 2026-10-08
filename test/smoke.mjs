/** Smoke test — no DSH needed. Exercises the real free backends. */
import { freeSearch } from '../lib/search.js';
import { freeRead } from '../lib/reader.js';

const args = process.argv.slice(2);
const readFlag = args.indexOf('--read');

if (readFlag !== -1) {
  const url = args[readFlag + 1];
  if (!url) {
    console.error('usage: smoke.mjs --read <url>');
    process.exit(2);
  }
  console.log(`[read] ${url}`);
  const r = await freeRead(url, { maxChars: 4000 });
  console.log(`engine=${r.engine} title=${r.title}`);
  console.log('---');
  console.log(r.content.slice(0, 4000));
  process.exit(0);
}

const query = args.join(' ') || 'best android pomodoro apps reddit';
console.log(`[search] ${query}`);
const results = await freeSearch(query, { maxResults: 8, timeoutMs: 15000 });
console.log(`got ${results.length} results`);
for (const r of results) {
  console.log(`- [${r.source}] ${r.title}\n  ${r.url}\n  ${(r.snippet ?? '').slice(0, 140)}`);
}
if (results.length === 0) {
  console.error('SMOKE FAIL: zero results');
  process.exit(1);
}
// Bonus: read the first reddit result if there is one.
const reddit = results.find((r) => /reddit\.com/.test(r.url));
if (reddit) {
  console.log(`\n[read-first-reddit] ${reddit.url}`);
  try {
    const r = await freeRead(reddit.url, { maxChars: 3000 });
    console.log(`engine=${r.engine} title=${r.title}`);
    console.log(r.content.slice(0, 1500));
  } catch (e) {
    console.log(`reddit read failed (acceptable if rate-limited): ${e.message}`);
  }
}
console.log('\nSMOKE OK');
