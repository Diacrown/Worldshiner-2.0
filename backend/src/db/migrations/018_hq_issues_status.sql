-- The old India tracker's "Issues" tab was built around a "Complaint" HQ
-- status that was never carried into this schema (same class of gap as
-- migration 017's sketch_request/cad_requested/render_requested/
-- qc_pass_hold_for_set). Needed now for the new dashboard tab bar's HQ
-- "Issues" tab (see jobTabs.js).
INSERT INTO hq_statuses (code, label, sort_order) VALUES
  ('complaint', 'Complaint', 245)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;
