import { pool } from '../db/pool.js';

// Dashboard status tabs — the fast-triage bar shown above the jobs table.
// Two separate tab sets because HQ and branch offices track a job's status
// on entirely different vocabularies (jobs.hq_status_code vs jobs.status_code).
//
// Both groupings below are copied VERBATIM from the two old trackers'
// actual tab-definition code (india_factory_app.html's DASH_TABS,
// jewellery_tracker_v3_pwa.html's TAB_STATUSES) — not reconstructed or
// guessed. A few statuses exist in the current schema but didn't exist in
// either old file (mostly newer HQ statuses added since); those are
// deliberately left out of every tab, exactly matching the old India
// tracker's own stated philosophy in its source comment: "A job whose
// status isn't listed under any tab here simply won't appear under a named
// tab — it still shows in All Jobs."
//
// "Issues" (HQ) is a genuine status ('Complaint' only — NOT 'On Hold',
// confirmed directly against the old file). "Issues on Hand" (branch) is
// NOT a status grouping at all — the old Sydney tracker's TAB_STATUSES
// object has no issues entry; it's a wholly separate open/resolved issue
// log (job_issues table) rendered as its own panel. See issues.service.js.

export const HQ_TABS = [
  { id: 'q1', label: 'Q1', statuses: ['new_job', 'quoting', 'quote_pending', 'query_raised'] },
  { id: 'cad', label: 'CAD', statuses: ['new_cad_requested', 'cad_mod_requested'] },
  { id: 'render', label: 'Render', statuses: ['new_render_request'] },
  { id: 'cad_pending', label: 'Cad Pending', statuses: ['sketch_request', 'cad_requested', 'render_requested', 'modifying_cad'] },
  { id: 'order_pending', label: 'Order Pending', statuses: ['order_pending'] },
  { id: 'in_production', label: 'In Production', statuses: ['in_production', 'new_wax_request', 'wax_requested', 'qc_repair'] },
  { id: 'ready_to_ship', label: 'Ready to Ship', statuses: ['qc_pass', 'qc_pass_hold_for_set'] },
  { id: 'shipped', label: 'Shipped', statuses: ['shipped'] },
  { id: 'closed', label: 'Closed', statuses: ['closed'] },
  { id: 'issues', label: 'Issues', statuses: ['complaint'] },
];
// HQ's "All Jobs" count excludes Shipped and Closed (confirmed in the old
// file's buildTabs(): counts.all filters out both) — it means "active work",
// not literally every job ever.
export const HQ_ALL_JOBS_EXCLUDES = ['shipped', 'closed'];

export const BRANCH_TABS = [
  { id: 'quoting', label: 'Quoting', statuses: ['quoting', 'additional_info_needed', 'quote_received', 'quote_approved', 'quote_given', 'additional_quote_given'] },
  { id: 'design_cad', label: 'Design & CAD', statuses: ['new_cad_requested', 'making_cad', 'cad_received', 'cad_provided', 'request_modification', 'modifying_cad', 'mod_cad_received', 'cad_approved', 'request_render', 'render_in_progress', 'render_received', 'render_submitted'] },
  { id: 'production', label: 'Production', statuses: ['confirm_order', 'production_started', 'on_hold', 'request_wax', 'wax_in_production', 'wax_deliver', 'local_production', 'in_repair', 'job_delayed', 'ready_to_ship', 'ready_to_dispatch', 'in_transit', 'shipped_india'] },
  { id: 'finishing', label: 'Finishing', statuses: ['in_setting', 'with_setter', 'with_polisher'] },
  { id: 'closed', label: 'Closed', statuses: ['job_completed', 'not_proceeding'] },
];
// Branch's "All Jobs" is genuinely unfiltered (old file: `all: null`) — no
// exclusions, unlike HQ's.
export const BRANCH_ALL_JOBS_EXCLUDES = [];

