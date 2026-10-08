# Scout — lean web search + reader for any AI agent

Free-first, provider-agnostic web search + universal page reader. Token-efficient by design: highlights-first excerpts, reranked snippets, token budgets. Flat string/integer/boolean params so DSH, MCP, or OpenAI-style function calling can all use it. No API key needed.

**Scout 0.5 is a lightweight evidence retrieval layer for agents, not a search engine.** The interface is six verbs: **SEARCH** candidate sources · **READ** evidence · **FIND** exact passages · follow **LINKS** to deeper sources · judge **PROVENANCE** · **VERIFY** with citations. No internal LLM, no summarizer — cheap deterministic plumbing plus agent-facing affordances. Zero npm dependencies, plain `fetch()` + string parsing, no tracking.

## What you get

| Tool | What it does |
|---|---|
| `scout_search` | **Free-first, provider-agnostic**: optional keyed backends (**SearXNG** own-infra first when set; **Brave**; **Google CSE legacy-only**, see below) + keyless free backends (DuckDuckGo HTML, **Bing RSS** — unofficial endpoint — Google News RSS) + **intent-routed specials** (Wikipedia, HackerNews, StackExchange for factual/technical/research; reddit-biased pass + HN for opinion; plus **Arctic Shift** when you name a subreddit (`r/foo`)). One-call expansion via `alternatives` (≤4, one fused ranking). Returns `[SRn]` hits with provenance (domain, source type, providers, dates) plus explicit partial/outage health — never silent thin results. Handles `site:` queries. |
| `scout_read` | Reads a URL as clean text: `text` (full), `highlights` (query excerpts, ~1/5 tokens), `links` (anchor + URL + internal/external traversal list), or `find` (exact phrase → section + offset + context, cursor-paged). **Reddit threads** (post + top comments via Arctic Shift), **subreddit digests**, **StackOverflow** (question + top answers via API), **HN threads** (via Firebase API), **Discourse** (`…json`), **text PDFs** (local extraction, page markers estimated), generic articles (tables kept as markdown), plus a public-reader fallback for 403/429 pages. |
| `web` providers `scout` | Also plugs into the built-in `web_search` / `web_fetch` tools, so they work with no key configured. |

## How it works

Transparent by design: plain `fetch()` + string parsing, zero npm dependencies, no tracking. One search-side memory (Google News headline bridge, 30 min) and one reader-side page cache (cleaned text, 10 min, 50 entries). Every backend is failure-isolated behind a circuit breaker — one throttled or changed endpoint never blanks a search.

```mermaid
flowchart TD
    Agent(["Any AI agent"]) -->|query + alternatives ≤4<br/>maxResults 3-5| S["scout_search<br/>freeSearch()"]

    S --> XV["Expand: query + variants<br/>each variant hits the same providers"]
    XV --> RT["Route per variant<br/>intent = explicit > scope > auto classify<br/>specials selected, reddit-pass gated"]

    subgraph Fanout ["Parallel fan-out — one failure never blanks the search"]
        RT --> K["Keyed / own-infra (optional)<br/>SearXNG first; Brave;<br/>Google CSE legacy-only"]
        RT --> N["Google News RSS<br/>keyless, always on"]
        RT --> D["DuckDuckGo HTML<br/>back off once on 429"]
        RT --> B["Bing RSS x2 (unofficial)<br/>normal + reddit-biased"]
        RT --> W["Specials by intent<br/>Wikipedia / HN / SO as routed"]
        RT --> A["Arctic Shift<br/>only if r/foo named"]
    end

    Fanout -->|per-backend timeout<br/>hung backend → empty, breaker trips| I["Fuse ONE union: RRF retrieval agreement<br/>same URL twice = easier to find, NOT confirmed<br/>canonical key: no tracking/www/amp"]
    I --> F["Domain + recency filters<br/>include / exclude hosts · auto..year"]
    F --> R["Intent-aware rerank<br/>lexical title x3 + snippet dominates<br/>small intent × type prior + capped agreement<br/>+ diversity · dated-first inside a window"]
    R --> T["Trim + sanitize snippets<br/>~220 chars · strip bidi/zero-width"]
    T --> Hits["Compact hits + provenance + health<br/>[SRn] title + URL + snippet + date<br/>domain · source type · providers<br/>partial / unavailable explicit in meta"]

    Hits --> Pick{"Agent picks 1-2 URLs"}
    Pick -->|url + query| RD["scout_read<br/>freeRead()"]

    subgraph Reader ["Reader chain — fast-paths first, cached 10 min"]
        RD --> Guard["SSRF guard + per-hop<br/>redirect validation"]
        Guard --> Cache["Page cache<br/>follow-ups skip re-fetch"]
        Cache --> Fast["Fast-paths<br/>Reddit Arctic / SO API<br/>HN Firebase / Discourse .json<br/>Google News bridge"]
        Fast -->|hit > 80 chars| Lean
        Fast -->|miss| Gen["Generic HTML<br/>strip nav, prefer article/main<br/>tables → markdown"]
        Gen -->|pdf| PDF["PDF text locally<br/>uncompressed + Flate, no deps<br/>page markers estimated"]
        PDF --> Lean
        Gen -->|ok| Lean["Lean output + paging<br/>highlights ~1/5 · text + budget<br/>find matches + cursor · links list"]
        Gen -->|403 / 429 / thin| Jina["Public reader fallback r.jina.ai<br/>jinaFallback: false to skip<br/>signed URLs refused fail-closed"]
        Jina --> Lean
    end

    Lean --> Answer(["Cited answer<br/>untrusted data, never instructions"])
    Lean -.->|"answer missing:<br/>follow a link, or<br/>re-search with alternatives"| S
```

