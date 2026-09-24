import { pool, withTransaction } from '../db/pool.js';
import { getBranchToHqStatus, getHqToBranchHeadline, getBranchStatus } from './statusSync.js';
import { jobNeedsSettingCharge, evaluateSettingChargeGuard } from './settingChargeGuard.js';
import { buildScope } from './scope.js';
import { getClientDirectory, levenshtein } from './clients.service.js';
import { tabsForUser, statusesForTab, resolveViewingHq, HQ_PHASES, HQ_PHASES_EXCLUDE_STATUSES } from './jobTabs.js';

export async function listJobs(user, { officeOverride, ownerView, status, tab, search, clientPrefix, limit = 100, offset = 0 } = {}) {
  const { where, params } = buildScope(user, { officeOverride, ownerView });
  const viewingHq = await resolveViewingHq(user, officeOverride);
  // The Status column shown in the table has to match whichever world the
  // tabs above it are drawn from — a job listed under an HQ tab needs its
  // HQ status shown, not its branch status, or the two would visibly
  // contradict each other the moment someone drills between office levels.
  let sql = `
    SELECT j.*, o.code AS office_code, o.name AS office_name,
      ${viewingHq ? 'hs.label' : 'bs.label'} AS status_label
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = j.status_code
    LEFT JOIN hq_statuses hs ON hs.code = j.hq_status_code
    ${where}
  `;
  const extra = [];
  if (tab) {
    // Dashboard tab bar — filters by a group of statuses on whichever
    // column matches the CURRENTLY VIEWED office's tab set (hq_status_code
    // at HQ level, status_code once drilled into a specific branch — see
    // jobTabs.js's resolveViewingHq).
    const resolved = statusesForTab(user, tab, viewingHq);
    if (resolved) {
      params.push(resolved.statuses);
      extra.push(`j.${resolved.statusColumn} = ANY($${params.length}::text[])`);
    }
  } else if (status) {
    params.push(status);
    extra.push(`j.status_code = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    extra.push(`(j.job_name ILIKE $${params.length} OR j.contact_person ILIKE $${params.length} OR j.po_number ILIKE $${params.length})`);
  }
  if (clientPrefix) {
    // Exact match against the Clients page's grouping key (see
    // clients.service.js deriveClientKey) — escaped so a client name that
    // happens to contain % or _ can't widen the match.
    const escaped = clientPrefix.replace(/[\\%_]/g, '\\$&');
    params.push(`${escaped}%`);
    extra.push(`j.job_name ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (extra.length) sql += (where ? ' AND ' : ' WHERE ') + extra.join(' AND ');

  params.push(limit);
  sql += ` ORDER BY j.created_at DESC LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

// Dashboard tab bar counts — one query, grouped by whichever status column
// applies to this viewer, mapped through jobTabs.js's tab definitions. A
// status that exists in the DB but isn't in any tab (shouldn't happen once
// jobTabs.js accounts for every status.js code, but a schema could drift
// ahead of it) is silently excluded from every tab's count rather than
// thrown — the "All Jobs" total below still includes it, so a mismatch
// between "All Jobs" and the sum of tab counts is the signal something in
// jobTabs.js needs updating.
export async function getJobTabCounts(user, { officeOverride } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const viewingHq = await resolveViewingHq(user, officeOverride);
  const { tabs, statusColumn, allJobsExcludes, hasIssueLog } = tabsForUser(user, viewingHq);

  // "All Jobs" means different things per side — HQ's old tracker excludes
  // Shipped/Closed (it's meant as "active work"); the branch tracker's old
  // `all: null` was genuinely unfiltered. Both confirmed directly against
  // the old files' own code, not guessed.
  let totalSql = `SELECT count(*)::int AS n FROM jobs j ${where}`;
  const totalParams = [...params];
  if (allJobsExcludes.length) {
    totalParams.push(allJobsExcludes);
    totalSql += `${where ? ' AND' : ' WHERE'} j.${statusColumn} != ALL($${totalParams.length}::text[])`;
  }
  const totalResult = await pool.query(totalSql, totalParams);

  const caseLines = tabs.map((t, i) => {
    const placeholder = `$${params.length + i + 1}`;
    return `WHEN j.${statusColumn} = ANY(${placeholder}::text[]) THEN '${t.id}'`;
  }).join('\n      ');
  const tabParams = [...params, ...tabs.map((t) => t.statuses)];
  const countSql = `
    SELECT
      CASE ${caseLines} END AS tab_id,
      count(*)::int AS n
    FROM jobs j
    ${where}
    GROUP BY 1
  `;
  const { rows } = await pool.query(countSql, tabParams);
  const countsByTab = Object.fromEntries(rows.filter((r) => r.tab_id).map((r) => [r.tab_id, r.n]));

  const resultTabs = tabs.map((t) => ({ id: t.id, label: t.label, count: countsByTab[t.id] || 0 }));

  // Branch offices' "Issues on Hand" isn't a status group at all — it's the
  // count of open job_issues rows for jobs in this scope. Appended as its
  // own entry so the frontend can render it in the same row, but the
  // frontend must treat clicking it differently (opens the issues panel,
  // not a filtered jobs table) — see hasIssueLog in the response.
  if (hasIssueLog) {
    const issuesSql = `
      SELECT count(*)::int AS n
      FROM job_issues i
      JOIN jobs j ON j.id = i.job_id
      ${where}${where ? ' AND' : ' WHERE'} i.status = 'open'
    `;
    const issuesResult = await pool.query(issuesSql, params);
    resultTabs.push({ id: 'issues', label: 'Issues on Hand', count: issuesResult.rows[0].n });
  }

  return { total: totalResult.rows[0].n, tabs: resultTabs, hasIssueLog };
}

// Office/branch breakdown bar — HQ-only (a branch user only ever has one
// office, so this bar has nothing to show them). Scoped to the viewer's own
// org (a Diacrown HQ user never sees Diamore's offices and vice versa,
// matching buildScope's org isolation everywhere else). Excludes the HQ
// office itself (jobs are never logged directly against HQ — only against
// a branch, exactly like the old India tracker's office bar never had an
// "HQ" pill) and excludes inactive/placeholder offices (see migration 020 —
// Diamore's DM-LOC1 stays hidden here until it's a real, confirmed location).
export async function getOfficeCounts(user) {
  if (!(user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq)) return { offices: [] };
  // Built directly rather than via buildScope() — that helper assumes
  // `jobs` is the base table being filtered; here `offices` is the base
  // table (so a zero-job office still shows up), which needs the org
  // restriction applied to the offices table itself, not just to which
  // jobs get counted.
  const params = [];
  let orgClause = '';
  if (!user.isGlobalAdmin) {
    params.push(user.orgId);
    orgClause = `AND o.org_id = $${params.length}`;
  }
  let ownerClause = '';
  if (user.restrictToOwnJobs) {
    params.push(user.sub);
    ownerClause = `AND j.owner_user_id = $${params.length}`;
  }
  const sql = `
    SELECT o.code, o.name, count(j.id)::int AS n
    FROM offices o
    LEFT JOIN jobs j ON j.office_id = o.id ${ownerClause}
    WHERE o.is_hq = FALSE AND o.active = TRUE ${orgClause}
    GROUP BY o.id, o.code, o.name
    ORDER BY o.name
  `;
  const { rows } = await pool.query(sql, params);
  return { offices: rows.map((r) => ({ code: r.code, name: r.name, count: r.n })) };
}

// Summary stat line's "In production / CAD stage / QC" — HQ-only, org-scoped,
// deliberately ignoring whatever tab/office/search filter is currently
// active (matches the old India tracker exactly — see jobTabs.js's
// HQ_PHASES comment for why). "Jobs shown" and branch's "Invoice total"
// don't need a backend call at all — they're computed client-side from
// whatever's already loaded in the visible table.
export async function getPhaseCounts(user) {
  if (!(user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq)) return { cad: 0, prod: 0, qc: 0 };
  const params = [];
  let orgClause = '';
  if (!user.isGlobalAdmin) {
    params.push(user.orgId);
    orgClause = `AND j.office_id IN (SELECT id FROM offices WHERE org_id = $${params.length})`;
  }
  let ownerClause = '';
  if (user.restrictToOwnJobs) {
    params.push(user.sub);
    ownerClause = `AND j.owner_user_id = $${params.length}`;
  }
  const excludeIdx = params.length + 1;
  params.push(HQ_PHASES_EXCLUDE_STATUSES);
  const phaseIdx = { cad: params.length + 1, prod: params.length + 2, qc: params.length + 3 };
  params.push(HQ_PHASES.cad, HQ_PHASES.prod, HQ_PHASES.qc);
  const sql = `
    SELECT
      count(*) FILTER (WHERE j.hq_status_code = ANY($${phaseIdx.cad}::text[]))::int AS cad,
      count(*) FILTER (WHERE j.hq_status_code = ANY($${phaseIdx.prod}::text[]))::int AS prod,
      count(*) FILTER (WHERE j.hq_status_code = ANY($${phaseIdx.qc}::text[]))::int AS qc
    FROM jobs j
    WHERE j.hq_status_code IS NOT NULL AND j.hq_status_code != ALL($${excludeIdx}::text[])
    ${orgClause} ${ownerClause}
  `;
  const { rows } = await pool.query(sql, params);
  return { cad: rows[0].cad, prod: rows[0].prod, qc: rows[0].qc };
}

export async function getJobById(user, jobId) {
  const { where, params } = buildScope(user);
  const idParamIndex = params.length + 1;
  const sql = `
    SELECT j.*, o.code AS office_code, o.name AS office_name, bs.label AS status_label
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = j.status_code
    ${where ? where + ' AND' : 'WHERE'} j.id = $${idParamIndex}
  `;
  const { rows } = await pool.query(sql, [...params, jobId]);
  return rows[0] ?? null;
}

export async function updateJob(user, jobId, input) {
  const existing = await getJobById(user, jobId);
  if (!existing) return null;

  const fieldMap = {
    jobName: 'job_name', contactPerson: 'contact_person', clientPhone: 'client_phone',
    priority: 'priority', clientDeliveryDate: 'client_delivery_date', poNumber: 'po_number',
    renderLink: 'render_link', diacrownSsp: 'diacrown_ssp',
    notes: 'notes', clientStoneSemiMount: 'client_stone_semi_mount',
    followUpDate: 'follow_up_date', clientComment: 'client_comment',
  };
  // Assay fields are server-side gated, not just hidden in the UI — writing
  // them from a non-UK-profile office is rejected outright, matching the
  // project's established "check it in the handler, not just the route"
  // pattern (see docs/ARCHITECTURE.md §7).
  const assayFieldMap = {
    inAssay: 'in_assay', assayOfficeName: 'assay_office_name',
    assayInvoiceNo: 'assay_invoice_no', assayDateSent: 'assay_date_sent',
    // Tier 5 field-audit gap — UK-only, so gated the same way as the rest
    // of this map even though they aren't strictly assay fields themselves.
    assayPriority: 'assay_priority', salesRep: 'sales_rep', inquirySentAt: 'inquiry_sent_at',
  };
  const touchesAssay = Object.keys(assayFieldMap).some((k) => input[k] !== undefined);
  if (touchesAssay && !user.officeHasAssay) {
    const err = new Error('This office does not have Assay Office tracking enabled');
    err.status = 403;
    throw err;
  }
  if (touchesAssay) Object.assign(fieldMap, assayFieldMap);

  // Per-field write permission: office-level scoping already controls which
  // JOBS staff can see/edit, but invoice_amount is pricing data HQ wants
  // locked down regardless of which office the job belongs to — a branch
  // master can still see the job and edit everything else on it.
  const hqOnlyFieldMap = { invoiceAmount: 'invoice_amount' };
  const touchesHqOnly = Object.keys(hqOnlyFieldMap).some((k) => input[k] !== undefined);
  const isHqOrAdmin = user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq;
  if (touchesHqOnly && !isHqOrAdmin) {
    const err = new Error('Only HQ or an admin can set invoice amount');
    err.status = 403;
    throw err;
  }
  if (touchesHqOnly) Object.assign(fieldMap, hqOnlyFieldMap);

  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(fieldMap)) {
    if (input[key] !== undefined) {
      params.push(input[key]);
      sets.push(`${col} = $${params.length}`);
      if (key === 'clientComment' && input[key]) {
        params.push(new Date().toISOString());
        sets.push(`client_comment_at = $${params.length}`);
      }
    }
  }
  if (!sets.length) return existing;

  params.push(jobId);
  const { rows } = await pool.query(
    `UPDATE jobs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0];
}

// Batch Assay: save assay office/invoice/date to several jobs at once,
// matching the manual's "Batch Assay -> Save to Selected Jobs" flow.
export async function batchUpdateAssay(user, { jobIds, assayOfficeName, assayInvoiceNo, assayDateSent }) {
  if (!user.officeHasAssay) {
    const err = new Error('This office does not have Assay Office tracking enabled');
    err.status = 403;
    throw err;
  }
  if (!Array.isArray(jobIds) || !jobIds.length) {
    const err = new Error('jobIds must be a non-empty array');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs SET in_assay = TRUE, assay_office_name = $1, assay_invoice_no = $2, assay_date_sent = $3
       WHERE id = ANY($4) AND office_id = $5
       RETURNING id`,
      [assayOfficeName || null, assayInvoiceNo || null, assayDateSent || null, jobIds, user.officeId]
    );
    return { updated: rows.map((r) => r.id) };
  });
}

export async function createJob(user, officeId, input) {
  const {
    jobName, contactPerson, clientPhone, priority = 'Medium', statusCode = 'quoting',
    clientDeliveryDate, poNumber, renderLink, diacrownSsp, invoiceAmount, notes,
    clientStoneSemiMount = false,
  } = input;

  if (!jobName || !jobName.trim()) {
    const err = new Error('jobName is required');
    err.status = 400;
    throw err;
  }
  // Same invoice_amount restriction as updateJob — otherwise a branch office
  // could just set it at creation time instead of going through the
  // (blocked) update path.
  const isHqOrAdmin = user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq;
  if (invoiceAmount !== undefined && !isHqOrAdmin) {
    const err = new Error('Only HQ or an admin can set invoice amount');
    err.status = 403;
    throw err;
  }

  const { rows } = await pool.query(
    `INSERT INTO jobs (
       office_id, job_name, contact_person, client_phone, priority, status_code,
       client_delivery_date, po_number, render_link, diacrown_ssp, invoice_amount, notes,
       client_stone_semi_mount, owner_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [officeId, jobName.trim(), contactPerson || null, clientPhone || null, priority, statusCode,
     clientDeliveryDate || null, poNumber || null, renderLink || null, diacrownSsp || null,
     invoiceAmount || null, notes || null, clientStoneSemiMount, user.sub]
  );
  const job = rows[0];

  await pool.query(
    `INSERT INTO job_status_history (job_id, status_code, side, changed_by_user_id, note)
     VALUES ($1,$2,'branch',$3,'Job created')`,
    [job.id, job.status_code, user.sub]
  );

  return job;
}

/**
 * The status-change flow: setting-charge guard → branch→HQ status sync →
 * history row → job update, all inside one transaction. This is the direct
 * replacement for quickStatusChange()/saveJob()'s status-handling in the old
 * app, previously duplicated with small drifts across every office file.
 */
export async function changeJobStatus(user, jobId, { newStatusCode, providedSettingCharge, note }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    const job = rows[0];
    if (!job) {
      const err = new Error('Job not found');
      err.status = 404;
      throw err;
    }
    if (!user.isGlobalAdmin && job.office_id !== user.officeId) {
      const err = new Error('You do not have access to this job');
      err.status = 403;
      throw err;
    }

    const targetStatus = await getBranchStatus(newStatusCode);
    if (!targetStatus) {
      const err = new Error(`Unknown status code: ${newStatusCode}`);
      err.status = 400;
      throw err;
    }
    if (targetStatus.is_system_only) {
      const err = new Error(`"${targetStatus.label}" can only be set automatically by the HQ sync, not chosen manually`);
      err.status = 400;
      throw err;
    }

    // HQ-locked statuses ("blue" in the StatusSync reference sheet): once
    // HQ's sync has moved a job into one of these (is_system_only), the
    // branch can't change it away manually until HQ moves it further — a
    // global admin can still override, as an escape hatch for correcting
    // mistakes rather than a true bypass of the rule.
    const currentStatus = await getBranchStatus(job.status_code);
    if (currentStatus?.is_system_only && !user.isGlobalAdmin) {
      const err = new Error(`This job's status ("${currentStatus.label}") was set by HQ and is locked until HQ updates it further.`);
      err.status = 423;
      throw err;
    }

    // Client's-own-stone / semi-mount guard (see settingChargeGuard.js)
    const { rows: itemRows } = await client.query(
      'SELECT count(*)::int AS n FROM job_client_items WHERE job_id = $1', [jobId]
    );
    const { rows: designRows } = await client.query(
      'SELECT description FROM job_design_entries WHERE job_id = $1', [jobId]
    );
    const { rows: officeRows } = await client.query('SELECT name FROM offices WHERE id = $1', [job.office_id]);

    const needsCharge = jobNeedsSettingCharge({
      notes: job.notes,
      designEntryDescriptions: designRows.map((r) => r.description).filter(Boolean),
      clientItemCount: itemRows[0].n,
      officeName: officeRows[0]?.name,
    });
    const guard = evaluateSettingChargeGuard({
      newStatusCode,
      clientStoneSemiMount: job.client_stone_semi_mount,
      settingChargeConfirmed: job.setting_charge_confirmed,
      needsCharge,
      providedSettingCharge,
    });
    if (!guard.ok) {
      const err = new Error(guard.error);
      err.status = 409;
      throw err;
    }

    const hqStatusCode = await getBranchToHqStatus(newStatusCode);
    const clearsConfirmation = newStatusCode === 'quoting' && job.setting_charge_confirmed;

    const { rows: updated } = await client.query(
      `UPDATE jobs SET
         status_code = $1,
         hq_status_code = COALESCE($2, hq_status_code),
         status_synced_by = 'branch',
         status_synced_at = now(),
         setting_charge_confirmed = CASE WHEN $3 THEN FALSE ELSE COALESCE($4, setting_charge_confirmed) END
       WHERE id = $5
       RETURNING *`,
      [newStatusCode, hqStatusCode, clearsConfirmation, guard.data.settingChargeConfirmed ?? null, jobId]
    );

    await client.query(
      `INSERT INTO job_status_history (job_id, status_code, side, changed_by_user_id, note)
       VALUES ($1,$2,'branch',$3,$4)`,
      [jobId, newStatusCode, user.sub, note || null]
    );

    return updated[0];
  });
}

