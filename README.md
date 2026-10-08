# Scout — lean web search + reader for AI agents

**Free-first, provider-agnostic web search and page reader for AI agents.** Token-efficient by design: highlights-first excerpts, reranked snippets, token budgets. Flat string/integer/boolean params so DSH, MCP, or OpenAI-style function calling can all use it. No API key needed.

**Scout 0.5 is a lightweight evidence retrieval layer for agents, not a search engine.** **Scout exposes two tools around six retrieval capabilities:** **SEARCH** candidate sources · **READ** evidence · **FIND** exact passages · follow **LINKS** to deeper sources · inspect **PROVENANCE** · support agent-led **VERIFICATION**. No internal LLM, no summarizer — cheap deterministic plumbing plus agent-facing affordances. Zero npm dependencies, plain `fetch()` + string parsing, no tracking.

## Why Scout?

Many AI agents have reasoning and tool-calling capabilities but no usable web access in every deployment. Scout provides a lightweight, keyless web retrieval layer so the **agent can decide when and how to gather external information**. Scout does not plan research, summarize findings, or make decisions for the model.

```text
Agent decides what to do.
Scout retrieves the information.
Agent reasons over it.
```

## What you get

| Tool | What it does |
|---|---|
| `scout_search` | Keyless-first web search (DDG + Google News RSS + Bing RSS + Wikipedia/HN/StackExchange/Reddit specials, optional Brave key or self-hosted SearXNG). `site:` support, `alternatives` expansion, provenance + health on every call. |
| `scout_read` | Clean page text with `text` / `highlights` (~1/5 tokens) / `links` / `find` modes, plus Reddit, StackOverflow, HN, Discourse, PDF, and article fast-paths. |
| `web` providers `scout` | Also backs the built-in `web_search` / `web_fetch` tools, so they work with no key configured. |

Details: [agent usage](docs/agent-usage.md) · [providers](docs/providers.md) · [architecture](docs/architecture.md).

## Quick start

1. `scout_search` with `maxResults: 3-5` → compact `[SRn]` hits with dates, domains, and source types. Add `alternatives` (up to 4) only when the query is ambiguous or the first ranking missed.
2. `scout_read { url, query, view: 'highlights' }` → extractive excerpts. Follow-ups on the same page are cached 10 min and free; long pages page with `offset=N`.
3. Hard question loop (agent-led): search → read 1–2 hits → `find` the passage → follow `links` deeper → re-search if needed. Scout never runs this loop itself.

Full workflow, config, and output contracts: [docs/agent-usage.md](docs/agent-usage.md).

## Health contract

**Empty results and provider failure are different states.** `No results found` means there may be no result; `Partial results:` / explicit outage means search infrastructure is degraded. Provider outages surface as a footer naming the failed backends, never as silent thin results.

## Providers in brief

Works keyless out of the box. Optional `BRAVE_API_KEY` slots in first for better relevance; Google CSE is legacy-only (closed to new customers, off by 2027-01-01); optional self-hosted SearXNG slots ahead of everything. Full ladder and honest backend limits: [docs/providers.md](docs/providers.md).

## Honest limits (teaser)

- Keyless endpoints are undocumented and can change; every backend is failure-isolated so one outage never blanks a search.
- Bot-walled official docs are the hardest pages to read (direct 403 + rate-limited fallback) — the known ceiling, not a bug.
- No JS rendering; English-first; token counts are `chars/4` estimates.

Security model (SSRF guard, Jina privacy, fail-closed signed URLs): [docs/security.md](docs/security.md).

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

## Docs

| Page | What's there |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Pipeline diagram, fusion/rerank, caches, circuit breaker, retrieval modes |
| [docs/providers.md](docs/providers.md) | Free-first ladder, Brave/CSE/SearXNG, intent routing, backend limits |
| [docs/agent-usage.md](docs/agent-usage.md) | Full config, output contracts, lean workflow, forum/PDF reading |
| [docs/benchmarks.md](docs/benchmarks.md) | Test gates, regression vs agent benchmark, pilot results |
| [docs/security.md](docs/security.md) | SSRF guard, fallback privacy, honest limits |

## Test

```powershell
npm test   # offline quality gates (L1–L5), all must-pass
```

Suites, frozen ranking bench, and the pilot agent benchmark: [docs/benchmarks.md](docs/benchmarks.md). The gates are regression guards, not proof.

---

Made with ✨ Muse Spark 1.3 Contributor ✨ — lean, transparent, and free for any agent.
