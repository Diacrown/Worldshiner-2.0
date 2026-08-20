# World Shiner 2.0 — Session Handoff (2026-08-20)

Full context for continuing this project in a new conversation. Read this first, then spot-check anything critical against the actual code/DB rather than trusting it blindly — it's a snapshot, not a guarantee.

## What this project is

A ground-up rebuild of "World Shiner," a jewellery job-tracking system, replacing an old Firestore/Firebase system (project `jewellery-tracker-6371b`) that ran as separate static HTML apps per office. New stack: Node/Express/PostgreSQL API + a single-file vanilla-JS frontend (no build step, deliberately).

**Repo layout:**
- `backend/` — Express API, `src/routes/*.routes.js` (thin) → `src/services/*.service.js` (business logic), raw parameterized SQL via `pg` (no ORM), migrations in `backend/src/db/migrations/*.sql` run in filename order by `backend/src/db/migrate.js`, reference data + demo accounts in `backend/src/db/seed.js`.
- `frontend/index.html` — the entire frontend. `frontend/config.js` is the one line that points it at a backend (`window.WORLDSHINER_API_BASE`).
- `docs/` — `ARCHITECTURE.md` (design decisions + old-system audit), `ROADMAP.md` (built vs. deferred), `DEPLOYMENT.md`, this file.
- `backend/scripts/migrate-historical-jobs.js` and `scripts/export-firestore.js` — one-time data-migration tools (see below).

**Key architectural patterns to follow if extending this:**
- Office/org visibility is centralized in `services/scope.js`'s `buildScope(user, {officeOverride, ownerView})` — reuse it, never re-derive office-scoping logic per feature (this exact duplication was the old system's root-cause bug class, documented in `docs/ARCHITECTURE.md`).
- Sub-resources hanging off a job (issues, chat, design entries, setter/polisher) enforce scoping by calling `getJobById(user, jobId)` first (from `jobs.service.js`) — null return means out-of-scope/404, not a separate ownership check.
- Server-side gating for role/office-specific fields happens in the service layer, not just hidden in the UI (see `officeHasAssay` gating in `jobs.service.js` `updateJob`).
- Frontend forms follow one consistent pattern: `.overlay > .sheet` markup, `api()` wrapper (auto-attaches JWT), toast on error, reload list on success.

## Environments

**Local dev:**
- Postgres 17 runs as a **plain background process, NOT a Windows service** (`C:\Users\Admin\pgdata17`, port 5433) — the actual Windows Postgres service exists but can't be controlled (no admin/UAC elevation in this shell). If it's not running: `"/c/Program Files/PostgreSQL/17/bin/pg_ctl" -D "C:\Users\Admin\pgdata17" -l "C:\Users\Admin\pgdata17\server.log" -o "-p 5433" start`. It does NOT survive a machine restart/crash — check `server.log` for "database system was not properly shut down" and give it ~15-20s to finish WAL recovery before connecting.
- Backend: `cd backend && npm start` (port 4000). `.env` has `DATABASE_URL` pointed at the local instance.
- Frontend: `cd frontend && python -m http.server 8080`. **`config.js` is currently checked in pointing at PRODUCTION** (`https://worldshiner2-api.onrender.com/api`) — for local frontend testing, temporarily edit it to `http://localhost:4000/api`, test, then **revert it before committing** (this has bitten us once already).
- Gotcha: the Claude Browser tool's preview pane aggressively caches `config.js` across reloads/hard-refresh/new-tabs within the same session. If local API calls mysteriously fail with "Failed to fetch" after editing config.js, check `window.WORLDSHINER_API_BASE` in the console — if it's stale, either open a genuinely fresh tab or monkey-patch `window.fetch` in-session to redirect the stale prod URL to localhost rather than fighting the cache.

