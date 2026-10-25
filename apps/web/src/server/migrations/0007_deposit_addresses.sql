-- Deposit addresses (docs/spikes/s8-deposit.md, after nidohq/nido#165): one sponsored classic G per wallet, bound by
-- the deposit router (contracts/deposit) to the wallet's smart account, so anyone, an exchange included, can pay USDC
-- to a G… and it can only ever land in the wallet. Additive only.
--   status: creating (claim_token's request is building G), active (G registered and locked), failed (the build
--   stopped; the next request builds a new G). Stroops as TEXT. teardown_xdr can only close G (merge into the relayer
--   once G is empty); it moves no funds.
CREATE TABLE deposit_addresses (
  wallet_id TEXT PRIMARY KEY REFERENCES wallets (id),
  status TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  recipient TEXT NOT NULL,
  address TEXT UNIQUE,
  expiration_ledger INTEGER,
  -- Approximate wall time of expiration_ledger (5 s ledgers from the registration), ISO 8601 UTC.
  expires_at TEXT,
  create_tx TEXT,
  register_tx TEXT,
  lock_tx TEXT,
  teardown_xdr TEXT,
  swept_total TEXT NOT NULL DEFAULT '0',
  last_sweep_tx TEXT,
  last_sweep_at TEXT,
  -- The wallet's Durable Object sweeps every 60 s until this time (24 h after the address was last shown).
  watch_until TEXT,
  created_at TEXT
);
