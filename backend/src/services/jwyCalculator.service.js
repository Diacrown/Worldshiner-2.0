// Pulls metal/alloy/weight from a quote already saved in the Jwy Calculator
// app into a job's Production spec, instead of that data being retyped by
// hand. The Calculator is a separate, independently-deployed app (its own
// Neon database + Netlify Blobs storage) — rather than reaching into its
// database directly, this calls its own existing public Netlify Functions
// (search-quotes, load-quote) over plain HTTPS, the same way its own
// frontend does. No new database credentials needed, just its deployed URL.
import { pool } from '../db/pool.js';
import { getJobById } from './jobs.service.js';

function assertConfigured() {
  if (!process.env.JWY_CALCULATOR_URL) {
    const err = new Error(
      'JWY_CALCULATOR_URL is not configured — set it in .env to the Jwy Calculator app\'s deployed URL ' +
      '(e.g. https://your-app.netlify.app) to enable pulling quotes into Production specs.'
    );
    err.status = 501;
    throw err;
  }
}

export function isConfigured() {
  return !!process.env.JWY_CALCULATOR_URL;
}

async function searchQuotesByJobNo(jobNo) {
  assertConfigured();
  const base = process.env.JWY_CALCULATOR_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/.netlify/functions/search-quotes?q=${encodeURIComponent(jobNo)}`);
  if (!res.ok) {
    const err = new Error(`Jwy Calculator search failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  const { results } = await res.json();
  // search-quotes matches job_no OR item_no by substring — keep only exact
  // job_no matches so a job "40" doesn't pull in quotes for job "1400".
  return (results || []).filter((r) => r.job_no === jobNo);
}

async function loadQuoteSnapshot(filenameBase) {
  assertConfigured();
  const base = process.env.JWY_CALCULATOR_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/.netlify/functions/load-quote?filenameBase=${encodeURIComponent(filenameBase)}`);
  if (!res.ok) {
    const err = new Error(`Jwy Calculator quote fetch failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

// A saved quote's alloy is a short code like "18KT WG" or "AG925" (see
// ALLOYS in JwyCalculator.jsx) — karat/purity prefix, then an optional
// color/type suffix. Split on the first run of letters-only after the
// leading digits+KT, best-effort; alloy_type always gets the exact code
// regardless, so nothing is lost if the split doesn't cleanly apply (e.g.
// "AG925" has no separate color component).
function splitAlloyShort(short) {
  const match = /^(\d+KT|[A-Z]+\d*)\s*(.*)$/.exec(short || '');
  if (!match) return { metalType: short || null, metalColor: null };
  return { metalType: match[1] || null, metalColor: match[2] || null };
}

// Finds the most recent saved quote for `job.po_number` and copies its
// metal/alloy/weight into job_production. Setting cost is deliberately NOT
// pulled: the Calculator only persists the raw per-stone input rows in a
// saved quote, not the computed setting total (that's derived at load time
// from live pricing data), so there's nothing reliable to read here without
// re-implementing its pricing rules. Returns null if the job has no PO
// number or no matching quote was found.
export async function pullQuoteIntoProduction(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  if (!job.po_number) {
    const err = new Error('This job has no PO number to match against the Calculator\'s saved quotes.');
    err.status = 400;
    throw err;
  }

  const matches = await searchQuotesByJobNo(job.po_number);
  if (!matches.length) return { found: false };

  const latest = matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const snapshot = await loadQuoteSnapshot(latest.filename_base);
  const { metalType, metalColor } = splitAlloyShort(snapshot.primaryAlloyShort);

  // This is a deliberate, user-triggered sync action (a button click, not a
  // background job), so it overwrites these four fields outright rather
  // than only filling blanks — the point is to make the job match the
  // quote the person just chose to pull.
  await pool.query(
    `INSERT INTO job_production (job_id, metal_type, metal_color, alloy_type, metal_weight_grams, calculator_quote_ref, calculator_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (job_id) DO UPDATE SET
       metal_type = EXCLUDED.metal_type,
       metal_color = EXCLUDED.metal_color,
       alloy_type = EXCLUDED.alloy_type,
       metal_weight_grams = EXCLUDED.metal_weight_grams,
       calculator_quote_ref = EXCLUDED.calculator_quote_ref,
       calculator_synced_at = now()`,
    [jobId, metalType, metalColor, snapshot.primaryAlloyShort || null, snapshot.primaryGramWt || null, latest.filename_base]
  );

  return {
    found: true,
    quoteRef: latest.filename_base,
    alloyType: snapshot.primaryAlloyShort,
    metalWeightGrams: snapshot.primaryGramWt,
  };
}
