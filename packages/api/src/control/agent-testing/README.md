# Agent Testing — architecture and security notes

Proprietary control-plane module (see `../LICENSE`, LICENSING.md). Product
spec: "Agent Testing by BasedAgents". Operator guide:
`docs/AGENT_TESTING_RUNBOOK.md`.

## Product-aware billing

The central `/v1/stripe/webhook` (control/billing.ts) verifies the
signature, then resolves the product family BEFORE any claim:

- **Testing events** — recognized by server-set
  `metadata.product_family=agent_testing` on the session/payment-intent, or
  by session/PI association against `testing_checkout_attempts` — are
  stored durably in `testing_stripe_events` before the acknowledgment and
  processed under a lease (`received → processing(lease) → processed |
  retryable_failed | manual_review`). A crash after the insert is retried
  by the cron; nothing is suppressed by an event-id claim. Financial facts
  come from canonical objects re-fetched from Stripe; metadata is only the
  association hint. Testing events can never write `owners.plan`, Keyring
  subscription ids or entitlements.
- **Keyring events** keep the legacy path, with one hardening: the
  `checkout.session.completed` upgrade now requires the session to map to
  a subscription (`mode=subscription`, or a legacy shape carrying a
  subscription id). A one-time payment session acknowledged there changes
  no plan state.

Payment, refund and dispute are independent order columns with guarded
transitions: an out-of-order failure/expiry can never demote a success; a
second successful payment for one order becomes a reconciliation incident
(operator alert), never a second entitlement — the run-plan operation's
semantic key (`plan:{order}`) is unique per order.

## Public vs private task data

Managed assignments are ordinary marketplace tasks created by the
"BasedAgents Testing" service principal through the SAME creation/funding
path and lifecycle gates as every other task. The public listing carries
only generic content (objective class, environment label, evidence rules,
compensation, how the claimant fetches the brief). Customer materials
(workflow, docs URL, allowed origins, fixture) live in the frozen per-attempt
brief, served exclusively by
`GET /v1/testing/assignments/:taskId/brief` to the CURRENT claimant with
active eligibility — rechecked on every request, revoked by unclaim/cancel/
suspension, `Cache-Control: private, no-store`. Reports, orders and intake
are owner-scoped (`404` for anyone else) and never enter public feeds,
prerender output or sitemaps. Worker submissions are untrusted data end to
end: schema-validated, size-bounded, secret-scanned, and never able to
alter budgets, permissions or decisions.

## Bounded authority

- **Customer**: session + strict origin allowlist for bounded service-order
  actions only (documented testing-only policy; no shared middleware was
  loosened). The checkout request carries only the approved quote id/
  version, scope hash, disclosure versions and an idempotency key — the
  server rejects any client-supplied price, Stripe id, budget, owner or
  redirect.
- **Operator**: `ownerSession` + `ADMIN_OWNER_IDS` on the server for every
  route, plus a fresh action-bound WebAuthn assertion for quote approval,
  publication, run review, replacements, resume/cancel, refunds and report
  publication. Each canonical binds the object ids, versions, scope hash
  and amounts of that one decision.
- **Money**: customer USD (integer cents) and worker USDC (atomic-unit
  strings) never mix. Worker bounties come from a SEPARATE treasury key
  (`TESTING_TREASURY_PRIVATE_KEY`) that signs standard EIP-3009 escrow
  deposits — the same handshake a buyer's wallet performs — bounded per
  order by `testing_budget_reservations`: a single guarded INSERT enforces
  `Σ(open reservations) + new ≤ cap` atomically, the included retest is a
  protected earmark inside the cap, and a reservation is released only when
  the deposit's return is confirmed. The claim gate re-checks the
  `task_claim_allowlist` (a neutral, OSS-clean marketplace extension —
  presence-probed, no proprietary import) inside the atomic claim UPDATE,
  so eligibility and operator-group diversity hold at the claim boundary.
- **Durability**: every external side effect (session create, task
  publish+fund, refund) runs as a `testing_operations` row with a unique
  semantic key, lease, bounded retries and a manual-review dead letter; ids
  and nonces are persisted BEFORE external calls so crashes converge
  instead of duplicating. No DB transaction spans a Stripe or settlement
  call.

## Files

| File | Role |
|---|---|
| `catalog.ts` | versioned package config, flags, readiness gates |
| `schemas.ts` | Zod contracts (intake, scope, brief, result, findings, report) + JSON Schema export + secret heuristics |
| `store.ts` | all SQL; atomic conditional writes; inbox/operations/notifications |
| `checkout.ts` | injectable Stripe surface + hosted checkout creation |
| `stripe-events.ts` | classification, durable inbox processing, refund/dispute facts |
| `planner.ts` | fixed run plans (B0 + E1..En + retest earmark) |
| `treasury.ts` | separate worker-payment signer |
| `fulfillment.ts` | eligibility, publication operations, marketplace sync, service-principal gate actions |
| `evidence.ts` | automated submission triage |
| `reports.ts` | deterministic drafts, immutable versions, Markdown export |
| `routes.ts` / `admin.ts` | customer/public/worker and operator HTTP surfaces |
| `jobs.ts` | cron: inbox, operations, sync, alerts, notifications, expiry, retention |
| `metrics.ts` | operator metrics (founder/test work excluded from demand) |
| `test-harness.ts` + `*.test.ts` | software passkey + scripted Stripe + fake facilitator; includes the executable §20.6 end-to-end demo |
