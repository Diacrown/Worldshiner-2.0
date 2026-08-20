// One-time historical data migration: reads the Firestore exports
// (jobs_v2.json, jobs_v2_uk.json — produced by export-firestore.js) and
// loads every real job, with its production spec, design entries, client
// items, images, setter/polisher/repairer records, chat, and reconstructed
// status history (from the old ts* timestamp fields), into Postgres.
//
// Usage:
//   DATABASE_URL=<target> node scripts/migrate-historical-jobs.js [--dry-run]
//
// Safe to re-run: dedupes by (office, po_number) when a PO number exists.
// Jobs with no PO number cannot be deduped — do NOT run this against the
// same target database twice, or those will duplicate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', '..', 'firestore-export');
const DRY_RUN = process.argv.includes('--dry-run');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Legacy status-label aliases confirmed from the old system's own documented
// "renamed fields/statuses, patched on the way in" behavior (functionality
// diff doc, §16) — not guesses.
const BRANCH_STATUS_ALIASES = {
  'In Production': 'production_started',
  'CAD Requested': 'making_cad',
};
// "At Assay Office" has no branch_statuses equivalent — it maps to the
// dedicated in_assay flag instead (see migration 008), not a status code.
const ASSAY_STATUS_LABEL = 'At Assay Office';

