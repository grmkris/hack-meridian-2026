extern crate std;
use std::rc::Rc;

use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke},
    token, vec, xdr, Address, Env, IntoVal, Symbol, TryFromVal,
};

use crate::{Onboard, OnboardClient};

/// A classic G-account ledger entry with no trustlines, the way friendbot leaves it.
fn classic_account(env: &Env) -> Address {
    let pk = [7u8; 32];
    let account_id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(pk)));
    let key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount { account_id: account_id.clone() }));
    let entry = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id,
            balance: 10_000 * 10_000_000,
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
    Address::try_from_val(env, &xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
        xdr::Uint256(pk),
    ))))
    .unwrap()
}

struct Setup {
    env: Env,
    usdc: Address,
    router: OnboardClient<'static>,
    sender: Address,
    recipient: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    let admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let sender = Address::generate(&env); // C-address: needs no trustline
    let recipient = classic_account(&env);
    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &usdc).mint(&sender, &100_000_000);
    env.set_auths(&[]);
    let router = OnboardClient::new(&env, &env.register(Onboard, ()));
    Setup { env, usdc, router, sender, recipient }
}

#[test]
fn recipient_without_trustline_reads_as_error() {
    let s = setup();
    let usdc = token::TokenClient::new(&s.env, &s.usdc);
    assert!(usdc.try_balance(&s.recipient).is_err());
}

fn transfer_invoke<'a>(s: &'a Setup, args: &'a soroban_sdk::Vec<soroban_sdk::Val>) -> MockAuthInvoke<'a> {
    MockAuthInvoke { contract: &s.usdc, fn_name: "transfer", args: args.clone(), sub_invokes: &[] }
}

#[test]
fn default_recording_auth_rejects_non_root_trust_auth() {
    // What a default `simulateTransaction` (authMode "record") does: the recipient's require_auth happens inside the
    // SAC, below the router, so recording refuses it. RPC simulation must use authMode "record_allow_nonroot".
    let s = setup();
    let err = s.router.mock_all_auths().try_pay_and_trust(&s.sender, &s.recipient, &s.usdc, &20_000_000);
    std::println!("default recording: {err:?}");
    assert!(err.is_err());
}

#[test]
fn trust_and_transfer_in_one_invocation_with_two_narrow_auths() {
    let s = setup();
    let (env, usdc, sender, recipient) = (&s.env, &s.usdc, &s.sender, &s.recipient);
    s.router.mock_all_auths_allowing_non_root_auth().pay_and_trust(sender, recipient, usdc, &20_000_000);

    // Each party authorized exactly one SAC call, rooted at the SAC (not at the router).
    let auths = env.auths();
    std::println!("{auths:#?}");
    assert_eq!(auths.len(), 2);
    assert_eq!(
        auths[0],
        (
            recipient.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    usdc.clone(),
                    Symbol::new(env, "trust"),
                    vec![env, recipient.into_val(env)]
                )),
                sub_invocations: std::vec![],
            }
        )
    );
    assert_eq!(
        auths[1],
        (
            sender.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    usdc.clone(),
                    Symbol::new(env, "transfer"),
                    vec![env, sender.into_val(env), recipient.into_val(env), 20_000_000i128.into_val(env)]
                )),
                sub_invocations: std::vec![],
            }
        )
    );
    let t = token::TokenClient::new(env, usdc);
    assert_eq!(t.balance(recipient), 20_000_000);
    assert_eq!(t.balance(sender), 80_000_000);
}

#[test]
fn without_recipient_auth_the_whole_invocation_fails() {
    // Enforcing mode with only the sender's transfer authorized: trust(recipient) has no auth, nothing moves.
    let s = setup();
    let args = (&s.sender, &s.recipient, 20_000_000i128).into_val(&s.env);
    let invoke = transfer_invoke(&s, &args);
    let err = s.router.mock_auths(&[MockAuth { address: &s.sender, invoke: &invoke }]).try_pay_and_trust(
        &s.sender,
        &s.recipient,
        &s.usdc,
        &20_000_000,
    );
    std::println!("without recipient auth: {err:?}");
    assert!(err.is_err());
    let t = token::TokenClient::new(&s.env, &s.usdc);
    assert!(t.try_balance(&s.recipient).is_err());
    assert_eq!(t.balance(&s.sender), 100_000_000);
}

#[test]
fn existing_trustline_makes_trust_a_no_op_that_needs_no_recipient_auth() {
    let s = setup();
    s.router.mock_all_auths_allowing_non_root_auth().pay_and_trust(&s.sender, &s.recipient, &s.usdc, &20_000_000);
    // Second payment, enforcing mode, sender's entry only.
    let args = (&s.sender, &s.recipient, 10_000_000i128).into_val(&s.env);
    let invoke = transfer_invoke(&s, &args);
    s.router.mock_auths(&[MockAuth { address: &s.sender, invoke: &invoke }]).pay_and_trust(
        &s.sender,
        &s.recipient,
        &s.usdc,
        &10_000_000,
    );
    assert_eq!(s.env.auths().len(), 1);
    assert_eq!(token::TokenClient::new(&s.env, &s.usdc).balance(&s.recipient), 30_000_000);
}
