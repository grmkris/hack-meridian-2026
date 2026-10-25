-- Claim link v2 (K2, 2026-10-25 18:05): "1 USDC for Jan" as an intent without a destination. Whoever opens the link
-- chooses where the money goes (a new Nod wallet, their Nod wallet, or a Stellar address); only then does Nod create
-- the payment intent, which takes the normal lanes (inside the allowance the AI app's key pays alone, otherwise the
-- sender's nod). Nod never holds the money: an unclaimed link pays nothing and just expires. Additive.
--   status: open (no destination yet), claimed (destination set; intent_id is the payment), expired is read from
--   expires_at. scope + idempotency_key: payment_prepare's idempotency (one link per key).
--   destination_kind: new_wallet, wallet (an existing Nod wallet, signed in), address (pasted; CAP-73 when it has no
--   USDC trustline).
CREATE TABLE claim_links (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  connection_id TEXT,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  requester TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  reason TEXT,
  amount TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL,
  destination_kind TEXT,
  destination_address TEXT,
  destination_wallet_id TEXT,
  intent_id TEXT,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (wallet_id, scope, idempotency_key)
);
CREATE INDEX claim_links_by_wallet ON claim_links (wallet_id, created_at);
