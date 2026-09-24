// Builds the WHERE-clause scoping every job list/read must respect. This is
// the single place office- and ownership-visibility rules live, replacing
// the ownsJob()/applyVisibleJobs() logic that used to be copy-pasted (and
// drift slightly) across every office's HTML file. Extracted out of
// jobs.service.js so other features needing the same visibility rules (SLA
// alerts, reports) reuse it instead of re-deriving it per file — exactly the
// duplication pattern docs/ARCHITECTURE.md documents as the old system's
// root-cause bug class.
//
// Selecting an office in the switcher can mean two different things: a real
// branch office ("show me Sydney's jobs") or an HQ office row ("show me
// every job across all of Diacrown's/Diamore's locations combined"). Jobs
// are never filed directly against HQ, so a naive exact office_id match on
// an HQ code always returns zero rows — officeOverrideExpansion() below
// expands an HQ code into "every office sharing its org_id" instead of
// matching it literally. This is what let the office switcher drop its old
// separate "All offices" option — selecting an org's own HQ row now IS
// that org's "all offices" view.
function officeOverrideExpansion(paramIndexForCode, extraOrgConstraintSql = '') {
  return `j.office_id IN (
    SELECT o2.id FROM offices o2
    JOIN offices sel ON sel.code = $${paramIndexForCode}${extraOrgConstraintSql}
    WHERE (sel.is_hq AND o2.org_id = sel.org_id) OR (NOT sel.is_hq AND o2.id = sel.id)
  )`;
}

export function buildScope(user, { officeOverride, ownerView } = {}) {
  const clauses = [];
  const params = [];

  if (user.isGlobalAdmin) {
    // True super admin — every org, every office.
    if (officeOverride) {
      params.push(officeOverride);
      clauses.push(officeOverrideExpansion(params.length));
    }
  } else if (user.isOrgAdmin || user.officeIsHq) {
    // Org admin or HQ staff — every office WITHIN THEIR OWN ORG only. This is
    // the actual fix: previously officeIsHq meant "every office in every
    // org", which would have let a Diacrown HQ staffer see Diamore's client
    // data the moment Diamore had any. An office code that belongs to a
    // different org silently matches nothing here (safe: empty result, not
    // an error that reveals whether the code exists elsewhere).
    params.push(user.orgId);
    let clause = `j.office_id IN (SELECT id FROM offices WHERE org_id = $${params.length})`;
    if (officeOverride) {
      params.push(officeOverride, user.orgId);
      clause = officeOverrideExpansion(params.length - 1, ` AND sel.org_id = $${params.length}`);
    }
    clauses.push(clause);
  } else {
    params.push(user.officeId);
    clauses.push(`j.office_id = $${params.length}`);
  }

  if (user.restrictToOwnJobs) {
    params.push(user.sub);
    clauses.push(`j.owner_user_id = $${params.length}`);
  } else if (user.isOfficeMaster && ownerView === 'mine') {
    params.push(user.sub);
    clauses.push(`j.owner_user_id = $${params.length}`);
  }
  // Everyone else (ordinary staff, or a master with ownerView='all'): no
  // owner filter — sees every job in their office's scope. This matches the
  // old default ("everyone else … see all jobs, but no admin controls").

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