Lean rule: **highlights-first, never both views at once** — `view: 'highlights'` needs `query` (extractive, order preserved), `tokenBudget` caps at `budget × 4` chars on a sentence boundary. `view: 'links'` returns the page's link list (anchor + URL + internal/external) for traversal — follow subpages without guessing URLs. `find: 'phrase'` locates exact passages with section + offset + context (page `findCursor` for more matches) and wins over `view` when both are given. `links` and `find` run over the **full cached source**, not an offset window; output caps still apply. `<table>`s survive as compact markdown.

## Install (this profile)

Already installed as a linked bundle (`scout-dsh`). After any code change:

1. **Restart the DSH app** (the host requires a restart to load plugin updates — the installer reports `restart-required`).
2. Verify: `mount-status.json` (next to `index.js`) appears after boot, e.g.
   `{"build": "0.5.0", "searchProvider": "registered", "tools": {"scout_search": "registered-via-…", …}}`.
3. Tools `scout_search` / `scout_read` are now available to agents, and `web_search` keeps working even with no `ANYSEARCH_API_KEY`.

Fresh install elsewhere:

```powershell
# from the plugin folder
dsh plugin add ./Scout-dsh
# or: DSH GUI → Settings → Plugins → Install → pick the folder
```

Or raw npm-style (after publishing):

```powershell
npm install ./Scout-dsh
```

Then restart `dsh web` (or reload the profile). Tools `scout_search` / `scout_read` appear, and `web_search` keeps working even with no `ANYSEARCH_API_KEY`.

## Providers: free-first ladder (Google CSE is legacy)

Scout is provider-agnostic. The serving order per search:

1. **Optional keyed backends** (skipped when no keys are set)
   - **Brave Search API** — the recommended keyed primary. Export `BRAVE_API_KEY`
     (~$5/mo free credits, then ~$5/1k requests). Slots in **first**, ahead of
     all keyless backends (a configured SearXNG goes ahead of it); if it ever fails, the keyless backends still cover.
   - **Google Custom Search (CSE) — legacy only.** Google closed the CSE JSON API
     to new customers, and existing customers must migrate off it by
     **January 1, 2027**. Kept working for keys issued earlier (set `googleCx`
     + export `GOOGLE_API_KEY`); do not build new setups around it.
2. **Free/keyless backends (always on)** — DuckDuckGo HTML (general web, handles
   `site:` natively), Google News RSS (real Google coverage for news/current,
   no signup), Bing RSS (general web + the reddit-biased pass — note this is an
   **unofficial public endpoint**, not the retired keyed Bing Search API, and can
   change or be blocked without notice).
3. **Specialized free sources** — Wikipedia OpenSearch, HN Algolia, StackExchange
   API, Arctic Shift (Reddit full-text, only when a subreddit is named).
4. **Optional self-hosted metasearch** — SearXNG via `searxngUrl` config or
   `SEARXNG_URL` env (empty = off). Slots in first when set, failure-isolated
   like every other backend. The instance URL is operator-trusted config;
   result URLs stay untrusted and still go through the SSRF-guarded reader.

Why not scrape google.com? Its HTML is a JS shell — results render
client-side, so plain-HTTP scraping returns zero links. News RSS is the honest
keyless Google backend; Brave is the honest keyed one.

## Keyed providers (optional): Brave primary, Google CSE legacy

