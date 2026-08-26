// One-time backfill: the original migration only ever checked clientRef/
// cadImage for images, missing three India-side fields entirely
// (indiaCardCads, indiaCardRefs, indiaHiddenRefs). This adds the missing
// job_images rows for jobs that were already migrated, matched via
// source_ref (Firestore doc ID) rather than re-deriving anything fuzzy.
// Safe to re-run — skips any (job_id, url) pair that already exists,
// EXCEPT for indiaHiddenRefs specifically: since Firestore is live and
// still being edited, a URL synced earlier under an unrestricted kind
// (e.g. clientRef, at sync time) can later be reclassified as hidden in
// the source — confirmed happening for real data. For that field only,
// an existing row gets its kind upgraded to 'india_hidden' rather than
// silently left under its old, less-restricted kind.
//
// Usage: DATABASE_URL=<target> node scripts/backfill-india-images.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', '..', 'firestore-export');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const FIELDS = [
  ['indiaCardCads', 'cad'],
  ['indiaCardRefs', 'cad'],
  ['indiaHiddenRefs', 'india_hidden'],
];

function isUrl(s) {
  return typeof s === 'string' && /^https?:\/\//.test(s);
}

async function main() {
  const files = ['jobs_v2.json', 'jobs_v2_uk.json'];
  let inserted = 0, skippedDuplicate = 0, reclassified = 0, skippedNoJob = 0;

  for (const file of files) {
    const filePath = path.join(EXPORT_DIR, file);
    if (!fs.existsSync(filePath)) { console.log(`Skipping ${file} — not found`); continue; }
    const docs = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (const [firestoreId, job] of Object.entries(docs)) {
      const urlsByKind = [];
      for (const [field, kind] of FIELDS) {
        const val = job[field];
        const urls = Array.isArray(val) ? val.filter(isUrl) : (isUrl(val) ? [val] : []);
        for (const url of urls) urlsByKind.push([url, kind]);
      }
      if (!urlsByKind.length) continue;

      const { rows: jobRows } = await pool.query('SELECT id FROM jobs WHERE source_ref = $1', [firestoreId]);
      if (!jobRows.length) { skippedNoJob++; continue; }
      const jobId = jobRows[0].id;

      for (const [url, kind] of urlsByKind) {
        const { rows: existing } = await pool.query(
          'SELECT id, kind AS existing_kind FROM job_images WHERE job_id = $1 AND url = $2', [jobId, url]
        );
        if (existing.length) {
          if (kind === 'india_hidden' && existing[0].existing_kind !== 'india_hidden') {
            await pool.query('UPDATE job_images SET kind = $1 WHERE id = $2', [kind, existing[0].id]);
            reclassified++;
            console.log(`  [reclassified] job ${jobId}: ${url} was '${existing[0].existing_kind}', now 'india_hidden'`);
          } else {
            skippedDuplicate++;
          }
          continue;
        }
        await pool.query('INSERT INTO job_images (job_id, kind, url) VALUES ($1,$2,$3)', [jobId, kind, url]);
        inserted++;
      }
    }
  }

  console.log(`\nBackfill summary`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Reclassified to india_hidden: ${reclassified}`);
  console.log(`  Already present, unchanged (skipped): ${skippedDuplicate}`);
  console.log(`  No matching migrated job (skipped): ${skippedNoJob}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
