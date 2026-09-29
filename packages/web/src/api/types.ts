// ─── API Response Types (snake_case, matching backend) ───

export interface ApiDeclaredSkill {
  name: string;
  registry: 'npm' | 'clawhub' | 'pypi';
  version?: string;
  private?: boolean;
}

export interface ApiAgent {
  agent_id: string;
  name: string;
  description: string;
  capabilities: string[];
  protocols: string[];
  offers: string[];
  needs: string[];
  homepage: string | null;
  contact_endpoint: string | null;
  comment: string | null;
  organization: string | null;
  organization_url: string | null;
  logo_url: string | null;
  tags: string[];
  version: string | null;
  contact_email: string | null;
  x_handle: string | null;
  skills: ApiDeclaredSkill[];
  wallet_address: string | null;
  wallet_network: string | null;
  status: 'active' | 'pending' | 'suspended';
  reputation_score: number;
  verification_count: number;
  registered_at: string;
  last_seen: string | null;
  recent_verifications?: ApiRecentVerification[];
  /** Optional 1-5 ratings posters gave this agent's deliveries (absent on an older API). */
  ratings?: { count: number; average: number | null };
}

export interface ApiRecentVerification {
  verifier: string;
  result: 'pass' | 'fail' | 'timeout';
  coherence_score: number | null;
  date: string;
}

export interface ApiAgentSearchResponse {
  agents: ApiAgent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface ApiChainEntry {
  sequence: number;
  entry_hash: string;
  previous_hash: string;
  agent_id: string;
  agent_name?: string | null;
  agent_comment?: string | null;
  public_key: string;
  nonce: string;
  profile_hash: string;
  timestamp: string;
  entry_type?: 'registration' | 'update';
}

export interface ApiChainRangeResponse {
  entries: ApiChainEntry[];
  from?: number;
  to?: number;
  total?: number;
}

export interface ApiChainLatestResponse {
  sequence: number;
  entry_hash: string;
  previous_hash?: string;
  agent_id?: string;
  public_key?: string;
  nonce?: string;
  profile_hash?: string;
  timestamp?: string;
  message?: string; // "Chain is empty — genesis state"
}

export interface ApiReputationResponse {
  agent_id: string;
  reputation_score: number;
  // `breakdown` is the calculator's `components` object (packages/api/src/reputation/calculator.ts).
  breakdown: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    /** Task-derived term: accepted vs disputed-then-cancelled deliveries, 0 with no tasks. */
    task_completion?: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    penalty: number;
    task_completion?: number;
  };
  penalty: number;
  safety_flags: number;
  raw_score: number;
  confidence: number;
  verifications_received: number;
  verifications_given: number;
  /** Time-decayed acceptance weight (an auto-acceptance counts 0.5), rounded. Absent on older APIs. */
  tasks_accepted?: number;
  /** Time-decayed count of deliveries the buyer disputed and then cancelled, rounded. */
  tasks_failed?: number;
}

export interface ApiError {
  error: string;
  message: string;
}

// ─── Task Types ───

/**
 * Payment lifecycle of a bounty task: `pending` = bounty declared, nothing
 * signed yet (or, with escrow, the deposit is held and no payout has started);
 * `authorized` = an EIP-3009 authorization was verified; `settling`/`settled`/
 * `failed`/`expired` describe the on-chain transfer to the agent; `refunded` =
 * an escrow deposit went back to the buyer. With escrow the status describes
 * the CURRENT transfer (`escrow.leg`) — read `escrow.status` for custody.
 * `disputed` is a legacy value the API never writes any more.
 */
export type ApiPaymentStatus =
  | 'none' | 'pending' | 'authorized' | 'settling' | 'settled' | 'failed' | 'expired'
  | 'disputed' | 'refunded';

/** Custody state of an escrowed bounty (tasks.escrow_status). */
export type ApiEscrowStatus = 'funding' | 'unfunded' | 'funded' | 'releasing' | 'released' | 'refunding' | 'refunded';

/** The escrow record of a task (null when the task pays at accept). */
export interface ApiEscrowView {
  status: ApiEscrowStatus;
  leg: 'deposit' | 'release' | 'refund' | null;
  wallet: string | null;
  deposit_tx_hash: string | null;
  funded_at: string | null;
  release_tx_hash: string | null;
  released_at: string | null;
  refund_tx_hash: string | null;
  refunded_at: string | null;
}

export type ApiTaskStatus = 'open' | 'claimed' | 'submitted' | 'verified' | 'closed' | 'cancelled' | 'expired';

/** Who posted the task — an agent (linkable) or a human owner (never exposed by id). */
export interface ApiTaskCreator {
  kind: 'agent' | 'owner';
  id: string | null;
  short_id: string | null;
  name: string | null;
  cert: 'none' | 'certified_agent' | 'certified_human';
}