// HQ-side aliases — best-effort matches for labels with no exact seed
// match, chosen by closest real-world meaning. Low-volume (1-9 jobs each
// in the real data), reviewed manually rather than left unmapped.
const HQ_STATUS_ALIASES = {
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
const TS_FIELD_TO_STATUS = {
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
};

function validYmd(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}
// Some real records have genuinely malformed dates (e.g. "2026-16-04" —
// month 16 doesn't exist, a data-entry typo in the old system). Rather than
// fail the whole job's import over one bad field, this returns null for
// anything that isn't a real calendar date instead of throwing.
function parseDate(v) {
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
function parseTimestamp(v) {
  if (!v) return null;
  if (v._seconds != null) return new Date(v._seconds * 1000).toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function parsePriority(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low') return 'Low';
  if (s === 'high' || s === 'urgent') return 'High';
  return 'Medium';
}
// invoiceAmt has real values like "2450 + gst", "4130 INCL", "£960" — pull
// the leading number, preserve the rest as a note rather than dropping it.
function parseInvoiceAmount(v) {
  if (v == null || v === '') return { amount: null, extra: null };
  const s = String(v).trim();
  const m = s.match(/[\d,]+\.?\d*/);
  if (!m) return { amount: null, extra: s };
  const amount = Number(m[0].replace(/,/g, ''));
  const extra = s.slice(m.index + m[0].length).trim() || (m.index > 0 ? s.slice(0, m.index).trim() : null);
  return { amount: isNaN(amount) ? null : amount, extra: extra || null };
}
function isUrl(s) {
  return typeof s === 'string' && /^https?:\/\//.test(s);
}

async function main() {
  const statusRes = await pool.query('SELECT code, label FROM branch_statuses');
  const branchLabelToCode = new Map(statusRes.rows.map((r) => [r.label, r.code]));
  const hqRes = await pool.query('SELECT code, label FROM hq_statuses');
  const hqLabelToCode = new Map(hqRes.rows.map((r) => [r.label, r.code]));
  const officeRes = await pool.query('SELECT id, code FROM offices');
  const officeCodeToId = new Map(officeRes.rows.map((r) => [r.code, r.id]));

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

  const files = [
    { path: path.join(EXPORT_DIR, 'jobs_v2.json'), source: 'jobs_v2' },
    { path: path.join(EXPORT_DIR, 'jobs_v2_uk.json'), source: 'jobs_v2_uk' },
  ];

  const summary = { imported: 0, skippedDuplicate: 0, errored: 0, unmappedBranchStatus: new Set(), unmappedHqStatus: new Set(), errors: [] };

  for (const file of files) {
    if (!fs.existsSync(file.path)) { console.log(`Skipping ${file.source} — file not found`); continue; }
    const docs = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    const byOffice = {};
    for (const [id, job] of Object.entries(docs)) {
      const officeCode = job.office;
      if (!officeCode || !officeCodeToId.has(officeCode)) {
        summary.errored++;
        summary.errors.push({ id, source: file.source, error: `Unknown or missing office: ${officeCode}` });
        continue;
      }
      (byOffice[officeCode] ||= []).push([id, job]);
    }

    for (const [officeCode, entries] of Object.entries(byOffice)) {
      const officeId = officeCodeToId.get(officeCode);
      let batchId = null;
      if (!DRY_RUN) {
        const { rows } = await pool.query(
          `INSERT INTO import_batches (office_id, filename, row_count_total) VALUES ($1,$2,$3) RETURNING id`,
          [officeId, file.source, entries.length]
        );
        batchId = rows[0].id;
      }

      for (const [firestoreId, job] of entries) {
        const client = DRY_RUN ? null : await pool.connect();
        try {
          if (!DRY_RUN) await client.query('BEGIN');
          const q = DRY_RUN ? async () => ({ rows: [] }) : (...args) => client.query(...args);

          const jobName = (job.jobName || '').trim();
          if (!jobName) throw new Error('Missing jobName');

          const poNumber = (job.poNumber || '').trim() || null;
          if (poNumber) {
            const { rows: dupRows } = await q('SELECT id FROM jobs WHERE office_id = $1 AND po_number = $2', [officeId, poNumber]);
            if (dupRows.length) { summary.skippedDuplicate++; if (!DRY_RUN) await client.query('ROLLBACK'); continue; }
          }

          const { code: statusCode, inAssay } = resolveBranchStatus(job.status);
          if (job.status && !statusCode) summary.unmappedBranchStatus.add(job.status);
          const hqStatusCode = resolveHqStatus(job.indiaStatus);
          if (job.indiaStatus && !hqStatusCode) summary.unmappedHqStatus.add(job.indiaStatus);

          const { amount: invoiceAmount, extra: invoiceExtra } = parseInvoiceAmount(job.invoiceAmt);
          let notes = job.notes || '';
          if (invoiceExtra) notes = notes ? `${notes}\n(Invoice note: ${invoiceExtra})` : `(Invoice note: ${invoiceExtra})`;
          if (job.settingCharge && job.settingCharge !== 'None') notes += `\n(Setting charge: ${job.settingCharge})`;

          const createdAt = parseTimestamp(job.createdAt) || new Date().toISOString();

          const { rows: jobRows } = await q(
            `INSERT INTO jobs (
               office_id, job_name, contact_person, client_phone, priority, status_code, hq_status_code,
               client_delivery_date, po_number, render_link, diacrown_ssp, invoice_amount, notes,
               client_stone_semi_mount, setting_charge_confirmed, design_no, in_assay,
               assay_office_name, assay_invoice_no, assay_date_sent,
               import_batch_id, imported_at, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now(),$22)
             RETURNING id`,
            [
              officeId, jobName, job.contact || null, job.clientPhone || null,
              parsePriority(job.priority), statusCode || 'quoting', hqStatusCode,
              parseDate(job.clientDeliveryDate || job.dueDate), poNumber, job.renderLink || null,
              job.diacrown || null, invoiceAmount, notes.trim() || null,
              !!job.clientStoneSemiMount, !!job.settingChargeConfirmed, job.designNo || null,
              inAssay || job.status === ASSAY_STATUS_LABEL,
              job.assayOfficeName || null, job.assayInvoiceNo || null, parseDate(job.assayDateSent),
              batchId, createdAt,
            ]
          );
          const jobId = DRY_RUN ? 0 : jobRows[0].id;

          // job_production
          if (job.prod && Object.keys(job.prod).length) {
            const p = job.prod;
            await q(
              `INSERT INTO job_production (
                 job_id, inquiry_date, quotation_date, cad_issued, qc_pass, ship_date, item_type,
                 item_size, qty, metal_type, metal_color, alloy_type, rhodium, stone_type, stone_details,
                 stone_source, setting_type, stamp_logo, stamp_metal, stamp_loc, vendor, finding1,
                 approval_date, po_date, stone_issue_date, delivery_date, cad_issued_to
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
               ON CONFLICT (job_id) DO NOTHING`,
              [
                jobId, parseDate(p.inquiryDate), parseDate(p.quotationDate), parseDate(p.cadIssued), parseDate(p.qcPass),
                parseDate(p.shipDate), p.itemType || null, p.itemSize || null, p.qty ? Number(p.qty) || null : null,
                p.metalType || null, p.metalColor || null, p.alloyType || null, p.rhodium || null, p.stoneType || null,
                p.stoneDetails || null, p.stoneSource || null, p.settingType || null, p.stampLogo || null,
                p.stampMetal || null, p.stampLoc || null, p.vendor || null, p.finding1 || null,
                parseDate(p.approvalDate), parseDate(p.poDate), parseDate(p.stoneIssueDate), parseDate(p.deliveryDate),
                p.cadIssuedTo || null,
              ]
            );
          }

          // job_design_entries
          if (Array.isArray(job.designEntries)) {
            let sortOrder = 0;
            for (const e of job.designEntries) {
              if (!e || !['custom', 'matching_set', 'stock'].includes(e.kind)) continue;
              await q(
                `INSERT INTO job_design_entries (job_id, kind, base_number, description, po_number, sort_order, style_code, qty)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [jobId, e.kind, e.base || null, e.desc || null, e.po || null, sortOrder++, e.styleCode || null, e.qty ? Number(e.qty) || null : null]
              );
            }
          }

          // job_client_items — real data mostly has this empty; handle string or object entries defensively
          if (Array.isArray(job.clientItems)) {
            let sortOrder = 0;
            for (const item of job.clientItems) {
              const description = typeof item === 'string' ? item : (item?.description || item?.desc || null);
              if (!description) continue;
              await q('INSERT INTO job_client_items (job_id, description, sort_order) VALUES ($1,$2,$3)', [jobId, description, sortOrder++]);
            }
          }

          // job_images — clientRef/cadImage are already-hosted URLs (Cloudinary/Drive); link directly, skip bare filenames that aren't real URLs
          const imageSets = [['clientRef', 'client_ref'], ['cadImage', 'cad']];
          for (const [field, kind] of imageSets) {
            const val = job[field];
            const urls = Array.isArray(val) ? val : (isUrl(val) ? [val] : []);
            for (const url of urls) {
              if (isUrl(url)) await q('INSERT INTO job_images (job_id, kind, url) VALUES ($1,$2,$3)', [jobId, kind, url]);
            }
          }

          // job_setter_polisher / repairer
          for (const role of ['setter', 'polisher', 'repairer']) {
            const name = job[`${role}Name`], fee = job[`${role}Fee`], dateSent = job[`${role}DateSent`];
            if (!name && !dateSent && !fee) continue;
            await q(
              `INSERT INTO job_setter_polisher (job_id, role_type, person_name, fee, date_sent, due_date, date_returned)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [jobId, role, name || null, fee ? (parseInvoiceAmount(fee).amount) : null, parseDate(dateSent), parseDate(job[`${role}DueDate`]), parseDate(job[`${role}DateReturned`])]
            );
          }

          // job_chat_messages — no real-user mapping exists yet, so the historical sender's name is folded into the message body
          if (Array.isArray(job.chat)) {
            for (const m of job.chat) {
              const body = `[${m.from || m.role || 'Unknown'}] ${m.text || ''}`.trim();
              await q(
                `INSERT INTO job_chat_messages (job_id, body, created_at) VALUES ($1,$2,$3)`,
                [jobId, body, parseTimestamp(m.ts) || createdAt]
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
            await q(
              `INSERT INTO job_status_history (job_id, status_code, side, note, changed_at)
               VALUES ($1,$2,'branch','Migrated from historical record',$3)`,
              [jobId, h.code, h.at]
            );
          }

          if (!DRY_RUN) await client.query('COMMIT');
          summary.imported++;
        } catch (err) {
          if (!DRY_RUN) await client.query('ROLLBACK').catch(() => {});
          summary.errored++;
          summary.errors.push({ id: firestoreId, source: file.source, office: officeCode, error: err.message });
        } finally {
          if (client) client.release();
        }
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Migration summary`);
  console.log(`  Imported: ${summary.imported}`);
  console.log(`  Skipped (duplicate PO): ${summary.skippedDuplicate}`);
  console.log(`  Errored: ${summary.errored}`);
  if (summary.unmappedBranchStatus.size) console.log(`  Unmapped branch status labels: ${[...summary.unmappedBranchStatus].join(', ')}`);
  if (summary.unmappedHqStatus.size) console.log(`  Unmapped HQ status labels: ${[...summary.unmappedHqStatus].join(', ')}`);
  if (summary.errors.length) {
    console.log(`\n  First 20 errors:`);
    for (const e of summary.errors.slice(0, 20)) console.log(`    [${e.source}/${e.office || '?'}] ${e.id}: ${e.error}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
