-- Enrichment derived from the branch user manual + Sydney-vs-UK functionality
-- diff: the status pipeline was missing several real stages/sync mappings
-- (fixed via seed.js, not here — statuses are data, not schema), and three
-- real feature gaps: UK-only Assay Office tracking, richer issue/repair
-- fields, and a due-date-driven follow-up field for the Alerts panel.

-- One feature flag, not a general per-office feature-flag framework — the
-- Sydney-vs-UK diff shows exactly one real functional difference (Assay).
ALTER TABLE offices ADD COLUMN has_assay_office BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE jobs ADD COLUMN in_assay BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN assay_office_name TEXT;
ALTER TABLE jobs ADD COLUMN assay_invoice_no TEXT;
ALTER TABLE jobs ADD COLUMN assay_date_sent DATE;

-- Drives "Client chase-up due" (Alerts panel) and the manual's quick
-- +3d/+5d/+7d/+14d/+30d note buttons.
ALTER TABLE jobs ADD COLUMN follow_up_date DATE;

ALTER TABLE job_issues ADD COLUMN repairer_name TEXT;
ALTER TABLE job_issues ADD COLUMN amount_given NUMERIC(12,2);
ALTER TABLE job_issues ADD COLUMN date_given DATE;
