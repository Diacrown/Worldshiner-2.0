# Architecture: audit of World Shiner 1.0, and how 2.0 is built

## 1. What the old system actually is (from the uploaded code + prior sessions)

Three files were audited directly: `jewellery_tracker_v3_pwa.html` (the
Texas/DM-USA branch app, ~8,900 lines), `india_factory_app.html` (the India/HQ
app, ~5,500 lines), and the standalone `staff.html` / `staff_setup.html`
(Staff Manager). Plus prior session history covering Sydney, UK, Brisbane,
Melbourne, New Zealand, Poland, and Germany.

**Stack:** vanilla JS, no build step, no framework. Firebase Auth
(email/password) for login. A single shared Firestore project
(`jewellery-tracker-6371b`) with one `jobs_v2` collection (UK uses a separate
`jobs_v2_uk`). Cloudinary for image hosting. Google Apps Script webhooks for
a Google Sheets sync. Gmail API (browser OAuth token client) for reading/
sending client emails. Netlify for hosting — one static site per office.

**Offices found:** WS-SYD (Sydney), WS-BNE (Brisbane), WS-UK, WS-MEL
(Melbourne), WS-NZ (New Zealand), WS-POL (Poland), DM-USA (Texas), WS-IT
(Italy), DM-GER (Germany, per prior sessions — not in the `staff.html` copy
audited here, since it and the parallel Diamore app were built as fully
separate deployments), and HQ (India).

**How multi-tenancy actually worked:** every job document is tagged with a
literal `office` string field (e.g. `office: 'DM-USA'`), **hardcoded into
that office's own copy of the HTML file**. The client then queries
`where('office','==','DM-USA')`. There is no server — Firestore security
rules and this client-side tag are the entire access-control mechanism.

## 2. Root-cause issues this audit found (not guesses — read directly from the code)

1. **The office tag is a copy-pasted literal.** `jewellery_tracker_v3_pwa.html`
   line ~3894: `addDoc(collection(db, COL), { ...data, office: 'DM-USA', ... })`.
   Every office's file has its own copy of this exact pattern with its own
   literal string. Prior sessions record the direct consequence: Poland and
   Texas ended up with ~124 jobs each mistagged as Sydney, traced to a
   mislabeled dropdown carried over when a new office's file was cloned from
   Sydney's. **2.0 fix:** the office is derived server-side from the
   authenticated user's own account (`resolveWriteOfficeId` in
   `middleware/auth.js`) — never accepted from client input except for a
   global admin explicitly acting on another office's behalf. Verified in
   `smoke-test.sh` check #6.

2. **Reference data is duplicated and had already drifted.** `india_factory_app.html`
   contains two separate `OFFICES` arrays (lines ~4830 and ~5472) — the second
   is missing Italy. Every office's status dropdown is its own copy of a
   26-item `<option>` list. **2.0 fix:** `offices` and `branch_statuses` are
   single tables, read by every part of the app.

