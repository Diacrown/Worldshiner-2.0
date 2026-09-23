-- Ported straight from india_factory_app.html's DASH_TABS/ALERT_CATS: these
-- 4 hq_statuses existed in the old India (Diacrown/Diamore) tracker but were
-- never added to the new schema's hq_statuses seed, so jobs sitting in them
-- would have silently never matched the "Cad Pending" / "Ready to Ship"
-- alert categories. Sort order values slot them in next to their closest
-- existing neighbour so the status dropdown still reads in a sane order.
INSERT INTO hq_statuses (code, label, sort_order) VALUES
  ('sketch_request',      'Sketch Request',        95),
  ('cad_requested',       'CAD Requested',          97),
  ('render_requested',    'Render Requested',      125),
  ('qc_pass_hold_for_set','QC Pass hold for set',  241)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;
