#![no_std]
//! A counter anyone can increment for themselves: the baseline's example of authorization, instance storage with a
//! kept-alive TTL, a typed error and a contract event. Replace it with the project's own contract.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env,
};

/// A ledger closes about every five seconds.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Instance storage lives thirty days past its last write, topped up once it falls below twenty-nine.
const INSTANCE_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_EXTEND_TO - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Count,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Overflow = 1,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Incremented {
    #[topic]
    pub by: Address,
    pub count: u32,
}

#[contract]
pub struct Counter;

#[contractimpl]
impl Counter {
    /// The current count; zero before the first increment.
    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// Adds one on behalf of `by`, who must authorize the call, and returns the new count.
    pub fn increment(env: Env, by: Address) -> Result<u32, Error> {
        by.require_auth();
        let count = Self::count(env.clone())
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        let storage = env.storage().instance();
        storage.set(&DataKey::Count, &count);
        storage.extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND_TO);
        Incremented { by, count }.publish(&env);
        Ok(count)
    }
}

mod test;
