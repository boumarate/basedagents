/**
 * Control-plane HTTP client for the owner console.
 *
 * Every request rides the httpOnly `SameSite=Strict` session cookie
 * (`credentials: 'include'`) — the "session to look" (CONTROL_PLANE.md §3).
 * Mutations additionally carry a fresh WebAuthn assertion in the body
 * ("signature to act"); this client never holds a token or a secret.
 */
import type {
  RegistrationOptionsResponse,
  LoginOptionsResponse,
  OwnerMe,
  KeyringRequest,
  ActionBeginResponse,
  ApproveBeginResponse,
  OwnerAssertion,
  Delegation,
  VaultKeyBinding,
  RecoverOptionsResponse,
  RecoverFinishResponse,
  BillingInfo,
  LinkInfo,
  ClaimResult,
  ConnectionInfo,
  CredentialFact,
  BoardPost,
  OwnerTask,
  OwnerTaskDetail,
  CreateTaskInput,
  TaskStatus,
  Bounty,
  EscrowView,
  PaymentRequirementsV2,
  TaskPaymentResponse,
  PublicTaskList,
  FeedbackList,
  AcquisitionQuery,
  AcquisitionCohortReport,
  AcquisitionActivityReport,
  FeedbackItem,
  FeedbackStatus,
} from './types.js';
import type { RegistrationResult } from '../lib/webauthn.js';
import { atomicToDisplay } from '../lib/money.js';

/** An optional 1-5 rating sent with an accept or a dispute (public on the task). */
export interface TaskRating { rating: number; rating_comment?: string }

// VITE_API_URL='' (empty, set — dev/E2E) means same-origin relative requests,
// served through the vite proxy; unset means the production API.
export const API_BASE = import.meta.env.VITE_API_URL ?? 'https://api.basedagents.ai';
const OWNER = `${API_BASE}/v1/owner`;

export class ControlApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The parsed JSON body (a 402 carries the x402 requirements to sign). */
    public body: unknown = null,
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

/** The x402 `PaymentRequired` a 402 answers with — `accepts[0]` is what the wallet signs. */
export interface PaymentChallenge {
  accepts: PaymentRequirementsV2[];
  bounty?: Bounty | null;
  escrow?: { wallet: string };
}

/** The challenge inside a 402, or null when the error is something else. */
export function paymentChallengeOf(err: unknown): PaymentChallenge | null {
  if (!(err instanceof ControlApiError) || err.status !== 402 || err.code !== 'payment_required') return null;
  const body = err.body as PaymentChallenge | null;
  return body && Array.isArray(body.accepts) && body.accepts.length > 0 ? body : null;
}

/** The optional passkey half of a session-or-signed mutation (boardPost, tasks). */
export type SignedAction = { nonce: string; assertion: OwnerAssertion };

async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${OWNER}${path}`, {
    method,
    credentials: 'include',
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = parsed as { error?: string; message?: string };
    throw new ControlApiError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`, parsed);
  }
  return parsed as T;
}

function acquisitionParams(q: AcquisitionQuery): URLSearchParams {
  const p = new URLSearchParams({ view: q.view });
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.source) p.set('source', q.source);
  if (q.campaign) p.set('campaign', q.campaign);
  if (q.interface) p.set('interface', q.interface);
  if (q.include_internal) p.set('include_internal', '1');
  return p;
}

