// Shared transform + insert logic for turning one Firestore job doc into a
// full row in `jobs` plus its sub-resources (production spec, design
// entries, client items, images, setter/polisher, chat, reconstructed
// status history). Used by both migrate-historical-jobs.js (the original
// one-shot full import) and sync-new-jobs.js (repeatable incremental sync)
// so the transform rules only exist in one place.

// Legacy status-label aliases confirmed from the old system's own documented
// "renamed fields/statuses, patched on the way in" behavior (functionality
// diff doc, §16) — not guesses.
export const BRANCH_STATUS_ALIASES = {
  'In Production': 'production_started',
  'CAD Requested': 'making_cad',
};
// "At Assay Office" has no branch_statuses equivalent — it maps to the
// dedicated in_assay flag instead (see migration 008), not a status code.
export const ASSAY_STATUS_LABEL = 'At Assay Office';

// job.specs is a flexible {k,v} array — the old system's own free-form
// spreadsheet-column sidecar (Tier 2 of the field audit). Of its ~23 real
// keys, these already have a proper structured column elsewhere in this
// schema, so they're deliberately not duplicated into job_specs.
export const SPEC_SKIP_KEYS = new Set([
  'Loc', 'JobNo', 'Customer', 'CAD Issued To', 'CAD Issued Date',
  'Ship Date', 'Stone Issue Date', 'SSP', 'Item Size',
]);
export function normalizeSpecKey(k) {
  return (k || '').replace(/\s+/g, ' ').trim();
}

// HQ-side aliases — best-effort matches for labels with no exact seed
// match, chosen by closest real-world meaning. Low-volume (1-9 jobs each
// in the real data), reviewed manually rather than left unmapped.
export const HQ_STATUS_ALIASES = {
  'CAD Submitted': 'cad_provided',
  'Put in Production': 'in_production',
  'Mod CAD Submitted': 'modifying_cad',
  'CAD Requested': 'new_cad_requested',
  'Sketch Submitted': 'render_submitted',
  'CAD Ready': 'cad_provided',
  'Sketch Request': 'new_render_request',
  'Canceled': 'closed',
  'New Wax Requested': 'wax_requested',
  'Render Requested': 'new_render_request',
};

// Old ts* fields -> branch_statuses code, for reconstructing job_status_history
// from records that predate this system. Ordered isn't required (sorted by
// actual date at insert time), just the field->code mapping.
export const TS_FIELD_TO_STATUS = {
  tsQuoting: 'quoting',
  tsQuoteGiven: 'quote_given',
  tsAddlQuote: 'additional_quote_given',
  tsQuoteApproved: 'quote_approved',
  tsMakingCad: 'making_cad',
  tsModifyingCad: 'modifying_cad',
  tsCadProvided: 'cad_provided',
  tsCadApproved: 'cad_approved',
  tsConfirmOrder: 'confirm_order',
  tsInProduction: 'production_started',
  tsInRepair: 'in_repair',
  tsWithPolisher: 'with_polisher',
  tsInSetting: 'in_setting',
  tsShippedIndia: 'shipped_india',
  // Real data has six more ts* fields the original map never listed —
  // their history events were silently dropped, not "intentionally excluded"
  // like the ones documented in docs/ARCHITECTURE.md.
  tsAtAssay: 'in_setting',
  tsRequestMod: 'request_modification',
  tsWithSetter: 'with_setter',
  tsAddlInfoNeeded: 'additional_info_needed',
  tsLocalProduction: 'local_production',
  tsRequestRender: 'request_render',
};

