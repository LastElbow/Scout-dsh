/** Pilot chart — no network. Run: node ./test/bench/pilot-chart.mjs
 * Reads pilot-rows.json, recomputes per-category + overall success, writes
 * docs/pilot-chart.svg (white card: readable in light and dark mode).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./pilot-rows.json', import.meta.url)));
const ARMS = [
  { key: 'A', label: 'A · full Scout', color: '#15803d' },
  { key: 'B', label: 'B · rerank off', color: '#b45309' },
  { key: 'C', label: 'C · generic intent', color: '#1d4ed8' },
];
const ok = (r, a) => (r[a]?.ac ?? 0) >= 0.5 ? 1 : 0;

function wilson(x, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const cats = ['overall', ...[...new Set(rows.map((r) => r.cat))]];
const data = cats.map((cat) => {
  const sub = cat === 'overall' ? rows : rows.filter((r) => r.cat === cat);
  return {
    cat,
    n: sub.length,
    arms: ARMS.map(({ key }) => {
      const wins = sub.reduce((s, r) => s + ok(r, key), 0);
      const [lo, hi] = wilson(wins, sub.length);
      return { key, rate: wins / sub.length, lo, hi };
    }),
  };
});

// Layout (px): label col | bar area (0-100%) | value labels.
const W = 860;
const X0 = 190;
const BARW = 520;
const ROWH = 30;
const GAP = 18;
const TOP = 122;
const FOOT = 76;
const H = TOP + data.length * (ROWH + GAP) + FOOT;
const barX = (v) => X0 + (v * BARW) / 100;

let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="Pilot benchmark results">`;
s += `<rect width="${W}" height="${H}" rx="12" fill="#ffffff"/>`;
s += `<text x="24" y="34" font-family="sans-serif" font-size="20" font-weight="bold" fill="#111111">Pilot benchmark: questions answered correctly</text>`;
s += `<text x="24" y="58" font-family="sans-serif" font-size="13" fill="#555555">Same 40 questions to each version · same model · graders didn't know which version answered</text>`;
// Legend on its own row.
ARMS.forEach(({ label, color }, i) => {
  const x = 24 + i * 220;
  s += `<rect x="${x}" y="70" width="14" height="14" rx="3" fill="${color}"/><text x="${x + 19}" y="82" font-family="sans-serif" font-size="12" fill="#333333">${label}</text>`;
});
data.forEach((row, ri) => {
  const y = TOP + ri * (ROWH + GAP);
  const bold = row.cat === 'overall';
  s += `<text x="24" y="${y + 20}" font-family="sans-serif" font-size="13" font-weight="${bold ? 'bold' : 'normal'}" fill="#111111">${row.cat} (n=${row.n})</text>`;
  row.arms.forEach(({ key, rate, lo, hi }, ai) => {
    const bh = ROWH / 3 - 2;
    const by = y + ai * (ROWH / 3);
    const w = Math.max(2, rate * BARW);
    const color = ARMS[ai].color;
    s += `<rect x="${X0}" y="${by}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}" opacity="${bold ? 1 : 0.85}"/>`;
    s += `<text x="${(X0 + w + 6).toFixed(1)}" y="${(by + bh - 1).toFixed(1)}" font-family="sans-serif" font-size="11" fill="#333333">${(rate * 100).toFixed(1).replace(/\.0$/, '')}%</text>`;
    if (bold) {
      // 95% Wilson CI whisker.
      const x1 = barX(lo * 100);
      const x2 = barX(hi * 100);
      const cy = by + bh / 2;
      s += `<line x1="${x1.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#111111" stroke-width="1.5"/>`;
      s += `<line x1="${x1.toFixed(1)}" y1="${(cy - 3).toFixed(1)}" x2="${x1.toFixed(1)}" y2="${(cy + 3).toFixed(1)}" stroke="#111111" stroke-width="1.5"/>`;
      s += `<line x1="${x2.toFixed(1)}" y1="${(cy - 3).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${(cy + 3).toFixed(1)}" stroke="#111111" stroke-width="1.5"/>`;
    }
  });
});
const fy = H - FOOT + 18;
s += `<text x="24" y="${fy}" font-family="sans-serif" font-size="12" fill="#555555">Overall: A 90.0% · B 85.0% · C 87.5%. A−B: +5.0pp, 95% CI [−5, 15], p=0.63 — could be luck at this size.</text>`;
s += `<text x="24" y="${fy + 20}" font-family="sans-serif" font-size="12" fill="#555555">Black whiskers on the top row show the 95% uncertainty range. Full 250-question study tracked in issue #10.</text>`;
s += `</svg>`;

const out = new URL('../../docs/pilot-chart.svg', import.meta.url);
writeFileSync(out, s);
console.log(`wrote ${out.pathname} (${W}x${H})`);
