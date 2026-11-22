# RentOk Gateway

A small LLM gateway and operations console built with Express, Prisma, PostgreSQL, React, Tailwind CSS, and Turborepo.

## Run with Docker Compose (recommended)

1. Copy `.env.example` to `.env`. Set a long random `ADMIN_API_KEY`; set `OPENAI_API_KEY` if you want live provider responses. Without it, the gateway intentionally uses its local fallback.
2. Run `docker compose up --build -d`. PostgreSQL starts with a separate `rentok_test` database, the API applies its Prisma migration, and the web preview starts.
3. Run `docker compose --profile test run --rm integration` to run the PostgreSQL-backed API integration checks in the isolated test database.

The dashboard is at `http://localhost:5175` (Compose) and the API at `http://localhost:4001` (Compose). For the local TypeScript workflow, copy `apps/api/.env.example` to `apps/api/.env`, then run `pnpm install`, `pnpm db:generate`, `pnpm db:migrate`, and `pnpm dev` from the repository root. To add demo database records, run `pnpm db:seed` from the root. Never point `pnpm test` at a development database: the integration suite only accepts a database name ending in `_test` and clears that isolated test database before running.

## Example request

```sh
curl http://localhost:4000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_GATEWAY_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Create a gateway key or read usage totals with the admin token from `.env`:

```sh
curl -X POST http://localhost:4000/v1/keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"local demo","budget":20}'

curl http://localhost:4000/v1/usage \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Admin key and usage endpoints require `ADMIN_API_KEY`; chat callers use individual gateway-issued keys. The dashboard uses illustrative client-side demo data saved in browser storage; it does not send the admin secret to the browser. `FOLDER-STRUCTURE.txt` lists the source tree. `RentOk-Gateway.zip` packages the source and structure file without dependencies, build output, or secrets.

See [DECISIONS.md](./DECISIONS.md) for scope and tradeoffs, and [AI-LOG.md](./AI-LOG.md) for an honest account of AI assistance and remaining human verification.
