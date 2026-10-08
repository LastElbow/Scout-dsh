/** L5 starter: frozen ranking bench — no network. Run: node ./test/ranking-bench.mjs
 *
 * 30 queries with canned multi-backend hits and graded gold URLs. Runs the
 * real rankPipeline (fusion + rerank + filters + trim) and reports Recall@5,
 * Recall@10, MRR, and nDCG@10 for rerank:true vs the rerank:false
 * interleave baseline. This measures the RANKING layer only: backend
 * retrieval itself needs live runs (deferred to the post-0.5 agent
 * benchmark). Recorded here as the baseline P0/P1 ranking PRs must beat.
 */
import { rankPipeline, normalizeUrl } from '../lib/search.js';
import { pathToFileURL } from 'node:url';

const B = (name, items) => ({
  name,
  items: items.map(([url, title, snippet, source]) => ({ url, title, snippet, source: source ?? name })),
});

// q: query. gold: canonical-ish URL → grade (2 = highly relevant, 1 = related).
const CASES = [
  // --- factual (4) ---
  {
    q: 'capital of France',
    lists: [
      B('wikipedia', [['https://en.wikipedia.org/wiki/Paris', 'Paris', 'Paris is the capital and largest city of France.', 'wikipedia']]),
      B('ddg', [
        ['https://world-facts.example.com/france', 'France country profile: capital Paris', 'France, capital Paris, population 68 million.', 'ddg'],
        ['https://dict-example.com/best', 'BEST Definition & Meaning', 'dictionary entry for best.', 'ddg'],
      ]),
    ],
    gold: { 'https://en.wikipedia.org/wiki/Paris': 2, 'https://world-facts.example.com/france': 1 },
  },
  {
    q: 'how tall is Mount Everest',
    lists: [
      B('wikipedia', [['https://en.wikipedia.org/wiki/Mount_Everest', 'Mount Everest', 'Mount Everest is 8,848.86 metres above sea level.', 'wikipedia']]),
      B('bing', [
        ['https://peaks-example.com/everest', 'Mount Everest height and routes', 'The height of Everest is 8,848.86 m as surveyed in 2020.', 'web'],
        ['https://seo-example.net/top-10-mountains', 'TOP 10 BEST mountains to climb 2026', 'Number 4 will shock you.', 'web'],
      ]),
    ],
    gold: { 'https://en.wikipedia.org/wiki/Mount_Everest': 2, 'https://peaks-example.com/everest': 2 },
  },
  {
    q: 'photosynthesis chemical equation',
    lists: [
      B('wikipedia', [['https://en.wikipedia.org/wiki/Photosynthesis', 'Photosynthesis', '6CO2 + 6H2O → C6H12O6 + 6O2.', 'wikipedia']]),
      B('ddg', [['https://bio-notes-example.com/photosynthesis', 'Photosynthesis equation explained', 'The equation balances carbon dioxide and water into glucose.', 'ddg']]),
    ],
    gold: { 'https://en.wikipedia.org/wiki/Photosynthesis': 2, 'https://bio-notes-example.com/photosynthesis': 1 },
  },
  {
    q: 'speed of light in vacuum',
    lists: [
      B('ddg', [
        ['https://physics-example.com/constants', 'Speed of light: 299,792,458 m/s', 'Exact value used to define the metre.', 'ddg'],
        ['https://en.wikipedia.org/wiki/Speed_of_light', 'Speed of light', 'The speed of light in vacuum is 299,792,458 metres per second.', 'wikipedia'],
      ]),
      B('bing', [['https://physics-example.com/constants?ref=home', 'Speed of light: 299,792,458 m/s', 'Longer duplicate snippet about the exact defined value.', 'web']]),
    ],
    gold: { 'https://en.wikipedia.org/wiki/Speed_of_light': 2, 'https://physics-example.com/constants': 2 },
  },
  // --- current (3) ---
  {
    q: 'latest Android Studio version 2026',
    lists: [
      B('google', [['https://developer.android.com/studio', 'Android Studio release notes', 'Latest stable release notes with version history.', 'google']], ),
      B('bing', [
        ['https://dev-blog-example.com/android-studio-new', 'Android Studio 2026 releases', 'Tracking each 2026 stable release of Android Studio.', 'web'],
        ['https://stale-example.com/studio-2022', 'Android Studio 2022 review', 'Old review from 2022.', 'web'],
      ]),
    ],
    gold: { 'https://developer.android.com/studio': 2, 'https://dev-blog-example.com/android-studio-new': 1 },
  },
  {
    q: 'today bitcoin price',
    lists: [
      B('bing', [
        ['https://markets-example.com/btc', 'Bitcoin price today', 'Live bitcoin price with daily chart.', 'web'],
        ['https://news-example.com/markets', 'Markets today: bitcoin moves', 'Bitcoin price action in today’s session.', 'web'],
      ]),
      B('ddg', [['https://old-example.com/btc-2021', 'Bitcoin 2021 retrospective', 'Looking back at the 2021 run.', 'ddg']]),
    ],
    gold: { 'https://markets-example.com/btc': 2, 'https://news-example.com/markets': 1 },
  },
  {
    q: 'Android 16 release date',
    lists: [
      B('google', [['https://developer.android.com/about/versions/16', 'Android 16 behavior changes', 'Release timeline and behavior changes for Android 16.', 'google']]),
      B('ddg', [['https://tech-news-example.com/android-16', 'Android 16 release schedule', 'When Android 16 ships to Pixel devices.', 'ddg']]),
    ],
    gold: { 'https://developer.android.com/about/versions/16': 2, 'https://tech-news-example.com/android-16': 1 },
  },
  // --- technical (6) ---
  {
    q: 'Kotlin StateFlow lifecycle collection',
    lists: [
      B('ddg', [
        ['https://developer.android.com/kotlin/flow/stateflow', 'StateFlow and lifecycle-aware collection', 'Collect StateFlow with repeatOnLifecycle.', 'web'],
        ['https://seo-example.net/stateflow-tricks', 'TOP 10 BEST StateFlow tricks', 'You will not believe trick 3.', 'web'],
      ]),
      B('stackoverflow', [['https://stackoverflow.com/questions/789', 'How to collect StateFlow with lifecycle?', 'Use repeatOnLifecycle with STARTED state.', 'stackoverflow']]),
    ],
    gold: { 'https://developer.android.com/kotlin/flow/stateflow': 2, 'https://stackoverflow.com/questions/789': 2 },
  },
  {
    q: 'Python asyncio gather vs TaskGroup',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/456', 'asyncio.gather vs TaskGroup error handling', 'TaskGroup cancels siblings on first error; gather needs return_exceptions.', 'stackoverflow']]),
      B('ddg', [
        ['https://docs.python.org/3/library/asyncio-task', 'asyncio task groups', 'TaskGroup structured concurrency documentation.', 'ddg'],
        ['https://copyblog-example.com/asyncio', 'BEST asyncio guide 2026 (sponsored)', 'Thin affiliate page.', 'ddg'],
      ]),
    ],
    gold: { 'https://docs.python.org/3/library/asyncio-task': 2, 'https://stackoverflow.com/questions/456': 2 },
  },
  {
    q: 'React useEffect cleanup function',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/321', 'When does the useEffect cleanup run?', 'Cleanup runs before re-effect and on unmount.', 'stackoverflow']]),
      B('ddg', [['https://react.dev/reference/react/useEffect', 'useEffect reference', 'Official useEffect docs including cleanup semantics.', 'ddg']]),
    ],
    gold: { 'https://react.dev/reference/react/useEffect': 2, 'https://stackoverflow.com/questions/321': 2 },
  },
  {
    q: 'Postgres index on jsonb field',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/654', 'GIN index on jsonb column', 'CREATE INDEX … USING gin (data) covers containment queries.', 'stackoverflow']]),
      B('ddg', [['https://postgresql.org/docs/current/datatype-json', 'JSON types documentation', 'GIN, BTREE and hash indexing strategies for jsonb.', 'ddg']]),
    ],
    gold: { 'https://postgresql.org/docs/current/datatype-json': 2, 'https://stackoverflow.com/questions/654': 2 },
  },
  {
    q: 'Rust borrow checker error E0502',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/987', 'Cannot borrow as mutable, E0502', 'Split the borrow or clone before the loop.', 'stackoverflow']]),
      B('ddg', [['https://doc.rust-lang.org/error_codes/E0502', 'E0502 error explanation', 'Official explanation of the simultaneous mutable/immutable borrow error.', 'ddg']]),
    ],
    gold: { 'https://doc.rust-lang.org/error_codes/E0502': 2, 'https://stackoverflow.com/questions/987': 2 },
  },
  {
    q: 'Docker multi-stage build node image size',
    lists: [
      B('ddg', [['https://docs.docker.com/build/building/multi-stage', 'Multi-stage builds', 'Keep images small with multi-stage Node builds.', 'ddg']]),
      B('stackoverflow', [['https://stackoverflow.com/questions/147', 'Shrink Node Docker image', 'Alpine + multi-stage cut our image from 1GB to 120MB.', 'stackoverflow']]),
    ],
    gold: { 'https://docs.docker.com/build/building/multi-stage': 2, 'https://stackoverflow.com/questions/147': 1 },
  },
  // --- official docs (4) ---
  {
    q: 'Android 16 edge-to-edge enforcement',
    lists: [
      B('google', [['https://developer.android.com/about/versions/16/behavior-changes', 'Android 16 behavior changes', 'Edge-to-edge enforcement details for target SDK 36.', 'google']]),
      B('ddg', [
        ['https://medium-example.com/edge-to-edge', 'My edge-to-edge journey', 'A personal migration story with gaps.', 'ddg'],
        ['https://developer.android.com/develop/ui/views/layout/edge-to-edge', 'Edge-to-edge developer guide', 'Official guide to window insets and edge-to-edge layouts.', 'ddg'],
      ]),
    ],
    gold: { 'https://developer.android.com/about/versions/16/behavior-changes': 2, 'https://developer.android.com/develop/ui/views/layout/edge-to-edge': 2 },
  },
  {
    q: 'TypeScript strict mode tsconfig',
    lists: [
      B('ddg', [
        ['https://typescriptlang.org/tsconfig/strict', 'tsconfig strict option', 'Official strict mode documentation.', 'ddg'],
        ['https://blog-example.com/tsconfig', 'My tsconfig setup', 'Anecdotal config walkthrough.', 'ddg'],
      ]),
    ],
    gold: { 'https://typescriptlang.org/tsconfig/strict': 2 },
  },
  {
    q: 'Kubernetes liveness vs readiness probes',
    lists: [
      B('ddg', [
        ['https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes', 'Configure liveness, readiness and startup probes', 'When each probe type fires and how failures are handled.', 'ddg'],
        ['https://qa-example.com/probes', 'Probes interview Q&A dump', 'Shallow copy of the docs.', 'ddg'],
      ]),
      B('stackoverflow', [['https://stackoverflow.com/questions/258', 'liveness vs readiness practical difference', 'Readiness gates traffic; liveness restarts the container.', 'stackoverflow']]),
    ],
    gold: { 'https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes': 2, 'https://stackoverflow.com/questions/258': 1 },
  },
  {
    q: 'GitHub Actions cache action v4',
    lists: [
      B('ddg', [
        ['https://github.com/actions/cache', 'actions/cache repository', 'Official cache action with v4 notes.', 'ddg'],
        ['https://tutorials-example.com/gh-cache', 'BEST Actions cache tutorial', 'Keyword-stuffed tutorial.', 'ddg'],
      ]),
    ],
    gold: { 'https://github.com/actions/cache': 2 },
  },
  // --- opinion (4) ---
  {
    q: 'best android pomodoro apps',
    lists: [
      B('ddg', [['https://seo-example.net/pomodoro-10', 'TOP 10 BEST pomodoro apps 2026', 'Affiliate list with no testing.', 'ddg']]),
      B('reddit-pass', [['https://www.reddit.com/r/android/comments/xyz', 'What pomodoro app actually works for ADHD? (android)', 'Real android pomodoro experience from daily users.', 'reddit']]),
      B('bing', [['https://play.google.com/store/apps/details?id=focus1', 'Focus Keeper app listing', 'Android pomodoro timer on Google Play.', 'web']]),
    ],
    gold: { 'https://www.reddit.com/r/android/comments/xyz': 2, 'https://play.google.com/store/apps/details?id=focus1': 1 },
  },
  {
    q: 'mechanical keyboard for programming worth it reddit',
    lists: [
      B('reddit-pass', [['https://www.reddit.com/r/MechanicalKeyboards/comments/k1', 'Keyboards for programming: my experience', 'Programmers discuss switches for long typing days.', 'reddit']]),
      B('ddg', [['https://shop-example.com/keyboards', 'BEST keyboards 2026 (sponsored)', 'Store listing.', 'ddg']]),
    ],
    gold: { 'https://www.reddit.com/r/MechanicalKeyboards/comments/k1': 2 },
  },
  {
    q: 'is Obsidian better than Notion for notes',
    lists: [
      B('reddit-pass', [['https://www.reddit.com/r/PKMS/comments/n2', 'Obsidian vs Notion after one year', 'Long-term notes comparison from heavy users.', 'reddit']]),
      B('ddg', [['https://compare-example.com/obsidian-notion', 'Obsidian vs Notion comparison', 'Feature table of both notes apps.', 'ddg']]),
    ],
    gold: { 'https://www.reddit.com/r/PKMS/comments/n2': 2, 'https://compare-example.com/obsidian-notion': 1 },
  },
  {
    q: 'how do I focus with ADHD programming',
    lists: [
      B('reddit-pass', [['https://www.reddit.com/r/ADHD_Programmers/comments/f3', 'How I focus while programming with ADHD', 'Techniques that work for ADHD programmers.', 'reddit']]),
      B('ddg', [['https://clinic-example.com/adhd', 'ADHD overview', 'Clinical definition page.', 'ddg']]),
    ],
    gold: { 'https://www.reddit.com/r/ADHD_Programmers/comments/f3': 2 },
  },
  // --- comparison (3) ---
  {
    q: 'A17 vs A57 specs price',
    lists: [
      B('ddg', [
        ['https://compare-example.com/a17-vs-a57', 'A17 vs A57 specs and price', 'Side-by-side specs with price table.', 'ddg'],
        ['https://shop-example.com/a17', 'Buy A17 today', 'Store page.', 'ddg'],
      ]),
      B('bing', [['https://specs-example.com/a57', 'A57 full specifications', 'A57 RAM, storage and price specs.', 'web']]),
    ],
    gold: { 'https://compare-example.com/a17-vs-a57': 2, 'https://specs-example.com/a57': 1 },
  },
  {
    q: 'SQLite vs Postgres for small app',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/369', 'SQLite vs Postgres tradeoffs', 'Single-file simplicity vs concurrent writes.', 'stackoverflow']]),
      B('ddg', [['https://blog-example.com/sqlite-postgres', 'SQLite vs Postgres for side projects', 'When each database fits a small app.', 'ddg']]),
    ],
    gold: { 'https://stackoverflow.com/questions/369': 2, 'https://blog-example.com/sqlite-postgres': 1 },
  },
  {
    q: 'npm vs pnpm install speed',
    lists: [
      B('ddg', [
        ['https://blog-example.com/npm-pnpm', 'npm vs pnpm benchmark', 'Measured install speed on a monorepo.', 'ddg'],
        ['https://docs.npmjs.com/cli', 'npm CLI docs', 'Official npm documentation.', 'ddg'],
      ]),
    ],
    gold: { 'https://blog-example.com/npm-pnpm': 2 },
  },
  // --- academic (2) ---
  {
    q: 'attention is all you need transformer paper',
    lists: [
      B('ddg', [
        ['https://arxiv.org/abs/1706.03762', 'Attention Is All You Need', 'The transformer architecture paper.', 'ddg'],
        ['https://blog-example.com/transformers', 'Transformers explained simply', 'Popular summary of the paper.', 'ddg'],
      ]),
    ],
    gold: { 'https://arxiv.org/abs/1706.03762': 2, 'https://blog-example.com/transformers': 1 },
  },
  {
    q: 'study on spaced repetition effectiveness',
    lists: [
      B('ddg', [['https://journal-example.com/spaced-repetition', 'Spaced repetition meta-analysis', 'Peer-reviewed study on spaced repetition effectiveness.', 'ddg']]),
    ],
    gold: { 'https://journal-example.com/spaced-repetition': 2 },
  },
  // --- troubleshooting (4) ---
  {
    q: 'Node EADDRINUSE port already in use fix',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/481', 'EADDRINUSE: address already in use', 'Kill the process or set SO_REUSEADDR; check port usage.', 'stackoverflow']]),
      B('ddg', [['https://blog-example.com/eaddrinuse', 'Fix EADDRINUSE fast', 'Commands to free the port.', 'ddg']]),
    ],
    gold: { 'https://stackoverflow.com/questions/481': 2, 'https://blog-example.com/eaddrinuse': 1 },
  },
  {
    q: 'git push rejected non-fast-forward',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/582', 'non-fast-forward push rejected', 'Pull with rebase, then push again.', 'stackoverflow']]),
      B('ddg', [['https://git-scm.com/docs/git-push', 'git-push documentation', 'Official push docs including force-with-lease.', 'ddg']]),
    ],
    gold: { 'https://stackoverflow.com/questions/582': 2, 'https://git-scm.com/docs/git-push': 1 },
  },
  {
    q: 'CORS error fetch frontend backend different origin',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/693', 'CORS blocked my fetch call', 'Configure Access-Control-Allow-Origin on the backend.', 'stackoverflow']]),
      B('ddg', [['https://mdn-example.com/cors', 'CORS on MDN', 'Cross-origin sharing explained.', 'ddg']]),
    ],
    gold: { 'https://stackoverflow.com/questions/693': 2, 'https://mdn-example.com/cors': 1 },
  },
  {
    q: 'out of memory JavaScript heap Vercel build',
    lists: [
      B('stackoverflow', [['https://stackoverflow.com/questions/714', 'Vercel build heap out of memory', 'Raise NODE_OPTIONS max-old-space-size for the build.', 'stackoverflow']]),
      B('ddg', [['https://vercel-docs-example.com/builds', 'Vercel builds overview', 'How Vercel builds run.', 'ddg']]),
    ],
    gold: { 'https://stackoverflow.com/questions/714': 2 },
  },
];

