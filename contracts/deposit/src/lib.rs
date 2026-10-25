//! Deposit addresses for passkey wallets: anyone can send the pinned asset to a classic `G…` and it can only ever land
//! in the one smart account `C…` that `G` was bound to.
//!
//! The design is Nido's (nidohq/nido#165): a sponsored zero-balance `G` grants an allowance, its master weight goes to
//! 0, its key is discarded, and a permissionless, bounded sweep pulls whatever arrives with `transfer_from`. Nido puts
//! the bound in a signer-less policy on the smart account (spender = `C`). Here the spender is this contract instead,
//! because installing a context rule on our OpenZeppelin account needs the owner's passkey (`add_context_rule` calls
//! the account's own `require_auth`) and the service creates deposit addresses without one. See
//! `docs/spikes/s8-deposit.md`.
//!
//! - `register(g, c, expiration_ledger)` needs `g`'s authorization. It binds `g` to `c` once (a second registration of
//!   the same `g` is refused forever) and, inside the same authorization, has the asset contract record
//!   `approve(g, this, i128::MAX, expiration_ledger)`. The caller passes the ledger (the service uses
//!   `max_expiration_ledger()` minus a small margin: the longest allowance the network accepts) because what `g` signs
//!   must not depend on the ledger the transaction lands in.
//! - `sweep(g)` needs nobody's authorization: this contract is the spender, so the asset contract accepts it as the
//!   direct caller. It moves `min(balance(g), allowance(g, this))` to the recorded `c` and nowhere else.
//!
//! There is no admin, no upgrade and no setter: the asset is fixed by the constructor and a binding never changes.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
};

/// A ledger closes about every five seconds.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Instance storage (the pinned asset) lives thirty days past its last use, topped up once below twenty-nine.
const INSTANCE_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_EXTEND_TO - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The one asset contract (a SAC) this router pulls from. Instance storage, set by the constructor.
    Token,
    /// `g → Deposit`, persistent: written once by `register`.
    Deposit(Address),
}

/// What a deposit address is bound to.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    /// The smart account every sweep pays.
    pub recipient: Address,
    /// The last ledger of the allowance granted at registration (inclusive).
    pub expiration_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `g` is already bound; bindings are immutable.
    AlreadyRegistered = 1,
    /// `g` was never registered here.
    NotRegistered = 2,
    /// The deposit address and the recipient are the same address.
    SameAddress = 3,
    /// `g` holds nothing this router may move (no balance, no trustline, or no allowance left).
    NothingToSweep = 4,
    /// The expiration ledger is not after the current ledger.
    ExpirationInPast = 5,
}

/// `g` is now a deposit address for `recipient`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Registered {
    #[topic]
    pub deposit: Address,
    #[topic]
    pub recipient: Address,
    pub expiration_ledger: u32,
}

/// `amount` moved from the deposit address to its recipient.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swept {
    #[topic]
    pub deposit: Address,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contract]
pub struct DepositRouter;

fn token_of(env: &Env) -> Address {
    let storage = env.storage().instance();
    storage.extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND_TO);
    // SAFETY: the constructor always sets the token and nothing removes it.
    storage.get(&DataKey::Token).unwrap()
}

#[contractimpl]
impl DepositRouter {
    /// Pins the asset contract for the life of this router.
    pub fn __constructor(env: Env, token: Address) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Token, &token);
        storage.extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND_TO);
    }

    /// The pinned asset contract.
    pub fn token(env: Env) -> Address {
        token_of(&env)
    }

    /// The latest ledger an allowance (and a binding) registered now can last through: the network's maximum entry
    /// TTL from the current ledger, ~180 days on testnet and mainnet today.
    pub fn max_expiration_ledger(env: Env) -> u32 {
        env.ledger().sequence() + env.storage().max_ttl()
    }

    /// What `g` is bound to, if it is a deposit address here.
    pub fn deposit(env: Env, g: Address) -> Option<Deposit> {
        env.storage().persistent().get(&DataKey::Deposit(g))
    }

    /// Binds `g` to `recipient` and, under the same authorization from `g`, approves this router for `g`'s whole
    /// balance through `expiration_ledger` (at most `max_expiration_ledger()` when the transaction applies). Returns it.
    pub fn register(
        env: Env,
        g: Address,
        recipient: Address,
        expiration_ledger: u32,
    ) -> Result<u32, Error> {
        g.require_auth();
        if g == recipient {
            return Err(Error::SameAddress);
        }
        let now = env.ledger().sequence();
        if expiration_ledger <= now {
            return Err(Error::ExpirationInPast);
        }
        let key = DataKey::Deposit(g.clone());
        let storage = env.storage().persistent();
        if storage.has(&key) {
            return Err(Error::AlreadyRegistered);
        }
        // The asset contract refuses an expiration past the network's maximum, so `ttl` is within the maximum too.
        token::TokenClient::new(&env, &token_of(&env)).approve(
            &g,
            &env.current_contract_address(),
            &i128::MAX,
            &expiration_ledger,
        );
        storage.set(
            &key,
            &Deposit {
                recipient: recipient.clone(),
                expiration_ledger,
            },
        );
        let ttl = expiration_ledger - now;
        storage.extend_ttl(&key, ttl, ttl);
        Registered {
            deposit: g,
            recipient,
            expiration_ledger,
        }
        .publish(&env);
        Ok(expiration_ledger)
    }

    /// Moves everything this router may take from `g` to `g`'s recipient. Anyone may call it. Returns the amount.
    pub fn sweep(env: Env, g: Address) -> Result<i128, Error> {
        let deposit: Deposit = env
            .storage()
            .persistent()
            .get(&DataKey::Deposit(g.clone()))
            .ok_or(Error::NotRegistered)?;
        let token = token::TokenClient::new(&env, &token_of(&env));
        let router = env.current_contract_address();
        // A classic account without a trustline has no balance entry: the asset contract errors, which means zero.
        let balance = match token.try_balance(&g) {
            Ok(Ok(b)) => b,
            _ => 0,
        };
        let amount = balance.min(token.allowance(&g, &router));
        if amount <= 0 {
            return Err(Error::NothingToSweep);
        }
        token.transfer_from(&router, &g, &deposit.recipient, &amount);
        Swept {
            deposit: g,
            recipient: deposit.recipient,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }
}

#[cfg(test)]
mod test;
