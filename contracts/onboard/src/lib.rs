//! CAP-73 recipient onboarding in one invocation: pays someone who has never held the asset.
//!
//! `pay_and_trust` creates the recipient's trustline through the Stellar Asset Contract's `trust(addr)` and then moves
//! `amount` from `sender` to `recipient` with the SAC's `transfer`. The router itself requires no auth: the SAC asks the
//! recipient to authorize `trust(recipient)` and the sender to authorize `transfer(sender, recipient, amount)`, so each
//! party signs an auth entry whose root invocation is exactly that one SAC call and nothing else. It keeps no storage,
//! so it has no TTL to extend, and every failure is the SAC's own error.
//!
//! Proven and deployed in `spikes/s3` (`docs/spikes/s3.md`); this source builds to the deployed wasm hash recorded in
//! `deployments/testnet.json`.
#![no_std]
use soroban_sdk::{contract, contractimpl, token, Address, Env};

#[contract]
pub struct Onboard;

#[contractimpl]
impl Onboard {
    pub fn pay_and_trust(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        amount: i128,
    ) {
        // No-op (and no auth) for C-addresses or when the trustline already exists.
        token::StellarAssetClient::new(&env, &token).trust(&recipient);
        token::TokenClient::new(&env, &token).transfer(&sender, &recipient, &amount);
    }
}

#[cfg(test)]
mod test;
