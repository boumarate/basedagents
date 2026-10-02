import type {
  ApiAgent,
  ApiAgentSearchResponse,
  ApiChainEntry,
  ApiChainRangeResponse,
  ApiChainLatestResponse,
  ApiReputationResponse,
  ApiTaskListResponse,
  ApiTaskDetailResponse,
  ApiSettledResponse,
  ApiTaskReceiptsResponse,
  ApiStatusResponse,
  ApiScanReport,
  ApiScanListResponse,
  ApiBoardListResponse,
  ApiBoardThreadResponse,
  BoardListParams,
  SearchParams,
  TaskSearchParams,
  ScanSearchParams,
} from './types';
import type { Agent, Verification, ChainEntry } from '../data/mockData';

export type { SearchParams } from './types';

export const API_BASE = import.meta.env.VITE_API_URL || 'https://api.basedagents.ai';

// ─── Mappers: API (snake_case) → Frontend (camelCase) ───

export function mapApiAgentToAgent(a: ApiAgent): Agent {
  return {
    id: a.agent_id,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities,
    protocols: a.protocols,
    offers: a.offers || [],
    needs: a.needs || [],
    homepage: a.homepage ?? undefined,
    status: a.status,
    reputationScore: a.reputation_score,
    verificationCount: a.verification_count,
    registeredAt: a.registered_at,
    lastSeen: a.last_seen || a.registered_at,
    // Chain fields not available from search/profile endpoint — use defaults
    chainSequence: 0,
    entryHash: '',
    previousHash: '',
    nonce: '',
    skills: a.skills || [],
    tags: a.tags || [],
    logoUrl: a.logo_url ?? null,
    xHandle: a.x_handle ?? null,
    contactEmail: a.contact_email ?? null,
    contactEndpoint: a.contact_endpoint ?? null,
    ratings: a.ratings,
  };
}

export function mapApiVerifications(a: ApiAgent): Verification[] {
  if (!a.recent_verifications) return [];
  return a.recent_verifications.map((v, i) => ({
    id: `v${i}`,
    verifierId: v.verifier,
    verifierName: v.verifier,
    targetId: a.agent_id,
    result: v.result,
    coherenceScore: v.coherence_score ?? 0,
    responseTimeMs: 0,
    notes: '',
    createdAt: v.date,
  }));
}

export function mapApiChainEntry(e: ApiChainEntry): ChainEntry {
  return {
    sequence: e.sequence,
    entryHash: e.entry_hash,
    previousHash: e.previous_hash,
    agentId: e.agent_id,
    agentName: e.agent_name ?? '',
    agentStatus: 'active',
    agentComment: e.agent_comment ?? null,
    timestamp: e.timestamp,
    nonce: e.nonce,
    profileHash: e.profile_hash,
  };
}

// ─── API Client ───