/**
 * The HQ-side counterpart to changeJobStatus(): India sets its own internal
 * status; if that status has a mapped branch "headline", the branch office's
 * visible status updates too (e.g. several India statuses all headline as
 * "Production Started"). This is the other half of the sync — without it,
 * hq_to_branch_headline_map would be seeded but never actually used.
 * Optionally upserts job_production fields (dates India tracks) in the same call.
 */
export async function changeJobHqStatus(user, jobId, { newHqStatusCode, productionFields, note }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT j.*, o.org_id FROM jobs j JOIN offices o ON o.id = j.office_id WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId]
    );
    const job = rows[0];
    if (!job) {
      const err = new Error('Job not found');
      err.status = 404;
      throw err;
    }
    if (!user.isGlobalAdmin && job.org_id !== user.orgId) {
      // Same reasoning as the office check in changeJobStatus below: an HQ
      // staffer or org admin from one org has no business touching another
      // org's job, even via a guessed/enumerated id.
      const err = new Error('You do not have access to this job');
      err.status = 403;
      throw err;
    }

    const { rows: hqRows } = await client.query('SELECT * FROM hq_statuses WHERE code = $1', [newHqStatusCode]);
    if (!hqRows.length) {
      const err = new Error(`Unknown HQ status code: ${newHqStatusCode}`);
      err.status = 400;
      throw err;
    }

    const branchHeadline = await getHqToBranchHeadline(newHqStatusCode);

    const { rows: updated } = await client.query(
      `UPDATE jobs SET
         hq_status_code = $1,
         status_code = COALESCE($2, status_code),
         status_synced_by = 'hq',
         status_synced_at = now()
       WHERE id = $3
       RETURNING *`,
      [newHqStatusCode, branchHeadline, jobId]
    );

    await client.query(
      `INSERT INTO job_status_history (job_id, status_code, side, changed_by_user_id, note)
       VALUES ($1,$2,'hq',$3,$4)`,
      [jobId, branchHeadline || newHqStatusCode, user.sub, note || null]
    );

    if (productionFields && Object.keys(productionFields).length) {
      const allowed = ['inquiryDate', 'quotationDate', 'cadIssued', 'cadModification', 'qcReady', 'qcPass', 'shipDate', 'itemType'];
      const colMap = {
        inquiryDate: 'inquiry_date', quotationDate: 'quotation_date', cadIssued: 'cad_issued',
        cadModification: 'cad_modification', qcReady: 'qc_ready', qcPass: 'qc_pass',
        shipDate: 'ship_date', itemType: 'item_type',
      };
      const sets = [];
      const params = [jobId];
      for (const key of allowed) {
        if (productionFields[key] !== undefined) {
          params.push(productionFields[key]);
          sets.push(`${colMap[key]} = $${params.length}`);
        }
      }
      if (sets.length) {
        await client.query(
          `INSERT INTO job_production (job_id) VALUES ($1)
           ON CONFLICT (job_id) DO NOTHING`,
          [jobId]
        );
        await client.query(`UPDATE job_production SET ${sets.join(', ')} WHERE job_id = $1`, params);
      }
    }

    return updated[0];
  });
}

