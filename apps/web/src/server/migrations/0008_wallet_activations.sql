-- Deposit-first signup (K2, 2026-10-25): a wallet whose smart account is planned but not deployed yet. wallets.contract_id
-- is the planned id, the one createCustomContract(deployer, salt) yields, so USDC paid to it, or swept into it from the
-- deposit address, waits there for the deploy. The deploy runs when the first USDC arrives, or when the owner gives an
-- AI app an allowance (the rule install needs the account). A wallet without a row was deployed at signup. Additive.
--   status: awaiting_deposit (nothing deployed), deploying (claim_token's request is deploying), active (deployed,
--   deploy_tx), failed (the deploy stopped; the next attempt takes it over). A deploying claim older than 2 min is stale.
--   trigger: what started the deploy (deposit, allowance, claim).
CREATE TABLE wallet_activations (
  wallet_id TEXT PRIMARY KEY REFERENCES wallets (id),
  status TEXT NOT NULL,
  deployer TEXT NOT NULL,
  salt TEXT NOT NULL,
  claim_token TEXT,
  claimed_at TEXT,
  deploy_tx TEXT,
  trigger TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL
);
