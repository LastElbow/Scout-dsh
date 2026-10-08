# AGENTS.md

Scout — lean, token-efficient free web search + reader. A DSH plugin
(`scout_search` / `scout_read`) that also backs the built-in `web_search` /
`web_fetch` tools. Zero npm dependencies, plain `fetch()` + string parsing,
no API key required.

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
