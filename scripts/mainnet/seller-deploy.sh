#!/usr/bin/env bash
# M4: deploy hm26-seller-mainnet (apps/seller with wrangler.mainnet.jsonc) once PAY_TO and the OpenZeppelin Channels
# mainnet key are in place. A deploy is real: run it only on Kristjan's "go M4" with HM26_MAINNET_GO=yes.
#
#   scripts/mainnet/seller-deploy.sh --dry-run                    checks + `wrangler deploy --dry-run` (nothing uploaded)
#   HM26_MAINNET_GO=yes scripts/mainnet/seller-deploy.sh [--write-web-env] [--verify-only]
#     --verify-only   skip the wrangler deploy: steps 1, 2, 4 and 5 against the deployed Worker
#
# 1. PAY_TO in apps/seller/wrangler.mainnet.jsonc must be the seller key in scripts/demo/.env.pubnet and hold a USDC
#    trustline on mainnet (`bun scripts/mainnet/seed.ts --network pubnet --only trustlines` creates it).
# 2. The OZ key: apps/seller/.dev.vars.mainnet holds OZ_FACILITATOR_KEY. When it is missing, the go run mints one with
#    `bun scripts/demo/oz-key.ts --network pubnet` (GET https://channels.openzeppelin.com/gen). Manual fallback: open
#    that URL in a browser (sign in with GitHub if it asks), then append `OZ_FACILITATOR_KEY=<key>` to the file and
#    `chmod 600` it. Either way the key must answer /x402/supported with stellar:pubnet and areFeesSponsored: true.
# 3. wrangler deploy -c wrangler.mainnet.jsonc --secrets-file .dev.vars.mainnet
# 4. Verify: /health reports stellar:pubnet and PAY_TO; GET /api/market-brief answers 402 for 0.10 USDC to PAY_TO.
# 5. --write-web-env copies the same key into apps/web/.env.mainnet's OZ_FACILITATOR_KEY line, never printing it.
# Onchain spend: none (the first payment is scripts/mainnet/smoke-pay.ts). Secrets never reach argv or stdout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELLER="$ROOT/apps/seller"
VARS="$SELLER/.dev.vars.mainnet"
CONFIG="$SELLER/wrangler.mainnet.jsonc"
URL="https://hm26-seller-mainnet.kristjan-grm11775.workers.dev"
OZ="https://channels.openzeppelin.com/x402"
SAC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
DRY=0
WRITE_WEB=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --write-web-env) WRITE_WEB=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "M4 seller deploy (pubnet$([ $DRY = 1 ] && echo ', DRY RUN: nothing is uploaded'))"
echo "  - deploy Worker hm26-seller-mainnet to $URL: 0 XLM onchain (Cloudflare only)"
echo "  - OZ Channels key: free (GET /gen), fee sponsorship on OpenZeppelin's side"
if [ $DRY = 0 ] && [ "${HM26_MAINNET_GO:-}" != "yes" ]; then
  echo "refusing: mainnet deploy. Run with --dry-run, or HM26_MAINNET_GO=yes on Kristjan's go." >&2
  exit 2
fi

