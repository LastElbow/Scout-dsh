# Scout

Lean evidence retrieval plumbing for otherwise web-blind AI agents.

## Language

**Agent**:
The AI caller that decides when, what, and how deeply to search, and what the evidence means.
_Avoid_: user, host, model

**Scout**:
The plugin that finds, fetches, extracts, compresses, caches, and returns web evidence without judging it.
_Avoid_: search engine, summarizer, answerer

**Evidence**:
Untrusted external content returned with its source URL.
_Avoid_: answer, result, fact

**Provenance**:
The domain, source type, providers, and dates attached to evidence so the agent can judge it.
_Avoid_: ranking, verdict, credibility score
