#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _};
use soroban_sdk::{IntoVal, Symbol};

fn setup() -> (Env, CounterClient<'static>) {
    let env = Env::default();
    let id = env.register(Counter, ());
    let client = CounterClient::new(&env, &id);
    (env, client)
}

#[test]
fn starts_at_zero() {
    let (_env, client) = setup();
    assert_eq!(client.count(), 0);
}

#[test]
fn increment_counts_and_is_authorized_by_the_caller() {
    let (env, client) = setup();
    env.mock_all_auths();
    let caller = Address::generate(&env);

    assert_eq!(client.increment(&caller), 1);
    assert_eq!(
        env.auths(),
        std::vec![(
            caller.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    client.address.clone(),
                    Symbol::new(&env, "increment"),
                    (caller.clone(),).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    assert_eq!(client.increment(&caller), 2);
    assert_eq!(client.count(), 2);
}

#[test]
fn increment_without_authorization_is_refused() {
    let (env, client) = setup();
    let caller = Address::generate(&env);

    assert!(client.try_increment(&caller).is_err());
    assert_eq!(client.count(), 0);
}

#[test]
fn increment_publishes_one_event() {
    let (env, client) = setup();
    env.mock_all_auths();
    let caller = Address::generate(&env);

    client.increment(&caller);
    assert_eq!(env.events().all().events().len(), 1);
}