// The full production spec (metal/stone/vendor/dates) has been captured on
// every historical job and on any job HQ has set a status for since — this
// just gives it a place to actually be seen and edited, which never existed.
const PRODUCTION_FIELD_MAP = {
  inquiryDate: 'inquiry_date', quotationDate: 'quotation_date', cadIssued: 'cad_issued',
  cadModification: 'cad_modification', qcReady: 'qc_ready', qcPass: 'qc_pass', shipDate: 'ship_date',
  itemType: 'item_type', itemSize: 'item_size', qty: 'qty', metalType: 'metal_type',
  metalColor: 'metal_color', alloyType: 'alloy_type', rhodium: 'rhodium', stoneType: 'stone_type',
  stoneDetails: 'stone_details', stoneSource: 'stone_source', settingType: 'setting_type',
  stampLogo: 'stamp_logo', stampMetal: 'stamp_metal', stampLoc: 'stamp_loc', vendor: 'vendor',
  finding1: 'finding1', approvalDate: 'approval_date', poDate: 'po_date',
  stoneIssueDate: 'stone_issue_date', deliveryDate: 'delivery_date', cadIssuedTo: 'cad_issued_to',
  metalWeightGrams: 'metal_weight_grams',
};

export async function getJobProduction(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query('SELECT * FROM job_production WHERE job_id = $1', [jobId]);
  return rows[0] ?? {};
}