function validYmd(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}
// Some real records have genuinely malformed dates (e.g. "2026-16-04" —
// month 16 doesn't exist, a data-entry typo in the old system). Rather than
// fail the whole job's import over one bad field, this returns null for
// anything that isn't a real calendar date instead of throwing.
export function parseDate(v) {
  if (!v) return null;
  if (typeof v !== 'string') return null;
  const ddmmyyyy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    if (!validYmd(Number(y), Number(m), Number(d))) return null;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    if (!validYmd(Number(y), Number(m), Number(d))) return null;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
export function parseTimestamp(v) {
  if (!v) return null;
  if (v._seconds != null) return new Date(v._seconds * 1000).toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
export function parsePriority(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low') return 'Low';
  if (s === 'high' || s === 'urgent') return 'High';
  return 'Medium';
}
// invoiceAmt has real values like "2450 + gst", "4130 INCL", "£960" — pull
// the leading number, preserve the rest as a note rather than dropping it.
export function parseInvoiceAmount(v) {
  if (v == null || v === '') return { amount: null, extra: null };
  const s = String(v).trim();
  const m = s.match(/[\d,]+\.?\d*/);
  if (!m) return { amount: null, extra: s };
  const amount = Number(m[0].replace(/,/g, ''));
  const extra = s.slice(m.index + m[0].length).trim() || (m.index > 0 ? s.slice(0, m.index).trim() : null);
  return { amount: isNaN(amount) ? null : amount, extra: extra || null };
}
export function isUrl(s) {
  return typeof s === 'string' && /^https?:\/\//.test(s);
}

// job.owner / issue.flaggedBy / issue.resolvedBy are old-system staff email
// addresses. Real accounts mostly don't exist yet, so this resolves to null
// for almost everything today — that's expected, not a bug. The value is in
// re-running this once real staff accounts exist: whoever's already signed
// up gets correctly attributed immediately, no separate backfill needed for
// them, and anyone who signs up later needs a one-time backfill pass instead
// of this import ever running twice.
export async function lookupUserIdByEmail(client, email) {
  if (!email || typeof email !== 'string') return null;
  const { rows } = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email.trim()]);
  return rows[0]?.id ?? null;
}

export function makeStatusResolvers(branchLabelToCode, hqLabelToCode) {
  function resolveBranchStatus(label) {
    if (!label) return { code: 'quoting', inAssay: false };
    if (label === ASSAY_STATUS_LABEL) return { code: 'in_setting', inAssay: true };
    if (branchLabelToCode.has(label)) return { code: branchLabelToCode.get(label), inAssay: false };
    if (BRANCH_STATUS_ALIASES[label]) return { code: BRANCH_STATUS_ALIASES[label], inAssay: false };
    return { code: null, inAssay: false };
  }
  function resolveHqStatus(label) {
    if (!label) return null;
    if (hqLabelToCode.has(label)) return hqLabelToCode.get(label);
    if (HQ_STATUS_ALIASES[label]) return HQ_STATUS_ALIASES[label];
    return null;
  }
  return { resolveBranchStatus, resolveHqStatus };
}

