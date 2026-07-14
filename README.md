# Nore Proxy

A unified OpenAI API proxy server

## Features

- **Unified API gateway**: `/v1/chat/completions` (OpenAI format) and `/v1/messages` (Anthropic format) endpoints, both routing to multiple upstream backends with per-model endpoint selection.
- **Claude Code support**: `/v1/messages` accepts the Anthropic Messages API format natively, translates requests to upstream OpenAI/Anthropic/Gemini backends, and normalizes streaming responses back to Anthropic format.
- **Multi-provider backend support**: route to OpenAI, Anthropic, Gemini, and OpenAI-Responses endpoints through per-adapter request/response translation and streaming normalization.
- **Intelligent endpoint management**: JSON-backed endpoint config with auto-reload, URL normalization, custom headers, multi-token round-robin rotation, and per-endpoint API format selection.
- **Per-endpoint generation defaults**: configure fallback values for `temperature`, `top_p`, and `max_tokens` per backend, merged client-wins before adapter translation.
- **Model registry & routing**: map display names to upstream model/version pairs, group models by endpoint in the admin UI, and auto-populate model lists from upstream providers.
- **Operational controls**: model health checks, silent connectivity testing, soft disable/enable, live request logs via SSE, and SQLite-backed usage analytics.
- **Access control & rate limiting**: per-API-key RPD/RPM/context-size limits with an admin-authenticated management panel.

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
copy .env.example .env
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
copy .env.example .env
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
| `MASTER_KEY` | Admin authentication key | mypasswordissafe |
| `ADMIN_MAX_ATTEMPTS` | Admin login attempts per minute per IP | 100 |
| `SESSION_TTL_HOURS` | Admin session lifetime | 24 |
| `CORS_ORIGIN` | Allowed CORS origin(s) | `*` |

### Runtime settings

Rate-limit defaults, prompt caching, and endpoint creation defaults are managed through the admin Settings UI and persisted in `settings.json`. They can be changed without restarting the server.

The server will not initiate if your `MASTER_KEY` is shorter than 16 characters.

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
| `/api/users` | GET | Get all users' usage stats |
| `/api/users/:apiKey` | GET | Get individual user details |

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
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
