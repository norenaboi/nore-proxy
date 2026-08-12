# Nore Proxy

A unified OpenAI API proxy server

## Features

- **Unified API gateway**: use OpenAI-compatible `/v1/chat/completions` or Anthropic-compatible `/v1/messages`, including Claude Code support.
- **Multi-provider support**: route requests to OpenAI, Anthropic, Gemini, OpenAI Responses, and OpenAI Codex backends.
- **Flexible model routing**: map public model names to specific backends or automatic target groups with fallback across models and providers.
- **Reliable key rotation**: distribute requests across API keys and automatically skip unhealthy or rate-limited keys.
- **Normalized responses**: preserve streaming, reasoning, and thinking content across supported formats.
- **Live management**: configure endpoints, models, headers, API formats, and runtime settings without restarting the server.
- **Request controls**: set per-endpoint generation policies and per-key request, token, and context limits.
- **Usage and cost tracking**: monitor requests, tokens, cache usage, and costs by user and model.
- **Admin dashboard**: manage configuration, test model connectivity, inspect request history and upstream errors, and view live logs.

## Quick Start

### Prerequisites
Node.js 18+ and npm

### Bare metal

1. Clone the repository
```bash
git clone https://github.com/norenaboi/nore-proxy.git
cd nore-proxy
```

2. Configure environment variables
```bash
cp .env.example .env
```

3. Install dependencies:
```bash
npm install
```

4. Run the server:
```bash
npm start
```

Once the server is running, open:

- Public UI: `http://localhost:8741`
- Admin login: `http://localhost:8741/admin/login`
- Models: `http://localhost:8741/models`
- Usage: `http://localhost:8741/usage`
- Playground: `http://localhost:8741/playground`

For development, use `npm run dev` for automatic restarts and `npm run typecheck` to run the TypeScript compiler without emitting files.

### Docker (Recommended)

1. Clone the repository:
```bash
git clone https://github.com/norenaboi/nore-proxy.git
cd nore-proxy
```

2. Configure environment variables
```bash
cp .env.example .env
```

3. Deploy:
```bash
docker compose up -d --build
```

When PostgreSQL is selected, nore-proxy connects to the configured server and runs its schema migrations before accepting traffic. Ensure the database exists and that the configured user can create and alter tables and indexes.

Compose uses bridge networking. Services running directly on the Docker host must use `host.docker.internal` instead of `localhost` in `DATABASE_URL` or `endpoints.json` (for example, `postgresql://user:password@host.docker.internal:5432/nore_proxy`). Internet-hosted database names work normally.

## Configuration

Environment variables configure server-level behavior that cannot be changed at runtime.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8741 |
| `MASTER_KEY` | Admin authentication key (min 16 chars) | required, no default |
| `ADMIN_MAX_ATTEMPTS` | Admin login attempts per minute per IP | 5 |
| `SESSION_TTL_HOURS` | Admin session lifetime | 24 |
| `CORS_ORIGIN` | Allowed CORS origin(s) | `*` |
| `DATABASE_URL` | Optional PostgreSQL URL. Only `postgres://` or `postgresql://` selects PostgreSQL; blank/unset uses SQLite. | unset |
| `LOG_DB_PATH` | SQLite request/error log and analytics database | `./logs/logs.db` |
| `API_KEY_DB_PATH` | SQLite client API-key database | `./logs/api_keys.db` |
| `KEY_STATE_DB_PATH` | SQLite upstream key-state database | `./logs/key_states.db` |
| `SESSION_DB_PATH` | SQLite admin-session database | `./logs/sessions.db` |

### Runtime settings

Rate-limit defaults, prompt caching, endpoint creation defaults, key-hop limits, and the global automatic-model target-attempt ceiling are managed through the admin Settings UI and persisted in `settings.json`. They can be changed without restarting the server. The automatic-model ceiling bounds each request; model-specific limits may lower it but cannot exceed it.

The server will not start if `MASTER_KEY` is missing or shorter than 16 characters.

## API Reference

### Admin Endpoints

All admin endpoints require authentication.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/logs` | GET | View recent logs |
| `/api/keys` | GET | Get all API keys |
| `/api/keys` | POST | Add new API key |
| `/api/keys` | PUT | Update existing key |
| `/api/keys` | DELETE | Delete key |
| `/api/models` | GET | Get all models |
| `/api/models` | POST | Add new model |
| `/api/models` | PUT | Update existing model |
| `/api/models` | DELETE | Delete model |
| `/api/models/visibility` | PATCH | Toggle public discovery visibility |
| `/api/models/toggle` | PATCH | Enable/disable a model |
| `/api/models/test` | POST | Silent model connectivity test |
| `/api/model-usage` | GET | Get model usage statistics |
| `/api/endpoints` | GET | Get all endpoints |
| `/api/endpoints` | POST | Add new endpoint |
| `/api/endpoints` | PUT | Update existing endpoint |
| `/api/endpoints` | DELETE | Delete endpoint |
| `/api/settings` | GET | Get all settings |
| `/api/settings` | PUT | Update settings |
| `/api/reload` | POST | Reload/Update configuration |
| `/api/logs/stream` | GET | SSE endpoint for live logs |
| `/api/logs/clear` | POST | Clear request logs |
| `/api/requests/filters` | GET | Get request-history filter options |
| `/api/requests` | GET | List and filter paginated request history |
| `/api/requests/:id` | GET | Inspect request routing, token, and cost details |
| `/api/errors/filters` | GET | Get upstream-error filter options |
| `/api/errors` | GET | List upstream error logs |
| `/api/errors/:id` | GET | Get error log details |
| `/api/errors` | DELETE | Clear error logs |
| `/api/endpoints/:version/keys` | GET | Get per-key health and stats |
| `/api/endpoints/:version/keys/reset` | POST | Re-enable a sidelined key |
| `/api/endpoints/:version/keys/reset-stats` | POST | Reset per-key usage and failure statistics |
| `/api/endpoints/:version/keys/disable` | POST | Manually disable a key |
| `/api/users` | GET | Get all users' usage stats |
| `/api/users/:keyId` | GET | Get individual user details |

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | View models |
| `/v1/chat/completions` | POST | OpenAI-format chat completions |
| `/v1/messages` | POST | Anthropic-format messages, Claude Code compatible |
| `/api/summary` | GET | Summary of statistics |
| `/api/usage` | POST | View usage statistics |

## Architecture

### Tech Stack

- **Frontend:** Svelte 5 + TypeScript, bundled with Vite
- **Backend:** Node.js + Express + TypeScript (ESM, executed with `tsx`)
- **Storage:** Better-SQLite3 by default, with optional PostgreSQL
- **Testing:** A global `npm test` health check built on the Node.js Test Runner
- **Deployment:** Multi-stage Docker build with compiled frontend assets

## License
MIT License - see LICENSE file for details
