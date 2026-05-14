import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { toNodeHandler } from "better-auth/node";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type JsonRecord = Record<string, Json>;

type DeviceLogin = {
  deviceCode: string;
  token?: string;
  accountId?: string;
  email?: string;
  expiresAt: number;
};

type GithubBrowserLogin = {
  githubDeviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
};

type SailStatus = "queued" | "running" | "paused" | "completed" | "failed";

type Sail = {
  id: string;
  status: SailStatus;
  repoName?: string;
  task?: string;
  branch?: string;
  machineId?: string;
  machineState?: string;
  snapshotKey?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
};

type FlyMachine = {
  id?: string;
  name?: string;
  state?: string;
  instance_id?: string;
  config?: JsonRecord;
};

const port = Number(process.env.PORT || 3000);
const baseURL = requiredEnv("BETTER_AUTH_URL", `http://localhost:${port}`);
const dataDir = process.env.RUDDER_CLOUD_DATA_DIR || path.join(os.homedir(), ".rudder-cloud");
const dbPath = process.env.RUDDER_CLOUD_DB || path.join(dataDir, "rudder-cloud.sqlite");
const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const snapshotBucket = process.env.RUDDER_S3_BUCKET || "";
const flyApiToken = process.env.FLY_API_TOKEN || "";
const flyApiBase = (process.env.FLY_API_HOSTNAME || "https://api.machines.dev").replace(/\/$/, "");
const flyAppName = process.env.FLY_APP_NAME || "";
const flyRegion = process.env.FLY_REGION || "iad";
const flyWorkerImage = process.env.RUDDER_WORKER_IMAGE || "ghcr.io/viraatdas/rudder-worker:latest";
const flyWorkerMemoryMb = Number(process.env.RUDDER_WORKER_MEMORY_MB || 1024);
const flyWorkerCpus = Number(process.env.RUDDER_WORKER_CPUS || 1);
const flyWorkerCpuKind = process.env.RUDDER_WORKER_CPU_KIND || "shared";
const idlePauseMs = Number(process.env.RUDDER_IDLE_PAUSE_MS || 15 * 60 * 1000);
const stateKey = process.env.RUDDER_CLOUD_STATE_KEY || "control-plane/rudder-cloud.sqlite";
const persistStateToS3 = process.env.RUDDER_CLOUD_PERSIST_STATE !== "0";
const githubDeviceClientId = process.env.RUDDER_GITHUB_DEVICE_CLIENT_ID || "178c6fc778ccc68e1d6a";
const deviceLogins = new Map<string, DeviceLogin>();
const githubBrowserLogins = new Map<string, GithubBrowserLogin>();
const configuredProviders = {
  google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
};
const s3 = new S3Client({ region: awsRegion });

await fs.mkdir(dataDir, { recursive: true });
await restoreDatabaseFromS3();

const database = new Database(dbPath);
database.pragma("journal_mode = WAL");
database.exec(`
  create table if not exists rudder_tokens (
    token_hash text primary key,
    account_id text not null,
    email text,
    created_at text not null,
    last_used_at text
  );
  create table if not exists rudder_sails (
    id text primary key,
    account_id text not null,
    status text not null,
    repo_name text,
    task text,
    branch text,
    machine_id text,
    machine_state text,
    snapshot_key text,
    manifest_json text,
    worker_token_hash text,
    last_heartbeat_at text,
    created_at text not null,
    updated_at text not null
  );
`);
ensureColumn("rudder_sails", "worker_token_hash", "text");
ensureColumn("rudder_sails", "last_heartbeat_at", "text");

