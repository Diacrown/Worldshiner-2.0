-- Tier 5 field-audit gap: UK-only fields with no equivalent column today.
-- Grouped with the existing assay fields and gated the same way
-- (officeHasAssay), since they only ever appear on UK jobs.
ALTER TABLE jobs ADD COLUMN assay_priority BOOLEAN;
ALTER TABLE jobs ADD COLUMN sales_rep TEXT;
ALTER TABLE jobs ADD COLUMN inquiry_sent_at DATE;
