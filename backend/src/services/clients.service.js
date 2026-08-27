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