const insertToken = database.prepare(`
  insert or replace into rudder_tokens (token_hash, account_id, email, created_at, last_used_at)
  values (@tokenHash, @accountId, @email, @createdAt, @lastUsedAt)
`);
const findToken = database.prepare("select * from rudder_tokens where token_hash = ?");
const touchToken = database.prepare("update rudder_tokens set last_used_at = ? where token_hash = ?");
const insertSail = database.prepare(`
  insert into rudder_sails (
    id, account_id, status, repo_name, task, branch, machine_id, machine_state,
    snapshot_key, manifest_json, worker_token_hash, last_heartbeat_at, created_at, updated_at
  ) values (
    @id, @accountId, @status, @repoName, @task, @branch, @machineId, @machineState,
    @snapshotKey, @manifestJson, @workerTokenHash, @lastHeartbeatAt, @createdAt, @updatedAt
  )
`);
const updateSail = database.prepare(`
  update rudder_sails
  set status = @status,
      machine_id = @machineId,
      machine_state = @machineState,
      updated_at = @updatedAt
  where id = @id and account_id = @accountId
`);
const findSail = database.prepare("select * from rudder_sails where id = ? and account_id = ?");
const findSailById = database.prepare("select * from rudder_sails where id = ?");
const listSailsForAccount = database.prepare(
  "select * from rudder_sails where account_id = ? order by updated_at desc limit 100",
);
const updateHeartbeat = database.prepare(`
  update rudder_sails
  set status = @status,
      last_heartbeat_at = @lastHeartbeatAt,
      updated_at = @updatedAt
  where id = @id
`);

const auth = betterAuth({
  baseURL,
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  database,
  socialProviders: socialProviders(),
});

const authHandler = toNodeHandler(auth.handler);