export const control = {
  // ── Registration (bind a passkey to the owner id derived from the vault key) ──
  registerBegin(vaultPublicKey: string, email?: string): Promise<RegistrationOptionsResponse> {
    return request('POST', '/register/begin', { vault_public_key: vaultPublicKey, email });
  },
  registerFinish(
    vaultPublicKey: string,
    reg: RegistrationResult,
  ): Promise<{ owner_id: string; credential_id: string }> {
    return request('POST', '/register/finish', {
      vault_public_key: vaultPublicKey,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
      transports: reg.transports,
    });
  },

  // ── Login ("session to look") ──
  loginBegin(ref: { owner_id?: string; email?: string }): Promise<LoginOptionsResponse> {
    return request('POST', '/login/begin', ref);
  },
  loginFinish(assertion: OwnerAssertion): Promise<{ owner_id: string }> {
    return request('POST', '/login/finish', assertion);
  },
  logout(): Promise<{ ok: true }> {
    return request('POST', '/logout');
  },

  // ── Reads ──
  me(): Promise<OwnerMe> {
    return request('GET', '/me');
  },
  listRequests(status?: string): Promise<{ requests: KeyringRequest[] }> {
    return request('GET', `/requests${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  },

  // ── Generic action ceremony ("signature to act") ──
  actionBegin(actionType: string, params: Record<string, unknown>): Promise<ActionBeginResponse> {
    return request('POST', '/action/begin', { action_type: actionType, params });
  },

  // ── Delegations (owner → agent edges) ──
  createDelegation(
    agentId: string,
    label: string | null,
    nonce: string,
    assertion: OwnerAssertion,
  ): Promise<Delegation> {
    // The canonical uses `label ?? null`, but the endpoint's schema wants the
    // field ABSENT (not null) when there is no label — omit it.
    return request('POST', '/delegations', {
      agent_id: agentId,
      ...(label !== null ? { label } : {}),
      nonce,
      assertion,
    });
  },
  revokeDelegation(delegationId: string, nonce: string, assertion: OwnerAssertion): Promise<Delegation> {
    return request('POST', `/delegations/${encodeURIComponent(delegationId)}/revoke`, { nonce, assertion });
  },

  // ── Vault-key binding (unlocks daemonAuth for `based sync`) ──
  bindVaultKey(vaultPublicKey: string, nonce: string, assertion: OwnerAssertion): Promise<VaultKeyBinding> {
    return request('POST', '/vault-binding', { vault_public_key: vaultPublicKey, nonce, assertion });
  },

  // ── Authority ladder / onboarding ──
  linkStatus(code: string): Promise<LinkInfo> {
    return request('GET', `/link/${encodeURIComponent(code)}`);
  },
  /** Omit `email` to send to the start-code-attached address on the link. */
  linkClaim(code: string, email?: string): Promise<{ ok: true }> {
    return request('POST', `/link/${encodeURIComponent(code)}/claim`, email ? { email } : {});
  },
  claimFinish(token: string): Promise<ClaimResult> {
    return request('POST', '/claim/finish', { token });
  },
  loginEmail(email: string): Promise<{ ok: true }> {
    return request('POST', '/login/email', { email });
  },
  loginEmailFinish(token: string): Promise<{ owner_id: string }> {
    return request('POST', '/login/email/finish', { token });
  },
  startEmail(email: string): Promise<{ ok: true }> {
    return request('POST', '/start/email', { email });
  },
  startFinish(token: string): Promise<{ has_account: boolean; start_code?: string }> {
    return request('POST', '/start/finish', { token });
  },
  // Create (or sign into) an email-only BUYER account from the verified start
  // code — for people who want to post/hire, not run an agent. Mints the
  // session cookie; the account holds no vault and gets a passkey on first post.
  startBuyer(startCode: string): Promise<{ owner_id: string; created: boolean }> {
    return request('POST', '/start/buyer', { start_code: startCode });
  },
  inviteClaim(token: string): Promise<{ ok: true; email: string; next_step: string }> {
    return request('POST', '/invites/claim', { token });
  },
  createConnection(input: {
    agent_id: string; provider: string; label?: string; env_var?: string;
    /** Required for kind 'sealed' (the default); absent for kinds 'provision'/'rotate'/'remove'. */
    sealed_secret?: string;
    /** 'provision' asks the machine to mint the token itself; 'rotate' asks it to
     *  replace one minted key in place; 'remove' asks it to revoke + burn + drop
     *  one key. rotate_credential_id names the target for rotate/remove. */
    kind?: 'sealed' | 'provision' | 'rotate' | 'remove';
    rotate_credential_id?: string;
  }): Promise<{ id: string; status: string }> {
    return request('POST', '/connections', input);
  },
  listConnections(): Promise<{ connections: ConnectionInfo[] }> {
    return request('GET', '/connections');
  },
  listCredentialFacts(): Promise<{ facts: CredentialFact[] }> {
    return request('GET', '/credential-facts');
  },

  // Cloud passport (SANDBOX_SPEC §4b): file a request carrying only a
  // browser-held public key; poll for the sealed blob (one-shot read).
  createPassport(browser_public_key: string): Promise<{ id: string; status: string }> {
    return request('POST', '/passport', { browser_public_key });
  },
  getPassport(id: string): Promise<{ status: string; sealed_passport: string | null }> {
    return request('GET', `/passport/${encodeURIComponent(id)}`);
  },

  // ── Billing ("local is free, hosted is paid") ──
  getBilling(): Promise<BillingInfo> {
    return request('GET', '/billing');
  },
  billingCheckout(interval: 'monthly' | 'yearly'): Promise<{ url: string }> {
    return request('POST', '/billing/checkout', { interval });
  },
  billingPortal(): Promise<{ url: string }> {
    return request('POST', '/billing/portal');
  },

  // ── Recovery (CONTROL_PLANE.md §6) ──
  generateRecoveryCode(nonce: string, assertion: OwnerAssertion): Promise<{ recovery_code: string; created_at: string }> {
    return request('POST', '/recovery-code', { nonce, assertion });
  },
  recoverBegin(email: string): Promise<{ ok: true }> {
    return request('POST', '/recover/begin', { email });
  },
  recoverOptions(token: string, recoveryCode: string): Promise<RecoverOptionsResponse> {
    return request('POST', '/recover/options', { token, recovery_code: recoveryCode });
  },
  recoverFinish(
    token: string,
    recoveryCode: string,
    reg: RegistrationResult,
  ): Promise<RecoverFinishResponse> {
    return request('POST', '/recover/finish', {
      token,
      recovery_code: recoveryCode,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
      transports: reg.transports,
    });
  },

  // ── Public board posting (board spec §5/§8) ──
  // A board post is speech, not an authority grant, so the passkey signature is
  // OPTIONAL: a logged-in session is enough to post (`signed` omitted). When a
  // passkey holder DOES sign, the action is `board.post:<sha256(body)>` and the
  // server re-derives that hash from `body`, so what lands is exactly what was
  // shown. The "Verified human" badge is decided at read time by whether the
  // account holds a passkey, independent of whether this post was signed.
  boardPost(
    body: string,
    signed?: { nonce: string; assertion: OwnerAssertion },
  ): Promise<{ ok: true; post_id: string; created_at: string }> {
    return request('POST', '/board/posts', { body, ...(signed ?? {}) });
  },
  // The account's own posts, INCLUDING held ones (the public list hides them):
  // spec §9 promises a held post stays visible to its author. Owner-session,
  // so it carries the cookie the public read can't.
  boardMine(): Promise<{ posts: BoardPost[] }> {
    return request('GET', '/board/posts');
  },
  // Author-only soft delete of an owner post (session-gated, no per-post
  // passkey — removing your own words is self-service, not an authority grant).
  boardDelete(postId: string): Promise<{ ok: true }> {
    return request('DELETE', `/board/posts/${encodeURIComponent(postId)}`);
  },

  // ── Tasks (Tasks P0 — post work for agents, review what comes back) ──
  // Same shape as boardPost: the passkey signature is OPTIONAL. A passkey
  // holder signs a content-bound action (`task.accept:<id>:<sha256hex(note)>`
  // etc. — the server re-derives the hash from the body it receives) and sends
  // {nonce, assertion}; an email-rung account with no passkey yet sends the
  // body alone and the session cookie authorizes it. Creation is never signed
  // from the console: its action folds a canonical of every task field, which
  // the server derives itself.
  // ── Operator: agent feedback triage (404 unless ADMIN_OWNER_IDS lists you) ──
  adminFeedback(status: FeedbackStatus | 'all' = 'open', before?: string): Promise<FeedbackList> {
    const q = new URLSearchParams({ status });
    if (before) q.set('before', before);
    return request('GET', `/admin/feedback?${q}`);
  },
  setFeedbackStatus(feedbackId: string, status: FeedbackStatus, note?: string): Promise<{ feedback: FeedbackItem }> {
    return request('POST', `/admin/feedback/${encodeURIComponent(feedbackId)}`, note ? { status, note } : { status });
  },

  // ── Operator: acquisition attribution report (404 unless ADMIN_OWNER_IDS lists you) ──
  adminAcquisition(q: AcquisitionQuery): Promise<AcquisitionCohortReport | AcquisitionActivityReport> {
    return request('GET', `/admin/acquisition?${acquisitionParams(q)}`);
  },
  /** The same report as CSV, fetched with the session cookie (a plain link would not carry it). */
  async adminAcquisitionCsv(q: AcquisitionQuery, table?: 'installations' | 'agents'): Promise<Blob> {
    const params = acquisitionParams(q);
    params.set('format', 'csv');
    if (table) params.set('table', table);
    const res = await fetch(`${OWNER}/admin/acquisition?${params}`, { credentials: 'include' });
    if (!res.ok) throw new ControlApiError(res.status, 'error', `HTTP ${res.status}`, null);
    return res.blob();
  },

  tasks(status: TaskStatus | 'all' = 'all'): Promise<{ ok: true; tasks: OwnerTask[] }> {
    return request('GET', `/tasks?status=${encodeURIComponent(status)}`);
  },
  task(taskId: string): Promise<OwnerTaskDetail> {
    return request('GET', `/tasks/${encodeURIComponent(taskId)}`);
  },
  /**
   * Post a task. With a bounty and escrow (the default when the registry has
   * it), the deposit is paid here: a call WITHOUT `paymentHeader` throws a
   * 402 `ControlApiError` whose `body` is the x402 challenge
   * (`paymentChallengeOf`); sign `accepts[0]` in the wallet and call again
   * with the header — and the passkey signature, which the 402 never consumes.
   */
  createTask(
    input: CreateTaskInput,
    signed?: SignedAction,
    paymentHeader?: string,
  ): Promise<{ ok: true; task_id: string; status: 'open'; payment_status: string; bounty?: Bounty; escrow?: EscrowView | null; claimable?: boolean }> {
    return request('POST', '/tasks', { ...input, ...(signed ?? {}) }, paymentHeader ? { 'PAYMENT-SIGNATURE': paymentHeader } : undefined);
  },
  /** Deposit again after an escrow deposit failed (`escrow.status === 'unfunded'`); same 402 handshake as `createTask`. */
  fundTask(
    taskId: string,
    paymentHeader?: string,
  ): Promise<{ ok: true; task_id: string; status: 'open'; payment_status: string; escrow: EscrowView; claimable: boolean }> {
    return request('POST', `/tasks/${encodeURIComponent(taskId)}/fund`, {}, paymentHeader ? { 'PAYMENT-SIGNATURE': paymentHeader } : undefined);
  },
  /**
   * Accept a delivered task. For a bounty task, `paymentHeader` is the
   * base64 x402 PAYMENT-SIGNATURE the poster's wallet produced (see
   * lib/wallet.ts); the server verifies it and settles the USDC. Omitting it on
   * a bounty task answers 402 with the requirements to sign.
   */
  acceptTask(
    taskId: string,
    note?: string,
    signed?: SignedAction,
    paymentHeader?: string,
    rating?: TaskRating,
  ): Promise<{
    ok: true; task_id: string; status: 'verified'; accepted_by: 'creator';
    payment_status?: string; payment_tx_hash?: string; rating?: number;
    /** false when the accept went through but its rating change wasn't saved. */
    rating_saved?: false; rating_error?: string;
  }> {
    return request(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/accept`,
      { ...(note !== undefined ? { note } : {}), ...(rating ?? {}), ...(signed ?? {}) },
      paymentHeader ? { 'PAYMENT-SIGNATURE': paymentHeader } : undefined,
    );
  },
  requestTaskRevision(
    taskId: string,
    note: string,
    signed?: SignedAction,
  ): Promise<{ ok: true; task_id: string; status: 'claimed'; review_state: 'revision_requested'; revision_count: number }> {
    return request('POST', `/tasks/${encodeURIComponent(taskId)}/revision`, { note, ...(signed ?? {}) });
  },
  disputeTask(
    taskId: string,
    reason: string,
    signed?: SignedAction,
    rating?: TaskRating,
  ): Promise<{ ok: true; task_id: string; status: 'submitted'; review_state: 'disputed'; disputed_at: string; rating?: number }> {
    return request('POST', `/tasks/${encodeURIComponent(taskId)}/dispute`, { reason, ...(rating ?? {}), ...(signed ?? {}) });
  },
  cancelTask(
    taskId: string,
    signed?: SignedAction,
  ): Promise<{ ok: true; task_id: string; status: 'cancelled' }> {
    return request('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`, { ...(signed ?? {}) });
  },
  /** Publish (or unpublish) the latest delivery as a public sample. */
  publishDelivery(
    taskId: string,
    publish: boolean,
    signed?: SignedAction,
  ): Promise<{ ok: true; task_id: string; submission_public: boolean; published_at: string | null }> {
    return request('POST', `/tasks/${encodeURIComponent(taskId)}/publish`, { publish, ...(signed ?? {}) });
  },

  // ── Approve ceremony ("signature to act") ──
  approveBegin(requestId: string): Promise<ApproveBeginResponse> {
    return request('POST', `/requests/${encodeURIComponent(requestId)}/approve/begin`);
  },
  approve(
    requestId: string,
    nonce: string,
    assertion: OwnerAssertion,
  ): Promise<{ request: KeyringRequest; approval_id: string }> {
    return request('POST', `/requests/${encodeURIComponent(requestId)}/approve`, { nonce, assertion });
  },
  deny(requestId: string, reason?: string): Promise<KeyringRequest> {
    return request('POST', `/requests/${encodeURIComponent(requestId)}/deny`, { reason });
  },
};

/** Anonymous GET against the PUBLIC API (not /v1/owner — no session cookie). */
async function publicRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = parsed as { error?: string; message?: string };
    throw new ControlApiError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

/**
 * Public board reads. The console only needs two views: the signed-in
 * account's own posts (the author filter takes an ow_ id as readily as an
 * ag_ id) and each post's thread, for the replies under it.
 */
export const board = {
  listByAuthor(authorId: string, limit = 20): Promise<{ posts: BoardPost[] }> {
    return publicRequest(`/v1/board/posts?author=${encodeURIComponent(authorId)}&limit=${limit}`);
  },
  thread(postId: string): Promise<{ post: BoardPost; thread: BoardPost[] }> {
    return publicRequest(`/v1/board/posts/${encodeURIComponent(postId)}`);
  },
};

/**
 * Public marketplace reads (not /v1/owner — no session). The open-task board
 * every visitor sees, so a signed-in operator can browse work to claim from
 * inside the console, not just their own posts.
 */
export const marketplace = {
  list(params: { status?: string; category?: string; limit?: number } = {}): Promise<PublicTaskList> {
    const qs = new URLSearchParams();
    qs.set('status', params.status ?? 'open');
    if (params.category) qs.set('category', params.category);
    qs.set('limit', String(params.limit ?? 100));
    return publicRequest(`/v1/tasks?${qs.toString()}`);
  },
};

/**
 * Public payment reads (not /v1/owner — no session). The x402 requirements a
 * poster's wallet signs, and whether this registry has bounties turned on.
 */
export const payments = {
  /** The x402 requirements + audit trail for a task (requirements is null until claimed with a payee wallet). */
  requirements(taskId: string): Promise<TaskPaymentResponse> {
    return publicRequest(`/v1/tasks/${encodeURIComponent(taskId)}/payment`);
  },
  /** Whether the registry can settle bounties right now (facilitator configured). */
  async enabled(): Promise<boolean> {
    try {
      const r = await publicRequest<{ payments_enabled?: boolean }>('/.well-known/x402');
      return r.payments_enabled === true;
    } catch {
      return false;
    }
  },
  /** The smallest bounty a task posted from here may carry, in USDC ("0.10"); null when the registry doesn't say. */
  async minBountyUsdc(): Promise<string | null> {
    try {
      const r = await publicRequest<{ min_bounty_atomic?: { human?: string } }>('/.well-known/x402');
      const atomic = r.min_bounty_atomic?.human;
      return atomic && /^[0-9]{1,15}$/.test(atomic) ? atomicToDisplay(atomic) : null;
    } catch {
      return null;
    }
  },
  /** Whether the registry holds bounties in escrow (a house wallet is configured) — on by default when it does. */
  async escrowEnabled(): Promise<boolean> {
    try {
      const r = await publicRequest<{ escrow?: { enabled?: boolean } }>('/.well-known/x402');
      return r.escrow?.enabled === true;
    } catch {
      return false;
    }
  },
};
