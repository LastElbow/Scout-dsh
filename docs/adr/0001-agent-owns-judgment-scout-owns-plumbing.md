# Agent owns judgment, Scout owns plumbing

Scout is a lightweight evidence retrieval layer for otherwise web-blind agents, not a strongest-search-engine contender. The agent owns judgment; Scout owns plumbing — this separation is the change gate for every future addition.

Agent owns: when to search, what to search, how deeply to search, which sources matter, whether to search again, what the evidence means, what decision to make. Scout owns: finding, fetching, extracting, compressing, caching, returning. Scout never summarizes with an LLM, never loops re-searches by itself, never issues credibility verdicts.

## Change gate

Every change or addition must pass: does it move judgment into Scout? If yes, reject it unless it is (a) additive not exclusive — web backends always run, (b) capped so lexical relevance still dominates, (c) explicitly overridable by the agent (`intent`, `searchScope`, `recency`, `redditBias`, `includeDomains`/`excludeDomains`, `rerank:false`), and (d) transparent in output (`meta.intent`, resolved recency, `providersFailed[]`, `partial`/`unavailable`, provenance per hit).

## Considered Options

Strongest-plugin path: LLM rerank, query rewriting, auto re-search loops, answer synthesis, credibility scoring. Rejected: it trades away zero-deps, token-leanness, determinism, and the agent's control for relevance points Scout doesn't need.

## Consequences

Currently allowed grey areas under the gate above: intent-routed specials + small intent × source-type prior, `matchesQuery` junk filter, RRF + heuristic rerank, auto `recency`/`redditBias` with dated-first inside a window, workflow hints in tool text. Any proposal to strengthen these (bigger priors, dropping undated, hiding backends, model judgment) must re-justify against this ADR, not slip in as tuning.
