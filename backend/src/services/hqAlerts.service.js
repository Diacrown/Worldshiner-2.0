import { pool } from '../db/pool.js';
import { buildScope } from './scope.js';

// ── Ported 1:1 from india_factory_app.html (the old Diacrown/Diamore HQ
// tracker) — same 7 categories, same thresholds, same anchor logic. Nothing
// here is stored: every reminder is worked out fresh on each request from
// hq_status_code + job_status_history + job_production, exactly like the old
// app derived it live from Firestore on every render. A reminder clears
// itself the instant the thing it's watching for changes.
//
// This is DELIBERATELY separate from sla.service.js / alerts.service.js,
// which implement the *branch* office's generic alert types. HQ users
// (officeIsHq — i.e. Diacrown's HQ or Diamore's HQ) get this feed instead;
// branch offices are untouched and keep the generic one.

const MS_H = 3600000;

function statusChangedMs(row) {
  if (row.hq_status_at) {
    const t = new Date(row.hq_status_at).getTime();
    if (!isNaN(t)) return t;
  }
  return new Date(row.created_at).getTime();
}
function fmtDuration(hours) {
  const h = Math.round(hours);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-GB'); // dd/mm/yyyy, matches old app's fmtDate
}

function catQ1(r) {
  if (!['new_job', 'quoting', 'quote_pending', 'query_raised'].includes(r.hq_status_code)) return null;
  const since = statusChangedMs(r), h = (Date.now() - since) / MS_H;
  if (h < 24) return null;
  return { since, overByH: h - 24, reason: 'No status change for ' + fmtDuration(h) };
}
function catCadRender(r) {
  if (!['new_cad_requested', 'cad_mod_requested', 'new_render_request'].includes(r.hq_status_code)) return null;
  const since = statusChangedMs(r), h = (Date.now() - since) / MS_H;
  if (h < 6) return null;
  return { since, overByH: h - 6, reason: 'No status change for ' + fmtDuration(h) };
}
function catCadPending(r) {
  if (!['sketch_request', 'cad_requested', 'render_requested', 'modifying_cad'].includes(r.hq_status_code)) return null;
  const since = statusChangedMs(r), h = (Date.now() - since) / MS_H;
  if (h < 36) return null;
  return { since, overByH: h - 36, reason: 'No status change for ' + fmtDuration(h) };
}
function catOrderPending(r) {
  if (r.hq_status_code !== 'order_pending') return null;
  const since = statusChangedMs(r), h = (Date.now() - since) / MS_H;
  if (h < 36) return null;
  return { since, overByH: h - 36, reason: 'No status change for ' + fmtDuration(h) };
}
function catReadyToShip(r) {
  if (!['qc_pass', 'qc_pass_hold_for_set'].includes(r.hq_status_code)) return null;
  let anchor = r.qc_pass_date ? new Date(r.qc_pass_date).getTime() : null;
  if (anchor == null || isNaN(anchor)) anchor = statusChangedMs(r);
  const h = (Date.now() - anchor) / MS_H;
  if (h < 120) return null;
  return { since: anchor, overByH: h - 120, reason: 'Ready to ship for ' + fmtDuration(h) };
}
function catDueDate(r) {
  if (!['in_production', 'qc_repair'].includes(r.hq_status_code)) return null;
  if (!r.client_delivery_date) return null;
  const dueT = new Date(r.client_delivery_date).getTime();
  if (isNaN(dueT)) return null;
  const warnFrom = dueT - 2 * 24 * MS_H;
  if (Date.now() < warnFrom) return null;
  const overdue = Date.now() > dueT;
  return { since: dueT, overdue, overByH: (Date.now() - dueT) / MS_H, reason: (overdue ? 'Was due ' : 'Due ') + fmtDate(r.client_delivery_date) };
}
function catGoodsPending(r) {
  if (['shipped', 'closed'].includes(r.hq_status_code)) return null; // done — nothing left to chase
  const src = (r.stone_source || '').trim();
  if (src !== 'Diacrown' && src !== 'Diacrown+Elegant') return null;
  if (r.stone_issue_date) return null; // stone's arrived — clears this reminder regardless of anything else
  if (!r.po_date) return null;
  const poT = new Date(r.po_date).getTime();
  if (isNaN(poT)) return null;
  const warnFrom = poT + 3 * 24 * MS_H;
  if (Date.now() < warnFrom) return null;
  return { since: poT, overByH: (Date.now() - warnFrom) / MS_H, reason: 'PO raised ' + fmtDate(r.po_date) + ' (' + src + ') — stone not yet issued' };
}

