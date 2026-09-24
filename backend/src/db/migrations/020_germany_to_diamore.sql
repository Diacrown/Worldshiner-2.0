-- Germany (DM-GER) is actually Diamore's location, not Diacrown's — seed.js
-- had it filed under the wrong org from when it was first set up. Moving it
-- for real: any jobs already logged under DM-GER become visible to Diamore
-- HQ staff instead of Diacrown HQ staff (org scoping is strict — see
-- scope.js buildScope). Confirmed with the user directly before running.
UPDATE offices
SET org_id = (SELECT id FROM orgs WHERE code = 'DIAMORE')
WHERE code = 'DM-GER';

-- DM-LOC1 was always a placeholder ("rename once confirmed" — see seed.js)
-- with no real jobs. Marking it inactive hides it from the office switcher
-- dropdown and the new office-breakdown bar alike, until it's a real,
-- named location — avoids a second round of changes once it's confirmed.
UPDATE offices
SET active = FALSE
WHERE code = 'DM-LOC1';
