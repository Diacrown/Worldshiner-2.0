-- Supports pulling metal/weight data from a saved Jwy Calculator quote into
-- a job's Production spec (see jwyCalculator.service.js). metal_weight_grams
-- didn't exist at all before — the Calculator tracks casting weight
-- (primaryGramWt) but World Shiner had nowhere to put it.
ALTER TABLE job_production ADD COLUMN metal_weight_grams NUMERIC(10,2);

-- Record of the last successful pull, so the Production tab can show
-- "last synced from quote <ref> on <date>" instead of leaving it ambiguous
-- whether a field was typed by hand or pulled from the Calculator.
ALTER TABLE job_production ADD COLUMN calculator_quote_ref TEXT;
ALTER TABLE job_production ADD COLUMN calculator_synced_at TIMESTAMPTZ;
