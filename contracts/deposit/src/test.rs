extern crate std;
use std::rc::Rc;

use soroban_sdk::{
    events::Event,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _},
    token, vec, xdr, Address, Env, IntoVal, Symbol, TryFromVal,
};

use crate::{Deposit, DepositRouter, DepositRouterClient, Error, Registered, Swept};

const USDC: i128 = 10_000_000;

/// A classic `G…` account entry (master weight 1, no trustlines), the way the relayer creates a deposit address.
fn classic_account(env: &Env, seed: u8) -> Address {
    let pk = [seed; 32];
    let account_id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(pk)));
    let key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: account_id.clone(),
    }));
    let entry = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id,
            balance: 0,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 0,
            seq_num: xdr::SequenceNumber(1),
            thresholds: xdr::Thresholds([1, 0, 0, 0]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&key, &entry, None).unwrap();
    Address::try_from_val(
        env,
        &xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
            xdr::Uint256(pk),
        ))),
    )
    .unwrap()
}

struct Setup {
    env: Env,
    usdc: Address,
    router: DepositRouterClient<'static>,
    /// The deposit address: a classic account with a USDC trustline.
    g: Address,
    /// The owner's smart account (a contract address needs no trustline).
    c: Address,
}

impl Setup {
    fn token(&self) -> token::TokenClient<'static> {
        token::TokenClient::new(&self.env, &self.usdc)
    }

    /// An exchange (or anyone) pays `amount` to the deposit address.
    fn pay_g(&self, amount: i128) {
        self.env.mock_all_auths();
        token::StellarAssetClient::new(&self.env, &self.usdc).mint(&self.g, &amount);
        self.env.set_auths(&[]);
    }

    fn register(&self) -> u32 {
        self.env.mock_all_auths();
        let until = self.router.register(&self.g, &self.c);
        self.env.set_auths(&[]);
        until
    }
}

fn setup() -> Setup {
    let env = Env::default();
    let issuer = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(issuer).address();
    let router = DepositRouterClient::new(&env, &env.register(DepositRouter, (&usdc,)));
    let g = classic_account(&env, 7);
    let c = Address::generate(&env);
    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &usdc).trust(&g);
    env.set_auths(&[]);
    Setup {
        env,
        usdc,
        router,
        g,
        c,
    }
}

#[test]
fn register_binds_g_and_approves_the_router_under_one_authorization_from_g() {
    let s = setup();
    s.env.ledger().set_sequence_number(1_000);
    let expected_until = 1_000
        + s.env
            .as_contract(&s.router.address, || s.env.storage().max_ttl());

    s.env.mock_all_auths();
    let until = s.router.register(&s.g, &s.c);
    assert_eq!(until, expected_until);

    // G authorized exactly register(g, c) with approve(g, router, MAX, until) beneath it; nobody else signed.
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.g.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.router.address.clone(),
                    Symbol::new(&s.env, "register"),
                    vec![&s.env, s.g.into_val(&s.env), s.c.into_val(&s.env)],
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        s.usdc.clone(),
                        Symbol::new(&s.env, "approve"),
                        vec![
                            &s.env,
                            s.g.into_val(&s.env),
                            s.router.address.into_val(&s.env),
                            i128::MAX.into_val(&s.env),
                            until.into_val(&s.env),
                        ],
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.router.address),
        [Registered {
            deposit: s.g.clone(),
            recipient: s.c.clone(),
            expiration_ledger: until,
        }
        .to_xdr(&s.env, &s.router.address)]
    );
    assert_eq!(s.token().allowance(&s.g, &s.router.address), i128::MAX);
    assert_eq!(
        s.router.deposit(&s.g),
        Some(Deposit {
            recipient: s.c.clone(),
            expiration_ledger: until,
        })
    );
    assert_eq!(s.router.token(), s.usdc);
}

#[test]
fn register_without_the_deposit_address_authorization_fails() {
    let s = setup();
    assert!(s.router.try_register(&s.g, &s.c).is_err());
    assert_eq!(s.router.deposit(&s.g), None);
    assert_eq!(s.token().allowance(&s.g, &s.router.address), 0);
}

#[test]
fn register_refuses_binding_an_address_to_itself() {
    let s = setup();
    s.env.mock_all_auths();
    assert_eq!(
        s.router.try_register(&s.g, &s.g),
        Err(Ok(Error::SameAddress))
    );
}

