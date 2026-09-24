-- Sydney's old TAB_STATUSES (jewellery_tracker_v3_pwa.html) lists "Ready to
-- Dispatch" inside its Production tab, but this status was never carried
-- into the new schema's branch_statuses — same class of gap as migrations
-- 017/018. Sits right after Ready to Ship in sort order, matching the old
-- file's own ordering (Ready to Ship, Ready to Dispatch, In Transit).
INSERT INTO branch_statuses (code, label, sort_order, is_system_only, is_archive) VALUES
  ('ready_to_dispatch', 'Ready to Dispatch', 215, false, false)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;
