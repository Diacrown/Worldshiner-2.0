// One-time reference export: dumps every Firestore collection to local JSON
// files so Claude can read the old system's real data shape without ever
// holding a live Firestore connection. Run locally, then delete the service
// account key used to run this — it's a one-time export, not a standing
// integration.
//
// Usage:
//   npm install firebase-admin   (if not already installed)
//   node scripts/export-firestore.js /path/to/serviceAccountKey.json ./firestore-export
//
// Output: one JSON file per top-level collection in the output directory,
// e.g. firestore-export/jobs_v2.json, firestore-export/staff.json

import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const [, , keyPath, outDir = './firestore-export'] = process.argv;

if (!keyPath) {
  console.error('Usage: node export-firestore.js /path/to/serviceAccountKey.json [outDir]');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const collections = await db.listCollections();
  console.log(`Found ${collections.length} top-level collection(s): ${collections.map((c) => c.id).join(', ')}`);

  for (const col of collections) {
    const snapshot = await col.get();
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