// Inserts one job + all its sub-resources within the caller's transaction
// (client must already have BEGIN issued). Returns { jobId, createdAt,
// jobName, poNumber }. Throws on error — caller decides ROLLBACK handling.
export async function insertJob(client, { officeId, batchId, sourceRef, job, statusCode, hqStatusCode, inAssay, summary }) {
  const jobName = (job.jobName || '').trim();
  if (!jobName) throw new Error('Missing jobName');

  const poNumber = (job.poNumber || '').trim() || null;

  const { amount: invoiceAmount, extra: invoiceExtra } = parseInvoiceAmount(job.invoiceAmt);
  let notes = job.notes || '';
  if (invoiceExtra) notes = notes ? `${notes}\n(Invoice note: ${invoiceExtra})` : `(Invoice note: ${invoiceExtra})`;
  if (job.settingCharge && job.settingCharge !== 'None') notes += `\n(Setting charge: ${job.settingCharge})`;

  const createdAt = parseTimestamp(job.createdAt) || new Date().toISOString();
  const ownerUserId = await lookupUserIdByEmail(client, job.owner);

  const { rows: jobRows } = await client.query(
    `INSERT INTO jobs (
       office_id, job_name, contact_person, client_phone, priority, status_code, hq_status_code,
       client_delivery_date, po_number, render_link, diacrown_ssp, invoice_amount, notes,
       client_stone_semi_mount, setting_charge_confirmed, design_no, in_assay,
       assay_office_name, assay_invoice_no, assay_date_sent, owner_user_id,
       client_comment, client_comment_at, snoozed_until, india_emailed_at, india_email_count,
       assay_priority, sales_rep, inquiry_sent_at,
       import_batch_id, source_ref, imported_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,now(),$32)
     RETURNING id`,
    [
      officeId, jobName, job.contact || null, job.clientPhone || null,
      parsePriority(job.priority), statusCode || 'quoting', hqStatusCode,
      parseDate(job.clientDeliveryDate || job.dueDate), poNumber, job.renderLink || null,
      job.diacrown || null, invoiceAmount, notes.trim() || null,
      !!job.clientStoneSemiMount, !!job.settingChargeConfirmed, job.designNo || null,
      inAssay || job.status === ASSAY_STATUS_LABEL,
      job.assayOfficeName || null, job.assayInvoiceNo || null, parseDate(job.assayDateSent), ownerUserId,
      job.clientComment || null, parseTimestamp(job.clientCommentAt), parseDate(job.snoozedUntil),
      parseTimestamp(job.indiaEmailedAt), Number(job.indiaEmailCount) || 0,
      job.assayPriority === 'Yes' ? true : job.assayPriority === 'No' ? false : null,
      job.salesRep || null, parseDate(job.inquirySentAt),
      batchId, sourceRef, createdAt,
    ]
  );
  const jobId = jobRows[0].id;

  // job_production
  if (job.prod && Object.keys(job.prod).length) {
    const p = job.prod;
    await client.query(
      `INSERT INTO job_production (
         job_id, inquiry_date, quotation_date, cad_issued, qc_pass, ship_date, item_type,
         item_size, qty, metal_type, metal_color, alloy_type, rhodium, stone_type, stone_details,
         stone_source, setting_type, stamp_logo, stamp_metal, stamp_loc, vendor, finding1,
         approval_date, po_date, stone_issue_date, delivery_date, cad_issued_to,
         cad_modification, qc_ready
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        jobId, parseDate(p.inquiryDate), parseDate(p.quotationDate), parseDate(p.cadIssued), parseDate(p.qcPass),
        parseDate(p.shipDate), p.itemType || null, p.itemSize || null, p.qty ? Number(p.qty) || null : null,
        p.metalType || null, p.metalColor || null, p.alloyType || null, p.rhodium || null, p.stoneType || null,
        p.stoneDetails || null, p.stoneSource || null, p.settingType || null, p.stampLogo || null,
        p.stampMetal || null, p.stampLoc || null, p.vendor || null, p.finding1 || null,
        parseDate(p.approvalDate), parseDate(p.poDate), parseDate(p.stoneIssueDate), parseDate(p.deliveryDate),
        p.cadIssuedTo || null, parseDate(p.cadModification), parseDate(p.qcReady),
      ]
    );
  }

  // job_specs — the old system's flexible per-job spec sidecar (Tier 2).
  // Keys already covered by a real column (see SPEC_SKIP_KEYS) are skipped
  // here to avoid duplicating them under a second name.
  if (Array.isArray(job.specs)) {
    let sortOrder = 0;
    for (const entry of job.specs) {
      const key = normalizeSpecKey(entry?.k);
      if (!key || SPEC_SKIP_KEYS.has(key)) continue;
      const value = entry?.v == null ? null : String(entry.v);
      if (!value) continue;
      await client.query(
        'INSERT INTO job_specs (job_id, spec_key, spec_value, sort_order) VALUES ($1,$2,$3,$4)',
        [jobId, key, value, sortOrder++]
      );
    }
  }

  // job_design_entries — 'set' is the old system's own shorthand for
  // matching_set (10 real entries use it); without this alias the whole
  // entry was silently dropped, not just a field within it.
  if (Array.isArray(job.designEntries)) {
    let sortOrder = 0;
    for (const e of job.designEntries) {
      const kind = e?.kind === 'set' ? 'matching_set' : e?.kind;
      if (!e || !['custom', 'matching_set', 'stock'].includes(kind)) continue;
      await client.query(
        `INSERT INTO job_design_entries (job_id, kind, base_number, description, po_number, sort_order, style_code, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [jobId, kind, e.base || null, e.desc || null, e.po || null, sortOrder++, e.styleCode || null, e.qty ? Number(e.qty) || null : null]
      );
    }
  }

  // job_client_items — real data mostly has this empty; handle string or object entries defensively.
  // job_images already has a client_item_id FK + 'client_item' kind built
  // for exactly this, but the loop never used it — item.images was dropped.
  if (Array.isArray(job.clientItems)) {
    let sortOrder = 0;
    for (const item of job.clientItems) {
      const description = typeof item === 'string' ? item : (item?.description || item?.desc || null);
      if (!description) continue;
      const { rows: itemRows } = await client.query(
        'INSERT INTO job_client_items (job_id, description, sort_order) VALUES ($1,$2,$3) RETURNING id',
        [jobId, description, sortOrder++]
      );
      const itemImages = Array.isArray(item?.images) ? item.images.filter(isUrl) : [];
      for (const url of itemImages) {
        await client.query(
          'INSERT INTO job_images (job_id, client_item_id, kind, url) VALUES ($1,$2,$3,$4)',
          [jobId, itemRows[0].id, 'client_item', url]
        );
      }
    }
  }

  // job_images — clientRef/cadImage are already-hosted URLs (Cloudinary/Drive); link directly, skip bare filenames that aren't real URLs.
  // indiaCardCads/indiaCardRefs are the same kind of India-side CAD reference
  // photo, just a field the original migration never checked. indiaHiddenRefs
  // is kept as its own kind — its old-system name implies it was
  // deliberately hidden from someone, and listJobImages() restricts it to
  // HQ/admin viewers rather than assuming it's safe for every branch office.
  const imageSets = [
    ['clientRef', 'client_ref'], ['cadImage', 'cad'],
    ['indiaCardCads', 'cad'], ['indiaCardRefs', 'cad'],
    ['indiaHiddenRefs', 'india_hidden'],
  ];
  for (const [field, kind] of imageSets) {
    const val = job[field];
    const urls = Array.isArray(val) ? val : (isUrl(val) ? [val] : []);
    for (const url of urls) {
      if (isUrl(url)) await client.query('INSERT INTO job_images (job_id, kind, url) VALUES ($1,$2,$3)', [jobId, kind, url]);
    }
  }

  // job_setter_polisher / repairer
  for (const role of ['setter', 'polisher', 'repairer']) {
    const name = job[`${role}Name`], fee = job[`${role}Fee`], dateSent = job[`${role}DateSent`];
    if (!name && !dateSent && !fee) continue;
    await client.query(
      `INSERT INTO job_setter_polisher (job_id, role_type, person_name, fee, date_sent, due_date, date_returned)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [jobId, role, name || null, fee ? (parseInvoiceAmount(fee).amount) : null, parseDate(dateSent), parseDate(job[`${role}DueDate`]), parseDate(job[`${role}DateReturned`])]
    );
  }

  // job_chat_messages — no real-user mapping exists yet, so the historical sender's name is folded into the message body.
  // m.img is a real attached photo — image_url exists on this table specifically for it, just never read before.
  if (Array.isArray(job.chat)) {
    for (const m of job.chat) {
      const body = `[${m.from || m.role || 'Unknown'}] ${m.text || ''}`.trim();
      await client.query(
        `INSERT INTO job_chat_messages (job_id, body, image_url, created_at) VALUES ($1,$2,$3,$4)`,
        [jobId, body, isUrl(m.img) ? m.img : null, parseTimestamp(m.ts) || createdAt]
      );
    }
  }

  // job_issues — the old system's issue-tracker data was never read at all.
  // Real data only ever has one issue object per job (not an array).
  if (job.issue && typeof job.issue === 'object') {
    const iss = job.issue;
    if (iss.type) {
      const openedBy = await lookupUserIdByEmail(client, iss.flaggedBy);
      const resolvedBy = await lookupUserIdByEmail(client, iss.resolvedBy);
      await client.query(
        `INSERT INTO job_issues (job_id, issue_type, description, status, opened_by_user_id, opened_at, resolved_by_user_id, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          jobId, iss.type, iss.reason || null, iss.open === false ? 'resolved' : 'open',
          openedBy, parseTimestamp(iss.flaggedAt) || createdAt, resolvedBy, parseTimestamp(iss.resolvedAt),
        ]
      );
    }
  }

  // job_status_history — reconstructed from the old ts* fields, sorted chronologically
  const historyEntries = [];
  for (const [field, code] of Object.entries(TS_FIELD_TO_STATUS)) {
    const dateStr = parseDate(job[field]);
    if (dateStr) historyEntries.push({ code, at: dateStr });
  }
  historyEntries.sort((a, b) => a.at.localeCompare(b.at));
  if (!historyEntries.length) historyEntries.push({ code: statusCode || 'quoting', at: createdAt.slice(0, 10) });
  for (const h of historyEntries) {
    await client.query(
      `INSERT INTO job_status_history (job_id, status_code, side, note, changed_at)
       VALUES ($1,$2,'branch','Migrated from historical record',$3)`,
      [jobId, h.code, h.at]
    );
  }

  return { jobId, createdAt, jobName, poNumber };
}
