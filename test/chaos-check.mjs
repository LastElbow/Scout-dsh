/** L4 provider chaos — no network (injected fakes). Run: node ./test/chaos-check.mjs
 *
 * Proves the circuit-breaker architecture: fake backends that 429 / 403 /
 * time out / hang / return malformed / empty / duplicate / garbage must
 * degrade to partial results, never blank the search, and never throw.
 * Backend names are unique per scenario: a tripped breaker skips its name
 * for ~3 min, so reuse would cross-contaminate scenarios in-process.
 */
import { freeSearch } from '../lib/search.js';

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

const hit = (host, path, title, snippet, source) => ({
  url: `https://${host}/${path}`,
  title,
  snippet,
  source,
});
const okBackend = (name, items) => ({ name, run: async () => items });
const failBackend = (name, msg) => ({
  name,
  run: async () => {
    throw new Error(msg);
  },
});
const hangBackend = (name) => ({ name, run: () => new Promise(() => {}) });
const OPTS = { maxResults: 8, timeoutMs: 1000, rerank: true, recency: 'all', redditBias: 'off' };

// 1. One provider down → the rest still serve
{
  const { results: r, meta } = await freeSearch('android pomodoro timers', {
    ...OPTS,
    backends: [
      okBackend('chaos-ok-1', [hit('a-example.com', 'p1', 'Android pomodoro timers guide', 'timer review', 'ddg')]),
      failBackend('chaos-429-1', 'HTTP 429 for ddg'),
    ],
  });
  ok(r.length === 1 && r[0].url.includes('a-example.com'), '1 down: survivor still serves');
  ok(meta.partial === true && meta.unavailable === false, '1 down: meta.partial, not unavailable');
  ok(meta.providersFailed.some((f) => f.name === 'chaos-429-1'), '1 down: failed backend named in meta');
}

// 2. Two of three down → partial, not blank
{
  const { results: r, meta } = await freeSearch('android pomodoro timers', {
    ...OPTS,
    backends: [
      okBackend('chaos-ok-2', [hit('b-example.com', 'p1', 'Android pomodoro timers guide', 'timer review', 'ddg')]),
      failBackend('chaos-403-2', 'HTTP 403 for bing'),
      failBackend('chaos-500-2', 'HTTP 503 for brave'),
    ],
  });
  ok(r.length === 1, '2 down: partial results, no throw');
  ok(meta.partial === true && meta.providersSucceeded.join(',') === 'chaos-ok-2', '2 down: meta names survivor + failures');
}

// 3. All down → honest empty, still no throw (explicit unavailable copy is #4's job)
{
  const { results: r, meta } = await freeSearch('android pomodoro timers', {
    ...OPTS,
    backends: [failBackend('chaos-429-3', 'HTTP 429 for ddg'), failBackend('chaos-tmo-3', 'timeout')],
  });
  ok(Array.isArray(r) && r.length === 0, 'all down: empty array, no throw');
  ok(meta.unavailable === true && meta.partial === false, 'all down: meta.unavailable distinct from partial');
}

// 4. Hung backend → timeout guard degrades it, search still returns
{
  const t0 = Date.now();
  const { results: r } = await freeSearch('android pomodoro timers', {
    ...OPTS,
    backends: [
      okBackend('chaos-ok-4', [hit('c-example.com', 'p1', 'Android pomodoro timers guide', 'timer review', 'ddg')]),
      hangBackend('chaos-hang-4'),
    ],
  });
  const elapsed = Date.now() - t0;
  ok(r.length === 1, 'hang: survivor still serves');
  ok(elapsed < 4000, `hang: timeout guard fires (~${elapsed}ms, budget 1000ms)`);
}

// 5. Duplicates across engines merge instead of doubling
{
  const { results: r } = await freeSearch('stateflow lifecycle', {
    ...OPTS,
    backends: [
      okBackend('chaos-ok-5a', [hit('d-example.com', 's', 'StateFlow lifecycle guide', 'collect', 'ddg')]),
      okBackend('chaos-ok-5b', [hit('d-example.com', 's?utm_source=x', 'StateFlow lifecycle guide', 'collect with more detail here', 'bing')]),
    ],
  });
  ok(r.length === 1, 'duplicates: canonical merge → single hit');
}

// 6. Malformed / empty / garbage backends never poison the search
{
  const { results: r } = await freeSearch('stateflow lifecycle', {
    ...OPTS,
    backends: [
      { name: 'chaos-garbage-6', run: async () => [{ url: 'not a url', title: null, snippet: undefined }] },
      { name: 'chaos-empty-6', run: async () => [] },
      { name: 'chaos-thin-6', run: async () => [{ url: 'https://e-example.com/only-url' }] },
      okBackend('chaos-ok-6', [hit('f-example.com', 's', 'StateFlow lifecycle guide', 'collect', 'ddg')]),
    ],
  });
  ok(r.length >= 1 && r.every((x) => /^https?:\/\//.test(x.url)), 'garbage tolerated: valid hits survive, no throw');
}

// 7. A tripped breaker skips its backend on the very next search
{
  const name = 'chaos-flaky-7';
  let calls = 0;
  const flaky = {
    name,
    run: async () => {
      calls++;
      throw new Error('HTTP 429 for flaky');
    },
  };
  await freeSearch('stateflow lifecycle', { ...OPTS, backends: [flaky] });
  await freeSearch('stateflow lifecycle', { ...OPTS, backends: [flaky] });
  ok(calls === 1, 'breaker: second search skips the throttled backend without calling it');
}

console.log(`\nCHAOS CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
