# Scout

Google-first free web search + universal page reader for DSH. Built for us, by us.

## What you get

| Tool | What it does |
|---|---|
| `scout_search` | **Google first** (full Search API with free key, else Google News RSS) + DuckDuckGo HTML + Bing RSS (+ reddit-biased pass) + Wikipedia + HackerNews + StackExchange, plus **Arctic Shift** when you name a subreddit (`r/foo`). Handles `site:` queries. |
| `scout_read` | Reads a URL as clean text. **Reddit threads** (post + top comments via Arctic Shift), **subreddit digests**, **StackOverflow** (question + top answers via API), **HN threads** (via Firebase API), **Discourse** (`…json`), generic articles, plus a public-reader fallback for 403/429 pages. |
| `web` providers `scout` | Also plugs into the built-in `web_search` / `web_fetch` tools, so they work with no key configured. |

## Install (this profile)

Already installed as a linked bundle (`scout-dsh`). After any code change:

1. **Restart the DSH app** (the host requires a restart to load plugin updates — the installer reports `restart-required`).
2. Verify: `mount-status.json` (next to `index.js`) appears after boot, e.g.
   `{"build": "0.2.0", "searchProvider": "registered", "tools": {"scout_search": "registered-via-…", …}}`.
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

## Google: two tiers (primary engine)

`scout_search` always hits Google first, in this order:

1. **Full Google Search (needs the free key)** — set `googleCx` to your
   Programmable Search Engine ID and export `GOOGLE_API_KEY`. Getting both
   is free: [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   create an API key (restrict it to Custom Search API) → 100 queries/day at
   $0. Get the CX at [programmablesearchengine.google.com](https://programmablesearchengine.google.com/)
   (create an engine, enable "search the entire web"). The key is read per
   request, so exporting it needs no restart.
2. **Google News RSS (keyless, always on)** — real Google coverage with no
   signup. Best for news/current queries.

Why not scrape google.com? Its HTML is a JS shell — results render
client-side, so plain-HTTP scraping returns zero links. News RSS + the free
CSE tier are the honest free options, and both are wired in.

## Config

All optional (defaults work):

- `maxResults` (default 8) — search result cap 1–20
- `searchTimeoutMs` (default 12000)
- `fetchTimeoutMs` (default 15000)
- `maxChars` (default 12000, max 50000)
- `jinaFallback` (default true) — use the public text proxy when a page blocks direct fetch
- `googleApiKeyEnv` (default `'GOOGLE_API_KEY'`) — env var holding the free CSE key
- `googleCx` (default `''`) — Programmable Search Engine ID (empty = News RSS tier)

## How it reads Reddit / forums

1. `reddit.com/…/comments/…` → Arctic Shift (post + top comments; reddit.com 403s anonymous `.json`, so Arctic is the real path).
2. Subreddit homepages → recent-posts digest via Arctic.
3. StackOverflow / StackExchange questions → question + top answers via the free API (direct HTML 403s bots).
4. HN items → story + top comments via the Firebase API.
5. Discourse `/t/slug/id` → tries `…json`, returns topic + first 10 posts.
6. Anything else → fetches HTML with a browser UA, strips nav/script/footer, prefers `<article>`/`<main>`, converts to markdown-ish text.
7. Blocked (403/429/empty) → retries through the public reader proxy (no key).

Private targets (`localhost`, `10/8`, `192.168/16`, `169.254`, …) are refused — SSRF guard.

## Limits (honest)

- Keyless Google = News RSS (fresh/current queries shine; obscure `site:` scoping is weaker — add the free CSE key for full Google).
- DuckDuckGo throttles aggressive IPs (429/202) — the plugin backs off once, then other backends cover; suspect queries degrade to honest-empty rather than junk (Bing results must share a query term).
- Reddit's own `.json` 403s without OAuth (Arctic covers threads; very fresh posts take a while to index).
- No JS rendering — heavy SPA pages return their static HTML text.
- Zero npm dependencies, Node 20+.

## Test without DSH (run from the plugin folder)

```powershell
node ./test/smoke.mjs "best android pomodoro apps reddit"
node ./test/smoke.mjs --read https://www.reddit.com/r/androidapps/comments/xxxxx/
```
