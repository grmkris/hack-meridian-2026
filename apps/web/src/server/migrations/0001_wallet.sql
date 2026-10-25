-- The eight entities of docs/SPEC.md "Data model", plus owner sessions, WebAuthn challenges and grants awaiting the
-- owner's passkey. Amounts are stroops (7-dp integers) stored as decimal TEXT; times are ISO-8601 UTC TEXT.
-- Writers: rows of payment_intents, payment_reservations, operations, receipts and the counters of spending_grants
-- are written only by the wallet's Durable Object (WalletObject), which serializes them per wallet.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  name TEXT NOT NULL,
  contract_id TEXT NOT NULL UNIQUE,
  passkey_credential_id TEXT NOT NULL UNIQUE,
  passkey_public_key TEXT NOT NULL,
  network TEXT NOT NULL,
  deploy_tx TEXT,
  fund_tx TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX wallets_by_owner ON wallets (owner_id);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  oauth_client_id TEXT NOT NULL,
  oauth_client_name TEXT NOT NULL,
  oauth_client_domain TEXT,
  oauth_grant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX connections_by_wallet ON connections (wallet_id, created_at);

CREATE TABLE spending_grants (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE REFERENCES connections (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  signer_public_key TEXT NOT NULL,
  signer_key_ref TEXT NOT NULL,
  asset TEXT NOT NULL,
  total TEXT NOT NULL,
  spent TEXT NOT NULL,
  reserved TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  valid_until_ledger INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  rule_status TEXT NOT NULL CHECK (rule_status IN ('installed', 'removal_pending', 'removed')),
  pocket_address TEXT,
  -- USDC pulled into the pocket and not yet paid out (already counted in spent); reconciled from chain at each quote.
  pocket_balance TEXT NOT NULL DEFAULT '0',
  first_payment_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  install_tx TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX spending_grants_by_wallet ON spending_grants (wallet_id);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  display_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX contacts_by_owner ON contacts (owner_id, display_name);

CREATE TABLE contact_destinations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  address TEXT NOT NULL,
  network TEXT NOT NULL,
  memo TEXT,
  readiness TEXT NOT NULL,
  verified_at TEXT,
  last_paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX contact_destinations_by_contact ON contact_destinations (contact_id);

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  -- connection id, or 'owner' for intents the owner made on the site: idempotency keys are per caller.
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  -- What the caller asked for, so a reused key with a different request is refused instead of answered.
  request_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'x402_fetch', 'x402_mcp')),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  connection_id TEXT,
  grant_id TEXT,
  requester TEXT NOT NULL,
  reason TEXT,
  contact_id TEXT,
  recipient_name TEXT,
  recipient_address TEXT NOT NULL,
  recipient_readiness TEXT NOT NULL,
  resource TEXT,
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee_ceiling_xlm REAL NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('autonomous', 'owner')),
  status TEXT NOT NULL,
  failure TEXT,
  -- The owner-lane invocation prepared when the owner pressed Approve (PreparedOwnerAuth / PreparedClaim JSON).
  approval_prepared TEXT,
  claim_prepared TEXT,
  recipient_signed_entry TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (wallet_id, scope, idempotency_key)
);
CREATE INDEX payment_intents_by_wallet ON payment_intents (wallet_id, status, created_at);

CREATE TABLE payment_reservations (
  intent_id TEXT PRIMARY KEY REFERENCES payment_intents (id),
  grant_id TEXT NOT NULL REFERENCES spending_grants (id),
  amount TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'consumed', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payment_reservations_by_grant ON payment_reservations (grant_id, state);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  intent_id TEXT,
  kind TEXT NOT NULL,
  tx_hash TEXT,
  submitted_at TEXT,
  ledger INTEGER,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed', 'unknown')),
  raw_result TEXT
);
CREATE INDEX operations_by_intent ON operations (intent_id);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  connection_id TEXT,
  kind TEXT NOT NULL,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  fee_stroops TEXT NOT NULL,
  fee_paid_by TEXT NOT NULL,
  fee_payer TEXT NOT NULL,
  recipient_name TEXT,
  recipient_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  explorer_url TEXT NOT NULL,
  pull_tx_hash TEXT,
  pull_explorer_url TEXT,
  requester TEXT NOT NULL,
  lane TEXT NOT NULL,
  resource TEXT
);
CREATE INDEX receipts_by_wallet ON receipts (wallet_id, confirmed_at);

CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE pending_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  signer_public_key TEXT NOT NULL,
  signer_key_ref TEXT NOT NULL,
  total TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  lifetime_seconds INTEGER NOT NULL,
  prepared TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Results of the idempotent tools that do not freeze a payment intent (connection_grant_create / _revoke).
CREATE TABLE tool_results (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);
