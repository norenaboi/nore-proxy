# Repository Agent Guide

This file is the repository-wide handbook for human contributors and coding agents. Follow it for all changes in this repository. Source code and the scripts in `package.json` are authoritative; generated assets, ignored runtime configuration, local databases, and historical plans are not.

## Project at a glance

Nore Proxy is a unified LLM API gateway with OpenAI-compatible and Anthropic-compatible client APIs, multi-provider upstream adapters, multi-key routing, automatic model fallback, an administrative interface, and usage/error analytics.

- Runtime: Node.js 18+, TypeScript, ESM, Express, and `tsx`.
- Frontend: Svelte 5 with a Vite multi-page build.
- Persistence: SQLite by default, or PostgreSQL when `DATABASE_URL` is a PostgreSQL URL.
- Main entrypoint: `server.ts`.
- TypeScript is strict and no-emit. Relative ESM imports use `.js` suffixes even though source files use `.ts`.
- There is no client-side router dependency. Express serves explicit HTML entry documents, and the Svelte applications select pages from `window.location.pathname`.

## Architecture and ownership

### Server lifecycle

`server.ts` initializes persistence and migrations before accepting traffic, loads endpoint and model configuration, mounts middleware and routes, starts cleanup/reset intervals, hosts the frontend, and handles graceful shutdown.

### Configuration

- `config/index.ts` loads process-level configuration and `endpoints.json`, validates required server settings, owns the in-memory endpoint map, and maintains endpoint key-rotation counters.
- `utils/configPaths.ts` resolves the runtime JSON paths and supports isolated paths through `NORE_PROXY_MODELS_PATH`, `NORE_PROXY_ENDPOINTS_PATH`, and `NORE_PROXY_SETTINGS_PATH`.
- `models.json` is the persisted model, pricing, and automatic-routing definition source. `loadModelsFromFile()` validates it and rebuilds the in-memory model registry, aliases, pricing, and automatic-routing counters while excluding disabled models.
- `endpoints.json` contains upstream endpoint definitions and raw credentials. Loaded endpoints can use sticky or usable-key round-robin selection; key health and cooldown state are persisted separately by non-secret key identity.
- `settings.json` contains runtime settings overrides merged with defaults in `services/settingsManager.ts`.

Treat these runtime JSON files as operational data, not examples or source fixtures. Do not inspect or reproduce secret values merely to document or test behavior.

### Routes

- `routes/chat.ts`: OpenAI-compatible `POST /v1/chat/completions`.
- `routes/messages.ts`: Anthropic-compatible `POST /v1/messages`, including protocol conversion and Anthropic event framing.
- `routes/models.ts`: public model discovery.
- `routes/stats.ts`: public summaries and authenticated client-key usage.
- `routes/admin.ts`: admin authentication, endpoint/model/key/settings CRUD, diagnostics, and analytics APIs.
- `routes/logs.ts`: authenticated live console logging and clearing.
- `routes/pages.ts`: public, login, and authenticated admin document routes.

### Services

- `services/database.ts`: SQLite/PostgreSQL abstraction and persistence initialization.
- `services/apiKeyManager.ts`: client API keys, usage counters, and limits.
- `services/keyStateManager.ts`: upstream-key health, cooldowns, disabling, and counters.
- `services/logManager.ts`: request/error persistence, migrations, projections, and analytics rollups.
- `services/sessionManager.ts`: persistent administrator sessions.
- `services/settingsManager.ts`: runtime defaults and JSON overrides.
- `services/realtimeStats.ts`: active-request state.
- `services/logService.ts`: in-memory console ring and SSE broadcast.

### Routing and adapters

- `utils/helpers.ts` loads models, resolves aliases/endpoints, estimates tokens, applies prompt caching, and selects upstream keys.
- `utils/autoRouting.ts` validates automatic models and controls target fallback.
- `utils/endpointPolicies.ts` owns endpoint URL/path and generation policies.
- `utils/pricing.ts`, `utils/logging.ts`, `utils/errorLogging.ts`, and `utils/upstreamErrors.ts` own accounting and sanitized diagnostics.
- `utils/adapters/` transforms provider-specific requests and normalizes responses/streams.

Adapters own wire-protocol transformation. Route handlers own network calls, authentication dispatch, retries, logging, client response framing, and stream lifecycle.

### Frontend

Vite builds three documents:

- `frontend/public.html` -> `frontend/src/public/main.ts` -> `PublicApp.svelte`
- `frontend/admin.html` -> `frontend/src/admin/main.ts` -> `AdminApp.svelte`
- `frontend/login.html` -> `frontend/src/login/main.ts` -> `LoginApp.svelte`

