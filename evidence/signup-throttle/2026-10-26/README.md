# Wallet signup throttling disabled

The owner requested removal of the hourly wallet signup limit and immediate production deployment.
Release `a663158f28a4855256c67b3a81ff4e5f0c18629b` is live on testnet and production and pushed to main.

The old production defaults allowed 3 wallets per hashed IP address per hour and 30 globally. The same
check ran before registration options and before account creation. The new `WALLET_CREATE_LIMITS_ENABLED`
binding is false on all stages, also the code default. Both paths bypass the cap store entirely while
it is disabled, so previously exhausted counters cannot block signup. Limits remain available only by
explicitly enabling the setting; they were not merely raised to a larger number.

The regression was reproduced with the real API handlers and a fixture chain: an exhausted cap store
returned 429 before the fix. With the fix, four consecutive registrations from the same visitor return
200 and make zero cap-store calls, with both omitted and false settings. Explicit true still enforces
the stored decision. Both required full checks completed with exit 0: lint, typecheck, 379 TypeScript
tests, 24 Rust tests, generated artifacts and build. Existing live tests remained skipped.

Plans changed only the Worker, release binding and new disabled cap flag. Both deployments exited 0;
Durable Object class deletion, rename, transfer and creation lists are empty. Testnet HTTP smoke passed
9/9. Production verification was limited to deployment completion and health readback, per the owner's
request to finish without more tests. No real wallet or payment was created for verification.

Both live health endpoints report the exact release and expected networks. Production deployment
completed at 04:31 UTC on 26 October 2026. Logs and live readback are adjacent. Application source is
unchanged by this evidence commit.
