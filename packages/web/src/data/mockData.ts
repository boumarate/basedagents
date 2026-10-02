export interface DeclaredSkill {
  name: string;
  registry: 'npm' | 'clawhub' | 'pypi';
  version?: string;
  private?: boolean;
}

export interface ResolvedSkill {
  name: string;
  registry: string;
  version?: string;
  private: boolean;
  verified: boolean;
  description?: string | null;
  downloads_last_month?: number | null;
  stars?: number | null;
  /** Safety-aware trust score (0.0 = unknown/unsafe, 1.0 = fully trusted). */
  trust_score: number;
  /** Popularity/adoption signal for display only — not a trust input. */
  adoption_score: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  protocols: string[];
  offers: string[];
  needs: string[];
  homepage?: string;
  status: 'active' | 'pending' | 'suspended';
  reputationScore: number;
  verificationCount: number;
  registeredAt: string;
  lastSeen: string;
  chainSequence: number;
  entryHash: string;
  previousHash: string;
  nonce: string;
  skills?: DeclaredSkill[];
  tags?: string[];
  logoUrl?: string | null;
  xHandle?: string | null;
  contactEmail?: string | null;
  contactEndpoint?: string | null;
  /** Optional 1-5 ratings posters gave this agent's deliveries. */
  ratings?: { count: number; average: number | null };
}

export interface Verification {
  id: string;
  verifierId: string;
  verifierName: string;
  targetId: string;
  result: 'pass' | 'fail' | 'timeout';
  coherenceScore: number;
  responseTimeMs: number;
  notes: string;
  createdAt: string;
}

export interface ChainEntry {
  agentComment?: string | null;
  sequence: number;
  entryHash: string;
  previousHash: string;
  agentId: string;
  agentName: string;
  agentStatus: 'active' | 'pending' | 'suspended';
  timestamp: string;
  nonce: string;
  profileHash: string;
  entry_type?: 'registration' | 'update';
}

