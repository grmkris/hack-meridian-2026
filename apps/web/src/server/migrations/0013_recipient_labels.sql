-- Recipient memory (2026-10-26). Additive.
--   recipient_labels: the name the user gave a raw Stellar address (payment_prepare with recipient_name and an
--   address no contact holds). Written at prepare with first_paid_at NULL; the ledger sets first_paid_at when the
--   payment confirms, and then, if no contact of the owner holds the address, saves one (contact_destinations.source
--   'paid', added_by the AI app). Only paid labels resolve a name (after contacts); a contact the owner removes later
--   is not saved again, because the label is no longer unpaid.
CREATE TABLE recipient_labels (
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  address TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'paid',
  first_paid_at TEXT,
  PRIMARY KEY (wallet_id, address)
);
CREATE INDEX recipient_labels_by_label ON recipient_labels (wallet_id, label);
