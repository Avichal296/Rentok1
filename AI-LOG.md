# AI log

## Tools used

I used OpenAI Codex in the desktop app (GPT-6) to read the supplied assignment, scaffold the monorepo, draft the API and dashboard, add Docker support and integration checks, and write the engineering notes. No external AI provider was called by this code generation work. The gateway itself can call OpenAI only when `OPENAI_API_KEY` is configured at runtime.

## Where AI can be wrong

The first dashboard draft labeled key limits as “monthly,” but reviewing the API showed that `used` is cumulative and there is no reset window. I caught the mismatch by comparing the UI label with the database schema and enforcement query, then changed the UI and docs to say cumulative/total request limit. I also inspected the conditional database update and added a concurrent-request integration case so the budget claim is backed by behavior.

## Where I overrode a suggestion

The assignment says a polished frontend is unnecessary. I still chose to build a restrained dashboard because the user requested a proper preview and a distinctive, clean UI. I kept the gateway as the core and documented that the dashboard is illustrative rather than wired to the API.

## Staying in control

Provider secrets are read from server environment variables and never included in frontend code or committed env files. Gateway secrets are SHA-256 hashed before storage. Admin endpoints require a separate server-side bearer token. Budget enforcement is a conditional database update before upstream I/O. I added integration coverage for these flows and documented the tradeoffs in `DECISIONS.md`.

## What I had to learn

The concurrency edge case is the key learning focus: a read-then-write budget check can admit two requests when one slot remains. The database conditional update reserves the slot atomically, so correctness does not rely on a process-local lock.

## Verification status

The web and API TypeScript production builds pass. The API integration suite passed both against a separate local PostgreSQL test database and inside Docker against the isolated `rentok_test` database. It covers virtual-key privacy, authentication, budget rejection under concurrent load, usage persistence, admin protection, key pausing, malformed requests, local fallback, and a simulated provider 503 using a local HTTP stub. I also ran a live Docker API smoke flow through key creation, chat completion, persisted usage totals, budget rejection, and key pausing. A real provider credential was not supplied, so successful live OpenAI forwarding has not been exercised.

The dashboard was refined in a follow-up pass with a keyboard page switcher, browser-persisted demo data, request status filters, CSV export, and a one-time demo-key reveal/copy dialog. These front-end interactions do not replace live API/database integration.

Docker Compose configuration validates; API and web images built and ran with a PostgreSQL 16 container. Initially the Docker daemon build could not find `docker-credential-desktop` on PATH; I located the helper under the Docker application and retried with that directory added. Deployment and the screen recording are left for the submitter as requested.