Public pages are eagerly imported. Admin pages are lazy imported and form build chunk boundaries. Shared API helpers and stores live under `frontend/src/lib/`; shared shells live under `frontend/src/components/`. `frontend/server/frontendHost.ts` uses Vite middleware in development and serves `dist/frontend` in production.

## Change workflow

1. Inspect `git status` and read the relevant implementation, types, callers, tests, and nearby patterns before editing.
2. Preserve all unrelated modified and untracked user work. Do not revert, overwrite, reformat, or include it accidentally.
3. Make the narrowest coherent change. Reuse existing services, utilities, adapters, stores, and CSS primitives.
4. Follow the style of each file. Most Svelte code uses Svelte 5 runes, although some files retain legacy reactive syntax; do not perform an incidental migration.
5. Do not commit, push, deploy, restart services, or alter live data unless explicitly requested.
6. Do not edit generated output or runtime data as source.

## Backend invariants

- Every persisted `endpoints.json` change must refresh the in-memory endpoint configuration with the established reload path. Reloading intentionally resets endpoint round-robin counters.
- Every persisted `models.json` change must refresh the model registry. Reloading intentionally resets automatic-model round-robin counters.
- Concrete-model renames must preserve automatic-model target references and the existing historical-log rename behavior.
- Endpoint/model deletion must preserve dependency checks; do not leave automatic models pointing to missing concrete models.
- Keep routing, key health, retry classification, accounting, and error semantics aligned between `routes/chat.ts` and `routes/messages.ts`.
- Never retry or switch targets after any response bytes have been emitted to the client.
- Endpoint generation settings are enforced policies: disabled parameters are removed, and enabled configured values override the client request. Preserve this behavior consistently across protocols.
- Prompt caching remains endpoint-specific and opt-in for older endpoints; absent/null legacy values must not silently inherit new-endpoint defaults.
- The supported upstream formats are `openai`, `anthropic`, `gemini`, `openai-responses`, and `openai-codex`. Each has distinct URL, authentication, request, response, and streaming requirements; `appendApiSuffix` also controls whether the proxy adds `/v1` or `/v1beta`. Do not implement a format as a URL-only switch.
- Logging failures must not crash request/stream finalization. Client-aborted streams are not upstream failures.
- Preserve nullable HTTP status semantics; a network error must not become status `0` through numeric coercion.

## Frontend invariants

- There is no client router. When adding or renaming a page, synchronize:
  - the Express paths in `routes/pages.ts`;
  - the pathname map in `frontend/src/admin/AdminApp.svelte` or `frontend/src/public/PublicApp.svelte`;
  - page titles and shell navigation in the relevant application/shell.
- Keep admin page imports lazy unless there is a deliberate build architecture change.
- Use `frontend/src/lib/api/admin.ts` for ordinary authenticated JSON requests. Any specialized raw fetch must preserve session-expiry redirects and explicit response parsing.
- Preserve masked-token editing semantics: masked placeholders represent stored credentials and must never be persisted as replacement secrets.
- Keep endpoint token deletion confirmation and index-remapping behavior intact.
- Use escaped Svelte text or `textContent`-equivalent rendering for stored or upstream-controlled values. Never inject error messages, headers, URLs, JSON, or stacks as raw HTML.
- Respect reduced-motion behavior through the existing motion helper and CSS rules.
- `dist/frontend` is generated. Production does not serve Svelte source directly; rebuild assets for production verification.

## Security and privacy

- Never print, copy into documentation, commit, or expose `.env` values, raw endpoint tokens, client API keys, administrator session data, analytics secrets, or runtime database contents.
- Preserve endpoint-token masking on admin responses and masked-placeholder resolution on updates.
- Preserve stable, non-secret key identity and HMAC-based analytics identifiers. Never store raw upstream credentials in key-state or diagnostic tables.
- Preserve case-insensitive credential-header stripping and credential-query sanitization, including provider keys placed in URLs.
- Do not log prompts or outbound request bodies unnecessarily. `request_params` in error storage is legacy-only; do not repopulate it casually.
- Keep field-size limits at persistence boundaries for headers, response bodies, and stack traces.
- `MASTER_KEY` is mandatory and must be replaced with a strong deployment-specific value.
- CORS currently defaults to `*`. Client-IP extraction may trust `CF-Connecting-IP`, while Express proxy trust is not globally configured. These are existing operational behaviors, not endorsement; change them only as an explicit, tested security task.

## Runtime configuration and data