function metrics(ranked, gold) {
  const keys = ranked.map((r) => normalizeUrl(r.url));
  const rel = Object.entries(gold)
    .filter(([, g]) => g >= 1)
    .map(([u]) => normalizeUrl(u));
  const gradeOf = (k) => {
    for (const [u, g] of Object.entries(gold)) if (normalizeUrl(u) === k) return g;
    return 0;
  };
  const at = (k) => keys.slice(0, k);
  const recallAt = (k) => (rel.length ? at(k).filter((x) => rel.includes(x)).length / rel.length : 1);
  let mrr = 0;
  for (let i = 0; i < keys.length; i++) {
    if (rel.includes(keys[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }
  const dcg = keys.slice(0, 10).reduce((s, k, i) => s + (Math.pow(2, gradeOf(k)) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(gold)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((s, g, i) => s + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  return { recall5: recallAt(5), recall10: recallAt(10), mrr, ndcg10: ideal ? dcg / ideal : 1 };
}

function run(rerank) {
  const agg = { recall5: 0, recall10: 0, mrr: 0, ndcg10: 0 };
  let misses = 0;
  for (const c of CASES) {
    const ranked = rankPipeline(c.lists, c.q, { maxResults: 10, rerank });
    const m = metrics(ranked, c.gold);
    agg.recall5 += m.recall5;
    agg.recall10 += m.recall10;
    agg.mrr += m.mrr;
    agg.ndcg10 += m.ndcg10;
    if (m.recall10 < 1) misses++;
  }
  const n = CASES.length;
  return {
    recall5: agg.recall5 / n,
    recall10: agg.recall10 / n,
    mrr: agg.mrr / n,
    ndcg10: agg.ndcg10 / n,
    misses,
    n,
  };
}

const on = run(true);
const off = run(false);
export { CASES, metrics, run };
const f = (x) => x.toFixed(3);
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  console.log(`cases: ${on.n}`);
  console.log(`rerank:true  Recall@5 ${f(on.recall5)}  Recall@10 ${f(on.recall10)}  MRR ${f(on.mrr)}  nDCG@10 ${f(on.ndcg10)}  missed-cases ${on.misses}`);
  console.log(`rerank:false Recall@5 ${f(off.recall5)}  Recall@10 ${f(off.recall10)}  MRR ${f(off.mrr)}  nDCG@10 ${f(off.ndcg10)}  missed-cases ${off.misses}`);
  const bar = { recall10: 0.85 };
  const gate = on.recall10 >= bar.recall10 ? 'PASS' : 'FAIL';
  console.log(`gate Recall@10 >= ${bar.recall10}: ${gate} (got ${f(on.recall10)})`);
  process.exit(gate === 'PASS' ? 0 : 1);
}
