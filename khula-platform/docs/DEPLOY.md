# Deploying tonight: real options, verified pricing

Checked against official pricing pages and docs in August 2026 — these change often, so re-verify before you commit if you're reading this later.

## The short answer

| If you want... | Use | Cost tonight | Cost ongoing |
|---|---|---|---|
| A live URL to demo in the next 15 minutes | **Render (free plan)** | R0 | R0 forever, but cold starts + no persistent data |
| Something that stays fast and keeps real data, minimal setup | **Railway** | R0 (uses free trial credit) | ~$5/mo (~R90/mo) |
| Best value if you're willing to spend an evening once | **A small VPS (Hetzner/DigitalOcean)** | Free to set up | $4–6/mo (~R70–110/mo), full control |
| You want to use your AWS certification and don't mind more setup | **AWS EC2** | Free using new-account credits | Free for ~6 months on new accounts, then usage-based |

None of these need a credit card to *try* except Railway and AWS, which ask for one but won't charge unless you exceed the free allowance.

---

## Option 1 — Render free plan (fastest, truly free, good for tonight's demo)

**What you get:** a public HTTPS URL, zero cost, forever. **The catch:** the free plan spins your app down after 15 minutes of no traffic (next visitor waits ~1 minute for it to wake up), and it has **no persistent disk** — any applications submitted get wiped on the next restart or redeploy. Perfect for showing people tonight; not yet suitable for taking real loan applications you need to keep.

**Steps (~15 minutes):**
1. Push this folder to a new GitHub repo (Render deploys from Git, not a zip upload):
   ```bash
   cd khula-platform
   git init && git add . && git commit -m "Khula MVP"
   gh repo create khula-platform --private --source=. --push
   # or create the repo on github.com and `git remote add origin ...` + `git push`
   ```
2. Go to [dashboard.render.com](https://dashboard.render.com), sign up (no card needed for the free plan), click **New > Blueprint**, and point it at your repo. Render will detect `render.yaml` (already included in this zip) and configure everything automatically.
3. In the Render dashboard, set the one secret it can't generate for you: run `npm run seed:admin -- "YourPassword"` locally, and paste the printed hash into the `ADMIN_PASSWORD_HASH` environment variable.
4. Deploy. You'll get a URL like `https://khula-financial-services.onrender.com` — that's your live app tonight.

To upgrade later for persistence: change `plan: free` to `plan: starter` in `render.yaml` (US$7/mo) and uncomment the `disk:` block, or just add a disk from the Render dashboard.

---

## Option 2 — Railway (best balance of "works tonight" and "keeps working")

**What you get:** no cold starts, real persistent volumes, a genuinely fast deploy. **The catch:** new accounts get a one-time $5 trial credit (30 days, no card required to start), after which it's a **$5/month minimum** (Hobby plan) — not permanently free.

**Steps (~10 minutes):**
1. Go to [railway.app](https://railway.app), sign up, **New Project > Deploy from GitHub repo** (push this folder to GitHub first, same as above).
2. Railway auto-detects the `Dockerfile` and `railway.json` already in this zip.
3. Add a **Volume** in the Railway dashboard, mounted at `/app/server/data` — this is what makes your data actually survive.
4. Add the same environment variables listed in `render.yaml` (Railway's dashboard lets you paste a whole `.env` file at once — copy from your local `.env`).
5. Deploy. Railway gives you a `*.up.railway.app` HTTPS URL immediately; add a custom domain later for free.

---

## Option 3 — A small VPS (best long-term value, if you can spend one evening)

**What you get:** full control, real persistence, and the cheapest ongoing cost by far — Hetzner's smallest box runs ~$4/mo (~R70/mo), DigitalOcean's ~$6/mo (~R110/mo). **The catch:** you're the sysadmin — no managed platform holding your hand.

**Steps (~45 minutes the first time):**
1. Spin up a small Ubuntu VPS (Hetzner Cloud CX22 or DigitalOcean Basic Droplet).
2. SSH in, install Docker: `curl -fsSL https://get.docker.com | sh`
3. Copy this project to the server (`scp -r khula-platform root@your-ip:/opt/`) or `git clone` it.
4. `cd /opt/khula-platform && cp .env.example .env` and fill in real values.
5. For free automatic HTTPS without buying a domain yet, put [Caddy](https://caddyserver.com/) in front, or use a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (also free) — either gives you a real HTTPS URL, which WhatsApp's webhook requires.
6. `docker compose up --build -d` — done, and it survives reboots (`restart: unless-stopped` is already set in `docker-compose.yml`).

---

## Option 4 — AWS EC2 (worth it given your AWS certification)

AWS changed its free-tier structure in July 2025: new accounts now get **$100–$200 in credits usable for 6 months** (not the old "750 free EC2 hours for 12 months" — that only still applies to accounts created before July 2025). The credits cover a small EC2 instance comfortably for the full 6 months if you're not running much else alongside it.

**Steps, high level:**
1. Launch a `t3.micro` EC2 instance (Ubuntu), attach a small EBS volume for `server/data`.
2. Open ports 80/443 in the security group.
3. Same Docker steps as Option 3 once you're SSH'd in.
4. Use an Elastic IP (free while attached to a running instance) plus Caddy or a Cloudflare Tunnel for HTTPS.

Given your AWS background, this is probably the most comfortable option once you have half an hour to spare — just not the fastest for literally tonight compared to Render or Railway.

---

## Whichever host you pick: two things WhatsApp needs

1. **A real HTTPS URL.** Meta will not accept an `http://` webhook or a self-signed certificate. Render and Railway give you this automatically; on a VPS/AWS use Caddy or a Cloudflare Tunnel (both free).
2. **A stable URL that doesn't change.** If you're only testing the web chat widget tonight, this doesn't matter yet — you can wire up the real WhatsApp webhook once you've picked where this lives long-term. The web widget works identically on every option above with zero extra setup.

## A pragmatic path for tonight specifically

Deploy to **Render's free plan right now** to get a shareable link working in the next 15 minutes — that's enough to demo the product, test the flow yourself, and show people tonight. Then, this week, move to **Railway** ($5/mo) if you want it to keep real applications without becoming a sysadmin project, or set up the **Hetzner VPS** if you'd rather spend one evening and pay less long-term. Don't wire up the real WhatsApp Business API until you've settled on where this will live for more than a demo — switching hosts later just means updating the webhook URL in Meta's dashboard, nothing else changes.

## Don't forget the database

Whichever host you land on, remember the free/cheapest tier usually means **no persistent disk** — see the note on each option above. If you want applications to survive a restart or redeploy without paying for platform-level disk storage, set `DATABASE_URL` in `.env` to a Postgres connection string instead (Railway and Supabase both have a free/cheap Postgres you can add in under 5 minutes). See `docs/DATABASE.md` for exactly how — it's a one-line env var change, nothing else in the app needs to be touched, and both storage paths have been tested end-to-end.
