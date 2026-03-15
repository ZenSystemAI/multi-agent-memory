# Changelog

## 1.2.0

### Entity Extraction & Linking
- **Automatic entity extraction** — memories extract entities (clients, technologies, workflows, people, domains, agents) at storage time using fast regex + known-tech dictionary. No LLM call, non-blocking (fire-and-forget).
- **Entity graph** — new `entities`, `entity_aliases`, and `entity_memory_links` tables in SQLite/Postgres. Alias resolution enables canonical entity deduplication.
- **LLM entity refinement** — consolidation engine discovers entities regex missed, normalizes aliases, classifies types. Alias cache refreshes after each run for compounding accuracy.
- **Qdrant native entity filtering** — `entities[].name` payload index enables entity-scoped vector search with no result-count ceiling. `GET /memory/search?entity=Docker` filters at the Qdrant level.
- **Shared `linkExtractedEntities`** — single function for entity find-or-create-then-link, used by memory store, webhook, and backfill.
- **New `brain_entities` MCP tool** — list, get, memories, stats actions for the entity graph.
- **New API endpoints** — `GET /entities`, `GET /entities/stats`, `GET /entities/:name`, `GET /entities/:name/memories`.
- **Briefing entity summary** — `GET /briefing` includes `entities_mentioned` in summary.
- **Stats entity counts** — `GET /stats` includes entity breakdown by type and top-mentioned.
- **Backfill script** — `api/scripts/backfill-entities.js` extracts entities from all existing memories.

### Bug Fixes
- **Fixed `scrollPoints` filter bug** — boolean `false` values (e.g. `{consolidated: false}`) were silently dropped, causing consolidation to reprocess all memories instead of only unconsolidated ones.
- **Fixed Postgres `createEntity` race condition** — concurrent inserts for the same entity now use `ON CONFLICT` upsert instead of SELECT-then-INSERT.
- **Fixed `brain_entities` validation** — `get` and `memories` actions now return an error when `name` is missing instead of silently falling through to `list`.
- **Removed user input echo from error responses** — 404/400 errors no longer reflect request parameters.

## 1.1.0

- Consolidation dedup: exact hash + 92% semantic similarity
- Gemini 2.5 Flash consolidation provider
- Webhook deduplication
- Event TTL auto-cleanup (configurable, default 30 days)
- Docker health check fixes

## 1.0.2

- Expanded npm keywords for better discoverability
- Improved package description
- Added Qdrant request timeout (default 10s, configurable via `QDRANT_TIMEOUT_MS`)
- Webhook now surfaces structured store warnings instead of silently swallowing errors
- Added troubleshooting section to README
- Added `brain_consolidate` and `brain_stats` usage examples to README
- CI now validates MCP server entrypoint
- Version alignment between package.json and MCP server registration

## 1.0.1

- Initial npm publish with README

## 1.0.0

- Initial release
