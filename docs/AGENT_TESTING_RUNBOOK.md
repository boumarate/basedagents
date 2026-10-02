# Agent Testing — operator runbook

Operational guide for **Agent Testing by BasedAgents** (the managed
agent-compatibility-audit product). Audience: the platform operator.
Everything here assumes the implementation on this branch; recheck the flag
names against `.env.example` after upgrades.

The product is **feature-flagged off by default**. Nothing sells, charges,
publishes, or emails until you deliberately enable it, and a missing
readiness item disables checkout with customer-readable copy — it never
produces a success-looking demo in production.

---

## 1. What the system does (one paragraph)

A buyer submits ONE workflow for audit — no account needed: the public
intake (`app.basedagents.ai/testing/request`) takes the form plus an email
address, parks the payload in a pre-auth inbox, and emails a sign-in link;
the request attaches to the account (created on the spot for a new address)
the moment that email signs in, which is also when you get the
submission alert. Unverified submissions expire after 14 days and are never
reviewable. From there: you review the intake,
approve a versioned quote (passkey ceremony) with an exact scope, price and
delivery target. The buyer pays a one-time Stripe Checkout. The verified
webhook creates a fixed run plan (internal baseline B0 + external runs
E1–E3 + a protected retest earmark) — publishing **nothing**. You approve
task publication (passkey); durable operations create escrow-funded
marketplace tasks under the "BasedAgents Testing" service principal,
restricted to the approved worker pool. Workers claim, pull their private
brief, execute, and deliver a JSON result. Automated triage validates shape,
scope hash, hash integrity, secrets and duplicates; **you** decide evidence
validity and the product outcome (passkey), and the marketplace consequence
runs through the normal lifecycle gates. You generate a deterministic report
draft, edit if needed, and publish (passkey) — one private, immutable,
exportable report. The buyer may request one targeted retest inside the
window and start repeat purchases from a fresh draft.

## 2. Roles and authority

- Operator = an owner account whose id is in `ADMIN_OWNER_IDS`, **with a
  passkey**. Every money- or publication-shaped action requires a fresh
  WebAuthn assertion bound to the exact object ids, versions, scope hash and
  amounts. There is no "approve anything" signature.
- Session-only operator actions (bookkeeping): needs-changes, decline,
  plan, pause, reconcile, eligibility upserts, source tagging.
- Passkey-ceremony actions: approve-quote, publish-tasks, resume, cancel,
  refund, run review, replace-attempt, publish-report.

## 3. Production setup (exact steps)

Do these in order; the readiness gate (`checkoutDisabledReason`) enforces
most of them.

1. **Migration**: apply `packages/api/migrations/0042_agent_testing.sql`
   (`wrangler d1 migrations apply` in prod; the Node runner replays it
   automatically locally).
2. **Stripe**:
   - Create the one-time Price for the audit package (test mode first):
     currency `usd`, `unit_amount` = the configured package price
     (default 20000 = $200), type one-time. Set
     `STRIPE_PRICE_TESTING_AUDIT=<price_…>`.
   - `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are the existing central
     ones; the central `/v1/stripe/webhook` now dispatches by product. Add
     these events to the webhook endpoint subscription if not already
     present: `checkout.session.completed`, `checkout.session.expired`,
     `checkout.session.async_payment_succeeded/failed`,
     `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `charge.refunded`, `refund.updated`, `refund.failed`,
     `charge.dispute.created/updated/closed`.
   - Complete the processor business-model review and tax/selling-region
     setup for the managed-service product before any live sale
     (`TESTING_TAX_MODE=stripe_tax` if you enable Stripe Tax; default
     `none` means you verified no collection obligation).
   - A live key additionally requires `TESTING_PRODUCT_LIVE_APPROVED=1`.
3. **Email**: `RESEND_API_KEY` + verified sender. The log-only sender fails
   the checkout readiness gate (`TESTING_ALLOW_LOG_EMAIL=1` exists for dev
   only — never set it in production). Set `TESTING_OPERATOR_EMAIL` as a
   **wrangler secret** (`scripts/put-secrets.sh`, never wrangler.toml — a
   personal address stays out of the public repo) to receive submission,
   payment, dispute and review alerts; unset, alerts stay in the console
   queue only.
4. **Service principal**: register a dedicated agent named
   "BasedAgents Testing" (normal registration; keep its Ed25519 key in the
   platform secret store). Set `TESTING_PLATFORM_AGENT_ID=<ag_…>`.
