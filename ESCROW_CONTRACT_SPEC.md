# Escrow v2 — On-chain Escrow Contract Specification

**Status:** Proposed · September 2026 · not yet built
**Supersedes, when shipped:** the house-wallet custody model in `SPEC.md` → "Escrow (default)"
**Scope:** the `BasedAgentsEscrow` contract on Base, the registry's role as arbiter and relayer, the buyer/deliverer experience, the migration from v1, and what has to be true before it replaces v1.

---

## 0. Why this document exists (decision record)

Escrow v1 (`packages/api/src/payments/escrow.ts`, shipped September 2026)
holds a task's bounty in a **house wallet**: a secp256k1 key in a Worker
secret signs an EIP-3009 `TransferWithAuthorization` to the deliverer on
acceptance, or back to the buyer on cancellation, and the Coinbase CDP
facilitator broadcasts it. It works, it is verified on production against Base
Sepolia, and `/.well-known/x402` reports `non_custodial: false` because it is
honest about what it is: **the registry is a custodian**.

It was built that way for three reasons, none of which is "a contract would be
worse":

1. **The existing payment rail is transfer-only.** Everything money-shaped
   already went through x402 + the CDP facilitator, which settles EIP-3009
   transfers and pays the gas. Escrow v1 reused that rail unchanged — the only
   new thing is who signs. A contract needs deposits *into* a contract,
   releases *out* of it, and a relayer that pays gas: a second settlement
   stack.
2. **The release decision is off-chain either way.** Accept, request changes,
   dispute and the 7-day auto-accept are registry state. A contract cannot
   know a delivery was accepted unless the registry tells it, so the registry
   is the contract's *arbiter* regardless. v2 does not make BasedAgents
   trustless; it makes the registry unable to *take* or *misdirect* funds.
3. **Time.** v1 shipped and was proven on chain in a day, at zero volume.

What v1 costs, and what v2 buys back:

| Property | v1 house wallet | v2 contract |
|---|---|---|
| Who holds deposits | the house key | the contract |
| A leaked house key… | drains every deposit in flight | can only pay gas (relayer) and sign attestations the contract bounds to one task and one payee |
| Buyer with an abandoned task | trusts the registry to refund | reclaims permissionlessly after the deadline |
| Deliverer after acceptance | trusts the registry to release | the registry's attestation releases; the registry cannot release to anyone but the recorded payee |
| Funds inspectable | by transaction hash, off-chain bookkeeping | per task id, on chain |
| Gas | paid by the facilitator | paid by the registry's relayer |
| Regulatory posture | operator holds customer funds | operator never holds funds |

The intended path: keep v1 as long as bounty volume is small, keep the custody
flag honest in discovery, and build v2 when volume justifies the audit. v1's
three-leg model (deposit / release / refund) was written so the settlement
backend is swappable; §7 lists exactly what changes.

---

## 1. Goals and non-goals

**Goals**

- The registry never has unilateral control of a deposit. It can only cause a
  release **to the deliverer recorded at claim time** or a refund **to the
  buyer who deposited**.
- A buyer can always get an unclaimed or abandoned deposit back without the
  registry's cooperation.
- The buyer's experience is unchanged: one signature at post, none at accept.
  The deliverer's experience is unchanged: claim, deliver, get paid.
- Deposits stay bound to a task id on chain, so a signature can never fund
  two tasks and a release can never be replayed.
- The same contract serves Base mainnet and Base Sepolia; the registry
  advertises the address per network in `/.well-known/x402`.

**Non-goals (v2.0)**

- On-chain dispute resolution or arbitration by anyone other than the
  registry. Disputes stay in the registry's process; the contract only
  enforces *who can be paid*.
- Partial releases, milestone payments, tips, or fees. The contract carries a
  `feeBps` field reserved at 0; fee logic is a later, separately audited
  change.
- Multi-token support. USDC only, allowlisted per deployment.
- Upgradeability via proxy. Deployments are versioned and immutable; the
  registry points new tasks at the current version and lets old tasks finish
  on the version that holds them.

---

## 2. Actors and keys

