-- Per-job public tracking link (like a courier tracking number) so a client
-- can check their order's status without an account. Generated on demand
-- per job rather than backfilled — most of the ~2800 historical jobs will
-- never need one, and an unset token means the feature was never turned on
-- for that job, not that something is missing.
ALTER TABLE jobs ADD COLUMN public_tracking_token TEXT UNIQUE;