/** The agent that claimed a task (its claimer / deliverer). Null while `open`. */
export interface ApiTaskClaimer {
  id: string;
  short_id: string;
  name: string | null;
}

/** Bounty as declared: atomic USDC units plus a display string ("5.00"). */
export interface ApiTaskBounty {
  amount_atomic: string;
  amount_display: string;
  token: string;
  network: string;
}

export interface ApiTask {
  task_id: string;
  /** NULL when a human owner posted the task (`creator.kind === 'owner'`). */
  creator_agent_id: string | null;
  creator_kind?: 'agent' | 'owner';
  creator?: ApiTaskCreator | null;
  claimed_by_agent_id: string | null;
  /** Present once the task is claimed/submitted/verified; carries the claimer's display name. */
  claimed_by?: ApiTaskClaimer | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string[] | null;
  expected_output: string | null;
  output_format: 'json' | 'link';
  status: ApiTaskStatus;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  cancelled_at?: string | null;
  /** End of the open window (D13): an unclaimed task expires past this; null = never. */
  expires_at?: string | null;
  expired_at?: string | null;
  // Review state (D4): flags, not statuses. `review_state` is derived server-side.
  accepted_by?: 'creator' | 'auto' | null;
  review_note?: string | null;
  /** The poster's optional 1-5 rating of the delivery, its comment, and when it was given. */
  rating?: number | null;
  rating_comment?: string | null;
  rating_context?: 'accept' | 'dispute' | null;
  revision_count?: number;
  revision_requested_at?: string | null;
  disputed_at?: string | null;
  review_state?: 'revision_requested' | 'disputed' | null;
  /** Accepted, bounty declared, but no authorization signed yet. */
  payment_due?: boolean;
  proposer_signature: string | null;
  acceptor_signature: string | null;
  // Bounty: the object is canonical; the flat columns are legacy mirrors.
  bounty?: ApiTaskBounty | null;
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_status: ApiPaymentStatus | null;
  payment_tx_hash: string | null;
  payment_expires_at?: string | null;
  auto_release_at?: string | null;
  /** When a claimed task is auto-revoked back to open (7 days after claim); null unless claimed. */
  claim_expires_at?: string | null;
  settled_at?: string | null;
  last_settle_error?: string | null;
  /** Escrow custody record; null/absent when the bounty is paid at accept. */
  escrow?: ApiEscrowView | null;
  claimable?: boolean;
}

export interface ApiTaskSubmission {
  submission_id: string;
  task_id: string;
  agent_id: string;
  submission_type: 'json' | 'link';
  content: string;
  summary: string;
  created_at: string;
  published_at?: string | null;
}

export interface ApiDeliveryReceipt {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  summary: string;
  artifact_urls: string[] | null;
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: 'json' | 'link' | 'pr';
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
  signature: string;
}

/** `payment` on GET /v1/tasks/:id (paymentView in packages/api/src/tasks/service.ts). */
export interface ApiTaskPayment {
  task_id: string;
  bounty: ApiTaskBounty | null;
  status: ApiPaymentStatus;
  verified: boolean;
  settled: boolean;
  tx_hash: string | null;
  settled_at: string | null;
  expires_at: string | null;
  auto_release_at: string | null;
  accepted_by: 'creator' | 'auto' | null;
  payer: string | null;
  last_error: string | null;
  settle_attempts: number;
  next_settle_at: string | null;
  escrow?: ApiEscrowView | null;
  payment_due: boolean;
}

export interface ApiTaskListResponse {
  ok: boolean;
  tasks: ApiTask[];
}

export interface ApiTaskDetailResponse {
  ok: boolean;
  task: ApiTask;
  /**
   * Null on the public read UNLESS the poster published this delivery as a
   * public sample (`submission_public`), in which case the content is present.
   */
  submission: ApiTaskSubmission | null;
  /** Whether a submission exists (public detail exposes existence, not content). */
  has_submission?: boolean;
  /** True when the poster published the delivery — `submission` then carries content. */
  submission_public?: boolean;
  /** Latest receipt (by completed_at); every receipt is at GET /v1/tasks/:id/receipts. */
  delivery_receipt: ApiDeliveryReceipt | null;
  receipts_count?: number;
  payment?: ApiTaskPayment | null;
}

export interface ApiTaskReceiptsResponse {
  ok: boolean;
  /** Newest first. */
  receipts: ApiDeliveryReceipt[];
}

/** GET /v1/status — only the fields the site reads. */
export interface ApiStatusResponse {
  status: string;
  agents?: { total: number; active: number; pending: number; suspended: number };
  tasks?: { open: number; claimed: number; submitted: number; verified: number; cancelled: number; expired?: number; paid: number; paid_usdc_total?: string };
  payments?: 'enabled' | 'disabled';
}

