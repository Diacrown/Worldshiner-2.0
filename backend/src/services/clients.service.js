import { pool } from '../db/pool.js';
import { buildScope } from './scope.js';
import { REGIONS, regionForOfficeCode } from './regions.js';

// No dedicated "client" entity exists in the schema (see jobs table — just
// job_name/contact_person/client_phone). Client identity has always lived as
// a free-text prefix of job_name, e.g. "PHENIX JWY - JOHN SMITH" -> client is
// "PHENIX JWY" — the same convention the old Firestore tracker used. This
// derives a best-effort grouping key from that prefix rather than requiring
// thousands of historical jobs to be manually re-tagged against a new table.
export function deriveClientKey(jobName) {
  if (!jobName) return 'Unspecified';
  const idx = jobName.indexOf(' - ');
  const raw = (idx === -1 ? jobName : jobName.slice(0, idx)).trim();
  if (!raw) return 'Unspecified';
  // Normalize casing/spacing so "PHENIX JWY" and "Phenix Jwy" land in the
  // same bucket instead of splitting a real client's jobs across two rows —
  // there's no canonical client record to key off of (see module comment).
  return raw.replace(/\s+/g, ' ').toUpperCase();
}

// Builds the full region -> country -> office -> client tree for the Clients
// map page, scoped to what `user` is allowed to see (same buildScope rules
// as the main job list: HQ/org-admin sees their whole org, branch staff sees
// only their own office).
export async function getClientDirectory(user) {
  const { where, params } = buildScope(user);
  const sql = `
    SELECT j.id, j.job_name, j.updated_at, o.code AS office_code, o.name AS office_name
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    ${where}
  `;
  const { rows } = await pool.query(sql, params);

  const officeMap = new Map();
  for (const row of rows) {
    let office = officeMap.get(row.office_code);
    if (!office) {
      office = { officeCode: row.office_code, officeName: row.office_name, clients: new Map(), jobCount: 0 };
      officeMap.set(row.office_code, office);
    }
    office.jobCount += 1;

    const key = deriveClientKey(row.job_name);
    let client = office.clients.get(key);
    if (!client) {
      client = { clientName: key, jobCount: 0, lastActivity: row.updated_at };
      office.clients.set(key, client);
    }
    client.jobCount += 1;
    if (row.updated_at > client.lastActivity) client.lastActivity = row.updated_at;
  }

  // Fold offices into the static region/country tree so the frontend can
  // render a fixed globe layout. Offices present in the data but missing
  // from the taxonomy still show up (regionForOfficeCode falls back to
  // 'other'), so nothing a user can actually see is ever silently dropped.
  const regionMap = new Map(REGIONS.map((r) => [r.id, {
    id: r.id, label: r.label, officeType: r.officeType, businessTypes: r.businessTypes,
    lat: r.lat, lng: r.lng, jobCount: 0,
    countries: new Map(r.countries.map((c) => [c.name, { name: c.name, offices: [], jobCount: 0 }])),
  }]));

  for (const office of officeMap.values()) {
    const { regionId, countryName } = regionForOfficeCode(office.officeCode);
    const region = regionMap.get(regionId) || regionMap.get('other');
    let country = region.countries.get(countryName);
    if (!country) {
      country = { name: countryName, offices: [], jobCount: 0 };
      region.countries.set(countryName, country);
    }
    const clients = Array.from(office.clients.values()).sort((a, b) => b.jobCount - a.jobCount);
    country.offices.push({ officeCode: office.officeCode, officeName: office.officeName, jobCount: office.jobCount, clients });
    country.jobCount += office.jobCount;
    region.jobCount += office.jobCount;
  }

  // Countries with no offices yet (e.g. Netherlands, Thailand) are kept in
  // the output with an empty offices[] so the frontend can render them
  // greyed-out on the map instead of just omitting them.
  return Array.from(regionMap.values()).map((r) => ({
    ...r,
    countries: Array.from(r.countries.values()),
  }));
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Flags likely-duplicate client buckets within the same office — the
// grouping in getClientDirectory is a guessed job_name prefix (see
// deriveClientKey), so a client typed inconsistently across jobs (a missing
// "JWY", a typo) shows up as two separate entries instead of one. Two
// heuristics, since either alone misses real cases: one name is a prefix of
// the other ("PHENIX" vs "PHENIX JWY"), or they're a close edit-distance
// match (a typo). Both run purely over the already-fetched directory, no
// extra queries, so cost is negligible even at ~400 clients per office.
export async function getMergeSuggestions(user) {
  const directory = await getClientDirectory(user);
  const suggestions = [];

  for (const region of directory) {
    for (const country of region.countries) {
      for (const office of country.offices) {
        const clients = office.clients;
        for (let i = 0; i < clients.length; i++) {
          for (let j = i + 1; j < clients.length; j++) {
            const a = clients[i], b = clients[j];
            if (a.clientName === b.clientName) continue;
            // A prefix match is only a good duplicate signal when the extra
            // trailing text is short — a client typed without its usual
            // suffix ("PHENIX" vs "PHENIX JWY", +4 chars). A big trailing
            // difference ("PHENIX JWY" vs "PHENIX JWY J-006-05921", +13)
            // usually means the longer one is a distinct job name that
            // never had its " - description" separator, not the same
            // client — those aren't worth suggesting at all.
            const shorterLen = Math.min(a.clientName.length, b.clientName.length);
            const longerLen = Math.max(a.clientName.length, b.clientName.length);
            const extraLen = longerLen - shorterLen;
            const isPrefix = (a.clientName.startsWith(b.clientName) || b.clientName.startsWith(a.clientName))
              && extraLen <= Math.max(6, shorterLen * 0.5);
            const isCloseTypo = shorterLen >= 5 && levenshtein(a.clientName, b.clientName) <= Math.max(1, Math.floor(shorterLen * 0.2));
            if (!isPrefix && !isCloseTypo) continue;
            const [bigger, smaller] = a.jobCount >= b.jobCount ? [a, b] : [b, a];
            suggestions.push({
              officeCode: office.officeCode,
              officeName: office.officeName,
              suggestedCanonical: bigger.clientName,
              suggestedDuplicate: smaller.clientName,
              canonicalJobCount: bigger.jobCount,
              duplicateJobCount: smaller.jobCount,
              reason: isPrefix ? 'prefix' : 'similar-spelling',
            });
          }
        }
      }
    }
  }

  return suggestions.sort((x, y) => (y.canonicalJobCount + y.duplicateJobCount) - (x.canonicalJobCount + x.duplicateJobCount));
}

// Renames the client-name prefix on every job at `officeCode` currently
// grouped under `fromName` to `toName`. This is a real, permanent edit to
// job_name — deliberately so, since it fixes the actual data quality issue
// rather than adding an alias layer every future client-grouping query
// would need to know about. Scoped through buildScope so an org admin can't
// merge clients in an office outside their own org.
export async function mergeClients(user, { officeCode, fromName, toName }) {
  if (!officeCode || !fromName || !toName) {
    const err = new Error('officeCode, fromName, and toName are required');
    err.status = 400;
    throw err;
  }
  const { where, params } = buildScope(user, { officeOverride: officeCode });
  const { rows } = await pool.query(`SELECT j.id, j.job_name FROM jobs j ${where}`, params);

  // Matches deriveClientKey's own normalization exactly, so this only
  // touches jobs that actually group under fromName today.
  const fromKey = fromName.trim().replace(/\s+/g, ' ').toUpperCase();
  const canonicalName = toName.trim();
  let updated = 0;
  for (const row of rows) {
    if (deriveClientKey(row.job_name) !== fromKey) continue;
    const idx = row.job_name.indexOf(' - ');
    let newName;
    if (idx !== -1) {
      // Already has a separator — swap only the client-name half, leave
      // the " - description" half exactly as-is.
      newName = canonicalName + row.job_name.slice(idx);
    } else {
      // No separator means the whole job_name doubled as the client key —
      // e.g. "Phenix Jwy Jai Thompson" with no dash anywhere. Every row in
      // this bucket has the same content as fromName (that's why it
      // matched), so there's nothing left over relative to fromName itself
      // — the real question is whether the row's name extends past the
      // *canonical* name. If it does ("Phenix Jwy Jai Thompson" starts with
      // canonical "PHENIX JWY"), that extra text is real per-job content
      // ("Jai Thompson") and gets preserved with a proper separator instead
      // of silently discarded. If it doesn't (e.g. a straight typo like
      // "PHENIX JAI" for "PHENIX JWY"), there's nothing to preserve.
      const upperOriginal = row.job_name.toUpperCase();
      const upperCanonical = canonicalName.toUpperCase();
      if (upperOriginal.length > upperCanonical.length && upperOriginal.startsWith(upperCanonical)) {
        const remainder = row.job_name.slice(canonicalName.length).trim();
        newName = remainder ? `${canonicalName} - ${remainder}` : canonicalName;
      } else {
        newName = canonicalName;
      }
    }
    if (newName === row.job_name) continue;
    await pool.query('UPDATE jobs SET job_name = $1 WHERE id = $2', [newName, row.id]);
    updated++;
  }
  return { updated };
}
