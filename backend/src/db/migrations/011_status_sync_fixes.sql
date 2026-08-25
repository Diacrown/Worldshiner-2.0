-- Fixes to the branch<->HQ status sync, corrected against the authoritative
-- "StatusSync" reference sheet (last updated 24 Aug 2026 by HQ):
--
-- 1. Branch "Quote Given" must NOT push anything to HQ's status at all (it's
--    the branch quoting their own client — HQ's internal "Quote Given" is a
--    separate, later action on HQ's own timeline). The original seed wrongly
--    mapped it straight through to HQ's distinct "Quote Given" status.
-- 2. Branch "Request Wax" never reached HQ before this fix — there was no
--    "New Wax Req." HQ status for it to map to at all, so HQ had zero
--    visibility when a branch requested wax.
-- 3. Branches had no "On Hold" status of their own — only HQ did.
-- 4. Two of the seven HQ-driven ("locked") branch statuses weren't flagged
--    is_system_only like the other five, inconsistently letting a branch
--    manually pick them even though they're meant to be pure sync targets.
DELETE FROM branch_to_hq_status_map WHERE branch_status_code = 'quote_given';

INSERT INTO hq_statuses (code, label, sort_order) VALUES ('new_wax_request', 'New Wax Req.', 145);
INSERT INTO branch_to_hq_status_map (branch_status_code, hq_status_code) VALUES ('request_wax', 'new_wax_request');

INSERT INTO branch_statuses (code, label, sort_order, is_system_only, is_archive) VALUES ('on_hold', 'On Hold', 165, false, false);
INSERT INTO branch_to_hq_status_map (branch_status_code, hq_status_code) VALUES ('on_hold', 'on_hold');

UPDATE branch_statuses SET is_system_only = TRUE WHERE code IN ('job_delayed', 'ready_to_ship');
