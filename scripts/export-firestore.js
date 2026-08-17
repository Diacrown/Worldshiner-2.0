// One-time reference export: dumps every Firestore collection to local JSON
// files so Claude can read the old system's real data shape without ever
// holding a live Firestore connection. Run locally, then delete the service
// account key used to run this — it's a one-time export, not a standing
// integration.
//
// Usage:
//   npm install firebase-admin   (if not already installed)
//   node scripts/export-firestore.js /path/to/serviceAccountKey.json ./firestore-export
//   node scripts/export-firestore.js /path/to/serviceAccountKey.json ./firestore-export --limit=20
//   node scripts/export-firestore.js /path/to/serviceAccountKey.json ./firestore-export --limit=20 --only=jobs_v2,staff
//
// --limit=N   only export the first N docs per collection (cheap for large/real collections — schema reference doesn't need every row)
// --only=a,b  only export these specific collections, skip the rest
//
// Output: one JSON file per top-level collection in the output directory,
// e.g. firestore-export/jobs_v2.json, firestore-export/staff.json

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  })
);
const [keyPath, outDir = './firestore-export'] = args;
const limit = flags.limit ? Number(flags.limit) : null;
const only = flags.only ? flags.only.split(',').map((s) => s.trim()) : null;

if (!keyPath) {
  console.error('Usage: node export-firestore.js /path/to/serviceAccountKey.json [outDir] [--limit=N] [--only=a,b]');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

fs.mkdirSync(outDir, { recursive: true });

async function main() {
  let collections = await db.listCollections();
  if (only) collections = collections.filter((c) => only.includes(c.id));
  console.log(`Exporting ${collections.length} collection(s): ${collections.map((c) => c.id).join(', ')}${limit ? ` (limit ${limit}/each)` : ''}`);

  for (const col of collections) {
    const query = limit ? col.limit(limit) : col;
    const snapshot = await query.get();
    const docs = {};
    snapshot.forEach((doc) => {
      docs[doc.id] = doc.data();
    });
    const outPath = path.join(outDir, `${col.id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(docs, null, 2));
    console.log(`  ${col.id}: ${snapshot.size} doc(s) -> ${outPath}`);
  }

  console.log('\nDone. Remember to revoke the service account key you used for this.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