Keyless HTML/RSS endpoints are undocumented and can change or be blocked
without notice. If that happens — or you just want better relevance — export
`BRAVE_API_KEY` (configure the env name via `braveApiKeyEnv`). Brave's Web
Search API then slots in **first**, ahead of all keyless backends; if it ever
fails, the keyless backends still cover. Same pattern fits any future keyed
provider (Serper, etc.): one `searchX()` function + one entry in the backend
list, failure-isolated by the same circuit breaker.

A local daily counter also guards the legacy Google CSE quota (~95/day) for
setups that still carry an old key; News RSS covers the rest. New setups
should use Brave, not CSE.

## Config

All optional (defaults work, tuned for low tokens):

- `maxResults` (default 8) — search result cap 1–20 (use 3–5 to save tokens)
- `snippetChars` (default 220, 80–500) — per-snippet cap; smaller = fewer tokens
- `rerank` (default true) — RRF fusion + heuristic rerank with per-source diversity guard
- `alternatives` (default `''`) — up to 4 alternate queries, newline-separated; every variant searches, one fused/deduped/reranked list returns (a 5th errors)
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

Search health travels with every call: `providersAttempted/Succeeded/Failed[], partial, unavailable` (+ `variants[]`, resolved `recency` and `intent`). `partial` = degraded coverage with a `Partial results:` footer naming the failed backends; `unavailable` = nothing served (an explicit outage message, never an empty-looking list). Empty results and provider failure are different states.

Reader output: `# title` + mode header (`highlights for "…"`, `find "…" · N match(es)`, `page links`, `full text`) + engine + token estimate, then the content, then `Source: url`. Find matches carry `section · offset` plus a `findCursor` when more remain; long reads carry `offset=N` with the guarantee that concatenated windows reconstruct the source exactly.

## Lean workflow (cheapest first — for humans and agents)

1. `scout_search` with `maxResults: 3-5` → compact hits with `~N tokens` counts and dates (`· 2026-03-06`) where known. Every hit carries a stable `[SRn]` id plus domain and source type (`official-docs|reference|news|community|aggregator|unknown`) — cite the URL. Provider outages surface as a `Partial results:` footer (or an explicit all-failed message), never as silent thin results. For hard questions add `alternatives` (up to 4 reformulations, one per line) — variants fan out, one fused ranking returns. `recency` defaults to `auto` (detects current-topic hints); set it explicitly only to override.
2. `scout_read { url, query, view: 'highlights' }` → extractive excerpts (~1/5 tokens). Needs both `query` + `view`.
3. Follow-ups are free: the cleaned page is cached 10 min, so a second question costs no re-fetch. Long pages say `Continue with offset=N` — pass it back to page through.
4. Only if the answer is missing: re-read with `view: 'text'` + `tokenBudget: 2000`.
5. Never request both views at once (paid APIs bill twice for the same reason).

**Multi-hop loop (hard questions):** search → read 1–2 hits with highlights → `find` the exact passage → if the answer lives deeper, `view: 'links'` and open the subpage (no URL guessing) → if the rankings missed, re-search with `alternatives` reformulations. Every step is token-capped; the page cache makes follow-ups free.

## How it reads Reddit / forums

1. `reddit.com/…/comments/…` → Arctic Shift (post + top comments; reddit.com 403s anonymous `.json`, so Arctic is the real path).
2. Subreddit homepages → recent-posts digest via Arctic.
3. StackOverflow / StackExchange questions → question + top answers via the free API (direct HTML 403s bots).
4. HN items → story + top comments via the Firebase API.
5. Discourse `/t/slug/id` → tries `…json`, returns topic + first 10 posts.
6. Anything else → fetches HTML with a browser UA, strips nav/script/footer, prefers `<article>`/`<main>`, converts to markdown-ish text (tables kept as markdown).
7. PDFs → local text extraction (no deps): uncompressed + Flate streams, page markers estimated. Encrypted or scanned-image PDFs fail with a clear error instead of junk.
8. Blocked (403/429/empty) → retries through the public reader proxy (`r.jina.ai`, no key) — see the privacy note in Config.

Private/local targets are refused — SSRF guard covers IPv4 (incl. hex/octal forms, `0.0.0.0`, CGNAT `100.64/10`), IPv6 (loopback, link-local, unique-local, mapped), `.localhost/.local/.internal`, dotless hosts, and re-validates every redirect hop.

## Limits (honest)

