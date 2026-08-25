// Seeds reference data ported from the audit of the live system (offices,
// the full branch + HQ status vocabularies, and the branch<->HQ mapping
// tables that replace the hardcoded BRANCH_TO_HQ / HEADLINE JS objects).
//
// Deliberately does NOT seed your real staff list. The old `staff` Firestore
// collection has ~14 real personal email addresses in it — baking those into
// a seed file is exactly the kind of thing that ends up committed to a public
// GitHub repo by accident (and your own learning-plan roadmap says to put
// this project on GitHub). Add real staff through POST /api/users once the
// server is running, or write a second, gitignored seed file for your own use.
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

// letter_prefix + next_design_value: S/B/K/T and their starting values come
// directly from the real Firestore `counters` collection (designNo=1344,
// designNoB=703, designNoK=541, designNoT=572) — NOT reset to 1, so newly
// claimed numbers never collide with real historical jobs still in use.
// Offices with no real counter get a fresh one starting at 1.
const OFFICES = [
  { code: 'WS-SYD', name: 'Sydney', is_hq: false, org: 'DIACROWN', letter_prefix: 'S', next_design_value: 1344 },
  { code: 'WS-BNE', name: 'Brisbane', is_hq: false, org: 'DIACROWN', letter_prefix: 'B', next_design_value: 703 },
  { code: 'WS-UK', name: 'UK', is_hq: false, org: 'DIACROWN', has_assay_office: true, letter_prefix: 'K', next_design_value: 541 },
  { code: 'WS-MEL', name: 'Melbourne', is_hq: false, org: 'DIACROWN', letter_prefix: 'M', next_design_value: 1 },
  { code: 'WS-NZ', name: 'New Zealand', is_hq: false, org: 'DIACROWN', letter_prefix: 'N', next_design_value: 1 },
  { code: 'WS-POL', name: 'Poland', is_hq: false, org: 'DIACROWN', letter_prefix: 'P', next_design_value: 1 },
  { code: 'DM-USA', name: 'Texas', is_hq: false, org: 'DIACROWN', letter_prefix: 'T', next_design_value: 572 },
  { code: 'WS-IT', name: 'Italy', is_hq: false, org: 'DIACROWN', letter_prefix: 'I', next_design_value: 1 },
  { code: 'DM-GER', name: 'Germany', is_hq: false, org: 'DIACROWN', letter_prefix: 'G', next_design_value: 1 },
  { code: 'HQ', name: 'Head Office / India (Diacrown)', is_hq: true, org: 'DIACROWN' },
  // DIAMORE: real infra doesn't exist yet for either of these — placeholders
  // so the org layer and its scoping rules can be built and tested now.
  // Rename DM-LOC1 to the actual location's real code once it's confirmed.
  { code: 'DM-HQ', name: 'Head Office / India (Diamore)', is_hq: true, org: 'DIAMORE' },
  { code: 'DM-LOC1', name: 'Diamore Location 1 (placeholder — rename once confirmed)', is_hq: false, org: 'DIAMORE', letter_prefix: 'D', next_design_value: 1 },
];

// code, label, sort_order, is_system_only, is_archive
const BRANCH_STATUSES = [
  ['quoting', 'Quoting', 10, false, false],
  ['additional_info_needed', 'Additional info needed', 20, false, false],
  ['quote_received', 'Quote Received', 30, false, false],
  ['quote_given', 'Quote Given', 40, false, false],
  ['additional_quote_given', 'Additional Quote Given', 50, false, false],
  ['quote_approved', 'Quote Approved', 60, false, false],
  ['new_cad_requested', 'New CAD Requested', 70, false, false],
  ['making_cad', 'Making CAD', 75, true, false], // system-only: HQ auto-sets this, branch can't pick it
  ['cad_received', 'CAD Received', 80, false, false],
  ['cad_provided', 'CAD Provided', 90, false, false],
  ['request_modification', 'Request Modification', 100, false, false],
  ['modifying_cad', 'Modifying CAD', 105, true, false], // system-only
  ['mod_cad_received', 'Mod CAD Recd.', 110, false, false],
  ['cad_approved', 'CAD Approved', 120, false, false],
  ['request_render', 'Request Render', 130, false, false],
  ['render_in_progress', 'Render In Progress', 135, true, false], // system-only
  ['render_received', 'Render Recd.', 140, false, false],
  ['render_submitted', 'Render Submitted', 150, false, false],
  ['confirm_order', 'Confirm Order', 160, false, false],
  ['on_hold', 'On Hold', 165, false, false],
  ['production_started', 'Production Started', 170, true, false], // system-only: never manually selectable
  ['request_wax', 'Request Wax', 175, false, false],
  ['wax_in_production', 'Wax in Production', 177, true, false], // system-only
  ['wax_deliver', 'Wax Deliver', 179, false, false], // branch-only record, doesn't reach India
  ['local_production', 'Local Production', 180, false, false],
  ['in_repair', 'In Repair', 190, false, false],
  ['job_delayed', 'Job Delayed', 200, true, false], // system-only — HQ's QC Repair headlines here
  ['ready_to_ship', 'Ready to Ship', 210, true, false], // system-only — HQ's QC Pass headlines here
  ['in_transit', 'In Transit', 220, false, false],
  ['shipped_india', 'Shipped - India', 230, false, false],
  ['in_setting', 'In Setting', 240, false, false],
  ['with_setter', 'With Setter', 241, false, false], // branch-only record, doesn't reach India
  ['with_polisher', 'With Polisher', 242, false, false], // branch-only record, doesn't reach India
  ['job_completed', 'Job Completed', 250, false, true], // archive: triggers photo purge
  ['not_proceeding', 'Not Proceeding', 260, false, true], // archive: triggers photo purge
];

