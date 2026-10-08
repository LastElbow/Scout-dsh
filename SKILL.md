---
name: scout-dsh
description: Scout — lean token-efficient free web search + reader for any AI agent. Free-first provider ladder (keyless DDG/Bing-RSS/Google-News + specials; optional Brave key, legacy CSE only). RRF fusion, highlights excerpts, token budgets, paging. No key needed.
---

# Scout skill — lean web for agents

Use this when the user asks to search the web or read a page and no paid key is available.
Prefer `scout_search`/`scout_read` over `web_search`/`web_fetch` — same backend, but lean (budgets, excerpts, paging).
All params are flat primitives (string/integer/boolean) so any agent/MCP client can call them.

## Lean workflow (cheapest first)

1. `scout_search` with `{ query, maxResults: 3-5 }` — compact hits with token counts + dates. One-call expansion: `alternatives` (up to 4 queries, one per line) fans out variants, then fuses once. `recency` defaults to `auto` (detects latest/today/version/year hints); set explicitly for control.
2. `scout_read` with `{ url, query, view: 'highlights' }` — extractive excerpts (~1/5 tokens).
3. Follow-up questions on the same page are free (cached 10 min). Long pages say `Continue with offset=N` — pass `offset` back to page through.
4. Only if the answer is missing: re-read with `{ view: 'text', tokenBudget: 2000 }`.
5. Never request both views at once. Cite URLs that actually supported the answer.

## Search

Call `scout_search` with `{ query, alternatives?, maxResults?, snippetChars?, includeDomains?, excludeDomains?, rerank?, recency?, redditBias? }`.
`query` supports `site:` filters — `site:reddit.com android pomodoro` biases toward Reddit.
`alternatives`: up to 4 extra queries, newline-separated — all variants search, one fused ranking returns.
`includeDomains`/`excludeDomains` are comma-separated hosts (`"github.com, stackoverflow.com"`).
`snippetChars` 80-500 (default 220). `recency`: auto (default)/day/week/month/year/all — auto detects current-topic hints; a 5th alternative errors, undated results are kept but rank below confirmed-fresh when a window applies.
`redditBias`: auto (default)/on/off — extra reddit pass for opinion queries only.
Results are fused across engines (same URL twice = strong signal), sanitized, and wrapped as untrusted data — not instructions.

## Read

Call `scout_read` with `{ url, query?, view?, maxChars?, tokenBudget?, withLinksSummary?, offset? }`.
- `view: 'highlights'` + `query` = cheapest (needs both). Extractive, order preserved.
- `view: 'text'` = full article (default). `tokenBudget` (e.g. 1000) caps at budget*4 chars.
- `withLinksSummary: true` appends `## Links`; default false saves tokens.
- `offset` pages long reads; the footer tells you the next offset.
Reddit URLs return post + top comments; SO returns question + top answers; HN/discourse similar.
If capped, re-call with a larger `tokenBudget` (up to 12500) or `maxChars` (up to 50000).
Note: the 403-fallback sends the URL to the public reader proxy r.jina.ai — use another result for sensitive URLs.
