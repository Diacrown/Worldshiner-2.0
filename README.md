# World Shiner 2.0

A ground-up rebuild of the World Shiner jewellery job-tracking system:
Node/Express/PostgreSQL API + a thin JS frontend, replacing the inherited
flat-HTML-per-office + Firestore architecture.

**Start here:** `docs/ARCHITECTURE.md` (what was audited from the old system
and why 2.0 is built this way), `docs/ROADMAP.md` (what's built and tested
right now vs. what's next), and `docs/DEPLOYMENT.md` (exact steps to put
this on free tiers, plus a concrete checklist for when to upgrade what as
usage grows).

## Quick start (local)

Requires Node 18+ and PostgreSQL running locally.

```bash
cd backend
cp .env.example .env
# Edit .env: set a real DATABASE_URL and a random JWT_SECRET
#   (generate one with: openssl rand -hex 32)

npm install
npm run migrate   # creates all tables
npm run seed      # loads offices, status vocab, and 5 demo logins

npm start         # http://localhost:4000
```

Demo logins (all password `demo1234` — **change/remove these before any real
use**, see docs/ROADMAP.md). Two hubs exist — DIACROWN (10 offices) and
DIAMORE (2 offices, placeholder codes until DIAMORE's real location is confirmed):

| Email | Role |
|---|---|
| admin@worldshiner.demo | Super admin — sees both orgs, every office |
| diacrown.orgadmin@worldshiner.demo | Diacrown org admin — sees Diacrown only, not Diamore |
| india.staff@worldshiner.demo | Diacrown HQ staff — sees Diacrown only |
| diamore.staff@worldshiner.demo | Diamore HQ staff — sees Diamore only, not Diacrown |
| diamore.location.staff@worldshiner.demo | Diamore's one location, ordinary staff |
| texas.master@worldshiner.demo | Texas (Diacrown), office master |
| texas.staff@worldshiner.demo | Texas (Diacrown), ordinary staff |
| sydney.staff@worldshiner.demo | Sydney (Diacrown), ordinary staff |

Verify the backend actually works before touching the frontend:
```bash
bash smoke-test.sh          # 26 checks: auth, office scoping, status sync, the setting-charge guard
bash smoke-test-orgs.sh     # 18 checks: DIACROWN/DIAMORE isolation, the three admin tiers
bash smoke-test-collab.sh   # 22 checks: job editing, issues, chat, image uploads
bash smoke-test-features.sh # 14 checks: design entries, SLA alerts, reports, import, Gmail scaffolding
bash smoke-test-auth.sh     # 19 checks: sign-up, invite codes, password change/reset
```
All five should print `0 failed`. If any fail, something about your local
Postgres/env setup differs from what was tested here — don't proceed to the
frontend until these pass. Run `smoke-test-features.sh` *before*
`smoke-test-auth.sh` (or re-seed between them) — `smoke-test-auth.sh`
changes some demo accounts' passwords as part of testing; re-run
`npm run seed` afterward to reset everything back to a known state
(`demo1234` for all demo accounts).

By default images save to local disk (`backend/uploads/`) — fine for this
local testing, but **not for deployment** (see `docs/DEPLOYMENT.md` — most
free hosts wipe local disks on restart). Set `STORAGE_DRIVER=supabase` in
`.env` once you deploy.

## Frontend

`frontend/index.html` is a single static file — no build step. Open it
directly, or serve it:
```bash
cd frontend
python3 -m http.server 8080   # or: npx serve
```
It talks to `http://localhost:4000/api` by default. To point it at a
deployed API, set `window.WORLDSHINER_API_BASE` before the app's script runs
(e.g. add `<script>window.WORLDSHINER_API_BASE = 'https://your-api.example.com/api';</script>`
right before the closing `</head>` tag).

**I was not able to test this frontend in an actual browser** — this
sandbox has no browser available, only a JS syntax check and an automated
check that every element ID the JS references actually exists in the HTML
(both passed). Do a quick manual pass yourself before relying on it: sign in,
create a job, change its status, open the tabs.

## Deploying for real

Full step-by-step (exact clicks, env vars, and a concrete "when to upgrade
what" checklist) is in `docs/DEPLOYMENT.md`. Short version: Supabase for
database + image storage, Render for the API, Netlify for the frontend —
all free to start.

## Project layout

```
backend/
  src/db/migrations/   -- SQL schema, applied in order by npm run migrate
  src/db/seed.js        -- reference data + demo logins + demo invite code
  src/services/         -- business logic (status sync, setting-charge guard, jobs, issues, invites)
  src/routes/           -- HTTP layer only — thin, delegates to services/
  render.yaml            -- one-click Render deployment blueprint
  smoke-test.sh          -- 26 checks: core jobs/status/scoping
  smoke-test-orgs.sh     -- 18 checks: DIACROWN/DIAMORE isolation, admin tiers
  smoke-test-collab.sh   -- 22 checks: editing, issues, chat, uploads
  smoke-test-auth.sh     -- 19 checks: sign-up, invite codes, password change/reset
frontend/
  index.html             -- the whole frontend, single file, no build step
  config.js              -- the one line you edit to point at a deployed API
  netlify.toml
docs/
  ARCHITECTURE.md         -- audit of the old system + how 2.0 is designed
  ROADMAP.md              -- done / deferred / needs-your-credentials
  DEPLOYMENT.md           -- free-tier setup steps + scaling checklist
```

## A note on the uploaded staff data

Your original `staff` collection (~14 real personal email addresses) was
deliberately **not** ported into the seed data — see docs/ROADMAP.md for why.
Add real staff through the Staff screen (admin login) or the `POST /api/users`
endpoint once you're running this for real.
