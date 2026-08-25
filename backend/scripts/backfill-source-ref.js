// One-time utility: populates jobs.source_ref for jobs imported by the
// original migrate-historical-jobs.js run, which predates that column.
//
// Field-based matching (office + job_name + created_at) turned out to be
// unreliable — real data has large clusters of identically-named jobs
// ("Stock", "S Stock", ...) bulk-imported at the same source timestamp in
// the old system, so name+timestamp isn't unique. Instead this relies on
// something that IS exact: migrate-historical-jobs.js processed each
// (office, source file) group in the same order the export JSON lists
// them, inserting one row per entry with no gaps (this run had zero
// skips/errors) — so the Nth job row (ordered by id) in a given
// import_batch corresponds exactly to the Nth entry in that batch's export
// group. This zips them back together.
//
// Requires firestore-export/jobs_v2.json and jobs_v2_uk.json to be
// UNCHANGED since the migration ran — if they've been re-exported since,
// this will detect a count mismatch per group and skip it rather than
// backfill against data that may no longer correspond 1:1.
//
// Usage: DATABASE_URL=<target> node scripts/backfill-source-ref.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', '..', 'firestore-export');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const officeRes = await pool.query('SELECT id, code FROM offices');
  const officeCodeToId = new Map(officeRes.rows.map((r) => [r.code, r.id]));

  const files = [
    { path: path.join(EXPORT_DIR, 'jobs_v2.json'), source: 'jobs_v2' },
    { path: path.join(EXPORT_DIR, 'jobs_v2_uk.json'), source: 'jobs_v2_uk' },
  ];

  let totalBackfilled = 0, totalSkippedGroups = 0;

  for (const file of files) {
    if (!fs.existsSync(file.path)) { console.log(`Skipping ${file.source} — file not found`); continue; }
    const docs = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    const byOffice = {};
    for (const [id, job] of Object.entries(docs)) {
      const officeCode = job.office;
      if (!officeCode || !officeCodeToId.has(officeCode)) continue;
      (byOffice[officeCode] ||= []).push(id);
    }

    for (const [officeCode, firestoreIds] of Object.entries(byOffice)) {
      const officeId = officeCodeToId.get(officeCode);

      const { rows: batchRows } = await pool.query(
        `SELECT ib.id FROM import_batches ib
         WHERE ib.office_id = $1 AND ib.filename = $2
           AND EXISTS (SELECT 1 FROM jobs j WHERE j.import_batch_id = ib.id)
         ORDER BY ib.id DESC LIMIT 1`,
        [officeId, file.source]
      );
      if (!batchRows.length) {
        console.log(`  [skip] ${officeCode}/${file.source}: no matching import_batch with jobs found`);
        totalSkippedGroups++;
        continue;
      }
      const batchId = batchRows[0].id;

      const { rows: jobRows } = await pool.query(
        `SELECT id FROM jobs WHERE import_batch_id = $1 AND source_ref IS NULL ORDER BY id ASC`,
        [batchId]
      );

      if (jobRows.length === 0) {
        console.log(`  [skip] ${officeCode}/${file.source}: batch ${batchId} already fully backfilled`);
        continue;
      }
      if (jobRows.length !== firestoreIds.length) {
        console.log(`  [SKIP - MISMATCH] ${officeCode}/${file.source}: batch ${batchId} has ${jobRows.length} unbackfilled row(s) but export has ${firestoreIds.length} entries — refusing to guess. Needs manual review.`);
        totalSkippedGroups++;
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < jobRows.length; i++) {
          await client.query('UPDATE jobs SET source_ref = $1 WHERE id = $2', [firestoreIds[i], jobRows[i].id]);
        }
        await client.query('COMMIT');
        console.log(`  [ok] ${officeCode}/${file.source}: backfilled ${jobRows.length} row(s) in batch ${batchId}`);
        totalBackfilled += jobRows.length;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  [ERROR] ${officeCode}/${file.source}: ${err.message}`);
        totalSkippedGroups++;
      } finally {
        client.release();
      }
    }
  }

  console.log(`\nBackfill summary`);
  console.log(`  Backfilled: ${totalBackfilled}`);
  console.log(`  Skipped groups (needs review): ${totalSkippedGroups}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