export const HQ_ALERT_CATS = [
  { id: 'q1', label: 'Q1', check: catQ1, limitLabel: 'limit for this stage is 24h' },
  { id: 'cadrender', label: 'CAD / Render', check: catCadRender, limitLabel: 'limit for this stage is 6h' },
  { id: 'cadpending', label: 'Cad Pending', check: catCadPending, limitLabel: 'limit for this stage is 36h', xlCols: ['cad_issued_to'] },
  { id: 'orderpending', label: 'Order Pending', check: catOrderPending, limitLabel: 'limit for this stage is 36h' },
  { id: 'readytoship', label: 'Ready to Ship', check: catReadyToShip, limitLabel: 'limit for this stage is 5 days', xlCols: ['vendor'] },
  { id: 'duedate', label: 'Due Date', check: catDueDate, limitLabel: 'warns from 2 days before the due date', xlCols: ['vendor'] },
  { id: 'goodspending', label: 'Goods Pending', check: catGoodsPending, limitLabel: 'warns 3 days after PO date' },
];

// Pulls every field any of the 7 categories needs, scoped exactly like every
// other feature (buildScope — org-isolated: a Diacrown HQ user only ever
// sees Diacrown's jobs, a Diamore HQ user only Diamore's, across every
// office in that org, matching the old app's "badge counts every office"
// behaviour but with the org boundary the old system never actually had).
async function fetchScopedRows(user, officeOverride) {
  const { where, params } = buildScope(user, { officeOverride });
  const sql = `
    SELECT
      j.id, j.job_name, j.hq_status_code, j.po_number, j.design_no,
      j.client_delivery_date, j.created_at,
      o.code AS office_code, o.name AS office_name,
      (SELECT max(h.changed_at) FROM job_status_history h WHERE h.job_id = j.id AND h.side = 'hq') AS hq_status_at,
      jp.qc_pass AS qc_pass_date, jp.po_date, jp.stone_issue_date, jp.stone_source, jp.vendor, jp.cad_issued_to
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    LEFT JOIN job_production jp ON jp.job_id = j.id
    ${where ? `${where} AND` : 'WHERE'} j.hq_status_code IS NOT NULL
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

function alertsInCat(cat, rows) {
  const items = [];
  for (const r of rows) {
    const info = cat.check(r);
    if (info) items.push({ r, info });
  }
  items.sort((x, y) => (y.info.overByH || 0) - (x.info.overByH || 0)); // worst-first
  return items;
}

export async function listHqAlertCounts(user, { officeOverride } = {}) {
  const rows = await fetchScopedRows(user, officeOverride);
  const out = {}; let total = 0;
  HQ_ALERT_CATS.forEach((cat) => { const n = alertsInCat(cat, rows).length; out[cat.id] = n; total += n; });
  return { counts: out, total };
}

export async function listHqAlertsForCat(user, catId, { officeOverride } = {}) {
  const cat = HQ_ALERT_CATS.find((c) => c.id === catId);
  if (!cat) return null;
  const rows = await fetchScopedRows(user, officeOverride);
  return alertsInCat(cat, rows).map(({ r, info }) => ({
    jobId: r.id,
    jobName: r.job_name,
    officeCode: r.office_code,
    officeName: r.office_name,
    poNumber: r.po_number,
    designNo: r.design_no,
    hqStatusCode: r.hq_status_code,
    reason: info.reason,
    overdue: !!info.overdue,
    overByH: Math.round((info.overByH || 0) * 10) / 10,
    cadIssuedTo: r.cad_issued_to,
    vendor: r.vendor,
  }));
}