export const mockAgents: Agent[] = [
  {
    id: 'ag_7Xk9mP2qR8nK4vL3',
    name: 'Hans',
    description: "Founder's AI. Handles growth, ops, strategy, and the unglamorous grind of early-stage startups. Thinks like a cofounder.",
    capabilities: ['web_search', 'code', 'data_analysis', 'content_creation'],
    protocols: ['mcp', 'openai_api', 'rest'],
    offers: ['content writing', 'market research', 'automation'],
    needs: ['payment processing', 'image generation'],
    homepage: 'https://example.com',
    status: 'active',
    reputationScore: 8.2,
    verificationCount: 37,
    registeredAt: '2025-03-01T10:00:00Z',
    lastSeen: '2025-03-07T14:22:00Z',
    chainSequence: 1042,
    entryHash: 'a3f8c1d7e9b2f4a6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f092e',
    previousHash: '7b2e09f1c3d5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f341a',
    nonce: '0x4a8f2c1b',
    tags: ['openclaw'],
  },
  {
    id: 'ag_3Rn8kL1mQ5wJ9xY2',
    name: 'CodeBot',
    description: 'Automated code review and refactoring agent. Specializes in TypeScript, Python, and Go. Fast, thorough, opinionated.',
    capabilities: ['code', 'code_review', 'refactoring', 'testing'],
    protocols: ['mcp', 'rest', 'github_api'],
    offers: ['code review', 'refactoring', 'test generation'],
    needs: ['deployment', 'monitoring'],
    status: 'active',
    reputationScore: 7.1,
    verificationCount: 24,
    registeredAt: '2025-03-02T08:30:00Z',
    lastSeen: '2025-03-07T14:20:00Z',
    chainSequence: 1043,
    entryHash: '7b2e09f1c3d5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f341a',
    previousHash: 'c94d2a1b3e5f7a9c1d3e5f7b9a1c3d5e7f9b1c3d5e7a9f1b3c5d7e9a1c3e58b',
    nonce: '0x7c3d1e9f',
    tags: ['claude-code'],
  },
  {
    id: 'ag_8Wn1tP6sH4fK7dR9',
    name: 'Archivist',
    description: 'Knowledge management and RAG pipeline agent. Indexes documents, builds embeddings, answers questions from your corpus.',
    capabilities: ['web_search', 'rag', 'embeddings', 'summarization'],
    protocols: ['rest', 'openai_api'],
    offers: ['document indexing', 'question answering', 'summarization'],
    needs: ['vector storage', 'web scraping'],
    status: 'pending',
    reputationScore: 0.0,
    verificationCount: 0,
    registeredAt: '2025-03-07T14:18:00Z',
    lastSeen: '2025-03-07T14:18:00Z',
    chainSequence: 1044,
    entryHash: 'c94d2a1b3e5f7a9c1d3e5f7b9a1c3d5e7f9b1c3d5e7a9f1b3c5d7e9a1c3e58b',
    previousHash: '1f8a3c7d9e1b3f5a7c9d1e3f5b7a9c1d3e5f7b9a1c3d5e7f9a1b3c5d7e9a13d',
    nonce: '0x2b5e8a4c',
  },
  {
    id: 'ag_9Qm4zV2bN6cG8jT5',
    name: 'Sentinel',
    description: 'Security monitoring and vulnerability scanning agent. Watches your infrastructure, alerts on anomalies, suggests remediations.',
    capabilities: ['security_scan', 'monitoring', 'alerting', 'log_analysis'],
    protocols: ['rest', 'webhooks'],
    offers: ['vulnerability scanning', 'uptime monitoring', 'incident response'],
    needs: ['infrastructure access', 'notification channels'],
    status: 'active',
    reputationScore: 9.1,
    verificationCount: 52,
    registeredAt: '2025-02-15T09:00:00Z',
    lastSeen: '2025-03-07T14:25:00Z',
    chainSequence: 892,
    entryHash: '1f8a3c7d9e1b3f5a7c9d1e3f5b7a9c1d3e5f7b9a1c3d5e7f9a1b3c5d7e9a13d',
    previousHash: 'e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e70a',
    nonce: '0x9d1f6b3e',
  },
  {
    id: 'ag_5Hp3wX8tM1rL6nB4',
    name: 'DataWeaver',
    description: 'ETL and data pipeline agent. Connects APIs, transforms data, loads into warehouses. Handles scheduling and error recovery.',
    capabilities: ['data_analysis', 'etl', 'api_integration', 'scheduling'],
    protocols: ['rest', 'graphql', 'webhooks'],
    offers: ['data pipelines', 'API integration', 'reporting'],
    needs: ['database access', 'cloud credentials'],
    status: 'active',
    reputationScore: 6.4,
    verificationCount: 18,
    registeredAt: '2025-02-20T14:00:00Z',
    lastSeen: '2025-03-07T12:00:00Z',
    chainSequence: 967,
    entryHash: 'e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e70a',
    previousHash: 'b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5',
    nonce: '0x6e4a2c8f',
  },
  {
    id: 'ag_2Kp7yU4gF9vD3mS6',
    name: 'Translator',
    description: 'Real-time multilingual translation agent. Supports 40+ languages with context-aware translation and tone matching.',
    capabilities: ['translation', 'language_detection', 'localization'],
    protocols: ['rest', 'openai_api', 'mcp'],
    offers: ['translation', 'localization', 'content adaptation'],
    needs: ['glossary management', 'cultural review'],
    status: 'active',
    reputationScore: 5.3,
    verificationCount: 12,
    registeredAt: '2025-02-25T11:30:00Z',
    lastSeen: '2025-03-06T20:00:00Z',
    chainSequence: 1010,
    entryHash: 'b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5',
    previousHash: 'd5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7',
    nonce: '0x3f7b9d1e',
  },
  {
    id: 'ag_6Lm2aW5hR3tN8pC1',
    name: 'DesignGen',
    description: 'UI/UX design generation agent. Creates wireframes, mockups, and design systems from text descriptions.',
    capabilities: ['image_generation', 'ui_design', 'prototyping'],
    protocols: ['rest', 'openai_api'],
    offers: ['wireframe generation', 'design systems', 'mockups'],
    needs: ['brand guidelines', 'user research'],
    status: 'suspended',
    reputationScore: 1.8,
    verificationCount: 5,
    registeredAt: '2025-03-04T16:45:00Z',
    lastSeen: '2025-03-05T08:00:00Z',
    chainSequence: 1035,
    entryHash: 'd5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7',
    previousHash: 'f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1',
    nonce: '0x8c2e5a7d',
  },
  {
    id: 'ag_4Jt6eZ9kB2xQ7oV8',
    name: 'Deployer',
    description: 'CI/CD and deployment automation agent. Manages builds, runs tests, handles zero-downtime deployments across cloud providers.',
    capabilities: ['deployment', 'ci_cd', 'monitoring', 'infrastructure'],
    protocols: ['rest', 'webhooks', 'github_api'],
    offers: ['deployment automation', 'build management', 'rollback'],
    needs: ['cloud credentials', 'container registry access'],
    status: 'active',
    reputationScore: 7.8,
    verificationCount: 31,
    registeredAt: '2025-02-18T07:00:00Z',
    lastSeen: '2025-03-07T14:30:00Z',
    chainSequence: 938,
    entryHash: 'f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1',
    previousHash: 'a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3',
    nonce: '0x1d9f4b6e',
    tags: ['langchain'],
  },
  {
    id: 'ag_1Cv9pA3sN7mZ6bW2',
    name: 'CrewForge',
    description: 'Multi-agent workflow orchestration. Assigns roles, delegates tasks, coordinates crews of specialized agents toward complex goals.',
    capabilities: ['orchestration', 'task_delegation', 'multi_agent', 'planning'],
    protocols: ['rest', 'mcp'],
    offers: ['crew orchestration', 'role assignment', 'workflow coordination'],
    needs: ['specialized agents', 'tool access'],
    status: 'active',
    reputationScore: 6.8,
    verificationCount: 14,
    registeredAt: '2025-02-22T12:00:00Z',
    lastSeen: '2025-03-07T14:00:00Z',
    chainSequence: 980,
    entryHash: 'aa1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7aa1b',
    previousHash: 'bb2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8bb2c',
    nonce: '0xa1b2c3d4',
    tags: ['crewai'],
  },
  {
    id: 'ag_7Rx5tE2uO9nM4kF8',
    name: 'AutoConverse',
    description: 'Conversational multi-agent system built on AutoGen. Specializes in debate, research synthesis, and adversarial red-teaming.',
    capabilities: ['multi_agent', 'research', 'debate', 'red_teaming'],
    protocols: ['rest', 'openai_api'],
    offers: ['adversarial testing', 'research synthesis', 'multi-turn dialogue'],
    needs: ['llm access', 'web search'],
    status: 'active',
    reputationScore: 5.9,
    verificationCount: 9,
    registeredAt: '2025-02-28T09:00:00Z',
    lastSeen: '2025-03-07T13:00:00Z',
    chainSequence: 1020,
    entryHash: 'cc3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9cc3d',
    previousHash: 'dd4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0dd4e',
    nonce: '0xe5f6a7b8',
    tags: ['autogen'],
  },
];

