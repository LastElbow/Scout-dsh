# Agent usage — config, output contracts, lean workflow

Scout plugin = capability (two tools). This page = the full instructions; the `SKILL.md` is the compressed version agents load at runtime. Throughout: the [agent](../GLOSSARY.md) decides and verifies; Scout retrieves [evidence](../GLOSSARY.md) with [provenance](../GLOSSARY.md).

## Config

All optional (defaults work, tuned for low tokens):

- `maxResults` (default 8) — search result cap 1–20 (use 3–5 to save tokens)
- `snippetChars` (default 220, 80–500) — per-snippet cap; smaller = fewer tokens
- `rerank` (default true) — RRF fusion + heuristic rerank with per-source diversity guard
- `alternatives` (default `''`) — up to 4 alternate queries, newline-separated; every variant searches, one fused/deduped/reranked list returns (a 5th errors). Use only when the initial query is ambiguous, difficult, or returns poor candidates — each variant multiplies backend requests, so a single query is cheaper when it suffices
- `recency` (default `'auto'`) — `auto|day|week|month|year|all`; auto detects latest/today/version/price/year hints. With any window (explicit or auto-resolved), confirmed-fresh results outrank `date: unknown`; undated results are always kept, never dropped
- `intent` (default `'auto'`) — `auto|factual|current|technical|opinion|research|news|generic|academic`; routes specials + tunes priors
- `searchScope` (default `'auto'`) — `auto|web|news|docs|forums|code|academic`; coarse intent override (explicit `intent` wins)
- `redditBias` (default `'auto'`) — extra reddit pass for opinion/experience queries; `on`/`off` to force
- `includeDomains` / `excludeDomains` (default `''`) — comma-separated hosts (`"github.com, *.substack.com"`)
- `searchTimeoutMs` (default 12000)
- `fetchTimeoutMs` (default 15000)
- `maxChars` (default 8000, 500–50000) — full-text cap (~2000 tokens)
- `withLinksSummary` (default false) — append `## Links` URL list (off saves tokens)
- `view` (default `'text'`) — `text` (full article) | `highlights` (needs `query`, ~1/5 tokens) | `links` (traversal list for the page)
- `includeLinks` (default false) — same `## Links` section with anchor labels (richer lines)
- `find` (default `''`) — literal phrase to locate in the page; returns matches with section + offset + ~450-char context (wins over `view`)
- `findCursor` (default 0) — continue a find past earlier matches (output names the next cursor)
- `jinaFallback` (default true) — use the public text proxy (`r.jina.ai`) when a page blocks direct fetch. **Privacy:** the requested URL is sent to that third party — set `false` for sensitive deployments and use another result instead. Credential-bearing URLs (`?token=`, `?sig=`, `?X-Amz-*`, …) are **refused** for the fallback even when enabled (fail-closed); read those directly.
- `googleApiKeyEnv` (default `'GOOGLE_API_KEY'`) — env var holding a pre-existing CSE key (legacy only — closed to new customers, discontinued 2027-01-01)
- `googleCx` (default `''`) — Programmable Search Engine ID (empty = News RSS tier; new setups should not use this)
- `braveApiKeyEnv` (default `'BRAVE_API_KEY'`) — env var holding the Brave key (empty = keyless backends only)
- `searxngUrl` (default `''`) — self-hosted SearXNG base URL (empty = off); `searxngUrlEnv` (default `'SEARXNG_URL'`) is the env fallback

## Output contracts

Search hits (one per line, stable `[SRn]` ids per search — cite the URL, not the id):

```text
- [SR1] [Title](url) — snippet · 2026-10-06 · example.com · official-docs
```

Machine shape per hit: `title, url, snippet, source, publishedDate?, providers[], providerCount, independentHostCount, domain, sourceType, retrievedAt`. `sourceType` is one of `official-docs|reference|news|community|aggregator|unknown` — a coarse label for judging provenance, not a verdict. Fusion internals never leak.

Search health travels with every call: `providersAttempted/Succeeded/Failed[], partial, unavailable` (+ `variants[]`, resolved `recency` and `intent`). `partial` = degraded coverage with a `Partial results:` footer naming the failed backends; `unavailable` = nothing served (an explicit outage message, never an empty-looking list). **Empty results and provider failure are different states.**

Reader output: `# title` + mode header (`highlights for "…"`, `find "…" · N match(es)`, `page links`, `full text`) + engine + token estimate, then the content, then `Source: url`. Find matches carry `section · offset` plus a `findCursor` when more remain; long reads carry `offset=N` with the guarantee that concatenated windows reconstruct the source exactly.

## Lean workflow (cheapest first — for humans and agents)

1. `scout_search` with `maxResults: 3-5` → compact hits with `~N tokens` counts and dates (`· 2026-03-06`) where known. Every hit carries a stable `[SRn]` id plus domain and source type (`official-docs|reference|news|community|aggregator|unknown`) — cite the URL. Provider outages surface as a `Partial results:` footer (or an explicit all-failed message), never as silent thin results. For hard questions add `alternatives` (up to 4 reformulations, one per line) — variants fan out, one fused ranking returns; use only when the query is ambiguous or the first ranking missed. `recency` defaults to `auto` (detects current-topic hints); set it explicitly only to override.
2. `scout_read { url, query, view: 'highlights' }` → extractive excerpts (~1/5 tokens). Needs both `query` + `view`.
3. Follow-ups are free: the cleaned page is cached 10 min, so a second question costs no re-fetch. Long pages say `Continue with offset=N` — pass it back to page through.
4. Only if the answer is missing: re-read with `view: 'text'` + `tokenBudget: 2000`.
5. Request only the retrieval mode you need (paid APIs bill twice for the same reason).

**Agent-led multi-hop loop (hard questions — the agent drives, Scout performs each operation):** search → read 1–2 hits with highlights → `find` the exact passage → if the answer lives deeper, `view: 'links'` and open the subpage (no URL guessing) → if the rankings missed, re-search with `alternatives` reformulations. Scout never runs this loop itself; the agent decides each next step. Every step is token-capped; the page cache makes follow-ups free.

## How it reads Reddit / forums

1. `reddit.com/…/comments/…` → Arctic Shift (post + top comments; reddit.com 403s anonymous `.json`, so Arctic is the real path).
2. Subreddit homepages → recent-posts digest via Arctic.
3. StackOverflow / StackExchange questions → question + top answers via the free API (direct HTML 403s bots).
4. HN items → story + top comments via the Firebase API.
5. Discourse `/t/slug/id` → tries `…json`, returns topic + first 10 posts.
6. Anything else → fetches HTML with a browser UA, strips nav/script/footer, prefers `<article>`/`<main>`, converts to markdown-ish text (tables kept as markdown).
7. PDFs → local text extraction (no deps): uncompressed + Flate streams, page markers estimated. Encrypted or scanned-image PDFs fail with a clear error instead of junk.
8. Blocked (403/429/empty) → retries through the public reader proxy (`r.jina.ai`, no key) — see the privacy note in Config.