- SQLite data normally lives under `logs/`; PostgreSQL is selected only when `DATABASE_URL` begins with `postgres://` or `postgresql://`.
- Use `NORE_PROXY_MODELS_PATH`, `NORE_PROXY_ENDPOINTS_PATH`, and `NORE_PROXY_SETTINGS_PATH` for isolated configuration.
- Use `LOG_DB_PATH`, `API_KEY_DB_PATH`, `KEY_STATE_DB_PATH`, and `SESSION_DB_PATH` for isolated SQLite data; the corresponding `NORE_PROXY_*_DB_PATH` aliases are also supported. Never point tests at deployed databases or mounted production JSON.
- Settings files may contain legacy keys not accepted by the current update API. Preserve them unless an explicit migration is part of the task.
- Endpoint files may also contain legacy fields. Do not delete unknown operational data during unrelated rewrites.

## Commands

| Command | Purpose | Notes |
| --- | --- | --- |
| `npm start` | Start the server with `tsx` | Production-style runtime; requires built frontend assets for production hosting. |
| `npm run dev` | Start watched development mode | Uses Vite middleware through Express. |
| `npm run build` | Build the frontend | Alias of `build:frontend`. |
| `npm run build:frontend` | Build Vite assets into `dist/frontend` | Generated output must not be hand-edited. |
| `npm run typecheck` | Run server and frontend typechecks | Frontend typecheck also performs a Vite build. |
| `npm run typecheck:server` | Typecheck server/shared TypeScript | No emit. |
| `npm run typecheck:frontend` | Typecheck and build the frontend | Includes a production Vite build. |
| `npm test` | Run the global repository health check | Runs server typechecking, frontend typechecking and production build, then all root unit and contract tests. |
| `npm run test:frontend` | Run frontend utility tests | Uses Node's test runner with `tsx`. |
| `npm run check` | Run the global repository health check | Alias of `npm test`. |

Current limitations:

- There is no lint or format script/configuration.
- Tests avoid live services and operational data; application and persistence integration checks require explicitly isolated configuration and database paths.

## Verification policy

Run executable checks directly from the working tree with the repository's Node/npm scripts. Do not use Docker for verification unless the user explicitly requests it.

- Use isolated JSON configuration and isolated database paths for checks that start the application or exercise persistence.
- Bind test servers only to a loopback, non-production port.
- Never stop, remove, restart, rename, or modify a live `nore-proxy` process, container, or service to free a port or name.
- Do not restart or modify the deployed service unless isolated verification succeeds and the user explicitly approves deployment.
- Run the smallest relevant check first, followed by broader checks when warranted.
- For documentation-only changes, review the Markdown and run `git diff --check`; an application build is unnecessary.
- Report every skipped, unavailable, stale, or failing check honestly.

## Coupled-change checklist

### Page or navigation changes

Update Express document paths, the appropriate Svelte pathname map, page titles, shell navigation, authentication behavior, and production build output.

### Endpoint or model CRUD

Update types, input validation, JSON persistence, token masking, dependency handling, registry reloads, admin API responses, and the Svelte editor/list. Preserve automatic-model references during rename/delete operations.

### Provider/protocol behavior

Check URL construction, authentication, request transformation, non-stream response normalization, SSE parsing/framing, usage mapping, retry boundaries, both client protocol routes, and sanitized failure logging.

### Logging, analytics, or schema changes

Update SQLite and PostgreSQL implementations, startup migrations, typed projections/rollups, writers, readers, admin APIs, shared types, and all UI consumers. Keep old data readable where migration compatibility is expected.

### Runtime settings

Update settings types, hardcoded defaults, validation, persistence, admin API, UI controls, new-endpoint seeding, and every runtime consumer. Verify that each persisted key has a real consumer.

## Generated, ignored, and local-only files

Do not edit these as source:

- `dist/` and other build output;
- `node_modules/`;
- `logs/`, SQLite files, WAL/SHM files, and log output;
- local `.env` and runtime `models.json`, `endpoints.json`, and `settings.json` data;
- `.claude/` local agent configuration and historical local plan artifacts.

Binary provider icons and the favicon are source assets, but inspect or replace them only when the task concerns those assets.

## Definition of done

A change is complete when:

- all coupled server, frontend, persistence, and protocol surfaces are updated;
- credential, privacy, masking, logging, and streaming invariants are preserved;
- relevant checks have run from the working tree with appropriate runtime isolation, or documentation-only verification has completed;
- failures and verification gaps are reported accurately;
- generated/runtime files and unrelated user changes remain untouched;
- no commit, deployment, or live-service action occurred without explicit authorization.
