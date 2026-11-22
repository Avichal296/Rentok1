# RentOk Gateway
### A Lightweight LLM Gateway for API Key Management, Request Governance & Usage Observability

RentOk Gateway is a self-hostable LLM gateway designed to sit between applications and AI model providers. It provides a centralized layer for issuing virtual API keys, enforcing request budgets, routing chat-completion requests, handling provider failures, and tracking usage and estimated costs.

Instead of exposing provider credentials directly to applications, RentOk gives each caller its own gateway-issued key and applies access and budget policies before a request reaches the model provider.

The project combines a TypeScript/Express backend, Prisma ORM, PostgreSQL, a React-based operations console, and a Turborepo monorepo setup.

**Live Demo:** https://rentok1-u583.vercel.app/

**Repository:** https://github.com/Avichal296/Rentok1

---

## Table of Contents

- [Overview](#overview)
- [Why RentOk Gateway?](#why-rentok-gateway)
- [Core Features](#core-features)
- [System Architecture](#system-architecture)
- [Request Lifecycle](#request-lifecycle)
- [Budget Enforcement & Concurrency](#budget-enforcement--concurrency)
- [Security Architecture](#security-architecture)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Database Design](#database-design)
- [Technology Stack](#technology-stack)
- [Getting Started](#getting-started)
- [Docker Setup](#docker-setup)
- [Integration Testing](#integration-testing)
- [Environment Variables](#environment-variables)
- [Engineering Decisions & Trade-offs](#engineering-decisions--trade-offs)
- [Current Scope & Limitations](#current-scope--limitations)

---

## Overview

LLM applications often integrate directly with model providers. This creates several problems as applications grow:

- Provider API credentials can become exposed across multiple services.
- Different applications need separate access controls.
- Request limits are difficult to enforce consistently.
- Provider failures can interrupt application workflows.
- Tracking model usage, latency, and estimated expenditure becomes fragmented.

RentOk Gateway addresses these concerns by introducing a centralized request-control layer.

Applications communicate with RentOk using gateway-issued virtual keys. The gateway validates the caller, checks its request allowance, forwards the request to an OpenAI-compatible provider when configured, handles failures through a local fallback, and records usage information in PostgreSQL.

The goal is to make the gateway responsible for access, request governance, and usage visibility rather than distributing those responsibilities across individual applications.

## Why RentOk Gateway?

The central engineering idea is simple:

**Applications should consume AI services through controlled credentials, not own the provider credentials themselves.**

RentOk separates three responsibilities:

| Layer | Responsibility |
|---|---|
| Application | Sends chat-completion requests using a gateway key |
| RentOk Gateway | Authentication, request budgets, provider routing and usage tracking |
| Model Provider | Processes requests using server-side provider credentials |

This separation creates a single enforcement point for application-level access and request limits.

---

## Core Features

### 1. Virtual API Key Management

- Generate unique gateway keys with the `rk_live_` prefix.
- Assign a name and cumulative request budget to each key.
- Store SHA-256 hashes instead of raw API key secrets.
- Reveal the generated secret only once at creation.
- Maintain key metadata, including prefix, usage, budget and status.
- Pause or reactivate existing keys.
- Update request budgets through the authenticated admin API.
- Reject invalid, inactive, or exhausted keys.

### 2. Centralized LLM Request Gateway

- OpenAI-compatible chat-completion endpoint.
- Supports model selection and structured chat messages.
- Validates incoming request payloads using Zod.
- Authenticates every caller using its individual gateway key.
- Keeps provider credentials on the server.
- Supports configurable OpenAI-compatible provider base URLs.
- Returns a familiar chat-completion response structure.
- Includes gateway metadata identifying the provider and response status.

### 3. Atomic Request Budget Enforcement

A request budget is enforced before contacting the model provider.

- Each gateway key has its own cumulative request allowance.
- Conditional PostgreSQL updates reserve requests atomically.
- Concurrent requests cannot both consume the same final available slot.
- Requests exceeding the budget receive HTTP `429`.
- Admins can increase the budget or disable a key.

### 4. Provider Failure Handling

The gateway is designed to remain demonstrable even when a provider is unavailable.

- Configurable OpenAI-compatible upstream endpoint.
- 20-second upstream request timeout.
- Handles unsuccessful provider responses and network failures.
- Uses a deterministic local fallback response when credentials are absent or the provider request fails.
- Identifies fallback responses through `gateway.provider` and `gateway.status` metadata.

### 5. Usage Tracking & Cost Estimation

Each completed gateway request records:

- Gateway key ID
- Requested model
- Input tokens
- Output tokens
- Estimated cost in USD
- Provider used
- Request status
- Request latency
- Creation timestamp

The API also exposes aggregated usage totals, including request count, token consumption and estimated expenditure.

Cost calculations use provider-reported token counts when available, with character-based estimates for fallback responses.

### 6. Operations Dashboard

The React operations console provides an interactive interface organized around five sections:

| Section | Capabilities |
|---|---|
| Overview | Request volume, estimated spend, latency, success-rate indicators, key summaries and recent activity |
| Playground | Compose sample messages, switch between supported model selections and inspect simulated responses |
| API Keys | Create keys, inspect usage and budgets, pause or reactivate keys |
| Usage & Logs | Search request records, filter primary/fallback routes and export CSV |
| Settings | Workspace configuration interface and gateway defaults |

Additional interface features:

- Responsive sidebar navigation.
- Keyboard-driven command search (`Cmd/Ctrl + K`).
- One-time secret display with copy functionality.
- Request and usage tables.
- Interactive charts and summary cards.

**Dashboard implementation note:** The current console uses illustrative client-side data persisted in browser storage. It is a separate UI prototype and is not yet connected to the backend's live key-management and usage endpoints.

---

## System Architecture

RentOk uses a modular monorepo structure. The API and frontend are maintained as separate workspace applications, while shared repository-level configuration coordinates development and builds.

### High-level architecture

```mermaid
flowchart TB
    Client["Client Application"]
    Console["React Operations Console"]

    subgraph Gateway["RentOk Gateway"]
        API["Express API"]
        Auth["Gateway Key Authentication"]
        Budget["Atomic Budget Enforcement"]
        Router["Provider Routing"]
        Fallback["Local Fallback"]
        Logger["Usage & Cost Tracking"]
    end

    DB[("PostgreSQL")]
    Prisma["Prisma ORM"]
    Provider["OpenAI-Compatible Provider"]

    Client -->|"Bearer Gateway Key"| API
    Console -.->|"Current UI prototype"| Console

    API --> Auth
    Auth --> Budget
    Budget --> DB
    Budget --> Router

    Router -->|"Provider available"| Provider
    Router -->|"No credential / failure"| Fallback

    Provider --> Logger
    Fallback --> Logger

    Logger --> Prisma
    Prisma --> DB

    Logger --> API
    API --> Client
```

### Component responsibilities

**Client Applications**

Send chat-completion requests using individually issued gateway credentials. They do not need direct access to the provider API key.

**Express API**

Acts as the central entry point. It exposes health, key-management, usage and chat-completion endpoints.

**Authentication Layer**

Hashes incoming gateway keys and verifies their corresponding records and active status.

**Budget Enforcement Layer**

Uses conditional database updates to reserve a request before provider execution.

**Provider Routing Layer**

Forwards requests to the configured OpenAI-compatible provider or selects the local fallback path.

**Usage Tracking Layer**

Calculates estimated cost and persists request metadata, token counts, provider information and latency.

**PostgreSQL + Prisma**

Provides persistent storage for gateway keys, usage records and their relationship.

**React Console**

Provides a separate interactive interface for exploring gateway operations and workflows.

---

## Request Lifecycle

Every chat-completion request follows a controlled execution pipeline.

```mermaid
flowchart TD
    A["Incoming POST /v1/chat/completions"]
    B["Extract Bearer Gateway Key"]
    C{"Gateway Key Present?"}
    D["Return 401"]
    E["SHA-256 Hash & Database Lookup"]
    F{"Key Valid and Active?"}
    G["Return 401"]
    H["Validate Request using Zod"]
    I{"Valid Payload?"}
    J["Return 400"]
    K["Atomically Reserve Request Budget"]
    L{"Budget Available?"}
    M["Return 429"]
    N{"Provider Credential Configured?"}
    O["Call OpenAI-Compatible Provider"]
    P{"Provider Successful?"}
    Q["Generate Local Fallback"]
    R["Calculate Token Usage & Estimated Cost"]
    S["Persist Usage in PostgreSQL"]
    T["Return Chat Completion Response"]

    A --> B --> C
    C -->|No| D
    C -->|Yes| E --> F
    F -->|No| G
    F -->|Yes| H --> I
    I -->|No| J
    I -->|Yes| K --> L
    L -->|No| M
    L -->|Yes| N
    N -->|Yes| O --> P
    P -->|Yes| R
    P -->|No| Q
    N -->|No| Q
    Q --> R --> S --> T
```

### Step-by-step execution

1. **Authentication:** The caller sends a gateway key in the Authorization header.
2. **Key verification:** RentOk hashes the supplied key and looks up its database record. Inactive or invalid keys are rejected.
3. **Payload validation:** Zod validates the model, messages, roles and optional temperature.
4. **Budget reservation:** A conditional PostgreSQL update reserves one request only if the key is active and its budget has not been exhausted.
5. **Provider execution:** The gateway forwards the validated payload to the configured provider with a 20-second timeout.
6. **Failure handling:** If no provider credential exists or the upstream request fails, the gateway generates an explicitly marked local fallback response.
7. **Usage calculation:** Input/output token counts and estimated cost are calculated.
8. **Persistence:** Request metadata is stored in PostgreSQL through Prisma.
9. **Response:** The caller receives a chat-completion response with usage information and gateway provider/status metadata.

The proxy is intentionally non-streaming so that final usage and cost can be persisted before the complete response is returned.

---

## Budget Enforcement & Concurrency

One of the important engineering decisions in RentOk is how it handles concurrent requests competing for the same remaining budget.

A simple implementation might read the current usage count, compare it with the budget, and then increment the counter.

However, this creates a race condition:

```text
Request A reads used = 9
Request B reads used = 9

Request A checks budget = 10 → Allowed
Request B checks budget = 10 → Allowed

Request A increments usage
Request B increments usage

Final usage = 11
```

Both requests can pass the check even though only one request should be allowed.

### RentOk's approach

The gateway uses a conditional atomic update through Prisma:

```typescript
const reserve = await db.apiKey.updateMany({
  where: {
    id: key.id,
    active: true,
    used: {
      lt: key.budget
    }
  },
  data: {
    used: {
      increment: 1
    }
  }
});

if (reserve.count !== 1) {
  return res.status(429).json({
    error: {
      message: 'Request budget reached.',
      type: 'budget_exceeded'
    }
  });
}
```

The database performs the condition check and increment as one operation.

For example, when two requests compete for the final available slot:

```text
Budget = 10
Current usage = 9

Request A → Atomic update succeeds → used = 10
Request B → Condition fails → HTTP 429
```

This ensures the same request allowance cannot be reserved twice by concurrent application processes sharing the same PostgreSQL database.

The integration tests explicitly verify this behavior.

---

## Security Architecture

Security is handled at the gateway boundary rather than delegated to individual clients.

| Security mechanism | Implementation |
|---|---|
| Gateway authentication | Individual Bearer virtual keys |
| Key storage | SHA-256 hashed secrets |
| Secret exposure | Raw key returned only during creation |
| Admin authorization | Separate `ADMIN_API_KEY` |
| Provider credentials | Server-side environment variables |
| Request validation | Zod schema validation |
| HTTP security headers | Helmet |
| Cross-origin configuration | Configurable CORS origin |
| Request body protection | 1 MB JSON body limit |
| Timing-safe admin comparison | `timingSafeEqual` |
| Request budget protection | Conditional atomic database update |

The admin API key is separate from the gateway-issued keys. Chat clients cannot use their gateway keys to access administrative endpoints.

---

## Project Structure

The repository follows a workspace-based monorepo architecture using pnpm and Turborepo.

```text
RentOk-Gateway/
│
├── apps/
│   │
│   ├── api/
│   │   ├── src/
│   │   │   └── index.ts
│   │   │
│   │   ├── prisma/
│   │   │   ├── migrations/
│   │   │   │   ├── 202611220001_init/
│   │   │   │   │   └── migration.sql
│   │   │   │   └── migration_lock.toml
│   │   │   ├── schema.prisma
│   │   │   └── seed.ts
│   │   │
│   │   ├── test/
│   │   │   └── gateway.test.ts
│   │   │
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── .env.example
│   │
│   └── web/
│       ├── src/
│       │   ├── main.tsx
│       │   └── style.css
│       │
│       ├── index.html
│       ├── Dockerfile
│       ├── package.json
│       ├── tailwind.config.js
│       ├── postcss.config.js
│       ├── tsconfig.json
│       └── vite.config.ts
│
├── docker/
│   └── postgres-init.sql
│
├── .dockerignore
├── .env.example
├── .gitignore
├── docker-compose.yml
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── FOLDER-STRUCTURE.txt
├── DECISIONS.md
├── AI-LOG.md
└── README.md
```

### Backend — `apps/api`

The backend contains the gateway's request-processing logic.

| File / Directory | Responsibility |
|---|---|
| `src/index.ts` | Express application, authentication middleware, key management, chat-completion routing, provider fallback and usage persistence |
| `prisma/schema.prisma` | Database models and relationships |
| `prisma/migrations/` | Version-controlled database migration history |
| `prisma/seed.ts` | Creates sample gateway key and usage records |
| `test/gateway.test.ts` | PostgreSQL-backed integration tests |
| `Dockerfile` | API container build and startup configuration |
| `tsconfig.json` | TypeScript compiler configuration |

### Frontend — `apps/web`

The frontend contains the React operations console.

| File / Directory | Responsibility |
|---|---|
| `src/main.tsx` | Dashboard application, navigation, views, interactions and client-side state |
| `src/style.css` | Dashboard styling |
| `index.html` | Vite application entry |
| `vite.config.ts` | Frontend development and build configuration |
| `tailwind.config.js` | Tailwind CSS configuration |
| `Dockerfile` | Frontend container build and preview server |

### Infrastructure & Repository Configuration

| File | Responsibility |
|---|---|
| `docker-compose.yml` | Coordinates PostgreSQL, API, web and integration-test services |
| `docker/postgres-init.sql` | Initializes the isolated PostgreSQL test database |
| `pnpm-workspace.yaml` | Declares monorepo workspace packages |
| `turbo.json` | Configures task dependencies, caching and environment passthrough |
| `package.json` | Root scripts and development tooling |
| `.env.example` | Documents required environment variables |
| `DECISIONS.md` | Architecture choices, trade-offs and future improvements |
| `AI-LOG.md` | Documents AI assistance and human verification |
| `FOLDER-STRUCTURE.txt` | Source tree reference |

---

## API Reference

All API routes are served by the Express backend.

### Health Check

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Returns gateway health status |

Example:

```bash
curl http://localhost:4000/health
```

### API Key Management

These endpoints require the administrative Bearer token.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/keys` | Create a gateway API key |
| GET | `/v1/keys` | List gateway keys and their metadata |
| PATCH | `/v1/keys/:id` | Update a key's active status or request budget |

Create a key:

```bash
curl -X POST http://localhost:4000/v1/keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-app",
    "budget": 1000
  }'
```

Example response:

```json
{
  "id": "generated-key-id",
  "name": "production-app",
  "prefix": "rk_live_...",
  "budget": 1000,
  "secret": "rk_live_generated_secret",
  "warning": "Copy this key now. It cannot be retrieved again."
}
```

The raw secret is returned only at creation time. Store it securely.

Pause a key:

```bash
curl -X PATCH http://localhost:4000/v1/keys/KEY_ID \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'
```

### Chat Completions

| Method | Endpoint | Authentication |
|---|---|---|
| POST | `/v1/chat/completions` | Gateway-issued API key |

Example:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {
        "role": "user",
        "content": "Explain how an API gateway works."
      }
    ],
    "temperature": 0.7
  }'
```

The response follows a familiar chat-completion structure:

```json
{
  "id": "chatcmpl_generated_id",
  "object": "chat.completion",
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Response from the gateway."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 40,
    "total_tokens": 65
  },
  "gateway": {
    "provider": "openai",
    "status": "success"
  }
}
```

Fallback responses identify themselves using:

```json
{
  "gateway": {
    "provider": "mock",
    "status": "fallback"
  }
}
```

### Usage & Logs

These endpoints require the administrative Bearer token.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/usage` | Fetch recent request records and aggregate usage |
| GET | `/v1/usage?keyId=KEY_ID` | Filter usage by gateway key |

Example:

```bash
curl http://localhost:4000/v1/usage \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

The response includes request records and aggregated cost, token and request totals.

---

## Database Design

RentOk currently uses two primary PostgreSQL models.

### ApiKey

Represents an individual gateway-issued credential.

| Field | Type | Purpose |
|---|---|---|
| `id` | String | Primary identifier |
| `name` | String | Key name |
| `prefix` | String | Unique identifiable key prefix |
| `hash` | String | SHA-256 hash of the secret |
| `budget` | Int | Maximum cumulative request count |
| `used` | Int | Number of reserved requests |
| `active` | Boolean | Whether the key is enabled |
| `createdAt` | DateTime | Creation timestamp |

### Usage

Stores request-level usage information.

| Field | Type | Purpose |
|---|---|---|
| `id` | String | Primary identifier |
| `keyId` | String | Associated gateway key |
| `model` | String | Requested model |
| `inputTokens` | Int | Input token count |
| `outputTokens` | Int | Output token count |
| `costUsd` | Float | Estimated request cost |
| `status` | String | Success or fallback status |
| `provider` | String | Provider used |
| `latencyMs` | Int | Total measured request latency |
| `createdAt` | DateTime | Request timestamp |

Relationship:

```mermaid
erDiagram
    ApiKey ||--o{ Usage : generates

    ApiKey {
        string id PK
        string name
        string prefix UK
        string hash UK
        int budget
        int used
        boolean active
        datetime createdAt
    }

    Usage {
        string id PK
        string keyId FK
        string model
        int inputTokens
        int outputTokens
        float costUsd
        string status
        string provider
        int latencyMs
        datetime createdAt
    }
```

A single API key can generate multiple usage records. The usage table includes indexes on `keyId` and `createdAt` to support common filtering and chronological queries.

---

## Technology Stack

| Category | Technology | Usage |
|---|---|---|
| Language | TypeScript | Backend and frontend development |
| Backend | Node.js, Express.js | HTTP API and gateway logic |
| Frontend | React 18 | Operations dashboard |
| Styling | Tailwind CSS, CSS | Frontend styling |
| ORM | Prisma | Database access and migrations |
| Database | PostgreSQL 16 | Persistent key and usage storage |
| Validation | Zod | Request payload validation |
| Security | Helmet, Node.js Crypto | HTTP security headers and key hashing |
| Build System | Turborepo | Monorepo task orchestration |
| Package Manager | pnpm | Workspace dependency management |
| Frontend Tooling | Vite | Development and production builds |
| Containerization | Docker, Docker Compose | Local service orchestration |
| Testing | Node.js Test Runner | API integration testing |
| Model Integration | OpenAI-compatible HTTP API | Chat-completion provider integration |

---

## Getting Started

### Prerequisites

Make sure the following tools are installed:

- Node.js 22+
- pnpm 9+
- PostgreSQL 16+ (or Docker)
- Docker Desktop (recommended for the complete local setup)

### 1. Clone the repository

```bash
git clone https://github.com/Avichal296/Rentok1.git

cd Rentok1
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

Copy the API environment template:

```bash
cp apps/api/.env.example apps/api/.env
```

Configure your PostgreSQL connection and admin credential.

```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/rentok?schema=public"

PORT=4000

ADMIN_API_KEY="your-long-random-admin-token"

OPENAI_API_KEY="your-provider-api-key"

OPENAI_BASE_URL="https://api.openai.com/v1"

WEB_ORIGIN="http://localhost:5173"
```

The provider key is optional. Without it, the gateway uses the local fallback response.

### 4. Generate Prisma Client

```bash
pnpm db:generate
```

### 5. Apply database migrations

```bash
pnpm db:migrate
```

### 6. Start the applications

```bash
pnpm dev
```

The API runs on port `4000`, and the Vite frontend uses its configured development port.

For separate application processes:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

### 7. Seed demo data (optional)

```bash
pnpm db:seed
```

The seed script creates a sample gateway key and usage records.

---

## Docker Setup

Docker Compose is the recommended way to run the complete local environment.

### 1. Configure environment variables

Copy the root environment template:

```bash
cp .env.example .env
```

Set a strong random `ADMIN_API_KEY`. Configure `OPENAI_API_KEY` if live provider responses are required.

### 2. Start the services

```bash
docker compose up --build -d
```

Docker Compose starts:

| Service | Responsibility | Local Port |
|---|---|---|
| PostgreSQL | Persistent database | `5433` |
| API | RentOk Gateway backend | `4001` |
| Web | Dashboard preview | `5175` |

The API container applies its Prisma migrations during startup. PostgreSQL initialization also creates a separate `rentok_test` database.

### 3. Access the application

- Dashboard: http://localhost:5175
- API health: http://localhost:4001/health

### 4. Stop the services

```bash
docker compose down
```

To remove the database volume as well:

```bash
docker compose down -v
```

**Warning:** Removing the volume permanently deletes the local PostgreSQL data.

---

## Integration Testing

RentOk includes PostgreSQL-backed integration tests using the Node.js built-in test runner.

The tests cover:

- Gateway health endpoint.
- Administrative authentication.
- Invalid gateway key rejection.
- Request payload validation.
- Gateway key creation and metadata protection.
- Local fallback response behavior.
- Usage record persistence.
- Aggregate usage calculations.
- Atomic budget enforcement under concurrent requests.
- Key deactivation.
- Provider failure handling.

### Run tests using Docker Compose

```bash
docker compose --profile test run --rm integration
```

The integration service uses the dedicated `rentok_test` database.

The test suite explicitly checks that its database name ends in `_test` before deleting or creating records. This prevents accidental cleanup of a development database.

Do not run the integration suite against your development database.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | API listening port; defaults to `4000` |
| `ADMIN_API_KEY` | Required for admin operations | Server-side admin bearer credential |
| `OPENAI_API_KEY` | No | Provider authentication credential |
| `OPENAI_BASE_URL` | No | OpenAI-compatible provider base URL |
| `WEB_ORIGIN` | No | Allowed frontend CORS origin |

Never commit `.env` files, provider credentials, database passwords or administrative secrets.

---

## Engineering Decisions & Trade-offs

RentOk was designed around a few deliberate implementation choices.

### Atomic database-level budget reservation

Instead of performing a separate read and increment, the gateway uses a conditional database update. This prevents concurrent requests from overspending the same request allowance.

### Hashed gateway credentials

Only SHA-256 hashes are stored in PostgreSQL. The original key is returned once during creation, reducing the impact of accidental database exposure.

### Synchronous usage persistence

Usage records are written before the completed response is returned. This keeps successful response handling coupled to durable usage tracking, at the cost of additional database latency.

### Explicit fallback behavior

Provider failures do not silently masquerade as successful model responses. The gateway identifies fallback responses in its metadata, allowing callers to distinguish real provider responses from local fallback behavior.

### Non-streaming request processing

The gateway waits for the final provider response so it can record token counts and estimated cost. Streaming support would require a different usage-capture and response-persistence design.

### Request-count budgets

The current budget unit is a cumulative request count rather than a monetary or token allowance. This keeps enforcement simple and makes the behavior straightforward to test, but it does not account for differences in request size.

---

## Current Scope & Limitations

RentOk focuses on the core gateway execution and governance flow rather than presenting itself as a fully managed production LLM platform.

The current implementation does not include:

- Streaming responses.
- Multiple independent provider adapters.
- Automatic retries or semantic caching.
- Monthly budget resets or token-based spending limits.
- User/team authentication and role-based admin permissions.
- A durable reservation ledger or reconciliation worker.
- Automated usage retention and cleanup jobs.
- Live backend integration for the React dashboard.
- Provider pricing synchronization.

The dashboard currently uses illustrative client-side data. Backend key management, request routing and usage endpoints are implemented separately.

Cost figures are estimates based on hard-coded model rates, not provider billing records. Unknown model names use the `gpt-4o-mini` estimate. These values should not be treated as authoritative billing data.

For further implementation details and documented trade-offs, see [DECISIONS.md](./DECISIONS.md).

For transparency about AI assistance and remaining human verification, see [AI-LOG.md](./AI-LOG.md).

---

## Project Links

- **Live Demo:** https://rentok1-u583.vercel.app/
- **GitHub Repository:** https://github.com/Avichal296/Rentok1

---

*RentOk Gateway — One controlled entry point between your applications and AI providers.*
