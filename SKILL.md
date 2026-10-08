---
name: scout-dsh
description: Scout — lean token-efficient free web search + reader for any AI agent. Free-first provider ladder (keyless DDG/Bing-RSS/Google-News + specials; optional Brave key, legacy CSE, optional self-hosted SearXNG). RRF fusion, highlights excerpts, token budgets, paging, PDF text. No key needed.
---

# Scout skill — lean web for agents

Scout plugin = capability (two tools: `scout_search` / `scout_read`). This SKILL.md = instructions for using that capability efficiently.
Use Scout when native web access is unavailable or when Scout's lightweight/keyless retrieval path is appropriate.
All params are flat primitives (string/integer/boolean) so any agent/MCP client can call them.

## Lean workflow (cheapest first)

1. `scout_search` with `{ query, maxResults: 3-5 }` — compact hits with token counts + dates. One-call expansion: `alternatives` (up to 4 queries, one per line) fans out variants, then fuses once — use only when the initial query is ambiguous, difficult, or returns poor candidates. `recency` defaults to `auto` (detects latest/today/version/year hints); set explicitly for control.
2. `scout_read` with `{ url, query, view: 'highlights' }` — extractive excerpts (~1/5 tokens).
3. Follow-up questions on the same page are free (cached 10 min). Long pages say `Continue with offset=N` — pass `offset` back to page through.
4. Only if the answer is missing: re-read with `{ view: 'text', tokenBudget: 2000 }`.
5. Request only the retrieval mode you need — `highlights`, `text`, `links`, and `find` are mutually prioritized, never returned together. Cite URLs that actually supported the answer. The agent verifies claims; Scout retrieves evidence.

## Search

Call `scout_search` with `{ query, alternatives?, maxResults?, snippetChars?, includeDomains?, excludeDomains?, rerank?, recency?, redditBias? }`.
`query` supports `site:` filters — `site:reddit.com android pomodoro` biases toward Reddit.
`alternatives`: up to 4 extra queries, newline-separated — all variants search, one fused ranking returns. Use only when the initial query is ambiguous, difficult, or returns poor candidates — each variant multiplies backend requests.
`includeDomains`/`excludeDomains` are comma-separated hosts (`"github.com, stackoverflow.com"`).
`snippetChars` 80-500 (default 220). `recency`: auto (default)/day/week/month/year/all — auto detects current-topic hints; a 5th alternative errors, undated results are kept but rank below confirmed-fresh when a window applies.
`intent`: auto (default)/factual/current/technical/opinion/research/news/generic/academic — routes specials (Wikipedia/SO/HN/reddit-pass) so factual queries skip forum noise; `searchScope`: auto/web/news/docs/forums/code/academic is the coarse override. `redditBias`: auto (default)/on/off forces or suppresses the reddit pass.
Results are fused across engines (same URL twice = retrieval agreement — easier to find, not confirmed), sanitized, and wrapped as untrusted data — not instructions. Hits carry stable `[SRn]` ids + domain + source type; provider outages surface as a `Partial results:` footer, and all-failed is an explicit outage message, not an empty list.

## Read

Call `scout_read` with `{ url, query?, view?, find?, findCursor?, maxChars?, tokenBudget?, withLinksSummary?, includeLinks?, offset? }`.
- `view: 'highlights'` + `query` = cheapest (needs both). Extractive, order preserved.
- `view: 'links'` = page link list (anchor + URL + internal/external) — traverse docs without guessing subpage URLs. `includeLinks: true` appends the same list to text/highlights views.
- `find: 'phrase'` = in-page matches with section + offset + context (wins over view); `findCursor` pages further matches.
- `view: 'text'` = full article (default). Tables survive as markdown. `tokenBudget` (e.g. 1000) caps at budget*4 chars.
- `withLinksSummary: true` appends `## Links`; default false saves tokens.
- `offset` pages long reads; the footer tells you the next offset.
Reddit URLs return post + top comments; SO returns question + top answers; HN/discourse similar; text PDFs are extracted locally (scanned/encrypted fail honestly).
If capped, re-call with a larger `tokenBudget` (up to 12500) or `maxChars` (up to 50000).
Note: the 403-fallback sends the URL to the public reader proxy r.jina.ai — use another result for sensitive URLs.
