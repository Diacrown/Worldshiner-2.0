// One-time backfill of assay_priority/sales_rep/inquiry_sent_at (Tier 5
// field-audit gap — UK-only) for jobs already migrated before job-import.js
// read them. Matched via source_ref, NULL-only, safe to re-run.
//
// Usage: DATABASE_URL=<target> node scripts/backfill-uk-inquiry-fields.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';
import { parseDate } from './lib/job-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', '..', 'firestore-export');

const { Pool } = pg;
const rawPool = new Pool({ connectionString: process.env.DATABASE_URL });
rawPool.on('error', () => {});

async function queryWithRetry(text, params, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await rawPool.query(text, params);
    } catch (err) {
      const transient = /Connection terminated|ECONNRESET|timeout/i.test(err.message);
      if (!transient || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
const pool = { query: queryWithRetry, end: () => rawPool.end() };

async function main() {
  // UK-only fields — only jobs_v2_uk.json ever has them.
  const filePath = path.join(EXPORT_DIR, 'jobs_v2_uk.json');
  const counts = { jobsUpdated: 0, skippedNoJob: 0 };
  if (!fs.existsSync(filePath)) { console.log('jobs_v2_uk.json not found — nothing to backfill'); return; }

  const docs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  for (const [firestoreId, job] of Object.entries(docs)) {
    if (!job.assayPriority && !job.salesRep && !job.inquirySentAt) continue;

    const { rows: jobRows } = await pool.query('SELECT id FROM jobs WHERE source_ref = $1', [firestoreId]);
    if (!jobRows.length) { counts.skippedNoJob++; continue; }

    const assayPriority = job.assayPriority === 'Yes' ? true : job.assayPriority === 'No' ? false : null;
    const { rowCount } = await pool.query(
      `UPDATE jobs SET
         assay_priority = COALESCE(assay_priority, $1),
         sales_rep = COALESCE(sales_rep, $2),
         inquiry_sent_at = COALESCE(inquiry_sent_at, $3)
       WHERE id = $4 AND (assay_priority IS NULL OR sales_rep IS NULL OR inquiry_sent_at IS NULL)`,
      [assayPriority, job.salesRep || null, parseDate(job.inquirySentAt), jobRows[0].id]
    );
    if (rowCount) counts.jobsUpdated++;
  }

  console.log('\nTier-5 UK-inquiry-fields backfill summary');
  console.log(' ', counts);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