// code, label, sort_order
const HQ_STATUSES = [
  ['new_job', 'New Job', 10],
  ['quoting', 'Quoting', 20],
  ['quote_pending', 'Quote Pending', 30],
  ['quote_given', 'Quote Given', 40],
  ['query_raised', 'Query Raised', 50],
  ['quote_expired', 'Quote Expired', 60],
  ['approved', 'Approved', 70],
  ['po_ready', 'Po ready', 80],
  ['cad_mod_order_confirmed', 'After CAD modify order confirmed', 90],
  ['new_cad_requested', 'New CAD Requested', 100],
  ['cad_mod_requested', 'CAD Mod Requested', 110],
  ['new_render_request', 'New Render Request', 120],
  ['order_pending', 'Order Pending', 130],
  ['in_production', 'In Production', 140],
  ['new_wax_request', 'New Wax Req.', 145],
  ['wax_requested', 'Wax Requested', 150],
  ['wax_check', 'Wax check', 160],
  ['awaiting_diamond', 'Awaiting Diamond', 170],
  ['partial_done', 'Partial Done', 180],
  ['on_hold', 'On Hold', 190],
  ['qc_repair', 'QC Repair', 200],
  ['cad_provided', 'CAD Provided', 210],
  ['modifying_cad', 'Modifying CAD', 220],
  ['render_submitted', 'Render Submitted', 230],
  ['qc_pass', 'QC Pass', 240],
  ['shipped', 'Shipped', 250],
  ['closed', 'Closed', 260],
];

// branch_status_code -> hq_status_code  (replaces hardcoded BRANCH_TO_HQ)
// Statuses not listed here intentionally leave India's status untouched,
// matching the old app's behaviour for e.g. 'Render Submitted'.
const BRANCH_TO_HQ = {
  quoting: 'new_job',
  // Deliberately NOT mapped: branch "Quote Given" is the branch quoting their
  // own client and must leave HQ's status untouched — HQ has its own,
  // separate "Quote Given" action on its own timeline (see StatusSync sheet).
  quote_approved: 'new_cad_requested',
  new_cad_requested: 'new_job',
  request_modification: 'cad_mod_requested',
  cad_approved: 'order_pending',
  request_render: 'new_render_request',
  confirm_order: 'order_pending',
  request_wax: 'new_wax_request', // was missing entirely — HQ never learned a branch needed wax
  on_hold: 'on_hold',
  not_proceeding: 'closed', // was missing entirely — India never learned a branch cancelled a job
};

