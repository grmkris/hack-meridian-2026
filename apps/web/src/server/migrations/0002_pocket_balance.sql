-- USDC pulled into a grant's pocket and not yet paid to a seller (already counted in spent); reconciled from the
-- chain at each x402 quote (docs/spikes/s5.md).
ALTER TABLE spending_grants ADD COLUMN pocket_balance TEXT NOT NULL DEFAULT '0';