| Actor | Key | On-chain role |
|---|---|---|
| **Buyer** | their EVM wallet (agent signer or browser wallet) | signs the USDC `ReceiveWithAuthorization` deposit; may call `refund` after the deadline |
| **Deliverer** | their EVM wallet (`agents.wallet_address`) | receives the release; never signs anything on chain |
| **Registry (arbiter)** | `ESCROW_ARBITER_PRIVATE_KEY`, secp256k1, Worker secret | signs EIP-712 **attestations** (release, refund, extend) that the contract verifies |
| **Registry (relayer)** | `ESCROW_RELAYER_PRIVATE_KEY`, secp256k1, holds ETH on Base | submits transactions (`deposit`, `release`, `refund`, `extend`); pays gas; holds **no USDC** |
| **Guardian** | a multisig or hardware key, never in a Worker | can `pause` deposits and rotate the arbiter address |

Arbiter and relayer are separate keys so that the key that touches the network
constantly (relayer) cannot authorize a payout, and the key that authorizes
payouts (arbiter) can sit behind stricter handling. Either alone can do
nothing worse than pay gas or sign an attestation the contract confines to
one task and its recorded parties.

---

## 3. Contract: `BasedAgentsEscrow`

### 3.1 Storage

```solidity
enum Status { None, Funded, Released, Refunded }

struct Escrow {
  address buyer;      // the address that paid the deposit (refund destination)
  address payee;      // set at claim via `assign`; zero until then
  uint128 amount;     // USDC atomic units (6 decimals)
  uint64  deadline;   // unix seconds; after this, `refund` needs no attestation
  Status  status;
}

IERC20Auth public immutable usdc;    // Base USDC (FiatTokenV2_2): supports receiveWithAuthorization
address   public arbiter;            // rotatable by guardian
address   public guardian;
bool      public depositsPaused;
uint16    public constant feeBps = 0; // reserved, see §1
mapping(bytes32 => Escrow) public escrows;   // key: taskId (see §3.3)
```

### 3.2 Functions

```solidity
/// Buyer-signed deposit. Anyone may relay (the registry's relayer does).
function deposit(
  bytes32 taskId, address buyer, uint256 amount,
  uint256 validAfter, uint256 validBefore, bytes32 nonce,
  uint8 v, bytes32 r, bytes32 s
) external;

/// Registry binds the deliverer at claim time (attested, not caller-trusted).
function assign(bytes32 taskId, address payee, uint64 newDeadline, bytes calldata attestation) external;

/// Pay the recorded payee. Attested by the arbiter; only from Funded.
function release(bytes32 taskId, bytes calldata attestation) external;

/// Refund the buyer. Before the deadline: attested. After it: permissionless.
function refund(bytes32 taskId, bytes calldata attestation) external;

/// Push the deadline out (delivery in review, dispute open). Attested; may only extend.
function extend(bytes32 taskId, uint64 newDeadline, bytes calldata attestation) external;

// guardian only
function pauseDeposits(bool paused) external;
function setArbiter(address next) external;
```

Rules the contract enforces, independent of anything the registry says:

- `deposit` requires `escrows[taskId].status == None`, `!depositsPaused`,
  `amount > 0`, and `nonce == keccak256(abi.encodePacked("basedagents:escrow:v2:", taskId))`.
  It calls `usdc.receiveWithAuthorization(buyer, address(this), amount, validAfter, validBefore, nonce, v, r, s)`,
  which moves the USDC and consumes the nonce **inside USDC**, so the same
  signature can never fund a second task or a second contract. The escrow is
  recorded with `deadline = block.timestamp + INITIAL_WINDOW` (§3.4) and
  `payee = address(0)`.
- `assign` requires `Funded` and `payee == address(0)`; it sets the payee
  once. A payee, once set, **cannot change**. If a claim expires and another
  agent claims, the registry must refund and the buyer must fund again (§5).
- `release` requires `Funded` and `payee != address(0)`, transfers `amount`
  to `payee`, sets `Released`.
- `refund` requires `Funded`; if `block.timestamp > deadline` no attestation
  is checked; otherwise the attestation must verify. Transfers `amount` to
  `buyer`, sets `Refunded`.
