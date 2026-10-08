# Providers — free-first ladder (Google CSE is legacy)

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

## Intent routing

Specials route by query intent (`intent: auto` classifies; override with `intent` or coarse `searchScope`): factual → web + Wikipedia · technical → web + StackOverflow + HN · opinion → web + reddit-pass + HN (+ Arctic when you name `r/foo`) · current/news → web backends (Google News RSS rides along) · research → web + Wikipedia + SO · academic → web + Wikipedia · generic → web only. Web backends always run, so a misclassification costs depth, never the whole search.

- The extra reddit-biased Bing pass runs only for opinion/experience queries (or `redditBias: 'on'`) — factual queries aren't forum-biased and Bing isn't hit twice.
- Arctic Shift runs only when you name a subreddit (`r/foo`).

## Honest backend limits

- Keyless Google = News RSS (fresh/current queries shine; obscure `site:` scoping is weaker — Brave covers full-web relevance; the legacy CSE key path works only for pre-existing keys until 2027-01-01).
- Keyed Bing Search APIs were retired by Microsoft (2025-08-11) — Scout's Bing RSS backend is a separate unofficial public endpoint, kept failure-isolated like every other keyless backend.
- DuckDuckGo throttles aggressive IPs (429/202) — a circuit breaker skips a throttled backend for ~3 min; other backends cover meanwhile.
- No academic (arXiv/Crossref) or code-search backend yet; `searchScope: code` maps to technical with nothing behind it.
- Reddit's own `.json` 403s without OAuth (Arctic covers threads; very fresh posts take a while to index).
- Bot-walled official docs are the hardest pages to read: `developer.android.com` 403s direct fetch, and the Jina fallback is keyless-rate-limited (~20 req/min) and itself sometimes blocked. The most authoritative sources have the thinnest coverage — the known ceiling, not a bug.