class FetchError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new FetchError(res.status, body || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  async getAgent(id: string): Promise<ApiAgent> {
    return fetchJson<ApiAgent>(`/v1/agents/${encodeURIComponent(id)}`);
  },

  async searchAgents(params: SearchParams = {}): Promise<ApiAgentSearchResponse> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.capabilities) qs.set('capabilities', params.capabilities);
    if (params.protocols) qs.set('protocols', params.protocols);
    if (params.offers) qs.set('offers', params.offers);
    if (params.needs) qs.set('needs', params.needs);
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.sort) qs.set('sort', params.sort);
    const query = qs.toString();
    return fetchJson<ApiAgentSearchResponse>(`/v1/agents/search${query ? '?' + query : ''}`);
  },

  async getChainLatest(): Promise<ApiChainLatestResponse> {
    return fetchJson<ApiChainLatestResponse>('/v1/chain/latest');
  },

  async getChainEntry(sequence: number): Promise<ApiChainEntry> {
    return fetchJson<ApiChainEntry>(`/v1/chain/${sequence}`);
  },

  async getChainRange(from?: number, to?: number): Promise<ApiChainRangeResponse> {
    const qs = new URLSearchParams();
    if (from !== undefined) qs.set('from', String(from));
    if (to !== undefined) qs.set('to', String(to));
    const query = qs.toString();
    return fetchJson<ApiChainRangeResponse>(`/v1/chain${query ? '?' + query : ''}`);
  },

  async getReputation(id: string): Promise<ApiReputationResponse> {
    return fetchJson<ApiReputationResponse>(`/v1/agents/${encodeURIComponent(id)}/reputation`);
  },

  async getStatus(): Promise<ApiStatusResponse> {
    return fetchJson<ApiStatusResponse>('/v1/status');
  },

  async getTasks(params: TaskSearchParams = {}): Promise<ApiTaskListResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.category) qs.set('category', params.category);
    if (params.capability) qs.set('capability', params.capability);
    // Server-side filters on creator_agent_id / claimed_by_agent_id (TaskQuerySchema).
    if (params.creator) qs.set('creator', params.creator);
    if (params.claimer) qs.set('claimer', params.claimer);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return fetchJson<ApiTaskListResponse>(`/v1/tasks${query ? '?' + query : ''}`);
  },

  /** Recently paid tasks + time-to-paid stats (one request serves the homepage section). */
  async getSettledTasks(params: { limit?: number; cursor?: string | null; window_days?: number } = {}): Promise<ApiSettledResponse> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.window_days !== undefined) qs.set('window_days', String(params.window_days));
    const query = qs.toString();
    return fetchJson<ApiSettledResponse>(`/v1/tasks/settled${query ? '?' + query : ''}`);
  },

  async getTask(id: string): Promise<ApiTaskDetailResponse> {
    return fetchJson<ApiTaskDetailResponse>(`/v1/tasks/${encodeURIComponent(id)}`);
  },

  /** Every delivery receipt for a task, newest first (a revision round adds one). */
  async getTaskReceipts(id: string): Promise<ApiTaskReceiptsResponse> {
    return fetchJson<ApiTaskReceiptsResponse>(`/v1/tasks/${encodeURIComponent(id)}/receipts`);
  },

  async getScanReport(identifier: string, version?: string): Promise<ApiScanReport> {
    // identifier can be "lodash", "github:owner/repo", "pypi:requests", etc.
    const encoded = encodeURIComponent(identifier);
    const qs = version ? `?version=${encodeURIComponent(version)}` : '';
    return fetchJson<ApiScanReport>(`/v1/scan/${encoded}${qs}`);
  },

  async listScanReports(params: ScanSearchParams = {}): Promise<ApiScanListResponse> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.sort) qs.set('sort', params.sort);
    if (params.source) qs.set('source', params.source);
    const query = qs.toString();
    return fetchJson<ApiScanListResponse>(`/v1/scan${query ? '?' + query : ''}`);
  },

  async triggerScan(
    packageOrOptions: string | {
      source?: 'npm' | 'github' | 'pypi';
      target: string;
      version?: string;
      ref?: string;
    },
    version?: string,
  ): Promise<{
    ok: boolean;
    source?: string;
    id?: string;
    package_name?: string;
    package_version?: string;
    score?: number;
    grade?: string;
    finding_count?: number;
    critical_high_count?: number;
    report_url?: string;
    error?: string;
    message?: string;
  }> {
    let body: Record<string, unknown>;

    if (typeof packageOrOptions === 'string') {
      // Legacy call: triggerScan(packageName, version?)
      body = { package: packageOrOptions };
      if (version) body.version = version;
    } else {
      const opts = packageOrOptions;
      if (opts.source && opts.source !== 'npm') {
        body = { source: opts.source, target: opts.target };
        if (opts.ref) body.ref = opts.ref;
      } else {
        body = { package: opts.target };
        if (opts.version) body.version = opts.version;
      }
    }

    const res = await fetch(`${API_BASE}/v1/scan/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  async rescanPackage(identifier: string): Promise<{
    ok: boolean;
    package_name?: string;
    score?: number;
    grade?: string;
    finding_count?: number;
    scanner_version?: number;
    error?: string;
    message?: string;
  }> {
    const res = await fetch(`${API_BASE}/v1/scan/${encodeURIComponent(identifier)}/rescan`, {
      method: 'POST',
    });
    return res.json();
  },

  async getBoardPosts(params: BoardListParams = {}): Promise<ApiBoardListResponse> {
    const qs = new URLSearchParams();
    if (params.after) qs.set('after', params.after);
    if (params.before) qs.set('before', params.before);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.author) qs.set('author', params.author);
    // Only sent when ON — the server treats absence as "everything", which is
    // also the launch default (a certified-only default is an empty board).
    if (params.certified_only) qs.set('certified_only', 'true');
    if (params.thread) qs.set('thread', params.thread);
    const query = qs.toString();
    return fetchJson<ApiBoardListResponse>(`/v1/board/posts${query ? '?' + query : ''}`);
  },

  async getBoardPost(id: string): Promise<ApiBoardThreadResponse> {
    // Returns the post plus its full thread (seq ASC, root first).
    return fetchJson<ApiBoardThreadResponse>(`/v1/board/posts/${encodeURIComponent(id)}`);
  },

  async probeAgent(agentId: string, method: string, params: Record<string, unknown> = {}): Promise<{
    ok: boolean;
    response_time_ms?: number;
    status_code?: number;
    body?: unknown;
    error?: string;
    message?: string;
  }> {
    const res = await fetch(`${API_BASE}/v1/agents/${encodeURIComponent(agentId)}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    return res.json();
  },
};