5. **Treasury**: fund a SEPARATE wallet with the worker-payment USDC budget
   and set `TESTING_TREASURY_PRIVATE_KEY` (64-hex secp256k1). This is the
   platform's operating money for bounties. It must NOT be the escrow
   custody wallet key (`ESCROW_WALLET_PRIVATE_KEY`) and is never derived
   from customer funds. Escrow + payments must already be configured
   (facilitator keys, house wallet) — testing tasks ride the standard
   escrow deposit → release/refund path.
6. **Worker coverage**: review real workers and record eligibility
   (`POST /v1/owner/admin/testing/workers/:agentId/eligibility` or the
   console "Testing ops" page): private `operator_group_id` with your
   ownership-evidence confidence, environments (client + transport),
   provenance (`operator_reviewed` for anything the catalog may show),
   expiry. The public catalog shows only operator_reviewed labels. Workers
   affiliated with a tested product's team must not count toward
   independent coverage — keep them out of that order's pool.
7. **Policy pages**: published service terms, privacy/disclosure and refund
   policy (versions `testing-terms-v1`/`testing-disclosure-v1` are what
   quotes snapshot — bump `catalog.ts` when you revise them).
8. **Sample page**: production may show only the labeled illustrative
   sample (shipped) or a separately approved real export. Never wire a
   private report into the public site.
9. **Flags**, in this order as you gain confidence:
   `TESTING_PRODUCT_ENABLED=1` (pages + intake) →
   `TESTING_CHECKOUT_ENABLED=1` (payments) →
   `TESTING_FULFILLMENT_ENABLED=1` (task publication).
10. **Monitoring**: watch the cron log line `[cron] Testing jobs done: …`,
    the operator queue's "Operations needing attention", and
    `TESTING_OPERATOR_EMAIL` alerts. Back up D1 as you already do —
    financial rows (orders/attempts/reservations) are ordinary tables.

## 4. Day-to-day: the queue

Console → **Testing ops** (`/testing/admin`). Work top to bottom:

- **Operations needing attention** — durable operations in `manual_review`
  (funding unavailable, no eligible workers, repeated failures). Fix the
  cause; re-approve publication if needed (operations are idempotent by
  semantic key — re-running never double-publishes or double-spends).
- **Intake review** — open the request. A counter above the list shows
  public submissions still awaiting email sign-in: coming demand, not yet
  reviewable (each appears as a normal row the moment its submitter signs
  in). The §9.1 checklist is in the
  approve form; "other" category and credential-requiring workflows cannot
  be quoted — send back with a note instead. Set a REALISTIC delivery
  target (it shows to the buyer pre-payment and is recorded; never call it
  guaranteed). Approving runs your passkey over the request version, scope
  hash, price, worker cap and target.
- **Paid — awaiting task approval** — open the order, check the plan
  (B0 + E1..E3 + earmark), eligibility preview per run, then select runs
  and approve publication (passkey names the total commitment). Budget
  facts: bounty 5 USDC/run, cap 30 USDC per order = 3 initial runs +
  1 retest + up to 2 replacements. The cap is a **ceiling, not a target**
  — never invent work to use it.
- **Evidence review** — every submission is triaged automatically
  (schema/scope-hash/integrity/secrets/duplicates) but triage is not
  acceptance. Read the evidence. Record: evidence valid|needs
  revision|invalid; outcome product_success|product_failure|inconclusive;
  environment demonstrated; slot satisfied; operator group; the
  marketplace action. **A valid product failure is payable work — accept
  it.** A simulated run, missing environment, invented trace or copied
  submission is not — revision or dispute through the same form.
  Watch the auto-accept countdown: the marketplace pays automatically
  after 7 days. If that fires unreviewed you get an URGENT alert — the
  worker's payment stands; the run STILL needs your evidence decision and
  no report publishes without it.
- **Reports** — Generate draft (deterministic from reviewed records; safe
  to re-generate), optionally edit the draft (PATCH keeps ReportSchema
  validity; published versions are immutable), publish with passkey. First
  publication arms the retest window and emails the buyer a sign-in link
  (the email never contains report content).
- **Retest** — appears as a pending `retest` run after the buyer requests
  it. Confirm it targets ONE reported finding in ONE environment (the run
  carries the parent finding), then publish it like any run: it consumes
  the protected earmark, not new budget. If replacements exhausted the cap
  (they cannot consume the earmark without an explicit exception), either
  authorize additional platform expense deliberately or record the remedy —
  never silently deny a sold inclusion. A retest that still fails is
  payable and appends a new report version; originals never change.

## 5. Money handling

