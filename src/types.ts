export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CredentialType = "api_key" | "oauth" | "token";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  email?: string;
  metadata?: Record<string, string>;
};

export type TokenCredential = {
  type: "token";
  provider: string;
  token?: string;
  tokenRef?: SecretRef;
  expires?: number;
  email?: string;
};

export type OAuthCredential = {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  clientId?: string;
  email?: string;
  accountId?: string;
  enterpriseUrl?: string;
  projectId?: string;
};

export type SecretRef = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: string;
  errorCount?: number;
  lastFailureAt?: number;
};

export type AuthProfileStore = {
  version: 1;
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, ProfileUsageStats>;
};

export type RudderConfig = {
  version: 1;
  defaultBackend: BackendId;
  lastUsedBackend?: BackendId;
  runPolicy: {
    sameCheckout: "single-active";
    concurrentPromptMode: "worktree" | "queue";
    mergeMode: "manual-on-conflict";
  };
  acpx: {
    install: "latest";
  };
  backends: {
    claude?: BackendConfig;
    codex?: BackendConfig;
    acpx?: BackendConfig;
  };
};

export type BackendId = "claude" | "codex" | "acpx";

export type BackendConfig = {
  profileId?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
};

export type RunStatus =
  | "created"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "merge-conflict"
  | "merged";

export type RunRecord = {
  id: string;
  status: RunStatus;
  task: string;
  backend: BackendId;
  model?: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string;
  targetBranch: string;
  baseCommit: string;
  worktree: {
    enabled: boolean;
    path: string;
    branch?: string;
  };
  process?: {
    pid?: number;
    startedAt?: string;
    endedAt?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  };
  session?: {
    nativeSessionId?: string;
    acpxSessionId?: string;
    sessionName?: string;
  };
  verification?: VerificationResult;
  merge?: MergeState;
};

export type MergeState = {
  status: "not-started" | "merged" | "conflict" | "failed";
  attemptedAt?: string;
  targetBranch?: string;
  conflictedFiles?: string[];
  error?: string;
};

export type RudderEvent = {
  ts: string;
  runId: string;
  type:
    | "run.created"
    | "run.started"
    | "run.detached"
    | "planner.spec"
    | "backend.output"
    | "backend.error"
    | "backend.exit"
    | "verifier.result"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "merge.result";
  message?: string;
  data?: JsonValue;
};

export type RunRequest = {
  run: RunRecord;
  prompt: string;
  contract: string;
};

export type BackendAdapter = {
  id: BackendId;
  verify(): Promise<{ ok: boolean; message: string }>;
  run(request: RunRequest, emit: (event: RudderEvent) => Promise<void>): Promise<number>;
};

export type SpecContract = {
  runId: string;
  task: string;
  createdAt: string;
  repo: {
    root: string;
    branch: string;
    baseCommit: string;
    status: string[];
  };
  instructionsFiles: Array<{ path: string; content: string }>;
  acceptanceCriteria: string[];
  suggestedTests: string[];
};

export type VerificationResult = {
  satisfied: string[];
  missing: string[];
  notes: string;
  shouldContinue: boolean;
};
