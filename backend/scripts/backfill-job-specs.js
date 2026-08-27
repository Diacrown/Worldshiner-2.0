// One-time backfill of job_specs (Tier 2 field-audit gap) for jobs already
// migrated before job-import.js read job.specs. Matched via source_ref.
// Safe to re-run — skips any job that already has at least one spec row.
//
// Usage: DATABASE_URL=<target> node scripts/backfill-job-specs.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';
import { SPEC_SKIP_KEYS, normalizeSpecKey } from './lib/job-import.js';

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
  const files = ['jobs_v2.json', 'jobs_v2_uk.json'];
  const counts = { jobsWithSpecsInserted: 0, specsInserted: 0, skippedAlreadyHasSpecs: 0, skippedNoJob: 0 };

  for (const file of files) {
    const filePath = path.join(EXPORT_DIR, file);
    if (!fs.existsSync(filePath)) { console.log(`Skipping ${file} — not found`); continue; }
    const docs = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (const [firestoreId, job] of Object.entries(docs)) {
      if (!Array.isArray(job.specs) || !job.specs.length) continue;

      const { rows: jobRows } = await pool.query('SELECT id FROM jobs WHERE source_ref = $1', [firestoreId]);
      if (!jobRows.length) { counts.skippedNoJob++; continue; }
      const jobId = jobRows[0].id;

      const { rows: existing } = await pool.query('SELECT id FROM job_specs WHERE job_id = $1 LIMIT 1', [jobId]);
      if (existing.length) { counts.skippedAlreadyHasSpecs++; continue; }

      let sortOrder = 0;
      let inserted = 0;
      for (const entry of job.specs) {
        const key = normalizeSpecKey(entry?.k);
        if (!key || SPEC_SKIP_KEYS.has(key)) continue;
        const value = entry?.v == null ? null : String(entry.v);
        if (!value) continue;
        await pool.query(
          'INSERT INTO job_specs (job_id, spec_key, spec_value, sort_order) VALUES ($1,$2,$3,$4)',
          [jobId, key, value, sortOrder++]
        );
        inserted++;
      }
      if (inserted) { counts.jobsWithSpecsInserted++; counts.specsInserted += inserted; }
    }
  }

  console.log('\nTier-2 job_specs backfill summary');
  console.log(' ', counts);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
