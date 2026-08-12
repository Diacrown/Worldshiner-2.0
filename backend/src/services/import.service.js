import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { withTransaction } from '../db/pool.js';

const KNOWN_FIELDS = {
  jobName: ['job name', 'jobname', 'job', 'title', 'description'],
  contactPerson: ['contact person', 'contact', 'client name', 'customer name', 'customer'],
  clientPhone: ['client phone', 'phone', 'contact phone', 'mobile', 'cell'],
  priority: ['priority'],
  poNumber: ['po number', 'po#', 'po no', 'po', 'purchase order'],
  notes: ['notes', 'note', 'remarks', 'comments', 'comment'],
  clientDeliveryDate: ['delivery date', 'due date', 'delivery', 'client delivery date'],
  designNo: ['design no', 'design number', 'design#', 'design'],
};

function isCsv(filename) {
  return /\.csv$/i.test(filename || '');
}

async function loadWorksheet(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  if (isCsv(filename)) {
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const err = new Error('No worksheet found in the uploaded file');
    err.status = 400;
    throw err;
  }
  return sheet;
}

// getSheetValues() returns a sparse array where index 0 is unused (ExcelJS
// rows are 1-indexed) and each row is itself 1-indexed by column.
function sheetToRows(sheet) {
  const values = sheet.getSheetValues();
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row === undefined) continue;
    const cells = [];
    for (let c = 1; c < row.length; c++) {
      const v = row[c];
      cells[c - 1] = v == null ? '' : (v instanceof Date ? v : String(v)).toString().trim();
    }
    rows.push(cells);
  }
  return rows;
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function suggestFieldMapping(headers) {
  const mapping = {};
  headers.forEach((header, i) => {
    const normalized = normalizeHeader(header);
    for (const [field, keywords] of Object.entries(KNOWN_FIELDS)) {
      if (keywords.some((kw) => normalized.includes(kw))) {
        mapping[i] = field;
        break;
      }
    }
  });
  return mapping;
}

export async function parsePreview(buffer, filename) {
  const sheet = await loadWorksheet(buffer, filename);
  const allRows = sheetToRows(sheet);
  if (!allRows.length) {
    const err = new Error('The file has no rows');
    err.status = 400;
    throw err;
  }
  const [headers, ...dataRows] = allRows;
  return {
    headers,
    sampleRows: dataRows.slice(0, 5),
    totalRows: dataRows.length,
    suggestedMapping: suggestFieldMapping(headers),
  };
}

function normalizePriority(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low') return 'Low';
  if (s === 'high') return 'High';
  if (s === 'medium' || s === 'med' || !s) return 'Medium';
  return null; // unrecognized — caller treats as a row error
}

function normalizeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return undefined; // signals "invalid", not "absent"
  return parsed.toISOString().slice(0, 10);
}

function applyMapping(row, mapping) {
  const out = {};
  for (const [colIndex, field] of Object.entries(mapping)) {
    out[field] = row[Number(colIndex)] ?? '';
  }
  return out;
}

// Commit re-parses the file server-side rather than trusting client-echoed
// row data from the preview step — prevents a tampered/mismatched mapping
// from being applied to different rows than what the user actually reviewed.
export async function commitImport(user, officeId, { buffer, filename, mapping }) {
  const sheet = await loadWorksheet(buffer, filename);
  const allRows = sheetToRows(sheet);
  const [, ...dataRows] = allRows;

  return withTransaction(async (client) => {
    const { rows: batchRows } = await client.query(
      `INSERT INTO import_batches (office_id, filename, imported_by_user_id, row_count_total)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [officeId, filename, user.sub, dataRows.length]
    );
    const batchId = batchRows[0].id;

    let imported = 0;
    let skippedDuplicate = 0;
    let errored = 0;
    const errors = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rowNumber = i + 2; // +1 for 1-index, +1 for the header row
      try {
        const mapped = applyMapping(dataRows[i], mapping);
        const jobName = (mapped.jobName || '').trim();
        if (!jobName) throw new Error('jobName is required (check your column mapping)');

        const priority = normalizePriority(mapped.priority);
        if (priority === null) throw new Error(`Unrecognized priority value: "${mapped.priority}"`);

        const deliveryDate = normalizeDate(mapped.clientDeliveryDate);
        if (deliveryDate === undefined) throw new Error(`Unrecognized date value: "${mapped.clientDeliveryDate}"`);

        const poNumber = (mapped.poNumber || '').trim() || null;

        if (poNumber) {
          const { rows: dupRows } = await client.query(
            'SELECT id FROM jobs WHERE office_id = $1 AND po_number = $2',
            [officeId, poNumber]
          );
          if (dupRows.length) {
            skippedDuplicate++;
            continue;
          }
        }

        const { rows: inserted } = await client.query(
          `INSERT INTO jobs (
             office_id, job_name, contact_person, client_phone, priority, status_code,
             client_delivery_date, po_number, notes, design_no, owner_user_id,
             import_batch_id, imported_at
           ) VALUES ($1,$2,$3,$4,$5,'quoting',$6,$7,$8,$9,$10,$11,now())
           RETURNING id, status_code`,
          [
            officeId, jobName, (mapped.contactPerson || '').trim() || null, (mapped.clientPhone || '').trim() || null,
            priority, deliveryDate || null, poNumber, (mapped.notes || '').trim() || null,
            (mapped.designNo || '').trim() || null, user.sub, batchId,
          ]
        );
        const job = inserted[0];
        await client.query(
          `INSERT INTO job_status_history (job_id, status_code, side, changed_by_user_id, note)
           VALUES ($1,$2,'branch',$3,'Imported')`,
          [job.id, job.status_code, user.sub]
        );
        imported++;
      } catch (err) {
        errored++;
        errors.push({ row: rowNumber, error: err.message });
      }
    }

    await client.query(
      `UPDATE import_batches
       SET row_count_imported = $1, row_count_skipped_duplicate = $2, row_count_errored = $3
       WHERE id = $4`,
      [imported, skippedDuplicate, errored, batchId]
    );

    return { batchId, totalRows: dataRows.length, imported, skippedDuplicate, errored, errors };
  });
}
