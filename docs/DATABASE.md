# Database: JSON files vs. Postgres

This app ships with two interchangeable storage backends behind the same interface (`server/lib/db.js`). Nothing in `server/routes/` or anywhere else needs to change when you switch — only your `.env`.

## Which one is active?

- **`DATABASE_URL` unset** → the zero-setup JSON file backend (`server/lib/db.file.js`), storing data under `server/data/*.json`. This is the default, good for local development and Render's free plan demo.
- **`DATABASE_URL` set** → the Postgres backend (`server/lib/db.postgres.js`). Good for anywhere you need data to actually survive restarts/redeploys without paying for a persistent disk separately — Railway, Render's paid plans, a VPS running Postgres alongside the app, or AWS RDS.

The server logs which one it picked on startup:
```
[db] Using local JSON file backend (set DATABASE_URL to switch to Postgres).
[db] Using Postgres backend (DATABASE_URL is set).
```

## Switching to Postgres

1. Get a Postgres connection string. Options, cheapest first:
   - **Railway**: add a Postgres service from their dashboard — it gives you a `DATABASE_URL` automatically.
   - **Render**: add a Render Postgres instance (free for 30 days, then from $6/mo) — copy its "External Database URL".
   - **Supabase / Neon**: both have a genuinely free Postgres tier if you want a managed database independent of your hosting platform.
   - **Self-hosted**: run Postgres in the same `docker-compose.yml` as the app (see the commented-out example below).
2. Set it in `.env`:
   ```
   DATABASE_URL=postgres://user:password@host:5432/dbname
   ```
3. Restart the app. On first request it automatically creates the table it needs (`store`) — no separate migration step required.

### Adding Postgres to docker-compose.yml

```yaml
services:
  khula:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      - DATABASE_URL=postgres://khula:khula@db:5432/khula
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=khula
      - POSTGRES_PASSWORD=khula
      - POSTGRES_DB=khula
    volumes:
      - khula-pg-data:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  khula-pg-data:
```

Change the `khula`/`khula` username and password before running this anywhere but your own laptop.

## A note on KYC documents specifically

Switching `DATABASE_URL` to Postgres persists **application records** (including KYC metadata — document types, review status, audit log) but **not the encrypted document files themselves**, which stay on local disk under `server/data/uploads/`. On Render, Railway, or any platform without a persistent disk attached, uploaded documents will be lost on redeploy even with Postgres configured — the application record will still show them as "uploaded" but the underlying file will be gone.

For real deployments handling actual KYC documents, either attach a persistent disk to your hosting platform (see `docs/DEPLOY.md`) or move `server/lib/documentStore.js` to object storage (S3, or S3-compatible like Backblaze B2/Cloudflare R2) — that file is the only place document storage logic lives, so it's a contained change. This matters more than it might seem: losing a borrower's uploaded ID document is a worse failure mode than losing an application record, since re-uploading is friction the borrower has to redo.

## How the Postgres backend actually stores data

Rather than a hand-built schema per collection (applications, conversations, admins), records are stored as JSONB blobs in one generic `store` table:

```sql
CREATE TABLE store (
  row_id SERIAL PRIMARY KEY,
  collection TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

`find`/`filter` pull all rows for a collection and run the same JavaScript predicate functions the file backend uses — so behavior between the two backends is identical, not just similar. This is the right trade-off at MVP scale (hundreds to low thousands of applications). If a collection grows large enough that "fetch everything in this collection" stops being fine, that's your signal to give `applications` a real dedicated table with indexed columns (`reference`, `idNumber`, `status`) rather than a generic JSONB store — a natural next step once loan volume justifies it.

## Verified, not assumed

Both backends were tested end-to-end against the same suite: create an application (approved and declined paths), upload KYC documents (including a magic-byte rejection test with a disguised file), decrypt and view a document as admin with a byte-for-byte diff against the original, verify KYC and unlock signing, download the generated pre-agreement PDF, sign, cancel within the reconsideration window, admin login/stats/list, and a full WhatsApp conversation. The Postgres backend was tested against a real local Postgres instance, not just reviewed for correctness.