const server = http.createServer(async (req, res) => {
  res.once("finish", () => {
    schedulePersistDatabase();
  });
  try {
    const url = new URL(req.url || "/", baseURL);
    if (url.pathname.startsWith("/api/auth")) {
      authHandler(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        s3: Boolean(snapshotBucket),
        fly: Boolean(flyApiToken && flyAppName && flyWorkerImage),
        state: Boolean(snapshotBucket && persistStateToS3),
        auth: configuredProviders,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cli/login") {
      await handleCliLoginStart(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cli/login/github-token") {
      await handleCliGithubToken(req, res);
      return;
    }
    if (url.pathname === "/api/cli/login/poll") {
      await handleCliLoginPoll(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/cli/login") {
      renderLoginPage(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/cli/github/start") {
      await handleCliGithubStart(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/cli/github/wait") {
      await handleCliGithubWait(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/cli/approve") {
      await handleCliApprove(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/rudder/sail")) {
      await handleSailApi(req, res, url);
      return;
    }
    renderHome(res);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`rudder cloud listening on ${baseURL}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void persistDatabaseToS3().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

let persistTimer: NodeJS.Timeout | undefined;
let persistInFlight = false;
let persistAgain = false;

async function restoreDatabaseFromS3(): Promise<void> {
  if (!snapshotBucket || !persistStateToS3) {
    return;
  }
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: snapshotBucket,
      Key: stateKey,
    }));
    if (!response.Body) {
      return;
    }
    const buffer = await streamToBuffer(response.Body);
    if (buffer.length === 0) {
      return;
    }
    await fs.writeFile(dbPath, buffer, { mode: 0o600 });
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name !== "NoSuchKey" && name !== "NotFound") {
      console.warn(`rudder cloud state restore skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function schedulePersistDatabase(): void {
  if (!snapshotBucket || !persistStateToS3) {
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistDatabaseToS3();
  }, 750);
  persistTimer.unref?.();
}

async function persistDatabaseToS3(): Promise<void> {
  if (!snapshotBucket || !persistStateToS3) {
    return;
  }
  if (persistInFlight) {
    persistAgain = true;
    return;
  }
  persistInFlight = true;
  try {
    database.pragma("wal_checkpoint(FULL)");
    const body = await fs.readFile(dbPath);
    await s3.send(new PutObjectCommand({
      Bucket: snapshotBucket,
      Key: stateKey,
      Body: body,
      ContentType: "application/vnd.sqlite3",
      ServerSideEncryption: "AES256",
    }));
  } catch (error) {
    console.warn(`rudder cloud state persist failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    persistInFlight = false;
    if (persistAgain) {
      persistAgain = false;
      schedulePersistDatabase();
    }
  }
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof Readable || (body && typeof body === "object" && Symbol.asyncIterator in body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (body && typeof body === "object" && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  throw new Error("unsupported S3 body type");
}

async function handleCliLoginStart(res: ServerResponse): Promise<void> {
  const deviceCode = randomUUID();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  deviceLogins.set(deviceCode, { deviceCode, expiresAt });
  sendJson(res, 200, {
    deviceCode,
    loginUrl: `${baseURL}/cli/login?device_code=${encodeURIComponent(deviceCode)}`,
    pollUrl: "/api/cli/login/poll",
    interval: 2,
    expiresIn: 300,
  });
}

async function handleCliLoginPoll(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const url = new URL(req.url || "/", baseURL);
  const deviceCode = stringField(body, "deviceCode") || url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now()) {
    sendJson(res, 404, { error: "login expired" });
    return;
  }
  if (!login.token) {
    sendJson(res, 200, { pending: true });
    return;
  }
  deviceLogins.delete(deviceCode);
  const responseBody: JsonRecord = {
    pending: false,
    token: login.token,
  };
  if (login.accountId) {
    responseBody.accountId = login.accountId;
  }
  if (login.email) {
    responseBody.email = login.email;
  }
  sendJson(res, 200, responseBody);
}

async function handleCliGithubToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const githubToken = stringField(body, "token");
  if (!githubToken) {
    throw badRequest("token is required");
  }
  const user = await githubUser(githubToken);
  const issued = issueRudderToken(`github:${user.id}`, user.email ?? `${user.login}@users.noreply.github.com`);
  const responseBody: JsonRecord = {
    token: issued.token,
    accountId: issued.accountId,
    provider: "github",
  };
  if (issued.email) {
    responseBody.email = issued.email;
  }
  sendJson(res, 200, responseBody);
}

function issueRudderToken(accountId: string, email?: string): { token: string; accountId: string; email?: string } {
  const rudderToken = `rdr_${randomBytes(32).toString("base64url")}`;
  const now = new Date().toISOString();
  insertToken.run({
    tokenHash: tokenHash(rudderToken),
    accountId,
    email: email ?? null,
    createdAt: now,
    lastUsedAt: now,
  });
  return { token: rudderToken, accountId, email };
}

function renderLoginPage(url: URL, res: ServerResponse): void {
  const deviceCode = url.searchParams.get("device_code") || "";
  const callbackURL = `/cli/approve?device_code=${encodeURIComponent(deviceCode)}`;
  const links = [
    configuredProviders.google
      ? `<a href="/api/auth/sign-in/social?provider=google&callbackURL=${encodeURIComponent(callbackURL)}">Continue with Google</a>`
      : "",
    configuredProviders.github
      ? `<a href="/api/auth/sign-in/social?provider=github&callbackURL=${encodeURIComponent(callbackURL)}">Continue with GitHub</a>`
      : "",
    deviceCode
      ? `<a href="/cli/github/start?device_code=${encodeURIComponent(deviceCode)}">Continue with GitHub device login</a>`
      : "",
  ].filter(Boolean).join("\n");
  const body = links || "<p>No OAuth providers are configured yet. Run <code>rudder login</code> from the CLI to use GitHub device login.</p>";
  sendHtml(res, `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rudder Cloud Login</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:48px;color:#111;background:#fff;line-height:1.45}a{display:block;margin:12px 0;color:#111}code{background:#f2f2f2;padding:2px 5px}</style></head>
<body><h1>Rudder Cloud</h1><p>Choose a provider to finish CLI login.</p>
${body}
</body></html>`);
}

async function handleCliGithubStart(url: URL, res: ServerResponse): Promise<void> {
  const deviceCode = url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now()) {
    sendHtml(res, "<p>Login expired. Run <code>rudder login</code> again.</p>", 400);
    return;
  }
  const existing = githubBrowserLogins.get(deviceCode);
  const githubLogin = existing && existing.expiresAt > Date.now()
    ? existing
    : await startGithubBrowserLogin(deviceCode);
  renderGithubDevicePage(res, deviceCode, githubLogin);
}

async function handleCliGithubWait(url: URL, res: ServerResponse): Promise<void> {
  const deviceCode = url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  const githubLogin = githubBrowserLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now() || !githubLogin || githubLogin.expiresAt < Date.now()) {
    githubBrowserLogins.delete(deviceCode);
    sendHtml(res, "<p>Login expired. Run <code>rudder login</code> again.</p>", 400);
    return;
  }
  if (Date.now() < githubLogin.nextPollAt) {
    renderGithubDevicePage(res, deviceCode, githubLogin);
    return;
  }
  githubLogin.nextPollAt = Date.now() + githubLogin.intervalMs;
  const poll = await githubOAuthRequest<{
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  }>("https://github.com/login/oauth/access_token", {
    client_id: githubDeviceClientId,
    device_code: githubLogin.githubDeviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (poll.access_token) {
    const user = await githubUser(poll.access_token);
    const issued = issueRudderToken(`github:${user.id}`, user.email ?? `${user.login}@users.noreply.github.com`);
    login.token = issued.token;
    login.accountId = issued.accountId;
    login.email = issued.email;
    githubBrowserLogins.delete(deviceCode);
    sendHtml(res, "<p>Rudder Cloud login complete. You can close this tab.</p>");
    return;
  }
  if (poll.error === "slow_down") {
    githubLogin.intervalMs = Math.max(githubLogin.intervalMs + 5000, (poll.interval ?? 5) * 1000);
    githubLogin.nextPollAt = Date.now() + githubLogin.intervalMs;
  } else if (poll.error && poll.error !== "authorization_pending") {
    githubBrowserLogins.delete(deviceCode);
    sendHtml(res, `<p>GitHub login failed: ${escapeHtml(poll.error_description || poll.error)}</p>`, 400);
    return;
  }
  renderGithubDevicePage(res, deviceCode, githubLogin);
}

async function startGithubBrowserLogin(deviceCode: string): Promise<GithubBrowserLogin> {
  const start = await githubOAuthRequest<{
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  }>("https://github.com/login/device/code", {
    client_id: githubDeviceClientId,
    scope: "read:user user:email",
  });
  if (!start.device_code || !start.user_code || !start.verification_uri) {
    throw new Error(start.error_description || start.error || "GitHub device login failed");
  }
  const githubLogin: GithubBrowserLogin = {
    githubDeviceCode: start.device_code,
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    verificationUriComplete: start.verification_uri_complete,
    expiresAt: Date.now() + (start.expires_in ?? 900) * 1000,
    intervalMs: Math.max(1000, (start.interval ?? 5) * 1000),
    nextPollAt: Date.now() + Math.max(1000, (start.interval ?? 5) * 1000),
  };
  githubBrowserLogins.set(deviceCode, githubLogin);
  return githubLogin;
}

async function githubOAuthRequest<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? parseJson(text) : null;
  if (!response.ok) {
    throw new Error(responseErrorMessage(parsed) ?? text.trim() ?? `${response.status} ${response.statusText}`);
  }
  return parsed as T;
}

function renderGithubDevicePage(res: ServerResponse, deviceCode: string, githubLogin: GithubBrowserLogin): void {
  const href = githubLogin.verificationUriComplete || githubLogin.verificationUri;
  sendHtml(res, `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${Math.ceil(githubLogin.intervalMs / 1000)};url=/cli/github/wait?device_code=${encodeURIComponent(deviceCode)}">
<title>Rudder Cloud GitHub Login</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:48px;color:#111;background:#fff;line-height:1.45}.code{font:600 32px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;margin:20px 0}a{color:#111}p{max-width:620px}</style></head>
<body><h1>Rudder Cloud</h1>
<p>Authorize Rudder with GitHub, then return here. This page will finish automatically.</p>
<div class="code">${escapeHtml(githubLogin.userCode)}</div>
<p><a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open GitHub authorization</a></p>
<p>Waiting for GitHub approval...</p>
</body></html>`);
}

async function handleCliApprove(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const deviceCode = url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now()) {
    sendHtml(res, "<p>Login expired. Run <code>rudder login</code> again.</p>", 400);
    return;
  }
  const session = await getBetterAuthSession(req);
  if (!session?.user) {
    renderLoginPage(url, res);
    return;
  }
  const issued = issueRudderToken(
    String(session.user.id || `better-auth:${randomUUID()}`),
    typeof session.user.email === "string" ? session.user.email : undefined,
  );
  login.token = issued.token;
  login.accountId = issued.accountId;
  login.email = typeof session.user.email === "string" ? session.user.email : undefined;
  sendHtml(res, "<p>Rudder Cloud login complete. You can close this tab.</p>");
}

async function handleSailApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const heartbeatMatch = url.pathname.match(/^\/api\/rudder\/sail\/([^/]+)\/heartbeat$/);
  if (req.method === "POST" && heartbeatMatch) {
    await handleWorkerHeartbeat(req, res, heartbeatMatch[1]);
    return;
  }

  const authContext = requireBearer(req);
  if (req.method === "GET" && url.pathname === "/api/rudder/sail") {
    await refreshAccountSails(authContext.accountId);
    sendJson(res, 200, { sails: listAccountSails(authContext.accountId) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rudder/sail/launch") {
    const body = await readJsonBody(req);
    const sail = await createSail(authContext.accountId, body);
    sendJson(res, 200, sail);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rudder/sail/onload") {
    const body = await readJsonBody(req);
    const sail = await createSail(authContext.accountId, body, stringField(body, "runId"));
    sendJson(res, 200, sail);
    return;
  }
  const match = url.pathname.match(/^\/api\/rudder\/sail\/([^/]+)\/(pause|resume|onload|stop)$/);
  if (req.method === "POST" && match) {
    const sail = getAccountSail(match[1], authContext.accountId);
    if (!sail) {
      sendJson(res, 404, { error: "sail not found" });
      return;
    }
    const next = await mutateFlySail(sail, authContext.accountId, match[2]);
    sendJson(res, 200, next);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

async function createSail(accountId: string, body: Json, preferredId?: string): Promise<Sail> {
  ensureCloudRuntimeConfigured();
  const now = new Date().toISOString();
  const snapshot = await storeSnapshot(accountId, body);
  const id = preferredId || `sail_${randomBytes(5).toString("hex")}`;
  const workerToken = `rdrw_${randomBytes(32).toString("base64url")}`;
  const task = stringField(body, "task");
  const repoName = stringField(body, "repoName");
  const snapshotInput = objectField(body, "snapshot");
  const manifest = snapshotInput ? objectField(snapshotInput, "manifest") : undefined;
  const manifestRepo = manifest ? objectField(manifest, "repo") : undefined;
  const branch = manifestRepo ? stringField(manifestRepo, "branch") : undefined;
  insertSail.run({
    id,
    accountId,
    status: "queued",
    repoName: repoName ?? null,
    task: task ?? null,
    branch: branch ?? null,
    machineId: null,
    machineState: null,
    snapshotKey: snapshot.key,
    manifestJson: JSON.stringify(manifest ?? {}),
    workerTokenHash: tokenHash(workerToken),
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const snapshotUrl = await signedSnapshotUrl(snapshot.key);
  const machine = await createFlyMachine({
    sailId: id,
    accountId,
    snapshotUrl,
    workerToken,
    task,
    repoName,
  });
  const status = flyStateToSailStatus(machine.state);
  updateSail.run({
    id,
    accountId,
    status,
    machineId: machine.id ?? null,
    machineState: machine.state ?? null,
    updatedAt: new Date().toISOString(),
  });
  return getAccountSail(id, accountId) ?? {
    id,
    status,
    repoName,
    task,
    branch,
    machineId: machine.id,
    machineState: machine.state,
    snapshotKey: snapshot.key,
    createdAt: now,
    updatedAt: now,
  };
}

async function storeSnapshot(accountId: string, body: Json): Promise<{ key: string }> {
  ensureS3Configured();
  const snapshot = objectField(body, "snapshot");
  const base64 = snapshot ? stringField(snapshot, "base64") : undefined;
  const contentType = snapshot ? stringField(snapshot, "contentType") || "application/gzip" : "application/gzip";
  if (!base64) {
    throw badRequest("snapshot.base64 is required");
  }
  const buffer = Buffer.from(base64, "base64");
  const key = `snapshots/${accountId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.tgz`;
  await s3.send(new PutObjectCommand({
    Bucket: snapshotBucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ServerSideEncryption: "AES256",
  }));
  return { key };
}

async function signedSnapshotUrl(key: string): Promise<string> {
  ensureS3Configured();
  return await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: snapshotBucket,
      Key: key,
    }),
    { expiresIn: 60 * 60 },
  );
}

async function createFlyMachine(params: {
  sailId: string;
  accountId: string;
  snapshotUrl: string;
  workerToken: string;
  task?: string;
  repoName?: string;
}): Promise<FlyMachine> {
  ensureFlyConfigured();
  const machine = await flyRequest<FlyMachine>(`/v1/apps/${encodeURIComponent(flyAppName)}/machines`, {
    method: "POST",
    body: {
      name: `rudder-${params.sailId}`,
      region: flyRegion,
      config: {
        image: flyWorkerImage,
        env: {
          RUDDER_SAIL_ID: params.sailId,
          RUDDER_ACCOUNT_ID: params.accountId,
          RUDDER_CLOUD_URL: baseURL,
          RUDDER_WORKER_TOKEN: params.workerToken,
          RUDDER_SNAPSHOT_URL: params.snapshotUrl,
          RUDDER_TASK: params.task || "",
          RUDDER_REPO_NAME: params.repoName || "",
        },
        guest: {
          cpu_kind: flyWorkerCpuKind,
          cpus: flyWorkerCpus,
          memory_mb: flyWorkerMemoryMb,
        },
        restart: {
          policy: "no",
        },
        auto_destroy: false,
      },
    },
  });
  if (!machine.id) {
    return machine;
  }
  return await flyRequest<FlyMachine>(
    `/v1/apps/${encodeURIComponent(flyAppName)}/machines/${encodeURIComponent(machine.id)}/start`,
    { method: "POST", body: {} },
  ).catch(() => machine);
}

async function mutateFlySail(sail: Sail, accountId: string, action: string): Promise<Sail> {
  if (!sail.machineId) {
    throw badRequest("sail does not have a Fly machine yet");
  }
  let machine: FlyMachine;
  if (action === "pause") {
    machine = await flyRequest<FlyMachine>(
      `/v1/apps/${encodeURIComponent(flyAppName)}/machines/${encodeURIComponent(sail.machineId)}/suspend`,
      { method: "POST", body: {} },
    );
  } else if (action === "resume" || action === "onload") {
    machine = await flyRequest<FlyMachine>(
      `/v1/apps/${encodeURIComponent(flyAppName)}/machines/${encodeURIComponent(sail.machineId)}/start`,
      { method: "POST", body: {} },
    );
  } else if (action === "stop") {
    machine = await flyRequest<FlyMachine>(
      `/v1/apps/${encodeURIComponent(flyAppName)}/machines/${encodeURIComponent(sail.machineId)}/stop`,
      { method: "POST", body: { signal: "SIGINT", timeout: "10s" } },
    );
  } else {
    throw badRequest(`unsupported sail action: ${action}`);
  }
  updateSail.run({
    id: sail.id,
    accountId,
    status: action === "pause" ? "paused" : flyStateToSailStatus(machine.state),
    machineId: sail.machineId,
    machineState: machine.state ?? null,
    updatedAt: new Date().toISOString(),
  });
  return getAccountSail(sail.id, accountId) ?? sail;
}

async function handleWorkerHeartbeat(req: IncomingMessage, res: ServerResponse, sailId: string): Promise<void> {
  const sailRow = findSailById.get(sailId) as Record<string, unknown> | undefined;
  if (!sailRow) {
    sendJson(res, 404, { error: "sail not found" });
    return;
  }
  requireWorkerBearer(req, sailRow);
  const body = await readJsonBody(req);
  const state = stringField(body, "state");
  const status: SailStatus = state === "completed"
    ? "completed"
    : state === "failed"
      ? "failed"
      : "running";
  const now = new Date().toISOString();
  updateHeartbeat.run({
    id: sailId,
    status,
    lastHeartbeatAt: now,
    updatedAt: now,
  });
  sendJson(res, 200, { ok: true, status });
}

async function refreshAccountSails(accountId: string): Promise<void> {
  if (!flyApiToken || !flyAppName) {
    return;
  }
  const sails = listAccountSails(accountId);
  for (const sail of sails) {
    if (!sail.machineId) {
      continue;
    }
    if (shouldPauseStaleSail(sail)) {
      await flyRequest<FlyMachine>(
        `/v1/apps/${encodeURIComponent(flyAppName)}/machines/${encodeURIComponent(sail.machineId)}/suspend`,
        { method: "POST", body: {} },
      ).catch(() => null);
      const now = new Date().toISOString();
      updateSail.run({
        id: sail.id,
        accountId,
        status: "paused",
        machineId: sail.machineId,
        machineState: "suspended",
        updatedAt: now,
      });
      continue;
    }
    const machine = await flyRequest<FlyMachine>(
      `/v1/apps/${encodeURIComponent(flyAppName)}/machines/${encodeURIComponent(sail.machineId)}`,
      { method: "GET" },
    ).catch(() => null);
    if (!machine) {
      continue;
    }
    updateSail.run({
      id: sail.id,
      accountId,
      status: flyStateToSailStatus(machine.state),
      machineId: sail.machineId,
      machineState: machine.state ?? null,
      updatedAt: new Date().toISOString(),
    });
  }
}

function shouldPauseStaleSail(sail: Sail): boolean {
  if (sail.status !== "running" || !idlePauseMs || idlePauseMs < 1000) {
    return false;
  }
  const heartbeatOrCreated = sail.lastHeartbeatAt ?? sail.createdAt;
  const lastSeen = Date.parse(heartbeatOrCreated);
  return Number.isFinite(lastSeen) && Date.now() - lastSeen > idlePauseMs;
}

async function flyRequest<T>(pathname: string, init: { method: string; body?: JsonRecord }): Promise<T> {
  ensureFlyConfigured();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${flyApiToken}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const response = await fetch(`${flyApiBase}${pathname}`, {
    method: init.method,
    headers,
    body,
  });
  const text = await response.text();
  const parsed = text ? parseJson(text) : null;
  if (!response.ok) {
    throw new Error(responseErrorMessage(parsed) ?? text.trim() ?? `Fly API ${response.status}`);
  }
  return parsed as T;
}

async function githubUser(token: string): Promise<{ id: number | string; login: string; email?: string }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "rudder-cloud",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text();
  const parsed = text ? parseJson(text) : null;
  if (!response.ok) {
    throw unauthorized();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unauthorized();
  }
  const id = typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : undefined;
  const login = typeof parsed.login === "string" ? parsed.login : undefined;
  const email = typeof parsed.email === "string" ? parsed.email : undefined;
  if (!id || !login) {
    throw unauthorized();
  }
  return { id, login, email };
}

function listAccountSails(accountId: string): Sail[] {
  return listSailsForAccount.all(accountId).map(rowToSail);
}

function getAccountSail(id: string, accountId: string): Sail | null {
  const row = findSail.get(id, accountId);
  return row ? rowToSail(row) : null;
}

function rowToSail(row: unknown): Sail {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    status: String(value.status) as SailStatus,
    repoName: optionalString(value.repo_name),
    task: optionalString(value.task),
    branch: optionalString(value.branch),
    machineId: optionalString(value.machine_id),
    machineState: optionalString(value.machine_state),
    snapshotKey: optionalString(value.snapshot_key),
    lastHeartbeatAt: optionalString(value.last_heartbeat_at),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function flyStateToSailStatus(state: string | undefined): SailStatus {
  switch (state) {
    case "started":
    case "starting":
      return "running";
    case "suspended":
    case "stopped":
    case "stopping":
      return "paused";
    case "destroyed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

function requireBearer(req: IncomingMessage): { accountId: string; email?: string } {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!token.startsWith("rdr_")) {
    throw unauthorized();
  }
  const hash = tokenHash(token);
  const row = findToken.get(hash) as Record<string, unknown> | undefined;
  if (!row) {
    throw unauthorized();
  }
  touchToken.run(new Date().toISOString(), hash);
  return {
    accountId: String(row.account_id),
    email: optionalString(row.email),
  };
}

function requireWorkerBearer(req: IncomingMessage, sailRow: Record<string, unknown>): void {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const expected = optionalString(sailRow.worker_token_hash);
  if (!token.startsWith("rdrw_") || !expected || tokenHash(token) !== expected) {
    throw unauthorized();
  }
}

function socialProviders(): JsonRecord {
  const providers: JsonRecord = {};
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (googleClientId && googleClientSecret) {
    providers.google = {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    };
  }
  if (githubClientId && githubClientSecret) {
    providers.github = {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
    };
  }
  return providers;
}

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = database.prepare(`pragma table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  database.prepare(`alter table ${table} add column ${column} ${definition}`).run();
}

function renderHome(res: ServerResponse): void {
  sendHtml(res, "<h1>Rudder Cloud</h1><p>Use <code>rudder login</code> from the CLI.</p>");
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
}

function objectField(value: Json, field: string): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const next = value[field];
  return next && typeof next === "object" && !Array.isArray(next) ? next : undefined;
}

function stringField(value: Json, field: string): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value[field] === "string"
    ? value[field]
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getBetterAuthSession(req: IncomingMessage): Promise<{ user?: { id?: string; email?: string } } | null> {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        headers.set(key, value.join(", "));
      } else if (value) {
        headers.set(key, value);
      }
    }
    return await (auth.api as unknown as {
      getSession(input: { headers: Headers }): Promise<{ user?: { id?: string; email?: string } } | null>;
    }).getSession({ headers });
  } catch {
    return null;
  }
}

function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

function responseErrorMessage(value: Json | null): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return typeof value.error === "string"
    ? value.error
    : typeof value.message === "string"
      ? value.message
      : undefined;
}

function ensureCloudRuntimeConfigured(): void {
  ensureS3Configured();
  ensureFlyConfigured();
}

function ensureS3Configured(): void {
  if (!snapshotBucket) {
    throw new Error("RUDDER_S3_BUCKET is required for cloud snapshots");
  }
}

function ensureFlyConfigured(): void {
  if (!flyApiToken) {
    throw new Error("FLY_API_TOKEN is required to create Fly Machines");
  }
  if (!flyAppName) {
    throw new Error("FLY_APP_NAME is required to create Fly Machines");
  }
  if (!flyWorkerImage) {
    throw new Error("RUDDER_WORKER_IMAGE is required to create Fly Machines");
  }
}

function badRequest(message: string): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = 400;
  return error;
}

function unauthorized(): Error {
  const error = new Error("unauthorized");
  (error as Error & { status?: number }).status = 401;
  return error;
}

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}