#[test]
fn a_second_registration_of_the_same_g_is_refused_even_when_g_signs_it() {
    let s = setup();
    s.register();
    let attacker = Address::generate(&s.env);
    s.env.mock_all_auths();
    assert_eq!(
        s.router.try_register(&s.g, &attacker),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(
        s.router.try_register(&s.g, &s.c),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(
        s.router.deposit(&s.g).map(|d| d.recipient),
        Some(s.c.clone())
    );
}

#[test]
fn anyone_sweeps_with_no_authorization_and_the_funds_reach_only_the_recipient() {
    let s = setup();
    s.register();
    s.pay_g(25 * USDC);

    // No auths at all: the router is the spender and the SAC's direct caller.
    let swept = s.router.sweep(&s.g);
    assert_eq!(swept, 25 * USDC);
    assert_eq!(s.env.auths(), std::vec![]);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.router.address),
        [Swept {
            deposit: s.g.clone(),
            recipient: s.c.clone(),
            amount: 25 * USDC,
        }
        .to_xdr(&s.env, &s.router.address)]
    );
    assert_eq!(s.token().balance(&s.c), 25 * USDC);
    assert_eq!(s.token().balance(&s.g), 0);
}

#[test]
fn repeated_deposits_accumulate_in_the_recipient() {
    let s = setup();
    s.register();
    s.pay_g(5 * USDC);
    assert_eq!(s.router.sweep(&s.g), 5 * USDC);
    s.pay_g(7 * USDC);
    s.pay_g(USDC);
    assert_eq!(s.router.sweep(&s.g), 8 * USDC);
    assert_eq!(s.token().balance(&s.c), 13 * USDC);
}

#[test]
fn a_g_that_kept_its_key_is_still_only_sweepable_to_its_recipient() {
    // The master weight is never set to 0 here: G could sign anything, and every party's auth is mocked.
    let s = setup();
    s.register();
    s.pay_g(10 * USDC);
    let attacker = Address::generate(&s.env);
    s.env.mock_all_auths();
    assert_eq!(
        s.router.try_register(&s.g, &attacker),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(s.router.sweep(&s.g), 10 * USDC);
    assert_eq!(s.token().balance(&s.c), 10 * USDC);
    assert_eq!(s.token().balance(&attacker), 0);
}

#[test]
fn sweep_takes_the_smaller_of_balance_and_allowance() {
    let s = setup();
    s.register();
    s.pay_g(10 * USDC);
    // G (key still live in this test) lowers the allowance to 3 USDC.
    let until = s.router.deposit(&s.g).unwrap().expiration_ledger;
    s.env.mock_all_auths();
    s.token()
        .approve(&s.g, &s.router.address, &(3 * USDC), &until);
    s.env.set_auths(&[]);
    assert_eq!(s.router.sweep(&s.g), 3 * USDC);
    assert_eq!(s.router.try_sweep(&s.g), Err(Ok(Error::NothingToSweep)));
    assert_eq!(s.token().balance(&s.g), 7 * USDC);
    assert_eq!(s.token().balance(&s.c), 3 * USDC);
}

#[test]
fn sweep_with_nothing_approved_fails_and_moves_nothing() {
    let s = setup();
    s.register();
    s.pay_g(10 * USDC);
    s.env.mock_all_auths();
    s.token().approve(&s.g, &s.router.address, &0, &0);
    s.env.set_auths(&[]);
    assert_eq!(s.router.try_sweep(&s.g), Err(Ok(Error::NothingToSweep)));
    assert_eq!(s.token().balance(&s.g), 10 * USDC);
    assert_eq!(s.token().balance(&s.c), 0);
}

#[test]
fn sweep_of_an_empty_deposit_address_fails() {
    let s = setup();
    s.register();
    assert_eq!(s.router.try_sweep(&s.g), Err(Ok(Error::NothingToSweep)));
}

#[test]
fn sweep_of_a_g_without_a_trustline_reads_as_nothing_to_sweep() {
    let s = setup();
    let bare = classic_account(&s.env, 9);
    s.env.mock_all_auths();
    s.router.register(&bare, &s.c);
    s.env.set_auths(&[]);
    assert_eq!(s.router.try_sweep(&bare), Err(Ok(Error::NothingToSweep)));
}

#[test]
fn sweep_of_an_unregistered_address_fails() {
    let s = setup();
    s.pay_g(USDC);
    assert_eq!(s.router.try_sweep(&s.g), Err(Ok(Error::NotRegistered)));
    assert_eq!(s.token().balance(&s.g), USDC);
}

#[test]
fn the_allowance_is_live_through_its_expiration_ledger() {
    let s = setup();
    let until = s.register();
    s.pay_g(2 * USDC);
    s.env.ledger().set_sequence_number(until);
    assert_eq!(s.router.sweep(&s.g), 2 * USDC);
}
