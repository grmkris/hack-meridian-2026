-- Person links (an allowance for a person, person-link.ts): when the sender nods, the link is a rule on the sender's
-- account, not a payment. The sender's browser makes an Ed25519 link key and keeps its secret in the link's fragment;
-- the passkey installs a spending-limit rule for exactly the amount, valid seven days, with that key as its only
-- signer. Whoever opens the link signs the transfer to their own wallet in their browser; Nod relays it and pays the
-- fee. Nod never holds the key or the money. Additive: nullable columns on claim_links (kind NULL = a v2 link, paid
-- from an AI app's allowance).
--   kind: person. status (claims.ts) gains awaiting_nod (before the sender's passkey) and revoked.
--   signer_public_key: the link key's public half, base64url. rule_id, valid_until_ledger, install_tx: the rule.
--   pending_grant_id: the prepared install (pending_grants) between the page's two POSTs.
--   transfer_prepared: the prepared transfer the recipient's browser signs (PreparedLinkTransfer JSON, no secret).
--   claim_tx: the transfer; remove_tx, revoked_at: the sender removed the rule before anyone claimed it.
ALTER TABLE claim_links ADD COLUMN kind TEXT;
ALTER TABLE claim_links ADD COLUMN signer_public_key TEXT;
ALTER TABLE claim_links ADD COLUMN rule_id INTEGER;
ALTER TABLE claim_links ADD COLUMN valid_until_ledger INTEGER;
ALTER TABLE claim_links ADD COLUMN install_tx TEXT;
ALTER TABLE claim_links ADD COLUMN pending_grant_id TEXT;
ALTER TABLE claim_links ADD COLUMN transfer_prepared TEXT;
ALTER TABLE claim_links ADD COLUMN claim_tx TEXT;
ALTER TABLE claim_links ADD COLUMN remove_tx TEXT;
ALTER TABLE claim_links ADD COLUMN revoked_at TEXT;
