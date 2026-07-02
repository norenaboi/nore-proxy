# Nore Proxy

A unified OpenAI API proxy server

## Features

- Multi-endpoint API proxying
- Easy management of models, endpoints and API keys with admin panel
- Rate limiting (RPD/RPM/Context size)
- Request logging (SQLLite)
- Model mapping
- API key rotation with round robin
- Custom headers
- Prompt caching support for Claude
- Tool call pass

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

# Rate Limits (leave empty for default)
RPD_DEFAULT=500
RPM_DEFAULT=10
CONTEXT_SIZE_DEFAULT=100000
ADMIN_MAX_ATTEMPTS=100

# Prompt Caching for Claude
PROMPT_CACHING=false
PROMPT_CACHING_DEPTH=2
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

# Rate Limits (leave empty for default)
RPD_DEFAULT=500
RPM_DEFAULT=10

# Prompt Caching for Claude
PROMPT_CACHING=false
PROMPT_CACHING_DEPTH=2
```

3. Deploy on Docker Compose:
```bash
docker compose build
docker compose up -d
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8741 |
| `MASTER_KEY` | Admin authentication key | mypasswordissafe |
| `RPD_DEFAULT` | Requests per day limit | 500 |
| `RPM_DEFAULT` | Requests per minute limit | 10 |
| `PROMPT_CACHING` | Prompt caching for Claude | false |
| `PROMPT_CACHING_DEPTH` | Prompt caching depth | 2 |

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
| `/v1/chat/completions` | POST | API Handler |
| `/api/summary` | GET | Summary of statistics |
| `/api/usage` | POST | View usage statistics |

## Architecture

### Tech Stack

- Frontend: Javascript
- Backend: Node.js + Express
- Storage: Better-SQLite3

## License
MIT License - see LICENSE file for details