export async function updateJobProduction(user, jobId, input) {
  const job = await getJobById(user, jobId);
  if (!job) return null;

  const sets = [];
  const params = [jobId];
  for (const [key, col] of Object.entries(PRODUCTION_FIELD_MAP)) {
    if (input[key] !== undefined) {
      params.push(input[key] === '' ? null : input[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return getJobProduction(user, jobId);

  await pool.query(
    `INSERT INTO job_production (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING`,
    [jobId]
  );
  await pool.query(`UPDATE job_production SET ${sets.join(', ')} WHERE job_id = $1`, params);
  return getJobProduction(user, jobId);
}

export async function listJobImages(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    'SELECT * FROM job_images WHERE job_id = $1 ORDER BY uploaded_at ASC',
    [jobId]
  );
  // 'india_hidden' images (historical data's indiaHiddenRefs) are restricted
  // to HQ/admin — the old system's own field name implies these were
  // deliberately kept from someone, so default to the safer visibility
  // rather than assume every branch office should see them.
  const canSeeHidden = user.isGlobalAdmin || user.isOrgAdmin || user.officeIsHq;
  return canSeeHidden ? rows : rows.filter((r) => r.kind !== 'india_hidden');
}

export async function addJobImage(user, jobId, { kind, url, clientItemId }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  if (!['client_ref', 'cad', 'client_item'].includes(kind)) {
    const err = new Error('kind must be client_ref, cad, or client_item');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO job_images (job_id, client_item_id, kind, url) VALUES ($1,$2,$3,$4) RETURNING *`,
    [jobId, clientItemId || null, kind, url]
  );
  return rows[0];
}

export async function removeJobImage(user, jobId, imageId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rowCount } = await pool.query(
    'DELETE FROM job_images WHERE id = $1 AND job_id = $2',
    [imageId, jobId]
  );
  return rowCount > 0;
}

// job_specs — the flexible reference-spec sidecar (Tier 2 field-audit gap):
// legacy per-job fields like Style code, Cert No., Tag Color, or a
// reference image link that don't have a dedicated column (see job-import.js
// SPEC_SKIP_KEYS for what's excluded because it's already captured
// elsewhere), plus anything staff add going forward.
export async function listJobSpecs(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    'SELECT * FROM job_specs WHERE job_id = $1 ORDER BY sort_order ASC, id ASC',
    [jobId]
  );
  return rows;
}

export async function addJobSpec(user, jobId, { key, value }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const specKey = (key || '').trim();
  if (!specKey) {
    const err = new Error('key is required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO job_specs (job_id, spec_key, spec_value, sort_order)
     VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM job_specs WHERE job_id = $1), 0))
     RETURNING *`,
    [jobId, specKey, value || null]
  );
  return rows[0];
}

export async function removeJobSpec(user, jobId, specId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rowCount } = await pool.query(
    'DELETE FROM job_specs WHERE id = $1 AND job_id = $2',
    [specId, jobId]
  );
  return rowCount > 0;
}

// Best-guess match of an inbound email (subject + body) to an existing job,
// for the Mail tab's inbox-review flow — closes the loop on inbound replies
// without requiring a client to reply with any special format. Matches on
// PO number appearing anywhere in the email text, preferring the longest
// matching PO number (a short/generic one like "1" would otherwise match
// almost anything). Scoped through buildScope, so it only ever suggests a
// job the caller could already see.
export async function matchJobByText(user, text) {
  if (!text) return null;
  const exact = await matchJobByPoNumber(user, text);
  if (exact) return { ...exact, matchConfidence: 'exact' };
  return matchJobByClientName(user, text);
}

async function matchJobByPoNumber(user, text) {
  const { where, params } = buildScope(user);
  const textParamIndex = params.length + 1;
  const sql = `
    SELECT j.id, j.job_name, j.po_number, o.name AS office_name
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    ${where ? where + ' AND' : 'WHERE'} j.po_number IS NOT NULL AND j.po_number != ''
      AND $${textParamIndex} ILIKE '%' || j.po_number || '%'
    ORDER BY length(j.po_number) DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [...params, text]);
  return rows[0] || null;
}

// Fallback for a reply that names the client but doesn't quote their PO
// number — reuses the same client directory and edit-distance logic already
// built for the Clients page's duplicate-name merge tool (clients.service.js
// levenshtein), just comparing an email's text against a known client name
// instead of comparing two client names against each other.
async function matchJobByClientName(user, text) {
  const upperText = text.toUpperCase();
  const words = upperText.split(/[^A-Z0-9]+/).filter((w) => w.length >= 5);
  const directory = await getClientDirectory(user);

  let best = null; // { officeCode, clientName, jobCount, confidence }
  for (const region of directory) {
    for (const country of region.countries) {
      for (const office of country.offices) {
        for (const client of office.clients) {
          const name = client.clientName;
          if (name.length < 4) continue; // too short to match reliably, too easy to false-positive
          // A "client" backed by only one job is more likely a derivation
          // artifact (deriveClientKey guessed wrong on an oddly-worded job
          // name — e.g. a job literally named "Order - Sanders of Remuera"
          // reads as a client called "Order") than a real recurring client.
          // An inbound email worth fuzzy-matching is presumably about a
          // repeat client anyway, so this both fixes false positives and
          // matches the actual use case.
          if (client.jobCount < 2) continue;
          if (upperText.includes(name)) {
            // Exact substring mention — the strong signal. Prefer the
            // longest matching name so a short client name that happens to
            // be a substring of a longer one doesn't win over the real match.
            if (!best || best.confidence !== 'name-substring' || name.length > best.clientName.length) {
              best = { officeCode: office.officeCode, clientName: name, confidence: 'name-substring' };
            }
            continue;
          }
          if (best?.confidence === 'name-substring') continue; // already have a stronger match
          // Typo-tolerant fallback: only against the client name's first
          // word, and only for word pairs long enough that a short edit
          // distance is actually meaningful (avoids "JWY" matching "ANY").
          const firstWord = name.split(' ')[0];
          if (firstWord.length < 5) continue;
          for (const word of words) {
            if (Math.abs(word.length - firstWord.length) > 2) continue;
            const dist = levenshtein(word, firstWord);
            const threshold = firstWord.length >= 7 ? 2 : 1;
            if (dist > threshold) continue;
            // Keep the closer of two typo matches rather than just the last
            // one found, so an incidental word/name collision elsewhere in
            // the directory can't bump a tighter earlier match.
            if (!best || best.confidence !== 'name-typo' || dist < best.distance) {
              best = { officeCode: office.officeCode, clientName: name, confidence: 'name-typo', distance: dist };
            }
          }
        }
      }
    }
  }
  if (!best) return null;

  const escaped = best.clientName.replace(/[\\%_]/g, '\\$&');
  const { rows } = await pool.query(
    `SELECT j.id, j.job_name, j.po_number, o.name AS office_name
     FROM jobs j JOIN offices o ON o.id = j.office_id
     WHERE o.code = $1 AND j.job_name ILIKE $2 ESCAPE '\\'
     ORDER BY j.updated_at DESC LIMIT 1`,
    [best.officeCode, `${escaped}%`]
  );
  return rows[0] ? { ...rows[0], matchConfidence: 'fuzzy' } : null;
}

export async function getJobHistory(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    `SELECT h.*, u.display_name AS changed_by_name
     FROM job_status_history h
     LEFT JOIN users u ON u.id = h.changed_by_user_id
     WHERE h.job_id = $1
     ORDER BY h.changed_at ASC`,
    [jobId]
  );
  return rows;
}
