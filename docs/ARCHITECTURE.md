# Architecture

## Current (MVP) topology

```
┌─────────────────┐        ┌──────────────────┐
│  WhatsApp user   │──────▶│  Meta Cloud API    │
└─────────────────┘        │  webhook (Graph)   │
                            └─────────┬─────────┘
┌─────────────────┐                  │
│  Web chat widget │──────────────────┤
└─────────────────┘                  ▼
                            ┌──────────────────────┐
                            │   Express API          │
                            │   /api/applications     │
                            │   /api/whatsapp/webhook │
                            │   /api/admin/*          │
                            └──────────┬───────────┘
                                       ▼
                       ┌───────────────────────────────┐
                       │  Affordability engine (rules)   │
                       │  Risk scoring engine (rules)    │
                       └──────────────┬────────────────┘
                                      ▼
                          ┌───────────────────────┐
                          │  JSON file store        │
                          │  server/data/*.json     │
                          └───────────────────────┘
                                      ▲
                          ┌───────────┴────────────┐
                          │  Admin console (web)     │
                          └─────────────────────────┘
```

One decision engine, two front doors (WhatsApp and web) — this matters for an acquirer or a future engineering hire: there's a single source of truth for "is this loan affordable and how risky is it", not two parallel implementations that can drift.

## Suggested production topology

- **Compute:** containerize `server/` (a `Dockerfile` is trivial to add — it's a single Express process) and deploy to Render, Railway, Fly.io, or AWS ECS/Fargate.
- **Database:** replace `server/lib/db.js` with a Postgres-backed implementation (e.g. via Prisma or Knex) behind the same `insert/find/update/filter` interface, so no other file needs to change. Store ID numbers and bank details encrypted at rest (e.g. AWS KMS or pgcrypto).
- **Queue/async:** move WhatsApp message sending and third-party API calls (Smile ID, SigniFlow, Netcash) onto a small job queue (e.g. BullMQ + Redis) so webhook responses stay fast and retries are handled cleanly.
- **Observability:** structured logging (pino), error tracking (Sentry), and a dashboard on decision volumes/approval rates — useful for both operations and for any diligence process.
- **Multi-tenant readiness:** if Njomane ever licenses this platform to other lenders (a natural upsell), the affordability/risk engines are already stateless and config-driven (`.env`-based policy limits) — the main work would be tenant-scoping the data layer.

## Why the conversation engine is a state machine, not a chatbot LLM call

For a regulated lending flow, every question asked and every branch taken needs to be deterministic and auditable — an underwriter or regulator should be able to look at `session.step` and know exactly what was asked and why. `server/routes/whatsapp.js` and `public/js/chat.js` intentionally use a plain state machine rather than an LLM-driven conversation for this reason. There's room to layer a friendly LLM-powered "front end" for FAQs and general questions later — just keep it separate from the regulated data-collection path.
