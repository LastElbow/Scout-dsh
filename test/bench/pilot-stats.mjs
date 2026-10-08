/** Pilot stats — no network. Run: node ./test/bench/pilot-stats.mjs <results.json>
 *
 * Input: [{ id, cat, A:{ac,cc,cg}, B:{...}, C:{...} }] with judge scores
 * 0/0.5/1 (ac=answer_correct, cc=citation_complete, cg=citation_grounded).
 * success = ac >= 0.5. Prints per-arm rates (Wilson 95% CI), paired
 * McNemar exact p for A-vs-each, bootstrap 95% CI for the success-rate
 * difference, and a per-category table. Dependency-free.
 */
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ARMS = ['A', 'B', 'C'];
const ok = (r, a) => (r[a]?.ac ?? 0) >= 0.5;

function wilson(x, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

// McNemar exact (binomial) two-sided p for paired binary outcomes.
function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0;
  const comb = (N, K) => {
    let r = 1;
    for (let i = 0; i < K; i++) r = (r * (N - i)) / (i + 1);
    return r;
  };
  for (let i = 0; i <= k; i++) p += comb(n, i) / 2 ** n;
  return Math.min(1, 2 * p);
}

function bootstrapDiff(xs, ys, iters = 5000) {
  const n = xs.length;
  const diffs = [];
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < iters; i++) {
    let dx = 0;
    let dy = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rnd() * n);
      dx += xs[k];
      dy += ys[k];
    }
    diffs.push(dx / n - dy / n);
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.025 * iters)], diffs[Math.floor(0.975 * iters)]];
}

const f = (x) => (x * 100).toFixed(1) + '%';
console.log(`n=${rows.length} tasks`);
for (const a of ARMS) {
  const s = rows.map((r) => (ok(r, a) ? 1 : 0));
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const [lo, hi] = wilson(s.reduce((x, y) => x + y, 0), s.length);
  const cc = rows.reduce((x, r) => x + (r[a]?.cc ?? 0), 0) / rows.length;
  const cg = rows.reduce((x, r) => x + (r[a]?.cg ?? 0), 0) / rows.length;
  console.log(`arm ${a}: success ${f(mean)} [${f(lo)}, ${f(hi)}]  cite_complete ${f(cc)}  cite_grounded ${f(cg)}`);
}
for (const other of ['B', 'C']) {
  const xs = rows.map((r) => (ok(r, 'A') ? 1 : 0));
  const ys = rows.map((r) => (ok(r, other) ? 1 : 0));
  let b = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === 1 && ys[i] === 0) b++;
    if (xs[i] === 0 && ys[i] === 1) c++;
  }
  const diff = xs.reduce((x, y) => x + y, 0) / xs.length - ys.reduce((x, y) => x + y, 0) / ys.length;
  const [blo, bhi] = bootstrapDiff(xs, ys);
  console.log(`A-vs-${other}: diff ${(diff * 100).toFixed(1)}pp [${(blo * 100).toFixed(1)}, ${(bhi * 100).toFixed(1)}]  McNemar p=${mcnemar(b, c).toFixed(3)} (discordant A-only=${b}, ${other}-only=${c})`);
}
const cats = [...new Set(rows.map((r) => r.cat))];
console.log('per-category success (A/B/C):');
for (const cat of cats) {
  const sub = rows.filter((r) => r.cat === cat);
  const rates = ARMS.map((a) => f(sub.filter((r) => ok(r, a)).length / sub.length));
  console.log(`  ${cat} (n=${sub.length}): ${rates.join(' / ')}`);
}
