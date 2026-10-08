# AGENTS.md

Scout — lean, token-efficient free web search + reader. A DSH plugin
(`scout_search` / `scout_read`) that also backs the built-in `web_search` /
`web_fetch` tools. Zero npm dependencies, plain `fetch()` + string parsing,
no API key required.

## Design rule (governs every change)

Before changing or adding anything, read
`docs/adr/0001-agent-owns-judgment-scout-owns-plumbing.md` and pass its
change gate. Agent owns judgment; Scout owns plumbing. Terms as in
`GLOSSARY.md`.

## Start here (reading order)

1. `GLOSSARY.md` — the only four words that matter: **Agent**, **Scout**,
   **Evidence**, **Provenance**. Use them exactly; see Vocabulary below.
2. `docs/adr/0001-agent-owns-judgment-scout-owns-plumbing.md` — the change
   gate every edit must pass.
3. Then read only the doc your task touches:

| Task | Read |
|---|---|
| Search pipeline, fusion, rerank, caches, breaker | `docs/architecture.md` |
| Backends, Brave/CSE/SearXNG, intent routing | `docs/providers.md` |
| Params, output shapes, lean workflow, forum/PDF reading | `docs/agent-usage.md` + `SKILL.md` |
| Tests, frozen bench, pilot results | `docs/benchmarks.md` |
| SSRF guard, Jina privacy, fail-closed rules | `docs/security.md` |

`README.md` is intentionally lean (marketplace front page) — it summarizes
and links; the five pages above are the source of truth.

## Vocabulary — use exactly

From `GLOSSARY.md`. Drifting to synonyms is a bug in docs, issues, and
test names:

- **Agent** — the AI caller that decides and judges. _Avoid: user, host, model._
- **Scout** — the plugin that finds, fetches, extracts, compresses, caches,
  returns. _Avoid: search engine, summarizer, answerer._
- **Evidence** — untrusted external content with its source URL.
  _Avoid: answer, result, fact._
- **Provenance** — domain, source type, providers, dates for the agent to
  judge by. _Avoid: ranking, verdict, credibility score._

Key corollaries: same URL twice is **retrieval agreement** (easier to find),
not confirmation. `sourceType` is a coarse label, not a verdict. The agent
verifies claims; Scout retrieves evidence.

## Change-gate checklist (from ADR-0001)

If your change moves judgment into Scout, reject it unless ALL hold:

- (a) **Additive, not exclusive** — web backends always run; a
  misclassification costs depth, never the whole search.
- (b) **Capped** — lexical relevance still dominates (small priors, capped
  agreement bonus, undated results kept never dropped).
- (c) **Overridable** — the agent can countermand it (`intent`,
  `searchScope`, `recency`, `redditBias`, `includeDomains`/`excludeDomains`,
  `rerank:false`).
- (d) **Transparent** — visible in output (`meta.intent`, resolved recency,
  `providersFailed[]`, `partial`/`unavailable`, per-hit provenance).

Allowed grey areas already justified: intent-routed specials + small
intent × source-type prior, `matchesQuery` junk filter, RRF + heuristic
rerank, auto `recency`/`redditBias` with dated-first, workflow hints in tool
text. Strengthening any of these needs re-justification against the ADR, not
silent tuning. Never add: LLM rerank/summarize, query rewriting, auto
re-search loops, answer synthesis, credibility scores.

## Repo map

```text
index.js            plugin entry (tool registration, provider wiring)
lib/search.js       search fan-out, fusion, rerank, health
lib/reader.js       reader chain (fast-paths → generic HTML → PDF → Jina fallback)
lib/lean.js         shared helpers (canon, budgets, paging, sanitize)
cordis.patch.yml    DSH bundle patch
SKILL.md            runtime instructions agents load (keep in sync with docs/agent-usage.md)
test/lean-check.mjs L1 helpers/parsers/canon/ranking fixtures
test/reader-check.mjs L2 page fixtures, paging, links/find/tables/PDF
test/ssrf-check.mjs L3 59-case SSRF hard gate — any miss fails the build
test/chaos-check.mjs L4 partial/all-down/hang/breaker behavior
test/ranking-bench.mjs L5 frozen ranking bench (Recall@10 gate + MRR/nDCG)
test/smoke.mjs      live-backend smoke (needs network)
test/check-plugin.mjs plugin mount check
test/bench/        pilot agent-benchmark tasks, rows, stats, chart
docs/*.md           architecture, providers, agent-usage, benchmarks, security
docs/adr/           decisions (currently just 0001)
```

## Docs rule — README stays lean

Luna's rule (README too technical → split): `README.md` answers only
_what / why / tools / install_ plus teasers with links. Full detail lives in
`docs/*.md`. When you change behavior:

- Update the matching `docs/*.md` page, not the README.
- Touch the README only for a one-line summary or link fix.
- If the change is agent-facing (params, output shape, workflow, privacy),
  update `SKILL.md` in the same edit.
- Keep GLOSSARY terms; never let `official-docs` read as "automatically true".

## Tests

```powershell
npm test   # offline gates L1–L5, all must-pass
node ./test/smoke.mjs "best android pomodoro apps reddit"
node ./test/check-plugin.mjs
```

The gates are regression guards, not proof (see `docs/benchmarks.md`).
Docs-only edits need no test run; any `lib/` or `index.js` change does.

## Plugin notes

- Zero npm dependencies, Node 20+. Keep it that way — no raw-socket DNS
  pinning, no JS rendering, no new deps without ADR-level justification.
- After any code change: **restart the DSH app** (`restart-required`), then
  check `mount-status.json` next to `index.js`.
- Constraints: plain `fetch()` + string parsing, per-backend timeouts,
  failure-isolated backends, per-hop redirect validation, `chars/4` token
  estimates.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `LastElbow/Scout-dsh`, driven by the
`gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
