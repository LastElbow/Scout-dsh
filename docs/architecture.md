# Architecture — how Scout works

Scout is deterministic plumbing: plain `fetch()` + string parsing, zero npm dependencies, no tracking, no internal LLM, no summarizer. The [agent](../GLOSSARY.md) decides what to do; Scout finds, fetches, extracts, compresses, caches, and returns [evidence](../GLOSSARY.md) with [provenance](../GLOSSARY.md) so the agent can judge it. See `adr/0001-agent-owns-judgment-scout-owns-plumbing.md` for the change gate.

## Pipeline

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

## Retrieval modes

**Request only the retrieval mode you need.** `highlights`, `text`, `links`, and `find` are mutually prioritized; Scout never returns multiple full representations of the same page in one response — `view: 'highlights'` needs `query` (extractive, order preserved), `tokenBudget` caps at `budget × 4` chars on a sentence boundary. `view: 'links'` returns the page's link list (anchor + URL + internal/external) for traversal — follow subpages without guessing URLs. `find: 'phrase'` locates exact passages with section + offset + context (page `findCursor` for more matches) and wins over `view` when both are given. `links` and `find` run over the **full cached source**, not an offset window; output caps still apply. `<table>`s survive as compact markdown.

## Fusion and ranking

- Same URL in two engines fuses by Reciprocal Rank Fusion (canonical key strips tracking params, `www.`, `http/https`, AMP variants) — but read it as **retrieval agreement** (easy to find), not independent confirmation: same-host multi-provider hits report `providerCount` separately from `independentHostCount`, and the rerank agreement bonus is capped so it can never swamp lexical relevance. A canonical miss can still duplicate; the heuristic rerank sits on top, not instead.
- Ranking: lexical title ×3 + snippet dominates; a small intent × source-type prior (docs win technical, forums win opinion) never swamps lexical relevance; per-source diversity guard; dated-first inside a window. `rerank: false` disables fusion + heuristic rerank for A/B comparisons.
- Live retrieval precision varies by backend: Bing RSS has loose OR-semantics, so ambiguous queries surface noise (e.g. "Studio" pulls YouTube Studio above Android Studio). Ranking demotes junk but can't conjure precision the backends didn't return.

## Caches and isolation

- One search-side memory (Google News headline bridge, 30 min) and one reader-side page cache (cleaned text, 10 min, 50 entries). Follow-up questions on the same page cost no re-fetch.
- Every backend is failure-isolated behind a circuit breaker with per-backend timeouts — one throttled or changed endpoint never blanks a search. A throttled DuckDuckGo backend is skipped for ~3 min instead of paying a backoff on every search; other backends cover meanwhile.
- Suspect queries degrade to honest-empty rather than junk (Bing results must share a query term; DDG ad links are dropped).

## Dates and provenance

Dates come from backends that expose them (News/Bing RSS, HN, SO, Arctic); DDG/Wikipedia/CSE don't, and undated results are kept under `recency` filters rather than dropped. With any window (explicit or auto-resolved), confirmed-fresh results outrank `date: unknown`. `sourceType` (`official-docs|reference|news|community|aggregator|unknown`) is a coarse label for judging provenance, not a verdict.

## Honest ceilings

- No JS rendering — heavy SPA pages return their static HTML text.
- English-first throughout (`hl=en-US` defaults); non-English queries are underserved.
- Token counts are `chars/4` estimates: fine for English budgeting, overcounts CJK and code — never presented as precise.
- PDF text has ligature breakage ("Intr oduction", "netw orks") that can defeat `find`/highlights term matching; page numbers are positional estimates.
- Zero npm dependencies, Node 20+.