// Mirrors the frontend's `isHqOrAdmin` check (USER.isGlobalAdmin ||
// USER.isOrgAdmin || USER.officeIsHq) — used as the DEFAULT when no specific
// office is currently being viewed (viewingHqOverride === undefined).
//
// But the tab set actually needs to follow WHATEVER OFFICE IS CURRENTLY
// SELECTED, not fix itself to the logged-in user forever: an Org Admin (or
// Global Admin) who drills into one specific branch via the office switcher
// is looking at that branch's own world at that point, and must see that
// branch's own 6-tab system — exactly as if that branch's own staff were
// looking at it — not the HQ 10-tab system they'd see while sitting at
// their org's HQ level. jobs.service.js resolves which is true per request
// (by checking the selected office's is_hq flag) and passes it in as
// viewingHqOverride; that explicit value always wins when provided.
export function tabsForUser(user, viewingHqOverride) {
  const isHq = viewingHqOverride !== undefined ? viewingHqOverride : !!(user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq);
  return isHq
    ? { tabs: HQ_TABS, statusColumn: 'hq_status_code', allJobsExcludes: HQ_ALL_JOBS_EXCLUDES, hasIssueLog: false }
    : { tabs: BRANCH_TABS, statusColumn: 'status_code', allJobsExcludes: BRANCH_ALL_JOBS_EXCLUDES, hasIssueLog: true };
}

export function statusesForTab(user, tabId, viewingHqOverride) {
  const { tabs, statusColumn } = tabsForUser(user, viewingHqOverride);
  const tab = tabs.find((t) => t.id === tabId);
  return tab ? { statuses: tab.statuses, statusColumn } : null;
}

// Summary stat line — HQ's "In production / CAD stage / QC" pulse-check.
// Ported verbatim from india_factory_app.html's PHASES/STATUS_PHASE (a
// coarser, 6-phase grouping than the 10 dashboard tabs above, used only for
// this one line). Deliberately NOT scoped by whatever tab/office/search is
// currently active — the old file computed these from the full, unfiltered
// job list every time (`jobs.filter(...)`, never the filtered `list`), so a
// staff member always sees the true org-wide backlog here regardless of
// what they're currently looking at. Closed jobs are excluded from all
// three (matches the old file's `&& !isClosed(j)`).
// Only two current statuses (cad_provided, partial_done) didn't exist in
// the old file at all; both placed per HQ_TO_BRANCH_HEADLINE evidence
// elsewhere in this codebase (cad_provided headlines as "CAD Received";
// partial_done headlines as "Production Started").
export const HQ_PHASES = {
  cad: ['new_cad_requested', 'new_render_request', 'sketch_request', 'cad_requested', 'render_requested', 'render_submitted', 'modifying_cad', 'cad_mod_requested', 'cad_provided'],
  prod: ['order_pending', 'in_production', 'new_wax_request', 'wax_requested', 'wax_check', 'awaiting_diamond', 'on_hold', 'partial_done'],
  qc: ['qc_repair', 'qc_pass', 'qc_pass_hold_for_set'],
};
export const HQ_PHASES_EXCLUDE_STATUSES = ['closed']; // "closed" jobs never count toward any of the 3 phases above

// Resolves whether the CURRENTLY VIEWED office is HQ-level or a specific
// branch — the one query jobs.service.js needs to run per request so
// tabsForUser()/statusesForTab() can be told explicitly, rather than
// guessing from the logged-in user's own fixed role. No officeOverride
// means "no drill-down happening" — falls back to the viewer's own default
// (their own office's is_hq flag, i.e. plain HQ Staff and Org Admins sitting
// at their home level both correctly land on the HQ tab set; branch staff
// land on their own branch's tab set).
export async function resolveViewingHq(user, officeOverride) {
  if (!officeOverride) return !!(user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq);
  const { rows } = await pool.query('SELECT is_hq FROM offices WHERE code = $1', [officeOverride]);
  return rows[0] ? rows[0].is_hq : !!(user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq);
}