3. **Business logic is duplicated per file, not shared.** The branch→HQ
   status mapping (`BRANCH_TO_HQ`), the semi-mount "setting charge" guard,
   and the archive-triggered photo purge each exist as one JS object/function
   per office file. A bug fix in one has to be manually ported to the others
   (prior sessions document exactly this happening — a stale `VALID_STATUSES`
   list in UK's import tool, found during a "parity audit"). **2.0 fix:**
   each rule lives once, in `services/`, called by every request regardless
   of office.

4. **No server-side enforcement of anything.** The setting-charge guard was a
   browser `prompt()` — nothing stopped a direct write that skipped it.
   **2.0 fix:** `services/settingChargeGuard.js` runs inside the same
   transaction as the status change itself, server-side.

## 3. The 2.0 schema

Two migrations, applied in order by `npm run migrate`:

- **`001_core.sql`** — `offices`, `users`, `branch_statuses`, `hq_statuses`,
  `branch_to_hq_status_map`, `hq_to_branch_headline_map`, `jobs`,
  `job_status_history`.
- **`002_extended.sql`** — `job_production` (India's own dates — kept
  separate from the branch's fields on purpose; the old system's dueDate/
  clientDeliveryDate collision happened *because* both sides' fields lived on
  the same document), `job_setter_polisher`, `job_design_entries` +
  `design_number_counter`, `job_client_items`, `job_images`,
  `job_chat_messages` + `job_chat_read_receipts`, `job_issues` +
  `job_issue_events`.

`job_status_history` replaces what used to be ~20 separate nullable
`ts*` timestamp columns (`tsQuoting`, `tsCadApproved`, `tsInProduction`, ...) —
one append-only table instead of a wall of columns that has to be
hand-extended every time a status is added.

## 4. Auth & authorization model

JWT-based (`middleware/auth.js`), issued at login, carrying the user's
office, and three independent role flags read from `users`:

- `is_global_admin` — sees/acts on every office (old: `staff.admin === true`
  / the hardcoded `ADMIN_FALLBACK` list).
- `officeIsHq` (derived from the office record, not a user flag) — HQ/India
  staff see every office's jobs too, because production tracking for every
  branch **is** their job, not an admin privilege. This was a real gap in
  the first draft of this backend — it originally only gave cross-office
  visibility to global admins, which would have broken the India app's
  actual purpose. Caught and fixed while building, verified in
  `smoke-test.sh` check #8.
- `is_office_master` / `restrict_to_own_jobs` — the old system's
  `MASTER_ACCOUNTS` (toggle "all my office's jobs" vs "just mine") and
  `OWN_ONLY_ACCOUNTS` (always restricted), now proper columns instead of
  hardcoded email arrays.

Every list/read query is scoped through one function
(`buildScope` in `services/jobs.service.js`) instead of the old
`ownsJob()`/`applyVisibleJobs()` pattern that was copy-pasted (and could
drift) per office file.

## 5. Status sync, ported faithfully

Two independent, one-directional maps, exactly matching what the old code
did (`BRANCH_TO_HQ` / `HEADLINE` JS objects), now DB tables:

- `branch_to_hq_status_map` — when a branch sets its own status, India's
  status updates too, if a mapping exists (`PATCH /jobs/:id/status`).
  Statuses with no entry (e.g. `render_submitted`) intentionally leave
  India's status untouched — same as the original.
- `hq_to_branch_headline_map` — when India sets its own internal status
  (`PATCH /jobs/:id/hq-status`, HQ-staff/admin only), the branch sees a
  simplified "headline" version — several India statuses (`in_production`,
  `wax_requested`, `wax_check`, `awaiting_diamond`, `partial_done`,
  `on_hold`) all headline as `production_started` on the branch side, same
  collapsing behaviour as the original.

Both directions are exercised in the smoke tests (checks #11-14).

## 6. A known, verified, inherited quirk

`jobNeedsSettingCharge()` auto-detects client-stone/semi-mount jobs by
regex-scanning notes text for phrases like "client's stone". This is ported
**as-is** from the original, including its actual limitation: the regex has
no negation awareness, so a note that says *"confirmed no client's stone"*
still matches and still triggers the confirmation prompt. This was
discovered while writing the test suite (a test fixture accidentally
tripped it) and is now a permanent regression test
(`smoke-test.sh` check #18) rather than a silent surprise. Worth deciding,
with input from whoever writes these notes day-to-day, whether to keep the
simple heuristic or invest in something smarter — documented here rather
than silently "fixed" in a way that might not match how staff actually want
it to behave.

The original regex also hardcoded the literal phrase "texas stock" — 2.0
generalises this to `"<office name> stock"` (see comments in
`services/settingChargeGuard.js`) so the same rule applies everywhere, not
just Texas. Confirm this still makes sense per office before relying on it.

## 7. The org layer (DIACROWN / DIAMORE)

Added once DIAMORE became a real second hub, not a hypothetical one. Three
tiers of admin now exist, and getting the boundary between them right
mattered more than anything else in this addition:

- `is_global_admin` — true super admin, both orgs, every office. Only a
  global admin can grant this to anyone else.
- `is_org_admin` — every office within their own org only. Can manage staff
  and invite codes, but scoped to their org — enforced in the service layer
  (`invites.service.js`, `users.routes.js`), not just hidden in the UI.
- `officeIsHq` (derived from the office, not a role) — same visibility as
  org admin, without the admin actions. This used to mean "every office in
  every org" before DIAMORE existed for real; that would have let a Diacrown
  HQ staffer see Diamore's client data the moment Diamore had any live jobs.

**A real gap found and fixed while building this:** `changeJobHqStatus`
(the India-side status-change endpoint) had no org check at all — the only
gate was the `requireHqOrAdmin` *role* check, with zero row-level check that
the job being touched belonged to the caller's own org. Any HQ staffer could
have changed another org's job's status by guessing/enumerating its id. Now
checked directly against `offices.org_id` inside the same transaction, and
covered by a dedicated regression test (`smoke-test-orgs.sh`, check on the
hq-status route). Worth internalizing as a pattern: a role check on a route
is not the same guarantee as a row-level ownership check inside the handler
— the jobs list/read scoping already had this right (`buildScope` in
`jobs.service.js`); this endpoint had drifted from that pattern because it
was written before orgs existed and never revisited when they were added.

DIAMORE's actual office code (`DM-LOC1` in the seed data) is a placeholder —
rename it once its real location code is confirmed; everything else (org
isolation, invite codes, staff management) works identically regardless of
what the code is called.

## 8. What is intentionally NOT finished (yet)

See `docs/ROADMAP.md` for the current list — design entries, SLA alerts,
monthly reports, WhatsApp sharing, Excel/CSV import, and Gmail scaffolding
are now built. What's left needs the user's own external setup: a Google
Cloud OAuth project (Gmail), a real historical-data export to validate the
importer's column detection against, and confirmation that the SLA
dashboard's status-code mapping matches the real old-system rules.

## 9. `services/scope.js` extraction

`buildScope` was originally private to `jobs.service.js`. Once the SLA
dashboard and monthly reports both needed the identical 3-tier office/org
visibility logic, it was extracted to its own file and exported — the
alternative (reimplementing the same clause logic per feature) is exactly
the duplication pattern section 2 documents as the old system's root-cause
bug class. `jobs.service.js`, `sla.service.js`, and `reports.service.js` all
import it from `services/scope.js` now; there's only one copy of the rule.

## 10. Gmail OAuth callback — deliberately not behind requireAuth

`GET /api/gmail/callback` is the one route in this codebase that isn't
gated by `requireAuth`. This is intentional, not an oversight: Google
redirects the user's browser here directly after consent, so there's no
`Authorization` header to check — the browser is just following a redirect
URL. Instead, the acting user's id and office are signed into a short-lived
(10 minute) JWT carried through the OAuth `state` parameter when the
connect flow starts (`buildAuthUrl` in `gmail.service.js`), and the callback
verifies that token itself (`verifyState`) before trusting anything in the
request. If you're auditing routes for missing auth checks, this is the one
expected exception.
