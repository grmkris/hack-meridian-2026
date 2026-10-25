-- The proof of a revoke: the transaction that removed the grant's rule from the smart account, and the one that swept
-- the pocket back. Hashes are public; they link to stellar.expert.
ALTER TABLE spending_grants ADD COLUMN remove_tx TEXT;
ALTER TABLE spending_grants ADD COLUMN sweep_tx TEXT;
