// Incremental sync: imports only jobs not already present (matched by
// source_ref = Firestore doc ID), so it's safe to re-run repeatedly as the
// old system keeps accumulating real activity while both systems are in
// use side by side.
//
// Requires backfill-source-ref.js to have been run first so jobs from the
// original migrate-historical-jobs.js run have source_ref populated —
// otherwise every existing job looks "new" here and would be duplicated.
//
// This only inserts jobs that don't exist yet. It does NOT update the
// status/notes/etc. of jobs that were already migrated, even if they
// changed in the old system since — that's a separate "reconcile changes"
// problem this deliberately doesn't attempt, since blindly overwriting
// could clobber anything already edited in the new system.
//
// Usage: DATABASE_URL=<target> node scripts/sync-new-jobs.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';
import { makeStatusResolvers, insertJob } from './lib/job-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', '..', 'firestore-export');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const statusRes = await pool.query('SELECT code, label FROM branch_statuses');
  const branchLabelToCode = new Map(statusRes.rows.map((r) => [r.label, r.code]));
  const hqRes = await pool.query('SELECT code, label FROM hq_statuses');
  const hqLabelToCode = new Map(hqRes.rows.map((r) => [r.label, r.code]));
  const officeRes = await pool.query('SELECT id, code FROM offices');
  const officeCodeToId = new Map(officeRes.rows.map((r) => [r.code, r.id]));
  const { resolveBranchStatus, resolveHqStatus } = makeStatusResolvers(branchLabelToCode, hqLabelToCode);

  // One bulk fetch instead of one SELECT per doc — cheap in-memory lookups
  // for what's already synced rather than thousands of network round trips.
  const { rows: existingRefs } = await pool.query('SELECT source_ref FROM jobs WHERE source_ref IS NOT NULL');
  const knownRefs = new Set(existingRefs.map((r) => r.source_ref));
  console.log(`Loaded ${knownRefs.size} already-synced source_ref(s).`);

  const files = [
    { path: path.join(EXPORT_DIR, 'jobs_v2.json'), source: 'jobs_v2' },
    { path: path.join(EXPORT_DIR, 'jobs_v2_uk.json'), source: 'jobs_v2_uk' },
  ];

  const summary = { imported: 0, alreadySynced: 0, errored: 0, unmappedBranchStatus: new Set(), unmappedHqStatus: new Set(), errors: [] };

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
      const newEntries = entries.filter(([id]) => !knownRefs.has(id));
      summary.alreadySynced += entries.length - newEntries.length;
      if (!newEntries.length) continue;

      const { rows: batchRows } = await pool.query(
        `INSERT INTO import_batches (office_id, filename, row_count_total) VALUES ($1,$2,$3) RETURNING id`,
        [officeId, `${file.source}-sync-${new Date().toISOString().slice(0, 10)}`, newEntries.length]
      );
      const batchId = batchRows[0].id;

      for (const [firestoreId, job] of newEntries) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { code: statusCode, inAssay } = resolveBranchStatus(job.status);
          if (job.status && !statusCode) summary.unmappedBranchStatus.add(job.status);
          const hqStatusCode = resolveHqStatus(job.indiaStatus);
          if (job.indiaStatus && !hqStatusCode) summary.unmappedHqStatus.add(job.indiaStatus);

          await insertJob(client, { officeId, batchId, sourceRef: firestoreId, job, statusCode, hqStatusCode, inAssay });
          await client.query('COMMIT');
          summary.imported++;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          summary.errored++;
          summary.errors.push({ id: firestoreId, source: file.source, office: officeCode, error: err.message });
        } finally {
          client.release();
        }
      }
    }
  }

  console.log(`\nSync summary`);
  console.log(`  Newly imported: ${summary.imported}`);
  console.log(`  Already synced (skipped): ${summary.alreadySynced}`);
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
