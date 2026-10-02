#!/usr/bin/env bash
# One-time (per environment) runtime-secret setup for the Keyring control plane.
# Usage:
#   RESEND_API_KEY=re_...  STRIPE_SECRET_KEY=sk_live_...  STRIPE_WEBHOOK_SECRET=whsec_... \
#     ./scripts/put-secrets.sh [--env staging]
#
# Reads secret VALUES from the environment (never from argv — argv leaks into
# `ps` and shell history), pipes each into `wrangler secret put`, and prints
# which were set or skipped. Skipping is fine: without STRIPE_SECRET_KEY the
# billing endpoints answer 503; without RESEND_API_KEY recovery emails go to
# the log-only sender.
set -euo pipefail

cd "$(dirname "$0")/../packages/api"

WRANGLER_ENV_ARGS=()
if [[ "${1:-}" == "--env" && -n "${2:-}" ]]; then
  WRANGLER_ENV_ARGS=(--env "$2")
fi

put() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "· $name not set in environment — skipped"
    return
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" "${WRANGLER_ENV_ARGS[@]}"
  echo "✓ $name"
}

put RESEND_API_KEY
put STRIPE_SECRET_KEY
put STRIPE_WEBHOOK_SECRET
# Agent Testing worker-payment treasury (64-hex secp256k1; NOT the escrow
# custody key). Without it, testing task publication fails closed.
put TESTING_TREASURY_PRIVATE_KEY
# Where Agent Testing operator alerts (new submissions, paid orders, evidence
# ready…) are emailed. A secret so a personal address never sits in the
# public wrangler.toml; unset, alerts stay in the console queue only.
put TESTING_OPERATOR_EMAIL

echo
echo "Reminder: Stripe PRICE IDS are plain vars, not secrets — set"
echo "STRIPE_PRICE_PRO_MONTHLY / STRIPE_PRICE_PRO_YEARLY / STRIPE_PRICE_TESTING_AUDIT"
echo "in packages/api/wrangler.toml [vars] and deploy."