- **Customer money** (USD cents) and **worker liabilities** (USDC atomic)
  are separate records; nothing converts between them.
- **Refunds**: passkey over `{order, amount_cents, reason}` → durable
  operation → Stripe refund with the operation key as the idempotency key →
  webhook events set pending/partial/full/failed facts. A requested refund
  is NOT completed until the webhook says so.
- **Duplicate charge on one order**: automatic reconciliation incident +
  alert; resolve via the refund workflow. A duplicate never creates a
  second run plan.
- **Disputes**: opening one sets a risk hold and pauses NEW publication;
  results are never erased and earned worker payouts never clawed back.
  Resolve unclaimed tasks through cancel; claimed/submitted work through
  run review.
- **Cancellation**: customer "cancel-request" is a review item, not an
  action. Operator cancel (passkey) cancels unclaimed managed tasks through
  the normal lifecycle (their escrow deposits refund to the treasury) and
  lists anything needing per-run resolution. Refund separately.
- **Budget accounting**: reservations move
  reserved → committed (task funded) → settled (worker paid) or
  release_pending → released (deposit's return CONFIRMED on-chain). An
  unknown or pending transfer is never treated as failed to reuse funds.

## 6. Kill switches and incident handling

- `TESTING_CHECKOUT_ENABLED=0` — stops NEW checkouts. Paid orders, jobs,
  refunds, reads all keep working.
- `TESTING_FULFILLMENT_ENABLED=0` — stops NEW task publication. Sync,
  settlement bookkeeping, notifications, retention keep running. Never
  disable the cron to stop the product — the recovery jobs live there.
- **Stuck operation**: it lands in `manual_review` with the sanitized
  error. Publication crashes are recoverable — the task id and deposit
  nonce were persisted before any external call, so re-running converges.
- **"Timeout" on funding/settlement is not evidence money didn't move**:
  reconcile through the payment record/provider (order → Reconcile
  payments; escrow legs re-drive from the standard cron sweep) before any
  re-authorization.
- **Failed jobs**: exponential backoff, bounded attempts, then
  manual_review. The Stripe inbox has the same lifecycle; a crashed event
  is re-leased, never suppressed by an id claim.

## 7. Retention and privacy

Nightly (cron): unsubmitted drafts deleted after
`TESTING_DRAFT_RETENTION_DAYS` (30); worker evidence bodies redacted
`TESTING_EVIDENCE_RETENTION_DAYS` (90) after the initial report (skipped
under risk hold); reports retained `TESTING_REPORT_RETENTION_DAYS` (365)
with exports available. Financial records are never deleted by these jobs.
Backups follow your existing D1 procedure — do not promise instantaneous
erasure from backups or from workers' own systems; the disclosure text
already says test materials reach the executing operators.

Private surfaces: reports/orders are owner-checked, `private, no-store`,
never in prerender output or sitemaps. Public task listings carry only the
generic assignment text. If you add customer/product attribution to a
public task, record the customer's separate approval first.

## 8. Metrics honesty

`GET /v1/owner/admin/testing/metrics` (console: Load metrics). External
demand excludes founder/test orders — tag those on the request
(**founder_sample** / **test_fixture**) before or after quoting. The
validation target (3 unrelated paying customers, ≥2 repeat) is a
measurement, not a growth program: show the counts as they are. Processor
fees and review time read `null` until instrumented — never zero.

## 9. Local / test-mode demonstration

The full §20.6 journey is executable:

```bash
npm ci && npm run pretest
npx vitest run src/control/agent-testing/demo.e2e.test.ts   # in packages/api
```

It drives: real buyer signup (magic-link ladder) → intake → passkey quote
approval (software authenticator) → hosted checkout (scripted Stripe
double) → signed webhook → plan → passkey publication → escrow-funded tasks
(fake facilitator + test treasury) → three fixture workers claim/brief/
deliver (one real product failure) → triage → passkey reviews (the failure
is ACCEPTED and paid) → deterministic report → passkey publication → buyer
export → retest from the earmark (still failing → v2 addendum) → repeat
draft. Everything is labeled a fixture; it demonstrates the application,
not any real product or worker.

For a browser walkthrough: `E2E=1 TESTING_PRODUCT_ENABLED=1 …` with
`npm run dev:api` + the console dev server, mirroring the env used in the
test harness; Stripe test mode replaces the scripted double.

## 10. Rollback

Flags off (checkout first) → let jobs drain (they keep running) → resolve
open orders per §5/§6 → the 0042 tables are additive and can stay in place;
`task_claim_allowlist` only affects tasks that have rows in it.
