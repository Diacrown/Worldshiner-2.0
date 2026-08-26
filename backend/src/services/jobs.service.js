import { pool, withTransaction } from '../db/pool.js';
import { getBranchToHqStatus, getHqToBranchHeadline, getBranchStatus } from './statusSync.js';
import { jobNeedsSettingCharge, evaluateSettingChargeGuard } from './settingChargeGuard.js';
import { buildScope } from './scope.js';

export async function listJobs(user, { officeOverride, ownerView, status, search, limit = 100, offset = 0 } = {}) {
  const { where, params } = buildScope(user, { officeOverride, ownerView });
  let sql = `
    SELECT j.*, o.code AS office_code, o.name AS office_name, bs.label AS status_label
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = j.status_code
    ${where}
  `;
  const extra = [];
  if (status) {
    params.push(status);
    extra.push(`j.status_code = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    extra.push(`(j.job_name ILIKE $${params.length} OR j.contact_person ILIKE $${params.length} OR j.po_number ILIKE $${params.length})`);
  }
  if (extra.length) sql += (where ? ' AND ' : ' WHERE ') + extra.join(' AND ');

  params.push(limit);
  sql += ` ORDER BY j.created_at DESC LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;

  const { rows } = await pool.query(sql, params);
  return rows;
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
    renderLink: 'render_link', diacrownSsp: 'diacrown_ssp', invoiceAmount: 'invoice_amount',
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
  };
  const touchesAssay = Object.keys(assayFieldMap).some((k) => input[k] !== undefined);
  if (touchesAssay && !user.officeHasAssay) {
    const err = new Error('This office does not have Assay Office tracking enabled');
    err.status = 403;
    throw err;
  }
  if (touchesAssay) Object.assign(fieldMap, assayFieldMap);

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
