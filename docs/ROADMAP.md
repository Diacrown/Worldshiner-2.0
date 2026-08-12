# Roadmap: built, deferred, and why

## Built and tested (99 automated checks, 0 failing)

Run all five suites yourself before trusting any of this — the numbers
above are from this sandbox, not a promise about your machine. Run
`smoke-test-features.sh` before `smoke-test-auth.sh`, or re-seed between
them — `smoke-test-auth.sh` mutates some demo account passwords.
```bash
bash smoke-test.sh && bash smoke-test-orgs.sh && bash smoke-test-collab.sh && bash smoke-test-features.sh && bash smoke-test-auth.sh
```

- **Org layer (new)**: DIACROWN and DIAMORE as real, isolated hubs. Three
  admin tiers (super admin / org admin / office-level), with org isolation
  enforced at the database-query level, not just hidden in the UI. Includes
  a fix for a real gap found while building this — see `ARCHITECTURE.md`
  section 7. DIAMORE's office code (`DM-LOC1`) is a placeholder until its
  real location code is confirmed.

- **Auth**: JWT login, 5 role combinations (global admin, HQ staff, office
  master, ordinary staff, restricted-to-own-jobs) all modeled and scoped correctly.
- **Offices & status vocab**: single source of truth, seeded from what was
  actually found in your uploaded files (10 offices, 26 branch statuses, 20
  HQ statuses).
- **Jobs**: create, edit, list (searchable, filterable by status), get by id,
  full office-isolation between branches, HQ's cross-office visibility.
- **Status workflow**: branch-side changes, HQ-side changes, both sync
  directions, the semi-mount setting-charge guard (blocking AND unblocking
  paths), system-only status protection, full history trail.
- **Issue tracker**: open/resolve/reopen, full event history per issue.
- **Job chat**: per-job threads, cross-office (branch ↔ India), unread counts.
- **Images**: upload (local disk — see below), attach to a job, list, delete.
- **Staff management**: list/add/deactivate staff, replaces the standalone
  Staff Manager tool from your upload.
- **Frontend**: single-file, no build step, sidebar navigation, enterprise
  theme (navy/slate palette, Inter typeface), responsive down to mobile.
  Manually verified in-browser (login, all nav sections, Job Detail modal's
  6 tabs).
- **Design entries / client items**: auto-incrementing design number claiming
  (`S00001` style, zero-padded from `design_number_counter`), matching-set
  pieces sharing a base with a free-text suffix (`S00001E-S`/`S00001W-S`),
  stock entries with no claimed number, client items list — all with full
  CRUD and office-scoped like everything else. Deleting an entry never
  decrements the counter, so numbers stay monotonic.
- **SLA alerts dashboard**: flags jobs sitting past a threshold in Quoting
  (24h), CAD/Render (6h), or Ready to Ship (5 days), based on
  `job_status_history`. Read-only dashboard, no email/push. **The status-code
  mapping for "Q1" and "CAD/Render" are assumptions** — confirm they match
  your real old-system rules (see `sla.service.js`'s `SLA_THRESHOLDS` comment).
- **Monthly PDF reports**: per-office job counts (created / completed / not
  proceeding) plus a full status-activity breakdown, for any month, filtered
  by office. JSON preview + PDF download.
- **WhatsApp quote sharing**: one-click share from Job Detail, opens
  `wa.me` with a pre-filled status update message.
- **Excel/CSV import**: two-step preview → confirm flow (no real sample
  export was available to build against, so it auto-detects column mapping
  and always requires human review before committing, rather than guessing
  blind). Dedups by PO number per office, tags every imported job with an
  `import_batch_id` for traceability.
- **Gmail integration (scaffolding)**: OAuth connect flow, encrypted token
  storage, inbox search, CAD-email send, bulk mail — fully coded but
  **non-functional until you add Google Cloud OAuth credentials** (see
  `.env.example`). Safe to leave unset: `/api/gmail/*` returns a clean
  "not configured" response rather than erroring.

## Cloud image storage — correction

Earlier drafts of this doc called Supabase Storage "deferred." That was
stale: `saveSupabase()` in `routes/uploads.routes.js` has been fully
implemented since the first build. This isn't a code task, just a
credentials one — set `STORAGE_DRIVER=supabase` plus `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` in `.env` once you have a
Supabase project and a public Storage bucket.

## Still deferred, and why

- **A Sydney-specific workflow document** — you mentioned a detailed summary
  is coming; nothing built against it yet since it hasn't arrived.
- **Real staff accounts for the other offices** (Melbourne, Brisbane, UK, NZ,
  Texas, Poland, Italy, plus Sydney's other users) — deliberately not created
  without real email addresses and an explicit decision on who gets which
  role, same reasoning as the original demo-account note below.
- **Gmail OAuth credentials, Google Cloud project setup** — only you can
  create these (Client ID/Secret, consent screen). The scaffolding above is
  ready the moment you do.
- **A real Excel/CSV sample export** — the importer works today with
  best-effort column detection, but validating it against your actual old
  export format (and re-confirming the SLA status-code mapping above) is
  worth doing before relying on either for real data.

## About the demo accounts

`npm run seed` creates 5 accounts, all password `demo1234`, clearly labeled
`@worldshiner.demo`. These are for you to log in and try the app tonight —
**deactivate or delete them before this touches real client data**, and add
your actual staff through the Staff screen instead.

Your real `staff` collection from the uploaded files (~14 people's actual
email addresses) was deliberately not copied into this repo's seed data —
partly to protect their personal emails from ending up in a public GitHub
repo (your own learning plan mentions putting this project on GitHub), and
partly because migrating real staff is a real decision (who gets which role
now?) rather than something to guess at 2am.

## Suggested next session

1. Try the app end-to-end yourself; report anything that feels wrong.
2. Decide: Supabase Storage or Cloudinary for images — then that swap is quick.
3. Bring one real Excel export from the India app so import can be built
   against real data instead of a guess.
4. Add your real staff via the Staff screen once you're comfortable with it.
