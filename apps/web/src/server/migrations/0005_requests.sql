-- Payment requests between Nod wallets: one wallet asks another for an amount (docs: plan Phase 3). Additive only.
-- The request becomes paid when the payment its payer prepared with request_pay confirms (intent_id); the note is the
-- requester's own words, shown as theirs and never put in an event payload.
CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  requester_wallet_id TEXT NOT NULL REFERENCES wallets (id),
  -- The AI app that asked; NULL when the owner asked on the site.
  requester_connection_id TEXT,
  -- Where the money goes: the requester wallet's contract id.
  requester_address TEXT NOT NULL,
  -- Set when the payer's address is a Nod wallet: it gets the request in its inbox.
  payer_wallet_id TEXT REFERENCES wallets (id),
  payer_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'declined')),
  intent_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requester_wallet_id, requester_connection_id, idempotency_key)
);
CREATE INDEX payment_requests_by_payer ON payment_requests (payer_wallet_id, created_at);
CREATE INDEX payment_requests_by_requester ON payment_requests (requester_wallet_id, created_at);
CREATE INDEX payment_requests_by_intent ON payment_requests (intent_id);
