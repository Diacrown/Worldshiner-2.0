-- Historical data had three India-side image fields the original migration
-- never looked at (it only checked clientRef/cadImage): indiaCardCads,
-- indiaCardRefs (ordinary CAD reference photos — folded into the existing
-- 'cad' kind), and indiaHiddenRefs (explicitly named "hidden" in the old
-- data with no confirmed intent — kept restricted to HQ/admin visibility
-- rather than assumed safe to show every branch office).
ALTER TABLE job_images DROP CONSTRAINT job_images_kind_check;
ALTER TABLE job_images ADD CONSTRAINT job_images_kind_check
  CHECK (kind IN ('client_ref','cad','client_item','india_hidden'));
