# Nore Proxy

A unified OpenAI API proxy server

## Features

- **Unified API gateway**: `/v1/chat/completions` (OpenAI format) and `/v1/messages` (Anthropic format), both routing to multiple upstream backends.
- **Claude Code support**: `/v1/messages` accepts the Anthropic Messages API natively and translates to any upstream backend.
- **Multi-provider backends**: OpenAI, Anthropic, Gemini, OpenAI-Responses, and OpenAI-Codex adapters with streaming normalization.
- **Reasoning support**: preserve reasoning and thinking content across all backend adapters.
- **Endpoint management**: JSON-backed endpoint config with auto-reload, custom headers, and per-endpoint API format selection.
- **Key rotation**: round-robin or sticky rotation across multiple keys per endpoint.
- **Key health tracking**: failing keys are sidelined automatically and requests hop to the next healthy key.
- **Per-endpoint generation policies**: strip, pass through, or override client `temperature`, `top_p`, and `max_tokens` values.
- **Prompt caching for Claude**: optional Claude cache breakpoints with cache-read and cache-write token accounting.
- **Model registry**: map display names to upstream models, group by endpoint in the admin UI, and fetch model lists on demand.
- **Cost tracking**: calculate input, output, cache-read, and cache-write costs using per-model pricing.
- **Usage dashboards**: view per-user and per-model request, token, and cost breakdowns.
- **Self-service usage**: API key holders can view their own usage from the public usage page.
- **Upstream error inspection**: persistent, sanitized error logs with filtering and a dedicated admin page.
- **Persistent admin sessions**: SQLite-backed sessions survive restarts and expire automatically.
- **Live configuration reload**: update endpoints, models, and runtime settings without restarting the server.
- **Operational controls**: model health checks, silent connectivity testing, soft disable/enable, and live request logs via SSE.
- **Access control**: per-API-key RPD/RPM/context-size limits managed from the admin panel.

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

Edit .env
```
# Server
PORT=8741

# Masterkey used for admin authentication (recommended 32 chars)
MASTER_KEY=mypasswordissafe

# Admin rate limiting (attempts per minute per IP)
ADMIN_MAX_ATTEMPTS=100

# Session lifetime in hours
SESSION_TTL_HOURS=24

# CORS origin restriction (leave empty or remove to allow all origins)
CORS_ORIGIN=*
```

3. Install dependencies:
```bash
npm install
```

4. Run the server:
```bash
npm start
```

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

Edit .env

```
# Server
PORT=8741

# Masterkey used for admin authentication (recommended 32 chars)
MASTER_KEY=mypasswordissafe

# Admin rate limiting (attempts per minute per IP)
ADMIN_MAX_ATTEMPTS=100

# Session lifetime in hours
SESSION_TTL_HOURS=24

# CORS origin restriction (leave empty or remove to allow all origins)
CORS_ORIGIN=*
```

3. Deploy on Docker Compose:
```bash
docker compose build
docker compose up -d
```

## Configuration

Environment variables configure server-level behavior that cannot be changed at runtime.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8741 |
| `MASTER_KEY` | Admin authentication key (min 16 chars) | required, no default |
| `ADMIN_MAX_ATTEMPTS` | Admin login attempts per minute per IP | 100 |
| `SESSION_TTL_HOURS` | Admin session lifetime | 24 |
| `CORS_ORIGIN` | Allowed CORS origin(s) | `*` |

### Runtime settings

Rate-limit defaults, prompt caching, and endpoint creation defaults are managed through the admin Settings UI and persisted in `settings.json`. They can be changed without restarting the server.

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
| `/api/errors` | GET | List upstream error logs |
| `/api/errors/:id` | GET | Get error log details |
| `/api/errors` | DELETE | Clear error logs |
| `/api/endpoints/:version/keys` | GET | Get per-key health and stats |
| `/api/endpoints/:version/keys/reset` | POST | Re-enable a sidelined key |
| `/api/endpoints/:version/keys/disable` | POST | Manually disable a key |
| `/api/users` | GET | Get all users' usage stats |
| `/api/users/:apiKey` | GET | Get individual user details |

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

- Frontend: Javascript
- Backend: Node.js + Express
- Storage: Better-SQLite3

## License
MIT License - see LICENSE file for details