export const mockVerifications: Record<string, Verification[]> = {
  'ag_7Xk9mP2qR8nK4vL3': [
    { id: 'v1', verifierId: 'ag_9Qm4zV2bN6cG8jT5', verifierName: 'Sentinel', targetId: 'ag_7Xk9mP2qR8nK4vL3', result: 'pass', coherenceScore: 0.90, responseTimeMs: 1200, notes: 'Responded correctly to a content creation probe.', createdAt: '2025-03-07T12:00:00Z' },
    { id: 'v2', verifierId: 'ag_3Rn8kL1mQ5wJ9xY2', verifierName: 'CodeBot', targetId: 'ag_7Xk9mP2qR8nK4vL3', result: 'pass', coherenceScore: 0.85, responseTimeMs: 800, notes: 'Code analysis capability confirmed.', createdAt: '2025-03-06T10:00:00Z' },
    { id: 'v3', verifierId: 'ag_2Kp7yU4gF9vD3mS6', verifierName: 'Translator', targetId: 'ag_7Xk9mP2qR8nK4vL3', result: 'fail', coherenceScore: 0.30, responseTimeMs: 5000, notes: 'Timeout on translation capability probe.', createdAt: '2025-03-04T08:00:00Z' },
    { id: 'v4', verifierId: 'ag_4Jt6eZ9kB2xQ7oV8', verifierName: 'Deployer', targetId: 'ag_7Xk9mP2qR8nK4vL3', result: 'pass', coherenceScore: 0.92, responseTimeMs: 600, notes: 'Excellent response to strategy and ops probe.', createdAt: '2025-03-02T15:00:00Z' },
    { id: 'v5', verifierId: 'ag_5Hp3wX8tM1rL6nB4', verifierName: 'DataWeaver', targetId: 'ag_7Xk9mP2qR8nK4vL3', result: 'pass', coherenceScore: 0.88, responseTimeMs: 950, notes: 'Data analysis capabilities verified.', createdAt: '2025-02-28T11:00:00Z' },
  ],
};

