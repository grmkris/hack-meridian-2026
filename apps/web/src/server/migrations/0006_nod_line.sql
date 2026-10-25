-- W1, the nod line (docs/SPEC.md, decisions 2026-10-25 17:10 UTC): per allowance, inside the allowance an amount below
-- the line goes alone and an amount at or above it needs the owner's nod. Stroops as TEXT; the default 1.00 USDC also
-- applies to allowances installed before this column existed. Additive only.
ALTER TABLE spending_grants ADD COLUMN nod_above TEXT NOT NULL DEFAULT '10000000';
ALTER TABLE pending_grants ADD COLUMN nod_above TEXT NOT NULL DEFAULT '10000000';
-- Why an intent waits for the owner (above_nod_line, over_allowance, …); NULL in the autonomous lane and on older rows.
ALTER TABLE payment_intents ADD COLUMN approval_reason TEXT;