# 1. PAY_TO = the seller key, with a USDC trustline
PAY_TO="$(sed -nE 's/^[[:space:]]*"PAY_TO":[[:space:]]*"([^"]+)".*/\1/p' "$CONFIG")"
[[ "$PAY_TO" =~ ^G[A-Z2-7]{55}$ ]] || fail "PAY_TO in $CONFIG is not a G account: $PAY_TO"
STATE="$(cd "$ROOT" && bun -e "
import { accountState, publicKey } from './scripts/mainnet/lib.ts'
const s = await accountState(publicKey('seller'))
console.log(s.address, s.exists ? 'funded' : 'unfunded', s.usdc === null ? 'no-trustline' : 'trustline')")"
read -r KEY_PUB FUNDED TRUST <<<"$STATE"
[ "$KEY_PUB" = "$PAY_TO" ] || fail "PAY_TO $PAY_TO is not the seller key $KEY_PUB in scripts/demo/.env.pubnet"
echo "  PAY_TO $PAY_TO = seller key; $FUNDED, $TRUST"
if [ "$TRUST" != "trustline" ]; then
  [ $DRY = 1 ] && echo "  (dry run) the go run stops here until seed.ts --only trustlines has run" \
    || fail "PAY_TO has no USDC trustline yet: bun scripts/mainnet/seed.ts --network pubnet --only trustlines"
fi

# 2. the OpenZeppelin Channels mainnet key
if ! grep -qE '^OZ_FACILITATOR_KEY=.+' "$VARS" 2>/dev/null; then
  if [ $DRY = 1 ]; then echo "  (dry run) no OZ key in $VARS; the go run mints one with scripts/demo/oz-key.ts"
  else (cd "$ROOT" && bun scripts/demo/oz-key.ts --network pubnet); chmod 600 "$VARS"; fi
fi
if grep -qE '^OZ_FACILITATOR_KEY=.+' "$VARS" 2>/dev/null; then
  [ "$(stat -c %a "$VARS")" = 600 ] || fail "$VARS must be mode 600"
  printf 'Authorization: Bearer %s\n' "$(sed -n 's/^OZ_FACILITATOR_KEY=//p' "$VARS" | tail -1)" >"$TMP/auth"
  CODE="$(curl -s -m 20 -o "$TMP/supported.json" -w '%{http_code}' -H @"$TMP/auth" "$OZ/supported")"
  rm -f "$TMP/auth"
  OK="$(jq -r '[.kinds[]? | select(.network == "stellar:pubnet" and .extra.areFeesSponsored == true)] | length' "$TMP/supported.json" 2>/dev/null || echo 0)"
  [ "$CODE" = 200 ] && [ "$OK" -ge 1 ] || fail "OZ key: /supported → $CODE without stellar:pubnet + areFeesSponsored"
  echo "  OZ key in $VARS answers /supported 200: stellar:pubnet, fees sponsored"
fi

# 3. deploy (or bundle only)
cd "$SELLER"
if [ $DRY = 1 ]; then
  ./node_modules/.bin/wrangler deploy -c wrangler.mainnet.jsonc --dry-run --outdir "$TMP/bundle" 2>&1 | tail -12
  echo "  dry run done: bundled to a temp dir, nothing uploaded"
  exit 0
fi
[ $VERIFY_ONLY = 1 ] || ./node_modules/.bin/wrangler deploy -c wrangler.mainnet.jsonc --secrets-file .dev.vars.mainnet

# 4. verify (a new workers.dev hostname can take a minute to answer)
HEALTH=""
for _ in $(seq 1 20); do
  HEALTH="$(curl -s -m 20 "$URL/health")"
  jq -e .network <<<"$HEALTH" >/dev/null 2>&1 && break
  sleep 5
done
[ "$(jq -r .network <<<"$HEALTH")" = "stellar:pubnet" ] || fail "/health network: $(jq -c .network <<<"$HEALTH")"
[ "$(jq -r .pay_to <<<"$HEALTH")" = "$PAY_TO" ] || fail "/health pay_to is not $PAY_TO"
CODE="$(curl -s -m 20 -D "$TMP/headers" -o /dev/null -w '%{http_code}' "$URL/api/market-brief")"
[ "$CODE" = 402 ] || fail "GET /api/market-brief → $CODE, expected 402"
sed -n 's/^payment-required: //Ip' "$TMP/headers" | tr -d '\r' | base64 -d >"$TMP/required.json"
jq -e --arg pay "$PAY_TO" --arg sac "$SAC" \
  '.accepts[0] | .network == "stellar:pubnet" and .payTo == $pay and .asset == $sac and .amount == "1000000"' \
  "$TMP/required.json" >/dev/null || fail "402 terms: $(jq -c '.accepts[0]' "$TMP/required.json")"
echo "  verified: $URL/health on stellar:pubnet, 402 for 0.10 USDC to $PAY_TO"

# 5. the same key for the mainnet stage's Worker
if [ $WRITE_WEB = 1 ]; then
  (cd "$ROOT" && bun -e "
import { readFileSync } from 'node:fs'
import { FILES, readEnvFile, setEnvLine } from './scripts/mainnet/lib.ts'
const key = readEnvFile(FILES.sellerVars)['OZ_FACILITATOR_KEY'] ?? ''
if (key === '') throw new Error('no key')
setEnvLine(FILES.web, 'OZ_FACILITATOR_KEY', key)
console.log('  set OZ_FACILITATOR_KEY in apps/web/.env.mainnet (' + key.length + ' chars)')")
fi
echo "next: HM26_MAINNET_GO=yes bun scripts/mainnet/smoke-pay.ts"