- Keyless Google = News RSS (fresh/current queries shine; obscure `site:` scoping is weaker — Brave covers full-web relevance; the legacy CSE key path works only for pre-existing keys until 2027-01-01).
- Keyed Bing Search APIs were retired by Microsoft (2025-08-11) — Scout's Bing RSS backend is a separate unofficial public endpoint, kept failure-isolated like every other keyless backend.
- DuckDuckGo throttles aggressive IPs (429/202) — a circuit breaker skips a throttled backend for ~3 min instead of paying a backoff on every search; other backends cover meanwhile. Suspect queries degrade to honest-empty rather than junk (Bing results must share a query term; DDG ad links are dropped).
- Live retrieval precision varies by backend: Bing RSS has loose OR-semantics, so ambiguous queries surface noise (e.g. "Studio" pulls YouTube Studio above Android Studio). Ranking demotes junk but can't conjure precision the backends didn't return — this is what the planned agent A/B benchmark measures.
- Bot-walled official docs are the hardest pages to read: `developer.android.com` 403s direct fetch, and the Jina fallback is keyless-rate-limited (~20 req/min) and itself sometimes blocked. The most authoritative sources have the thinnest coverage — the known ceiling, not a bug.
- No academic (arXiv/Crossref) or code-search backend yet; `searchScope: code` maps to technical with nothing behind it.
- PDF text has ligature breakage ("Intr oduction", "netw orks") that can defeat `find`/highlights term matching; page numbers are positional estimates.
- English-first throughout (`hl=en-US` defaults); non-English queries are underserved.
- The extra reddit-biased Bing pass runs only for opinion/experience queries (or `redditBias: 'on'`) — factual queries aren't forum-biased and Bing isn't hit twice.
- Specials route by query intent (`intent: auto` classifies; override with `intent` or coarse `searchScope`): factual → web + Wikipedia · technical → web + StackOverflow + HN · opinion → web + reddit-pass + HN (+ Arctic when you name `r/foo`) · current/news → web backends (Google News RSS rides along) · research → web + Wikipedia + SO · academic → web + Wikipedia · generic → web only. Web backends always run, so a misclassification costs depth, never the whole search. Ranking adds a small intent × source-type prior (docs win technical, forums win opinion) that never swamps lexical relevance.
- Same URL in two engines fuses by Reciprocal Rank Fusion (canonical key strips tracking params, `www.`, `http/https`, AMP variants) — but read it as **retrieval agreement** (easy to find), not independent confirmation: same-host multi-provider hits report `providerCount` separately from `independentHostCount`, and the rerank agreement bonus is capped so it can never swamp lexical relevance. A canonical miss can still duplicate; the heuristic rerank sits on top, not instead.
- Dates come from backends that expose them (News/Bing RSS, HN, SO, Arctic); DDG/Wikipedia/CSE don't, and undated results are kept under `recency` filters rather than dropped.
- Reddit's own `.json` 403s without OAuth (Arctic covers threads; very fresh posts take a while to index).
- No JS rendering — heavy SPA pages return their static HTML text. Text PDFs are extracted locally (uncompressed + Flate streams, page numbers estimated); scanned-image and encrypted PDFs fail honestly instead of returning junk.
- Token counts are `chars/4` estimates: fine for English budgeting, overcounts CJK and code — never presented as precise.
- SSRF honesty: no raw-socket DNS pinning without extra deps, so DNS-rebinding inside a short TTL is mitigated (short timeouts + per-hop validation), not eliminated.
- Zero npm dependencies, Node 20+.

## Test

```powershell
# Offline (no network) — the quality gates, all must-pass:
npm test
# or per suite:
node ./test/lean-check.mjs      # L1: helpers, backend parsers, 20-URL canon, ranking fixtures (155 asserts)
node ./test/reader-check.mjs    # L2: 10 page fixtures, paging reconstruction, redirect-hop guard, links/find/tables/PDF
node ./test/ssrf-check.mjs      # L3: 59-case SSRF hard gate — any miss fails the build
node ./test/chaos-check.mjs     # L4: 1-down/2-down partial, all-down honest-empty, hang degraded, breaker skips
node ./test/ranking-bench.mjs   # L5 starter: 30 frozen queries, Recall@10 ≥ 0.85 gate + MRR/nDCG vs rerank:false
# Live backends + plugin mount:
node ./test/smoke.mjs "best android pomodoro apps reddit"
node ./test/check-plugin.mjs
```

The frozen bench measures the ranking layer only (golds are present in canned backend lists, so MRR/nDCG discriminate, not recall). Whether agents solve more tasks is tracked separately as a paired live A/B benchmark — the gates above are regression guards, not proof.

---

Made with ✨ Muse Spark 1.3 Contributor ✨ — lean, transparent, and free for any agent.