// hq_status_code -> branch_status_code  (replaces hardcoded HEADLINE map)
const HQ_TO_BRANCH_HEADLINE = {
  in_production: 'production_started',
  wax_requested: 'wax_in_production', // was 'production_started' — the branch manual documents a distinct headline here
  wax_check: 'production_started',
  awaiting_diamond: 'production_started',
  partial_done: 'production_started',
  on_hold: 'production_started',
  qc_repair: 'job_delayed', // was missing entirely
  quote_given: 'quote_received',
  new_cad_requested: 'making_cad',
  cad_provided: 'cad_received',
  modifying_cad: 'modifying_cad',
  new_render_request: 'render_in_progress',
  render_submitted: 'render_received',
  qc_pass: 'ready_to_ship',
  shipped: 'shipped_india',
};

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ORGS = [
      { code: 'DIACROWN', name: 'Diacrown' },
      { code: 'DIAMORE', name: 'Diamore' },
    ];
    for (const o of ORGS) {
      await client.query(
        `INSERT INTO orgs (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
        [o.code, o.name]
      );
    }
    console.log(`[seed] orgs: ${ORGS.length}`);

    for (const o of OFFICES) {
      const { rows: orgRows } = await client.query('SELECT id FROM orgs WHERE code = $1', [o.org]);
      await client.query(
        `INSERT INTO offices (code, name, is_hq, org_id, has_assay_office, letter_prefix, next_design_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_hq = EXCLUDED.is_hq, org_id = EXCLUDED.org_id,
           has_assay_office = EXCLUDED.has_assay_office,
           -- Backfill letter_prefix/next_design_value only the FIRST time an
           -- existing office row gets one (i.e. it's currently NULL) — once
           -- set, re-seeding must never reset a counter that's already live
           -- and incrementing.
           letter_prefix = COALESCE(offices.letter_prefix, EXCLUDED.letter_prefix),
           next_design_value = CASE WHEN offices.letter_prefix IS NULL THEN EXCLUDED.next_design_value ELSE offices.next_design_value END`,
        [o.code, o.name, o.is_hq, orgRows[0].id, !!o.has_assay_office, o.letter_prefix || null, o.next_design_value || 1]
      );
    }
    console.log(`[seed] offices: ${OFFICES.length}`);

    for (const [code, label, sort_order, is_system_only, is_archive] of BRANCH_STATUSES) {
      await client.query(
        `INSERT INTO branch_statuses (code, label, sort_order, is_system_only, is_archive)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
           is_system_only = EXCLUDED.is_system_only, is_archive = EXCLUDED.is_archive`,
        [code, label, sort_order, is_system_only, is_archive]
      );
    }
    console.log(`[seed] branch_statuses: ${BRANCH_STATUSES.length}`);

    for (const [code, label, sort_order] of HQ_STATUSES) {
      await client.query(
        `INSERT INTO hq_statuses (code, label, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
        [code, label, sort_order]
      );
    }
    console.log(`[seed] hq_statuses: ${HQ_STATUSES.length}`);

    for (const [branch, hq] of Object.entries(BRANCH_TO_HQ)) {
      await client.query(
        `INSERT INTO branch_to_hq_status_map (branch_status_code, hq_status_code) VALUES ($1,$2)
         ON CONFLICT (branch_status_code) DO UPDATE SET hq_status_code = EXCLUDED.hq_status_code`,
        [branch, hq]
      );
    }
    console.log(`[seed] branch_to_hq_status_map: ${Object.keys(BRANCH_TO_HQ).length}`);

    for (const [hq, branch] of Object.entries(HQ_TO_BRANCH_HEADLINE)) {
      await client.query(
        `INSERT INTO hq_to_branch_headline_map (hq_status_code, branch_status_code) VALUES ($1,$2)
         ON CONFLICT (hq_status_code) DO UPDATE SET branch_status_code = EXCLUDED.branch_status_code`,
        [hq, branch]
      );
    }
    console.log(`[seed] hq_to_branch_headline_map: ${Object.keys(HQ_TO_BRANCH_HEADLINE).length}`);

    // Demo accounts only — replace with real staff via POST /api/users.
    // Password for every demo account below is: demo1234
    const passwordHash = await bcrypt.hash('demo1234', 10);
    const demoUsers = [
      { email: 'admin@worldshiner.demo', display_name: 'Demo Super Admin', office: 'HQ', is_global_admin: true },
      { email: 'diacrown.orgadmin@worldshiner.demo', display_name: 'Demo Diacrown Org Admin', office: 'HQ', is_org_admin: true },
      { email: 'texas.master@worldshiner.demo', display_name: 'Demo Texas Master', office: 'DM-USA', is_office_master: true },
      { email: 'texas.staff@worldshiner.demo', display_name: 'Demo Texas Staff', office: 'DM-USA' },
      { email: 'sydney.staff@worldshiner.demo', display_name: 'Demo Sydney Staff', office: 'WS-SYD' },
      { email: 'india.staff@worldshiner.demo', display_name: 'Demo India Staff (Diacrown)', office: 'HQ' },
      { email: 'diamore.staff@worldshiner.demo', display_name: 'Demo India Staff (Diamore)', office: 'DM-HQ' },
      { email: 'diamore.location.staff@worldshiner.demo', display_name: 'Demo Diamore Location Staff', office: 'DM-LOC1' },
    ];
    for (const u of demoUsers) {
      const { rows } = await client.query('SELECT id FROM offices WHERE code = $1', [u.office]);
      const officeId = rows[0].id;
      await client.query(
        `INSERT INTO users (email, password_hash, display_name, office_id, is_global_admin, is_org_admin, is_office_master)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET
           display_name = EXCLUDED.display_name, office_id = EXCLUDED.office_id,
           password_hash = EXCLUDED.password_hash, active = TRUE`,
        [u.email, passwordHash, u.display_name, officeId, !!u.is_global_admin, !!u.is_org_admin, !!u.is_office_master]
      );
    }
    console.log(`[seed] demo users: ${demoUsers.length} (password: demo1234)`);

    // A ready-to-use invite code so sign-up can be tested immediately.
    // Grants ordinary HQ staff access — deliberately not admin, so a leaked
    // demo code can't grant anything sensitive. Revoke it before real use
    // (Staff screen -> Invite Codes, or admins can create their own).
    const { rows: hqRows } = await client.query("SELECT id FROM offices WHERE code = 'HQ'");
    await client.query(
      `INSERT INTO invite_codes (code, office_id, max_uses)
       VALUES ('DEMO-JOIN', $1, NULL)
       ON CONFLICT (code) DO NOTHING`,
      [hqRows[0].id]
    );
    console.log(`[seed] demo invite code: DEMO-JOIN (grants ordinary HQ staff access, unlimited uses — revoke before real use)`);

    await client.query('COMMIT');
    console.log('[seed] ✅ done');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] ❌ failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