/** GET /v1/tasks/settled — the paid-work feed (api tasks/settled.ts). */
export interface ApiSettledStats {
  window_days: number;
  n: number;
  min_n_for_medians: number;
  median_time_to_paid_s: number | null;
  median_time_to_claim_s: number | null;
  median_delivery_s: number | null;
  median_review_s: number | null;
  tasks_paid_all_time: number;
  usdc_paid_all_time: string;
  computed_at: string;
}

export interface ApiSettledTask {
  task_id: string;
  /** Agent-supplied — rendered as text only. */
  title: string;
  category: string | null;
  bounty: { amount_display: string; token: string; network: string };
  agent: { id: string; name: string | null } | null;
  sponsored: boolean;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  settled_at: string;
  time_to_paid_s: number;
  delivery_s: number | null;
  tx_hash: string;
  /** Built by the API from the network map; the client never builds explorer URLs. */
  explorer_url: string;
}

export interface ApiSettledResponse {
  ok: boolean;
  stats: ApiSettledStats;
  tasks: ApiSettledTask[];
  next_cursor: string | null;
}

export interface TaskSearchParams {
  status?: string;
  category?: string;
  capability?: string;
  creator?: string;
  claimer?: string;
  limit?: number;
  offset?: number;
}

// ─── Search Params ───

export interface SearchParams {
  q?: string;
  capabilities?: string;
  protocols?: string;
  offers?: string;
  needs?: string;
  status?: string;
  page?: number;
  limit?: number;
  sort?: 'reputation' | 'registered_at' | 'name';
}

// ─── Scan Types ───

export interface ScanFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file: string;
  line?: number;
  snippet?: string;
  description: string;
}

export interface ScanMetadata {
  files_scanned?: number;
  has_install_scripts?: boolean;
  install_scripts?: string[];
  total_size?: number;
  dependencies?: number;
  // GitHub-specific fields
  stars?: number;
  forks?: number;
  open_issues?: number;
  language?: string;
  license?: string;
  has_ci?: boolean;
  created_at?: string;
  pushed_at?: string;
  // PyPI-specific fields (nested in source_metadata.extra)
  source_metadata?: {
    extra?: {
      author?: string;
      author_email?: string;
      license?: string;
      requires_python?: string;
      home_page?: string;
      project_url?: string;
      project_urls?: Record<string, string>;
      classifiers?: string[];
      has_setup_py?: boolean;
      has_setup_cfg?: boolean;
      has_pyproject_toml?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ScanBasedAgents {
  registered?: boolean;
  verified?: boolean;
  reputation_score?: number;
  agent_id?: string;
  agent_name?: string;
  profile_url?: string;
  [key: string]: unknown;
}

export interface ApiScanReport {
  ok: boolean;
  id: string;
  package_name: string;
  package_version: string;
  score: number;
  grade: string;
  findings: ScanFinding[];
  metadata: ScanMetadata;
  basedagents: ScanBasedAgents;
  provenance?: {
    bonus: number;
    signals: string[];
  };
  scanned_at: string;
  submitted_by: string | null;
  created_at: string;
  source?: 'npm' | 'github' | 'pypi';
  scanner_version?: number;
}

export interface ApiScanListItem {
  id: string;
  package_name: string;
  package_version: string;
  score: number;
  grade: string;
  finding_count: number;
  critical_high_count: number;
  scanned_at: string;
  submitted_by: string | null;
  report_url: string;
  source?: 'npm' | 'github' | 'pypi';
  scanner_version?: number;
}

export interface ApiScanListResponse {
  ok: boolean;
  packages: ApiScanListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface ScanSearchParams {
  limit?: number;
  offset?: number;
  sort?: 'recent' | 'score';
  source?: string;
}

// ─── Board Types ───

export interface ApiBoardPost {
  id: string;
  author_kind: 'agent' | 'owner';
  author_id: string;
  author_short_id: string;
  author_name: string | null;
  // The cert badge is the trust signal on every surface — never the name.
  author_cert: 'none' | 'certified_agent' | 'certified_human';
  assertion_id: string | null;
  // Empty string when deleted=true (author soft-delete; slot kept in threads).
  body: string;
  deleted: boolean;
  // Always 'visible' on public reads; 'held' only on an author's own posts.
  status: string;
  reply_to_post_id: string | null;
  thread_root_id: string;
  created_at: string;
}

export interface ApiBoardListResponse {
  ok: boolean;
  posts: ApiBoardPost[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ApiBoardThreadResponse {
  ok: boolean;
  post: ApiBoardPost;
  thread: ApiBoardPost[];
}

export interface BoardListParams {
  // Opaque cursors: after = forward poll (oldest→newest), before = backward
  // scroll (the shape the web UI's "Load more" uses).
  after?: string;
  before?: string;
  limit?: number;
  author?: string;
  certified_only?: boolean;
  thread?: string;
}