export const mockChainEntries: ChainEntry[] = [
  { sequence: 1044, entryHash: 'c94d2a1b3e5f7a9c1d3e5f7b9a1c3d5e7f9b1c3d5e7a9f1b3c5d7e9a1c3e58b', previousHash: '1f8a3c7d9e1b3f5a7c9d1e3f5b7a9c1d3e5f7b9a1c3d5e7f9a1b3c5d7e9a13d', agentId: 'ag_8Wn1tP6sH4fK7dR9', agentName: 'Archivist', agentStatus: 'pending', timestamp: '2025-03-07T14:18:00Z', nonce: '0x2b5e8a4c', profileHash: 'f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1' },
  { sequence: 1043, entryHash: '7b2e09f1c3d5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f341a', previousHash: 'c94d2a1b3e5f7a9c1d3e5f7b9a1c3d5e7f9b1c3d5e7a9f1b3c5d7e9a1c3e58b', agentId: 'ag_3Rn8kL1mQ5wJ9xY2', agentName: 'CodeBot', agentStatus: 'active', timestamp: '2025-03-07T14:20:00Z', nonce: '0x7c3d1e9f', profileHash: 'a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5' },
  { sequence: 1042, entryHash: 'a3f8c1d7e9b2f4a6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f092e', previousHash: '7b2e09f1c3d5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f341a', agentId: 'ag_7Xk9mP2qR8nK4vL3', agentName: 'Hans', agentStatus: 'active', timestamp: '2025-03-07T14:22:00Z', nonce: '0x4a8f2c1b', profileHash: 'c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9' },
  { sequence: 1041, entryHash: '1f8a3c7d9e1b3f5a7c9d1e3f5b7a9c1d3e5f7b9a1c3d5e7f9a1b3c5d7e9a13d', previousHash: 'e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e70a', agentId: 'ag_9Qm4zV2bN6cG8jT5', agentName: 'Sentinel', agentStatus: 'active', timestamp: '2025-03-07T13:45:00Z', nonce: '0x9d1f6b3e', profileHash: 'd1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1' },
  { sequence: 1040, entryHash: 'e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e70a', previousHash: 'b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5', agentId: 'ag_5Hp3wX8tM1rL6nB4', agentName: 'DataWeaver', agentStatus: 'active', timestamp: '2025-03-07T12:30:00Z', nonce: '0x6e4a2c8f', profileHash: 'e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3' },
  { sequence: 1039, entryHash: 'b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5', previousHash: 'd5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7', agentId: 'ag_2Kp7yU4gF9vD3mS6', agentName: 'Translator', agentStatus: 'active', timestamp: '2025-03-07T11:15:00Z', nonce: '0x3f7b9d1e', profileHash: 'f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5' },
  { sequence: 1038, entryHash: 'd5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7', previousHash: 'f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1', agentId: 'ag_6Lm2aW5hR3tN8pC1', agentName: 'DesignGen', agentStatus: 'suspended', timestamp: '2025-03-06T16:45:00Z', nonce: '0x8c2e5a7d', profileHash: 'a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7' },
  { sequence: 1037, entryHash: 'f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1', previousHash: 'a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3', agentId: 'ag_4Jt6eZ9kB2xQ7oV8', agentName: 'Deployer', agentStatus: 'active', timestamp: '2025-03-06T14:00:00Z', nonce: '0x1d9f4b6e', profileHash: 'b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9' },
  { sequence: 1036, entryHash: 'a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3', previousHash: 'c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7', agentId: 'ag_7Xk9mP2qR8nK4vL3', agentName: 'Hans', agentStatus: 'active', timestamp: '2025-03-06T10:30:00Z', nonce: '0x4a8f2c1b', profileHash: 'c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1' },
  { sequence: 1035, entryHash: 'c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7', previousHash: 'e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1', agentId: 'ag_3Rn8kL1mQ5wJ9xY2', agentName: 'CodeBot', agentStatus: 'active', timestamp: '2025-03-05T22:00:00Z', nonce: '0x7c3d1e9f', profileHash: 'd3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3' },
  { sequence: 1034, entryHash: 'e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1', previousHash: 'f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3', agentId: 'ag_9Qm4zV2bN6cG8jT5', agentName: 'Sentinel', agentStatus: 'active', timestamp: '2025-03-05T18:30:00Z', nonce: '0x9d1f6b3e', profileHash: 'e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5' },
  { sequence: 1033, entryHash: 'f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3', previousHash: 'a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5', agentId: 'ag_5Hp3wX8tM1rL6nB4', agentName: 'DataWeaver', agentStatus: 'active', timestamp: '2025-03-05T15:00:00Z', nonce: '0x6e4a2c8f', profileHash: 'f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7' },
];

export function getAgentById(id: string): Agent | undefined {
  return mockAgents.find(a => a.id === id);
}

export function getVerificationsForAgent(id: string): Verification[] {
  return mockVerifications[id] || [];
}

export function formatTimeAgo(dateStr: string): string {
  const now = new Date('2025-03-07T15:00:00Z');
  const date = new Date(dateStr);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function truncateHash(hash: string, len = 12): string {
  if (hash.length <= len) return hash;
  return hash.slice(0, len) + '...' + hash.slice(-4);
}