**Production:**
- Database: Supabase Postgres (project ref `oaubkyipjgyaxackuvnh`, Mumbai/ap-northeast-1 region — connection details are in the user's Supabase dashboard and already configured in Render's env vars, not repeated here).
- Backend: Render, `https://worldshiner2-api.onrender.com`, deployed from GitHub via `backend/render.yaml` Blueprint. `STORAGE_DRIVER=supabase` for image uploads (verified working — bucket `job-images`, public).
- Frontend: Netlify, `https://wsl-job-tracker.netlify.app`, deployed via manual drag-and-drop to the site's own Deploys tab (not GitHub-connected — pushing to GitHub does NOT auto-update Netlify; re-drag the `frontend/` folder to update it).
- GitHub: `https://github.com/Diacrown/Worldshiner-2.0` (private). **I (Claude) do not retain GitHub tokens between uses by design** — every push this session needed a fresh, narrowly-scoped fine-grained PAT (repo-only, Contents: read/write) pasted by the user, used once via a temp credential file, then discarded. Expect to repeat this for any future push.
- CORS: `CORS_ORIGINS` on Render must exactly match the Netlify URL (no trailing slash) — this broke once already after a Netlify redeploy changed nothing, but is worth checking first if the frontend can't reach the backend.

## What's been built (functionally complete, tested)

1. **Core system**: JWT auth, 3-tier admin roles (global/org/office-master) + restrict-to-own-jobs, two orgs (DIACROWN/DIAMORE) with isolated offices, full job CRUD, branch↔HQ status sync (see below), setting-charge guard for semi-mount jobs, issue tracker, per-job chat, image uploads.
2. **Enterprise UI overhaul**: navy/slate palette (was warm terracotta/boutique), Inter typeface, collapsible sidebar nav, mobile-responsive.
3. **Status pipeline correction**: expanded from 26 to **34 branch statuses** and corrected the HQ sync maps, based on the real branch user manual (PDF) and a Sydney-vs-UK functionality diff (docx) the user supplied — several sync rules were completely missing before (e.g. `not_proceeding` never told India to close the job).
4. **Design entries / client items**: per-job CRUD, auto-claimed design numbers.
5. **Per-office design-number counters** — corrected from an initial wrong "one global counter" design after reading real Firestore data: each office has its own `letter_prefix` + `next_design_value` (columns on `offices`), seeded from the **real production counter values** (Sydney continues from 1344, Brisbane 703, UK 541, Texas 572; other offices start fresh at 1 with assigned prefixes M/P/N/I/G/D).
6. **SLA Alerts + Needs Attention** (merged as sub-tabs under one "Alerts" nav item): SLA breach detection (time-in-status thresholds) plus due-soon/awaiting-overseas-update/client-chase-up alerts with a snooze action. Thresholds are documented assumptions, not certainties — flagged in code comments.
7. **Setter/Polisher/Repairer tracking** — job-level (corrected from an initial wrong placement on the issue tracker after reading real data, which showed these as parallel job fields, not issue fields).
8. **Office-wide chat** (floating widget) — separate from per-job chat, confirmed as a real feature from the old system's `office_chat` Firestore collection.
9. **Assay Office** — UK-only (gated via `offices.has_assay_office` boolean, checked server-side not just UI-hidden): dedicated Job Detail tab, batch-assay action across selected jobs.
10. **Reports**: Monthly summary (PDF + JSON), Setter/Polisher/Repairer summary, Overdue (Quoting/CAD Approved stuck jobs), Client Items, CSV export.
11. **Excel/CSV import** (for future new jobs, distinct from the historical migration below): safe preview→confirm flow with auto column-mapping, PO dedup.
12. **Gmail OAuth scaffolding**: fully coded (OAuth flow, encrypted token storage via AES-256-GCM, inbox search, CAD-email send, bulk mail) but **non-functional until the user sets up a Google Cloud OAuth client** — gracefully reports "not configured" rather than erroring.
13. **Deployment**: fully live (Render + Netlify + Supabase), verified end-to-end (login, CORS, image upload/delete all tested against production).
14. **Historical data migration tooling** (see next section — this is mid-flight).

## Historical data migration — IN PROGRESS, this is the most urgent pending item

