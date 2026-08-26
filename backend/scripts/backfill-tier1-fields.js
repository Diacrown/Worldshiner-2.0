// One-time backfill for jobs already migrated before job-import.js was
// fixed to read: owner (-> owner_user_id), clientComment/-At, snoozedUntil,
// indiaEmailedAt/Count, prod.cadModification/qcReady, chat[].img, the
// 'set' design-entry kind alias, job.issue, and 6 additional ts* fields in
// status history. Matched via source_ref. Safe to re-run — every write is
// either a NULL-only UPDATE or checks for an existing row first.
//
// Usage: DATABASE_URL=<target> node scripts/backfill-tier1-fields.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';
import { parseDate, parseTimestamp, isUrl, lookupUserIdByEmail, TS_FIELD_TO_STATUS } from './lib/job-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', '..', 'firestore-export');

const { Pool } = pg;
const rawPool = new Pool({ connectionString: process.env.DATABASE_URL });
rawPool.on('error', () => {}); // idle-client drops are handled per-query below, not fatal

// The Supabase pooler drops the connection mid-run often enough over a long
// sequence of small queries that this needs its own retry, not just
// idempotent re-runs from scratch each time. Wraps every query with a
// couple of retries before giving up.
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
  const counts = {
    jobsUpdated: 0, prodUpdated: 0, issuesInserted: 0,
    designEntriesInserted: 0, historyInserted: 0,
    chatImagesSet: 0, clientItemImagesInserted: 0,
    skippedNoJob: 0,
  };

  for (const file of files) {
    const filePath = path.join(EXPORT_DIR, file);
    if (!fs.existsSync(filePath)) { console.log(`Skipping ${file} — not found`); continue; }
    const docs = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (const [firestoreId, job] of Object.entries(docs)) {
      const { rows: jobRows } = await pool.query('SELECT id FROM jobs WHERE source_ref = $1', [firestoreId]);
      if (!jobRows.length) { counts.skippedNoJob++; continue; }
      const jobId = jobRows[0].id;

      // --- jobs: NULL-only column backfill ---
      const ownerUserId = await lookupUserIdByEmail(pool, job.owner);
      const { rowCount: jobRc } = await pool.query(
        `UPDATE jobs SET
           owner_user_id = COALESCE(owner_user_id, $1),
           client_comment = COALESCE(client_comment, $2),
           client_comment_at = COALESCE(client_comment_at, $3),
           snoozed_until = COALESCE(snoozed_until, $4),
           india_emailed_at = COALESCE(india_emailed_at, $5),
           india_email_count = CASE WHEN india_email_count = 0 THEN $6 ELSE india_email_count END
         WHERE id = $7 AND (
           owner_user_id IS NULL OR client_comment IS NULL OR client_comment_at IS NULL OR
           snoozed_until IS NULL OR india_emailed_at IS NULL OR india_email_count = 0
         )`,
        [
          ownerUserId, job.clientComment || null, parseTimestamp(job.clientCommentAt), parseDate(job.snoozedUntil),
          parseTimestamp(job.indiaEmailedAt), Number(job.indiaEmailCount) || 0, jobId,
        ]
      );
      if (jobRc) counts.jobsUpdated++;

      // --- job_production: NULL-only column backfill ---
      if (job.prod && (job.prod.cadModification || job.prod.qcReady)) {
        const { rowCount: prodRc } = await pool.query(
          `UPDATE job_production SET
             cad_modification = COALESCE(cad_modification, $1),
             qc_ready = COALESCE(qc_ready, $2)
           WHERE job_id = $3 AND (cad_modification IS NULL OR qc_ready IS NULL)`,
          [parseDate(job.prod.cadModification), parseDate(job.prod.qcReady), jobId]
        );
        if (prodRc) counts.prodUpdated++;
      }

      // --- job_issues: insert if this job has a real issue and none exists yet ---
      if (job.issue && typeof job.issue === 'object' && job.issue.type) {
        const { rows: existingIssues } = await pool.query('SELECT id FROM job_issues WHERE job_id = $1', [jobId]);
        if (!existingIssues.length) {
          const openedBy = await lookupUserIdByEmail(pool, job.issue.flaggedBy);
          const resolvedBy = await lookupUserIdByEmail(pool, job.issue.resolvedBy);
          await pool.query(
            `INSERT INTO job_issues (job_id, issue_type, description, status, opened_by_user_id, opened_at, resolved_by_user_id, resolved_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              jobId, job.issue.type, job.issue.reason || null, job.issue.open === false ? 'resolved' : 'open',
              openedBy, parseTimestamp(job.issue.flaggedAt) || new Date().toISOString(), resolvedBy, parseTimestamp(job.issue.resolvedAt),
            ]
          );
          counts.issuesInserted++;
        }
      }

      // --- job_design_entries: insert any 'set'-kind entries that were previously skipped entirely ---
      if (Array.isArray(job.designEntries)) {
        for (const e of job.designEntries) {
          if (e?.kind !== 'set') continue;
          const { rows: existingEntry } = await pool.query(
            `SELECT id FROM job_design_entries WHERE job_id = $1 AND kind = 'matching_set'
             AND base_number IS NOT DISTINCT FROM $2 AND description IS NOT DISTINCT FROM $3`,
            [jobId, e.base || null, e.desc || null]
          );
          if (existingEntry.length) continue;
          const { rows: maxSort } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM job_design_entries WHERE job_id = $1', [jobId]);
          await pool.query(
            `INSERT INTO job_design_entries (job_id, kind, base_number, description, po_number, sort_order, style_code, qty)
             VALUES ($1,'matching_set',$2,$3,$4,$5,$6,$7)`,
            [jobId, e.base || null, e.desc || null, e.po || null, maxSort[0].next, e.styleCode || null, e.qty ? Number(e.qty) || null : null]
          );
          counts.designEntriesInserted++;
        }
      }

      // --- job_status_history: insert any of the 6 newly-added ts* events not already present ---
      const newTsFields = ['tsAtAssay', 'tsRequestMod', 'tsWithSetter', 'tsAddlInfoNeeded', 'tsLocalProduction', 'tsRequestRender'];
      for (const field of newTsFields) {
        const dateStr = parseDate(job[field]);
        if (!dateStr) continue;
        const code = TS_FIELD_TO_STATUS[field];
        const { rows: existingHist } = await pool.query(
          `SELECT id FROM job_status_history WHERE job_id = $1 AND status_code = $2 AND changed_at::date = $3::date`,
          [jobId, code, dateStr]
        );
        if (existingHist.length) continue;
        await pool.query(
          `INSERT INTO job_status_history (job_id, status_code, side, note, changed_at)
           VALUES ($1,$2,'branch','Migrated from historical record',$3)`,
          [jobId, code, dateStr]
        );
        counts.historyInserted++;
      }

      // --- job_chat_messages: set image_url on existing rows matched by job_id + created_at + body ---
      if (Array.isArray(job.chat)) {
        for (const m of job.chat) {
          if (!isUrl(m.img)) continue;
          const body = `[${m.from || m.role || 'Unknown'}] ${m.text || ''}`.trim();
          const ts = parseTimestamp(m.ts);
          const { rowCount: chatRc } = await pool.query(
            `UPDATE job_chat_messages SET image_url = $1
             WHERE job_id = $2 AND body = $3 AND image_url IS NULL
               AND ($4::timestamptz IS NULL OR created_at = $4::timestamptz)`,
            [m.img, jobId, body, ts]
          );
          if (chatRc) counts.chatImagesSet += chatRc;
        }
      }

      // --- job_client_items: insert images for existing items matched by job_id + description, if not already present ---
      if (Array.isArray(job.clientItems)) {
        for (const item of job.clientItems) {
          const description = typeof item === 'string' ? item : (item?.description || item?.desc || null);
          const itemImages = Array.isArray(item?.images) ? item.images.filter(isUrl) : [];
          if (!description || !itemImages.length) continue;
          const { rows: itemRow } = await pool.query(
            'SELECT id FROM job_client_items WHERE job_id = $1 AND description = $2 LIMIT 1',
            [jobId, description]
          );
          if (!itemRow.length) continue;
          const clientItemId = itemRow[0].id;
          for (const url of itemImages) {
            const { rows: existingImg } = await pool.query(
              'SELECT id FROM job_images WHERE client_item_id = $1 AND url = $2',
              [clientItemId, url]
            );
            if (existingImg.length) continue;
            await pool.query(
              'INSERT INTO job_images (job_id, client_item_id, kind, url) VALUES ($1,$2,$3,$4)',
              [jobId, clientItemId, 'client_item', url]
            );
            counts.clientItemImagesInserted++;
          }
        }
      }
    }
  }

  console.log('\nTier-1 backfill summary');
  console.log(' ', counts);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
