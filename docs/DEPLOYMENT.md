# Deploying World Shiner 2.0 on free tiers

Three services, all free to start: **Supabase** (database + image storage),
**Render** (the API), **Netlify** (the frontend — you already use this one).

## 1. Database + storage — Supabase

1. Create a project at supabase.com (free tier: 500MB DB, 1GB storage).
2. **Settings -> Database -> Connection string** — copy the "URI" one
   (starts `postgresql://postgres:...`). This is your `DATABASE_URL`.
3. **Storage -> New bucket** — name it `job-images`, mark it **Public**
   (so uploaded photos load directly by URL, same as Cloudinary did before).
4. **Settings -> API** — copy the Project URL and the `service_role` key
   (not the `anon` key — the service role key is what lets the API write to
   storage on users' behalf). These become `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`.

## 2. API — Render

1. Push this `backend/` folder to a GitHub repo (private is fine).
2. Render.com -> New -> Blueprint -> point at the repo. It reads
   `backend/render.yaml` automatically.
3. Fill in the env vars Render asks for (marked `sync: false` in the
   blueprint): `DATABASE_URL` (from step 1), `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` (from step 1), and `CORS_ORIGINS` (leave
   blank for now — you'll fill this in after step 3, once you know your
   Netlify URL).
4. Deploy. Render runs `npm run migrate` automatically on every boot
   (safe — it skips anything already applied) but does **not** auto-run
   `npm run seed` (see the comment in `render.yaml` for why). Run it once
   yourself: Render dashboard -> your service -> Shell tab ->
   `npm run seed`.
5. Note your API's URL (`https://worldshiner2-api.onrender.com` or similar).

**Free-tier catch:** Render's free web services spin down after 15 minutes
of no traffic, and the next request takes ~30-50 seconds to wake it back up.
Fine for testing; annoying for daily real use. The $7/mo "Starter" instance
removes this — worth it the moment this is actually being used day-to-day,
not a huge jump.

## 3. Frontend — Netlify

1. Edit `frontend/config.js` — one line — to your Render API URL from step 2:
   ```js
   window.WORLDSHINER_API_BASE = 'https://worldshiner2-api.onrender.com/api';
   ```
2. Push `frontend/` to a repo (or drag-and-drop the folder into Netlify's
   deploy UI — no build step, so this genuinely works).
3. Netlify gives you a URL (`https://something.netlify.app`).
4. **Go back to Render** and set `CORS_ORIGINS` to that exact Netlify URL,
   then redeploy the API. Without this step the frontend will load but every
   API call will fail with a CORS error.

## 4. Before anyone real uses this

- Log in as `admin@worldshiner.demo` (password `demo1234`), go to Staff,
  and either delete the demo accounts or change their passwords immediately.
- Same for the `DEMO-JOIN` invite code — revoke it (Staff -> Invite Codes)
  and create real ones scoped to the right offices.
- Rotate `JWT_SECRET` if you ever shared/committed the one Render
  auto-generated.

## 5. When you outgrow this (concrete triggers, not guesses)

| Signal you'll actually see | What to change |
|---|---|
| Render's cold-start delay (30-50s) is annoying staff daily | Upgrade to Render's $7/mo Starter (always-on) |
| Supabase dashboard shows you approaching 500MB | Job rows are small — this typically means image metadata + history, not job count itself. Upgrade to Supabase Pro (~$25/mo, 8GB) well before this is urgent |
| Supabase Storage approaching 1GB | Photos are the real growth driver, not job count. Move to Cloudflare R2 (10GB free, then $0.015/GB with **zero egress fees** — matters once staff/clients are frequently *viewing* photos, not just uploading) |
| `pg` connection errors under load ("too many clients") | Add PgBouncer/connection pooling — Supabase has this built in on paid tiers (use the "Transaction" pooler connection string instead of the direct one) |
| Job list queries feel slow with large offices | Already using indexed queries + `LIMIT`/`OFFSET` pagination (see `services/jobs.service.js`) — next step is adding a proper search index (Postgres full-text search, `pg_trgm`) instead of the current `ILIKE` scan |
| Alerts/reports need to run on a schedule, not on-demand | Add a background worker (node-cron in-process is enough at this scale; a real queue like BullMQ+Redis only once report volume is heavy) |
| Multiple regions/countries need low latency | Postgres read replicas (Supabase/Neon higher tiers) — this is well past "lakhs of jobs" territory, don't provision for it early |

None of the above requires re-architecting anything already built — every
one of these is a configuration or infrastructure change, not a code
rewrite, because the pieces (pluggable storage driver, indexed queries,
pagination, connection pooling being a connection-string change) were built
with this path in mind from the start.