The user provided a Firebase service-account key (used, should be revoked — see Outstanding Items) to pull real production data out of the old Firestore system. Two scripts were built:

- **`scripts/export-firestore.js`** — dumps Firestore collections to local JSON (`firestore-export/`, gitignored, contains real client data — never commit it). Supports `--limit=N` (sample) and `--only=a,b` (specific collections).
- **`backend/scripts/migrate-historical-jobs.js`** — the actual migration. Reads `firestore-export/jobs_v2.json` and `jobs_v2_uk.json` (the two real, in-use collections — two other collections, `jewellery_jobs` and `jobs_london`, were investigated and explicitly excluded per the user's own decision: `jobs_london` is confirmed-superseded legacy data, `jewellery_jobs` origin was unconfirmed). Transforms and loads each job's full data — production spec, design entries, client items, images (linked directly to their existing Cloudinary/Drive URLs, not re-uploaded), setter/polisher/repairer records, chat messages, and a **reconstructed `job_status_history`** built from the old per-status `ts*` timestamp fields (tsQuoting, tsCadProvided, tsShippedIndia, etc.) — this is a real enrichment, not just a straight copy, since the old system never had a proper history table.

**Status as of the interruption:**
- Real data volume: **2733 total real jobs** (WS-SYD 1885, WS-UK 431, WS-BNE 133, DM-USA 131, WS-MEL 76, WS-POL 50, WS-NZ 27).
- Status-label mapping (Firestore's human-readable labels → this system's status codes) is fully built and evidence-based, including confirmed legacy aliases ("In Production" = `production_started`, "CAD Requested" = `making_cad`, per the old system's own documented display-patching behavior) and a best-effort HQ-side alias table for ~10 low-volume unmapped labels.
- **Tested against local dev DB: 2733/2733 imported successfully, 0 errors**, after fixing one bug (a handful of source records have genuinely malformed dates like `"2026-16-04"` — month 16 doesn't exist, a data-entry typo in the old system; the script now nulls out just that one field instead of failing the whole job). Office distribution matched the source exactly. Full regression (66 smoke-test checks) still passed with the larger dataset loaded.
- **NOT yet run against production** — the attempt was killed by a shell syntax error (`DATABASE_URL=... time node script.js` — `time` is a bash keyword that can't follow an inline env-var assignment that way; nothing was written to production, this is purely a shell-quoting bug, not a script bug).

**To finish this**, from `backend/`, run (drop the `time`, or wrap correctly — e.g. `DATABASE_URL="..." node scripts/migrate-historical-jobs.js` without a shell keyword prefix, or wrap the whole thing in `bash -c 'time ...'`):
```bash
cd backend
DATABASE_URL="<production connection string, URL-encoded password>" node scripts/migrate-historical-jobs.js
```
**Critical constraint: this can only be run against production ONCE.** Jobs with no PO number can't be deduped (the script dedupes by `office + po_number`; empty-PO jobs always insert fresh), so a second run will create duplicates of every PO-less historical job. If it needs to be re-run for any reason, the safe move is to first check whether any rows already exist (e.g. `SELECT count(*) FROM jobs WHERE import_batch_id IS NOT NULL`) and consider clearing the previous import batch's jobs before re-running, rather than running it twice blind.

## Outstanding items (not urgent, but real)

- **Revoke the Firebase service account key** (`jewellery-tracker-6371b-firebase-adminsdk-fbsvc-...json` in Downloads) — Firebase Console → Project Settings → Service Accounts. Still not confirmed done.
- **Push latest commits to GitHub** — needs a fresh PAT from the user (same process as before). Local commits include all the Assay/Alerts/Setter-Polisher/Office-Chat/Reports UI work and both migration scripts.
- **Demo → real account conversion**: planned approach is per-office invite codes (not me generating passwords for real people) — but several office/user mappings from the user's own instructions don't fully match what's in Firestore's `staff` collection:
  - Brisbane: user said "Jigar, Atit" — Firestore shows `bnejewellery@worldshiner.com` and `brisbane@worldshiner.com` (=Atit, per `user_settings`); which email is Jigar's is unconfirmed.
  - Melbourne: user said "Maulin, Hetvan" — Firestore shows only ONE account, `cadmelbourne@worldshiner.com`; unclear whose it is or where the second person's account is.
  - Poland: user said "Darshil, Simit" — Firestore shows only `daarshill99@gmail.com` (Darshil); no account found for Simit.
  - UK: user said "Nehal, Darshit" — Firestore has those two AND two more unlisted people (`karishma.parasrampuria@yahoo.com`, `nisha.b@hotmail.co.uk`) — include them or not?
  - NZ: user said "Devang" — only one account (`nz@worldshiner.com`) exists; presumed to be Devang's but unconfirmed.
  - Italy, Germany: no Firestore accounts exist at all (new offices, never had real users in the old system).
- **Deactivate demo accounts** — deliberately deferred until the user has verified the live deployment works end-to-end with the demo logins (don't want to lock them out of testing their own deployment).
- **Owner attribution on migrated historical jobs**: all migrated jobs currently have `owner_user_id = NULL` since real staff accounts don't exist yet. Once real accounts are created, consider a backfill pass matching the old `owner` email field (preserved in the source data, just not currently used in the transform) to the new `users.id`.

## Feature enhancements worth considering next

Roughly in order of likely value:

1. **Server-side pagination / better filtering for the Jobs list** — the dataset just went from ~0 to 2733 real jobs; `listJobs` defaults to `limit=100` which works but the UI has no pagination controls yet. Worth adding before real staff start using this daily.
2. **Backfill `owner_user_id`** on migrated jobs once real accounts exist (see above) — restores "my jobs" filtering for historical data.
3. **Review the ~27 jobs with a nulled-out malformed date** — these imported successfully but lost one date field each (e.g. a `tsCadProvided` value). Low priority, but a data-quality cleanup pass could recover them by fixing the typo'd source date and re-setting that one field.
4. **CAD+Quote structured price-breakdown email** and **Allowed-Senders inquiry whitelist** — both scoped and deferred pending real Gmail credentials (the underlying OAuth scaffolding is ready).
5. **Google Sheets sync** — the old system pushed every job save to a connected Sheet via Apps Script webhook; not built, needs its own credential setup if wanted.
6. **Real-time updates** — currently manual-refresh/poll-based; the old Firestore system had live `onSnapshot` sync. A WebSocket or SSE layer would be a meaningful but non-trivial upgrade.
7. **Camera capture on mobile** — cheap win, just add `capture="environment"` to the existing image-upload `<input type=file>` elements so mobile browsers open the camera directly instead of a file picker.
8. **Columns customizer** (old UK build had one, Sydney didn't) — cosmetic, low priority.
9. **Duplicate-job finder** — existed in the old system as a maintenance tool; not rebuilt, could matter now that real historical data (with its own dedup quirks) is loaded.
10. **PWA/offline support** — the old system was installable and cached for offline use; this rebuild has none of that. Significant scope if pursued.

## Session-specific working notes

- Local dev credentials: DB `postgres`/`postgres` on port 5433; demo app accounts all use password `demo1234` (e.g. `admin@worldshiner.demo`).
- The `pg_ctl`/backend/frontend background processes do not survive this environment's occasional crashes — always health-check (`curl .../api/health`) before assuming something is running, and check for stale processes holding a port (`Get-NetTCPConnection -LocalPort <port>`) before starting a fresh one, since starting a second instance on an occupied port fails silently in the background-task log rather than the foreground.
- `smoke-test-auth.sh` mutates demo account passwords — always re-run `npm run seed` after it, and it's not safe to re-run back-to-back without a reseed in between (fixed-email test fixtures collide with themselves).
- The other three smoke suites (`smoke-test.sh`, `-orgs`, `-collab`) are safely re-runnable anytime as a quick regression check.
