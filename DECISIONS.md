# Decisions

## What I built

RentOk Gateway is a small HTTP service that accepts chat completion requests behind gateway-issued virtual keys. It validates keys, reserves a per-key request budget atomically in PostgreSQL, forwards to OpenAI when a server-side credential is configured, and uses a clearly identified local response if the provider is unavailable. It stores request usage and estimated cost in PostgreSQL and exposes simple key and usage endpoints. A compact React console shows traffic, spend, keys, recent requests, and a request playground.

## Request lifecycle

```text
Caller -- Bearer virtual key --> Express gateway
  -> SHA-256 key lookup and active check
  -> atomic budget reservation in PostgreSQL
  -> OpenAI request (20 second timeout)
       provider error / absent credential -> local fallback response
  -> usage and estimated cost written to PostgreSQL
  -> OpenAI-compatible chat completion response
```

The API key is hashed before storage. The provider credential is read only from the server environment. `GET /v1/usage` returns request rows and aggregate spend, and `GET /v1/keys` returns metadata without secrets.

The proxy is non-streaming so it can persist final provider usage and cost before returning a complete response. Admin key/usage routes require a separate server-side `ADMIN_API_KEY`; chat callers never receive that credential. Keys can be paused or have their cumulative request cap changed through the authenticated admin API.

## Important choices

1. **Cumulative request count as the budget unit.** Tokens and monetary caps track resource use more closely, but request counts make a small assignment easy to inspect and enforce. The cap does not reset automatically; a short prompt and a long prompt consume the same allowance.
2. **Atomic conditional reservation.** A single `UPDATE ... WHERE used < budget` is represented by Prisma `updateMany`; only one concurrent request can claim the final available slot. We reserve before calling the provider, so there is no overspend race. If the process dies after reservation, that request can consume budget without a usage row; a production version would add an idempotent reservation ledger and reconciliation job.
3. **Synchronous usage logging.** The response waits for the usage insert so a successful answer has a durable record. This adds database latency and means a database outage can interrupt a provider-success response. An async queue would improve latency but needs delivery guarantees and operational infrastructure.
4. **OpenAI-compatible response shape.** The endpoint uses familiar `messages`, `model`, and `choices` fields, with a small `gateway` metadata addition. This lowers integration friction but does not promise full compatibility with every provider-specific option.
5. **Timeout then local fallback.** One upstream attempt is capped at 20 seconds; failures return a marked local response rather than retrying an unhealthy provider and multiplying latency. The fallback is deterministic and not a substitute for model quality. With no provider key the fallback is the normal development path.

Costs use the provider's returned token counts when available and otherwise estimate tokens as roughly one token per four message/response characters. The current estimate assumes gpt-4o-mini rates of $0.15/M input and $0.60/M output tokens, and gpt-4o rates of $2.50/M input and $10/M output tokens; unknown model names use the mini rates. These are hard-coded estimates, not billing truth, and must be reviewed against current provider pricing.

## Why enforce budgets at the gateway?

The gateway is the point that owns both the caller identity and the path to the provider. A caller can make a mistake, be compromised, or intentionally ignore a client-side limit. Checking and reserving centrally means every request shares the same policy, and the caller never needs the provider credential.

## Concurrency

Concurrent calls on one key use a conditional atomic database update. If only one request remains, exactly one reservation succeeds; later requests receive HTTP 429. This protects request-count limits across concurrent API processes, assuming all processes use the same PostgreSQL database.

## What I did not build

- Streaming, retries, multiple real providers, and semantic caching: each introduces provider-specific or failure-state complexity beyond the core demo.
- User/team login, role-based admin permissions, audit events, and plan billing: a single shared admin bearer token is enough to exercise this small assignment, but it is not an organization-grade identity layer.
- Automated deployment: no hosting account, database URL, or provider secret was supplied. Deployment requires those external credentials and a chosen host.
- Persistent dashboard wiring: the console currently has interactive illustrative data; the API endpoints are real, but the dashboard does not yet authenticate to them. This is a deliberate cut to prioritize the gateway core, but it should be connected before presenting the UI as a live admin surface.

## Least confident decision

The local fallback keeps the endpoint available without a provider credential and makes failure behavior easy to demonstrate. However, a plausible canned response can be mistaken for model output if callers ignore the `gateway.status` metadata. In production I would make the fallback opt-in per key and include an explicit response header as well as metadata.

## Where it breaks / one more week

There is no distributed reservation expiry/reconciliation, token-price catalog versioning, role-based admin identity, or database retry strategy. Pricing rates are a small hard-coded estimate and unknown models use the mini-model rate. With another week I would add a durable request ledger with idempotency, admin audit events, proper monthly budget windows, provider adapters, and database-backed dashboard queries.
