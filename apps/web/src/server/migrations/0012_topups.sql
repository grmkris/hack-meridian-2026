-- Top-ups from another chain through NEAR Intents' 1Click API (topup.ts, docs/NEAR-INTENTS.md Flow A). 1Click pays out
-- on Stellar to the wallet's deposit address (a G… bound to the wallet's C…), and the deposit router sweeps it in. One
-- row per quote. Additive.
--   status: pending (waiting for the deposit on the origin chain), processing (1Click saw it and is swapping),
--   arrived (the sweep landed in the wallet: sweep_tx, arrived_amount), failed (1Click refunded or failed), expired
--   (the deadline passed with no deposit). oneclick_status: 1Click's own word for it.
--   swept_baseline: the deposit address's swept_total when quoted; the top-up has arrived once it grew past it.
CREATE TABLE topups (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  connection_id TEXT,
  idempotency_key TEXT,
  origin_chain TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  refund_to TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL,
  oneclick_status TEXT,
  swept_baseline TEXT NOT NULL,
  sweep_tx TEXT,
  arrived_amount TEXT,
  quote TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (wallet_id, connection_id, idempotency_key)
);
CREATE INDEX topups_by_wallet ON topups (wallet_id, created_at);