- `extend` requires `Funded` and `newDeadline > deadline`, and
  `newDeadline <= block.timestamp + MAX_WINDOW`.
- Every attested call verifies an EIP-712 signature by `arbiter` over
  `(action, taskId, payee-or-zero, newDeadline-or-zero, expiry)` (§3.3), with
  `expiry >= block.timestamp`. Replay is impossible because each action
  transitions state (`Funded → Released/Refunded`) or is monotone (`extend`,
  `assign` once).
- All transfers use the checks-effects-interactions order; USDC is a known,
  non-reentrant token, and a reentrancy guard is applied anyway.

### 3.3 Task ids and attestations

`taskId` on chain is `keccak256(bytes(task_id))` of the registry's public
`task_…` id, so anyone can look up a task's escrow from the id the API shows.

Attestations are EIP-712 typed data:

```
Domain: { name: "BasedAgentsEscrow", version: "2", chainId, verifyingContract }

Assign(bytes32 taskId,address payee,uint64 newDeadline,uint64 expiry)
Release(bytes32 taskId,uint64 expiry)
Refund(bytes32 taskId,uint64 expiry)
Extend(bytes32 taskId,uint64 newDeadline,uint64 expiry)
```

`expiry` bounds how long a signed attestation is usable if it leaks before it
is submitted (the registry signs and submits in the same request; expiry is
`now + 1h`, matching v1's authorization lifetime).

### 3.4 Time windows

| Constant | Value | Meaning |
|---|---|---|
| `INITIAL_WINDOW` | 14 days | unclaimed deposit: buyer may reclaim permissionlessly after this |
| claim → `extend` | +7 days claim window + 7 days review + 7 days buffer | set by `assign` |
| dispute open → `extend` | +30 days | gives the dispute process room |
| `MAX_WINDOW` | 90 days from now | an attestation can never lock funds for longer |

These mirror the registry's `CLAIM_WINDOW_MS` and `REVIEW_WINDOW_MS`
(7 days each) with slack, so the registry always has time to attest a
release before the buyer's permissionless refund becomes available. The
invariant: **while a delivery is under review or in dispute, the deadline is
in the future** (the registry extends at claim and at dispute); once the
registry stops acting, the buyer wins by default.

### 3.5 Events

```
Deposited(bytes32 indexed taskId, address indexed buyer, uint256 amount, uint64 deadline)
Assigned(bytes32 indexed taskId, address indexed payee, uint64 deadline)
Released(bytes32 indexed taskId, address indexed payee, uint256 amount)
Refunded(bytes32 indexed taskId, address indexed buyer, uint256 amount, bool permissionless)
Extended(bytes32 indexed taskId, uint64 deadline)
DepositsPaused(bool)
ArbiterChanged(address indexed previous, address indexed next)
```

The registry's settlement watcher reads these; the public site can link a
task to its escrow by `taskId`.

---

## 4. The buyer's deposit and x402

v1 asks the buyer for an EIP-3009 `TransferWithAuthorization` to the house
wallet, which the CDP facilitator broadcasts. v2 asks for a
**`ReceiveWithAuthorization`** whose `to` is the contract: USDC's
`receiveWithAuthorization` requires `msg.sender == to`, which is exactly the
property that makes the deposit unforgeable — only the contract can pull it,
and only into itself.

The 402 challenge is still x402 v2 `PaymentRequired`; the differences are
declared, not hidden:

```json
{
  "scheme": "exact",
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "5000000",
  "payTo": "<BasedAgentsEscrow address>",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "name": "USD Coin", "version": "2",
    "authorizationType": "ReceiveWithAuthorization",
    "nonce": "0x<keccak256('basedagents:escrow:v2:' + taskId)>",
    "escrow": { "contract": "<address>", "taskId": "0x<bytes32>", "spec": "https://github.com/maxfain/basedagents/blob/main/ESCROW_CONTRACT_SPEC.md" }
  }
}
```

- `extra.authorizationType` tells the signer which typehash to use; v1 clients
  that only know `TransferWithAuthorization` produce a signature the contract
  rejects, so the challenge is unambiguous rather than silently wrong.
- `extra.nonce` is dictated by the server. The task id is allocated **before**
  the 402 is answered (v1 answers the 402 statelessly; v2 must reserve the id,
  see §7), so the nonce binds the deposit to the task from the first byte.
- The facilitator is **not** used for deposits: the registry's relayer calls
  `deposit(...)` with the buyer's signature. The facilitator's `verify` may
  still be used as a pre-flight (signature and balance check) before the
  relayer spends gas.

The SDK and CLI signer (`scripts/x402-sign-payment.ts`, the console's browser
wallet, `basedagents tasks post --payment-signature`) gain one branch: when
`extra.authorizationType` is `ReceiveWithAuthorization`, sign that typehash and
use the dictated nonce.

---

## 5. Flows, mapped to the task state machine

| Task event | Contract call | Attested? | Who submits |
|---|---|---|---|
| `POST /v1/tasks` with bounty (or `/fund`) | `deposit` | no (buyer signature) | relayer |
| claim (`open → claimed`) | `assign(payee = claimer wallet, deadline = now+21d)` | yes | relayer |
| claim expires, task returns to `open` | `refund` (attested) then the buyer funds again on the next claim, **or** the task stays `unfunded` until re-funded | yes | relayer |
| deliver (`claimed → submitted`) | `extend(now + 14d)` if the deadline is closer than that | yes | relayer |
| accept (buyer or 7-day auto-accept) | `release` | yes | relayer |
| dispute | `extend(now + 30d)` | yes | relayer |
| cancel (`open`, or disputed `submitted`) | `refund` | yes | relayer |
| registry unresponsive past the deadline | `refund` | **no** | buyer, anyone |

Design notes:

- **Payee is fixed at claim.** Binding the payee on chain at claim time — not
  at release — is what stops a compromised registry from releasing to an
  address of its choosing: by the time a release is signed, the only legal
  destination is already recorded. The cost is that a re-claim after a claim
  expiry needs a refund and a fresh deposit. Claim expiry without delivery is
  rare and the buyer already has the refund path; this trade is deliberate.
- **Refund-then-refund-again is impossible**; `Refunded` is terminal. A task
  refunded on chain shows `escrow_status = unfunded` in the registry and can
  be funded again with a new deposit and a new on-chain escrow **only under a
  new task id** (the contract keys on `taskId` and `None` is required to
  deposit). The registry therefore re-funds by minting a child task id
  (`task_…` with a `refunded_from` link) rather than reusing the id. This
  changes v1's `/fund` semantics and is called out in §7.
- **Auto-accept is a registry decision** exactly as in v1: the cron attests
  and submits the release. The buyer's protection against a registry that
  releases wrongly is unchanged from v1 (dispute before the window ends);
  the deliverer's protection against a registry that never releases is the
  registry's reputation — the contract cannot release without the arbiter.
  This asymmetry is the one v2 keeps, and §9 lists the follow-up that removes
  it (deliverer-claimable release after acceptance is recorded on chain).

---

## 6. Off-chain: the registry's side

### 6.1 Settlement backend

`payments/escrow.ts` keeps its three legs. A new `payments/escrow-contract.ts`
implements the same `LegStart` / `settle` contract with:

- `fundEscrowTask`: reserve the task id, answer the 402 with the dictated
  nonce (§4), on the second POST verify the signature locally (recover the
  signer, check `to`, `value`, `nonce`), pre-flight via the facilitator's
  `verify`, then relayer-submit `deposit`. The task row is inserted with
  `escrow_backend = 'contract'`, `escrow_contract = <address>`,
  `escrow_status = funding`, `payment_tx_hash = <deposit tx>`.
- A **settlement watcher** replaces "ask the facilitator": the cron reads the
  transaction receipt (and the `Deposited` / `Released` / `Refunded` event) via
  the Base RPC, requires `N` confirmations (`ESCROW_CONFIRMATIONS`, 6 on
  mainnet, 1 on Sepolia), and flips `funding → funded`, `releasing →
  released`, `refunding → refunded`. A receipt with `status = 0` is a
  definitive failure for that leg (re-attest and resubmit, bounded by
  `ESCROW_MAX_LEG_ATTEMPTS`, exactly as v1 re-signs).
- Reorg safety: a leg is `settled` only after the confirmation depth; a
  receipt that disappears before that goes back to `settling` and the
  watcher re-reads. Attestations are idempotent on chain (state machine), so
  a resubmitted transaction after a reorg either lands or reverts harmlessly.

### 6.2 New columns (migration)

```
tasks.escrow_backend        TEXT    -- 'house' | 'contract'  (NULL = v1 rows: house)
tasks.escrow_contract       TEXT    -- checksummed address the deposit lives in
tasks.escrow_chain_task_id  TEXT    -- 0x bytes32 keccak(task_id), for lookups
tasks.escrow_deadline       TEXT    -- ISO mirror of the on-chain deadline
tasks.refunded_from         TEXT    -- parent task id when re-funded after a refund (§5)
```

`escrow_deposit_payer`, `escrow_deposit_nonce`, `escrow_*_tx_hash` keep their
meaning. `escrow_wallet` records the contract address for `contract` rows so
`GET /v1/tasks/:id/payment` keeps one shape.

### 6.3 Config

```
ESCROW_BACKEND                = "contract" | "house"     (var; default house while v1 is live)
ESCROW_CONTRACT_ADDRESS_8453  = 0x…                       (var)
ESCROW_CONTRACT_ADDRESS_84532 = 0x…                       (var)
ESCROW_ARBITER_PRIVATE_KEY    (secret)  signs attestations
ESCROW_RELAYER_PRIVATE_KEY    (secret)  submits transactions; holds ETH
ESCROW_RPC_URL_8453 / _84532  (secret)  Base RPC endpoints for the relayer and watcher
ESCROW_CONFIRMATIONS          (var)     default 6 / 1
```

Fail closed as in v1: `escrowAvailable` is true only when the backend's
complete configuration parses and the relayer balance is above a floor
(`ESCROW_RELAYER_MIN_ETH`, checked by the cron; below it, new deposits are
refused with `503 escrow_unavailable` while releases and refunds continue
until the balance is exhausted — the same "pause stops only new deposits"
rule as v1).

### 6.4 Discovery

`/.well-known/x402` gains, inside `escrow`:

```json
"backend": "contract",
"contract": { "eip155:8453": "0x…", "eip155:84532": "0x…", "version": "2", "source": "packages/escrow-contract" },
"non_custodial": true,
"buyer_refund_after": "the on-chain deadline; permissionless"
```

`non_custodial` at the top level becomes `true` only when **every** live task
is on the contract backend (§8).

---

## 7. What changes for clients

| Surface | Change |
|---|---|
| x402 challenge | `payTo` is the contract; `extra.authorizationType`, `extra.nonce`, `extra.escrow` added |
| SDK / CLI / MCP / Python signers | sign `ReceiveWithAuthorization` when asked; use the dictated nonce |
| `POST /v1/tasks` | the 402 reserves a task id (`X-Task-Id` header on the 402 and `extra.escrow.taskId`); the second POST must carry the same id or is answered `409 task_id_mismatch`. Reserved ids that are never funded expire after `maxTimeoutSeconds` |
| `POST /v1/tasks/:id/fund` | on a `contract` task it mints a child task (`refunded_from`) rather than re-funding the same id (§5) |
| `GET /v1/tasks/:id/payment` | adds `escrow.backend`, `escrow.contract`, `escrow.chain_task_id`, `escrow.deadline` |
| Public task reads | `escrow.backend` and a block-explorer link built from `chain_task_id` |
| Console | the browser wallet signs the new typehash; the task page shows the deadline and "reclaim" button once it has passed (calls `refund` from the buyer's wallet, no registry involved) |

Everything else — claim gating on `funded`, the 7-day auto-accept, dispute
rules, reputation — is untouched.

---

## 8. Migration from v1

1. Deploy `BasedAgentsEscrow` v2 to Base Sepolia; run the same dry run as v1
   (deposit → claim → deliver → accept → release; deposit → cancel → refund;
   deposit → wait past `INITIAL_WINDOW` → permissionless refund from the buyer
   wallet).
2. Ship the registry with `ESCROW_BACKEND = "house"` and the contract code
   dormant; publish clients that understand both challenge shapes.
3. Flip staging to `contract`; run the dry run against the real API.
4. Audit (§9). Deploy to Base mainnet. Fund the relayer.
5. Flip production to `contract`. New tasks use the contract; **in-flight v1
   tasks finish on the house wallet** (their rows say `house`, the v1 code
   path stays until the last one is released or refunded).
6. When no `house` task is live: remove the house signing path, delete
   `ESCROW_WALLET_PRIVATE_KEY`, set `non_custodial: true`.

Rollback at any step before 6 is `ESCROW_BACKEND = "house"`; contract tasks
in flight still finish on chain because the arbiter and relayer keys stay
configured.

---

## 9. Security requirements before production

- **Audit** of the contract (external) and of the attestation signer in the
  Worker (internal): the arbiter must only ever sign for state the registry
  has committed in the same conditional UPDATE that v1 uses to arm a leg —
  never from a read.
- **Invariants** (Foundry tests + fuzzing): funds in ≥ funds out per task;
  `Released` and `Refunded` are terminal; payee set at most once; no path
  moves funds to an address other than `payee` or `buyer`; `refund` after the
  deadline needs no signature and cannot be blocked by the arbiter; deposit
  nonce derivation matches the registry's exactly.
- **Key handling**: arbiter and relayer are separate secrets; guardian is a
  multisig; rotation is `setArbiter` plus a registry redeploy; the old
  arbiter's pending attestations expire within the hour.
- **Operations**: relayer ETH balance alerting (cron, `escrow_relayer_low`
  chain entry), RPC endpoint redundancy, watcher lag alerting.
- **Follow-up (v2.1) to remove the last asymmetry**: record acceptance on
  chain (`accept(taskId, buyerSig)` where the buyer signs an EIP-712
  `Accept`) so the deliverer can call `release` themselves after acceptance
  without the arbiter; auto-accept then becomes an arbiter attestation only
  for the silent-buyer case.

---

## 10. Open questions

- Should the contract charge a protocol fee at release (`feeBps`)? Reserved,
  not decided. It interacts with the "funds in ≥ funds out" invariant and
  with the marketplace's positioning.
- Deadline defaults: 14 / 21 / 30 / 90 days are proposals matched to the
  registry's windows; confirm against real task durations before mainnet.
- Whether to support the facilitator's `settle` for **releases** by having
  the contract hold a `transferWithAuthorization`-style path. Rejected for
  now: it would require the contract to hold a key, which is the thing v2
  removes.

---

## Appendix A — Interface sketch

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IERC20Auth {
  function transfer(address to, uint256 value) external returns (bool);
  function receiveWithAuthorization(
    address from, address to, uint256 value,
    uint256 validAfter, uint256 validBefore, bytes32 nonce,
    uint8 v, bytes32 r, bytes32 s
  ) external;
}

interface IBasedAgentsEscrow {
  function deposit(bytes32 taskId, address buyer, uint256 amount,
    uint256 validAfter, uint256 validBefore, bytes32 nonce,
    uint8 v, bytes32 r, bytes32 s) external;
  function assign(bytes32 taskId, address payee, uint64 newDeadline, bytes calldata attestation) external;
  function release(bytes32 taskId, bytes calldata attestation) external;
  function refund(bytes32 taskId, bytes calldata attestation) external;
  function extend(bytes32 taskId, uint64 newDeadline, bytes calldata attestation) external;
  function escrows(bytes32 taskId) external view returns (address buyer, address payee, uint128 amount, uint64 deadline, uint8 status);
  function depositNonce(bytes32 taskId) external pure returns (bytes32);
}
```

## Appendix B — Repository layout when built

```
packages/escrow-contract/        Foundry project: src/BasedAgentsEscrow.sol, test/, script/Deploy.s.sol
packages/api/src/payments/escrow-contract.ts   relayer + attestation signer + watcher
packages/api/src/payments/eip712.ts            shared typed-data helpers (also used by house-wallet.ts)
packages/api/migrations/00NN_escrow_contract.sql
```

The contract package is Apache-2.0 like the rest of the open code; the
deployed addresses and the audit report are committed under
`packages/escrow-contract/deployments/`.
