import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
type SailRuntime = "fly" | "byo-vm";

type Sail = {
  id: string;
  status: SailStatus;
  runtime: SailRuntime;
  repoName?: string;
  task?: string;
  branch?: string;
  machineId?: string;
  machineState?: string;
  snapshotKey?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  bootstrapCommand?: string;
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
const authBaseURL = `${baseURL.replace(/\/$/, "")}/api/auth`;
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
const publicLoginUrl = (process.env.RUDDER_PUBLIC_LOGIN_URL || "").trim();
const adminEmails = new Set((process.env.RUDDER_ADMIN_EMAILS || "viraat.laldas@gmail.com,viraat@exla.ai")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean));
const deviceLogins = new Map<string, DeviceLogin>();
const githubBrowserLogins = new Map<string, GithubBrowserLogin>();
const s3 = new S3Client({ region: awsRegion });

await fs.mkdir(dataDir, { recursive: true });
await restoreDatabaseFromS3();

const database = new Database(dbPath);
database.pragma("journal_mode = WAL");
database.exec(`
  create table if not exists user (
    id text primary key not null,
    name text not null,
    email text not null unique,
    emailVerified integer not null,
    image text,
    createdAt date not null,
    updatedAt date not null
  );
  create table if not exists session (
    id text primary key not null,
    expiresAt date not null,
    token text not null unique,
    createdAt date not null,
    updatedAt date not null,
    ipAddress text,
    userAgent text,
    userId text not null references user(id) on delete cascade
  );
  create index if not exists session_userId_idx on session(userId);
  create table if not exists account (
    id text primary key not null,
    accountId text not null,
    providerId text not null,
    userId text not null references user(id) on delete cascade,
    accessToken text,
    refreshToken text,
    idToken text,
    accessTokenExpiresAt date,
    refreshTokenExpiresAt date,
    scope text,
    password text,
    createdAt date not null,
    updatedAt date not null
  );
  create index if not exists account_userId_idx on account(userId);
  create table if not exists verification (
    id text primary key not null,
    identifier text not null,
    value text not null,
    expiresAt date not null,
    createdAt date not null,
    updatedAt date not null
  );
  create index if not exists verification_identifier_idx on verification(identifier);
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
    runtime text,
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
  create table if not exists rudder_settings (
    key text primary key,
    value text not null,
    updated_at text not null
  );
`);
ensureColumn("rudder_sails", "worker_token_hash", "text");
ensureColumn("rudder_sails", "last_heartbeat_at", "text");
ensureColumn("rudder_sails", "runtime", "text");

const insertToken = database.prepare(`
  insert or replace into rudder_tokens (token_hash, account_id, email, created_at, last_used_at)
  values (@tokenHash, @accountId, @email, @createdAt, @lastUsedAt)
`);
const findToken = database.prepare("select * from rudder_tokens where token_hash = ?");
const touchToken = database.prepare("update rudder_tokens set last_used_at = ? where token_hash = ?");
const insertSail = database.prepare(`
  insert into rudder_sails (
    id, account_id, status, runtime, repo_name, task, branch, machine_id, machine_state,
    snapshot_key, manifest_json, worker_token_hash, last_heartbeat_at, created_at, updated_at
  ) values (
    @id, @accountId, @status, @runtime, @repoName, @task, @branch, @machineId, @machineState,
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
      machine_state = @machineState,
      last_heartbeat_at = @lastHeartbeatAt,
      updated_at = @updatedAt
  where id = @id
`);
const updateWorkerToken = database.prepare(`
  update rudder_sails
  set worker_token_hash = @workerTokenHash,
      updated_at = @updatedAt
  where id = @id and account_id = @accountId
`);
const getSetting = database.prepare("select value from rudder_settings where key = ?");
const upsertSetting = database.prepare(`
  insert into rudder_settings (key, value, updated_at)
  values (@key, @value, @updatedAt)
  on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
`);

let authProviderFingerprint = providerFingerprint();
let auth: ReturnType<typeof createBetterAuth> = createBetterAuth();
let authHandler = toNodeHandler(auth.handler);

const server = http.createServer(async (req, res) => {
  res.once("finish", () => {
    schedulePersistDatabase();
  });
  try {
    const url = new URL(req.url || "/", baseURL);
    if (url.pathname.startsWith("/api/auth")) {
      refreshAuthHandler();
      authHandler(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        s3: Boolean(snapshotBucket),
        fly: Boolean(flyApiToken && flyAppName && flyWorkerImage),
        byoVm: Boolean(snapshotBucket && flyWorkerImage),
        state: Boolean(snapshotBucket && persistStateToS3),
        auth: configuredProviders(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/setup/github") {
      renderGithubAppSetup(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/setup/github/callback") {
      await handleGithubAppSetupCallback(url, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rudder/setup/github") {
      await handleOAuthCredentialSetup(req, res, "github");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rudder/setup/google") {
      await handleOAuthCredentialSetup(req, res, "google");
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
    if (req.method === "GET" && url.pathname === "/cli/oauth/google/start") {
      await handleCliOAuthStart(url, res, "google");
      return;
    }
    if (req.method === "GET" && url.pathname === "/cli/oauth/github/start") {
      await handleCliOAuthStart(url, res, "github");
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
  const loginBase = publicLoginUrl || `${baseURL}/cli/login`;
  const separator = loginBase.includes("?") ? "&" : "?";
  sendJson(res, 200, {
    deviceCode,
    loginUrl: `${loginBase}${separator}device_code=${encodeURIComponent(deviceCode)}`,
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
  const providers = configuredProviders();
  const buttons: string[] = [];
  if (providers.google) {
    buttons.push(providerButton(
      `/cli/oauth/google/start?device_code=${encodeURIComponent(deviceCode)}`,
      "Continue with Google",
      GOOGLE_ICON_SVG,
    ));
  }
  if (providers.github) {
    buttons.push(providerButton(
      `/cli/oauth/github/start?device_code=${encodeURIComponent(deviceCode)}`,
      "Continue with GitHub",
      GITHUB_ICON_SVG,
    ));
  }
  const cliBlock = deviceCode
    ? `<div class="device">
        Don't want to use a provider above? You can also
        <a href="/cli/github/start?device_code=${escapeHtml(deviceCode)}">sign in with a GitHub device code</a>.
      </div>`
    : `<div class="device">
        Run <code>rudder login</code> from the CLI to start a login session.
      </div>`;
  const noProviders = buttons.length === 0
    ? `<p class="empty">No OAuth providers are configured yet.${deviceCode ? " Use the GitHub device code option below." : ""}</p>`
    : "";
  const body = `
    <section class="hero">
      <h1>Sign in.</h1>
      <p class="lede">Connect this browser to Rudder Cloud so the CLI can launch and watch over cloud workers.</p>
      <div class="card">
        ${noProviders}
        ${buttons.join("\n")}
        ${cliBlock}
      </div>
    </section>
  `;
  sendHtml(res, renderShell({ title: "Sign in · Rudder Cloud", body }));
}

function providerButton(href: string, label: string, icon: string): string {
  return `<a class="provider" href="${escapeHtml(href)}"><span class="icon" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></a>`;
}

async function handleCliOAuthStart(url: URL, res: ServerResponse, provider: "google" | "github"): Promise<void> {
  const deviceCode = url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now()) {
    renderExpiredPage(res);
    return;
  }

  const providers = configuredProviders();
  if (!providers[provider]) {
    sendHtml(res, renderShell({
      title: "Provider unavailable · Rudder Cloud",
      body: `<section class="hero"><h1>Provider unavailable.</h1><p class="lede">${escapeHtml(provider)} login is not configured. Use the GitHub device code option instead.</p></section>`,
    }), 404);
    return;
  }

  const callbackURL = `${baseURL}/cli/approve?device_code=${encodeURIComponent(deviceCode)}`;
  refreshAuthHandler();
  const response = await auth.handler(new Request(`${authBaseURL}/sign-in/social`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
    },
    body: JSON.stringify({
      provider,
      callbackURL,
      disableRedirect: true,
    }),
  }));
  const text = await response.text();
  let parsed: Json = text ? parseJson(text) : null;
  if (!response.ok) {
    const message = responseErrorMessage(parsed) ?? (text || `${response.status} ${response.statusText}`);
    sendHtml(res, renderShell({
      title: "Login failed · Rudder Cloud",
      body: `<section class="hero"><h1>Login failed.</h1><p class="lede">${escapeHtml(message)}</p></section>`,
    }), response.status);
    return;
  }
  const redirectURL = parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.url === "string"
    ? parsed.url
    : undefined;
  if (!redirectURL) {
    throw new Error("OAuth provider did not return an authorization URL");
  }
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of responseHeaders.getSetCookie?.() ?? splitSetCookieHeader(response.headers.get("set-cookie"))) {
    res.setHeader("Set-Cookie", appendHeader(res.getHeader("Set-Cookie"), cookie));
  }
  res.statusCode = 302;
  res.setHeader("Location", redirectURL);
  res.end();
}

const GOOGLE_ICON_SVG = `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.614Z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.908-2.258c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.331A8.997 8.997 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.68 9c0-.593.102-1.17.284-1.71V4.959H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.041l3.007-2.331Z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.581C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.959L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"/></svg>`;
const GITHUB_ICON_SVG = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

const BRAND_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="6" y="6" width="52" height="52" rx="12" fill="#fff"/><rect x="6" y="6" width="52" height="52" rx="12" fill="none" stroke="#111" stroke-width="3"/><path d="M18 20h12c8 0 13 4 13 11s-5 11-13 11h-6v9h-6V20Zm6 6v10h6c4 0 7-2 7-5s-3-5-7-5h-6Z" fill="#111"/><path d="M39 42l8 9" stroke="#111" stroke-width="6" stroke-linecap="round"/></svg>`;

function renderShell(options: { title: string; body: string; footer?: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#ffffff">
    <title>${escapeHtml(options.title)}</title>
    <link rel="icon" href="https://rudder.viraat.dev/favicon.svg" type="image/svg+xml">
    <style>
      :root { color:#111; background:#fff; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight:300; }
      * { box-sizing: border-box; }
      body { margin:0; background:#fff; color:#111; min-height:100vh; }
      a { color:inherit; text-decoration-thickness:1px; text-underline-offset:4px; }
      .page { max-width: 1100px; margin: 0 auto; padding: 32px 24px 72px; }
      header { display:flex; align-items:center; justify-content:space-between; gap:24px; padding-bottom: 64px; }
      .brand { display:inline-flex; align-items:center; gap:12px; font-size:15px; text-decoration:none; color:#111; }
      .brand svg { width:28px; height:28px; }
      nav { display:flex; gap:18px; color:#555; font-size:14px; }
      nav a { color:#555; }
      h1 { margin:0; font-size: clamp(44px, 7vw, 88px); line-height:0.94; font-weight:300; letter-spacing:0; }
      .lede { margin: 28px 0 0; max-width: 620px; font-size: clamp(17px, 1.6vw, 21px); line-height:1.45; color:#333; font-weight:300; }
      .card { margin-top: 38px; max-width: 460px; border:1px solid #111; background:#fff; padding: 22px; box-shadow: 12px 12px 0 #111; }
      .provider { display:flex; align-items:center; gap:14px; width:100%; border:1px solid #111; background:#fff; color:#111; padding: 12px 14px; font:inherit; font-size:15px; cursor:pointer; text-decoration:none; transition: background .12s ease, color .12s ease; }
      .provider + .provider { margin-top: 10px; }
      .provider:hover, .provider:focus-visible { background:#111; color:#fff; outline:none; }
      .provider .icon { width:20px; height:20px; flex-shrink:0; display:inline-flex; align-items:center; justify-content:center; }
      .provider .icon svg { width:100%; height:100%; }
      .device { margin-top: 22px; padding-top: 18px; border-top: 1px dashed #111; color:#555; font-size: 14px; line-height:1.55; }
      .device code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#f2f2f2; padding: 1px 6px; }
      .device a { color:#111; }
      .empty { color:#555; font-size:15px; line-height:1.5; margin: 0 0 14px; }
      .code-display { font: 600 32px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 6px; margin: 20px 0 6px; }
      .muted { color:#666; font-size:14px; line-height:1.55; }
      .pill { display:inline-block; padding: 6px 10px; border:1px solid #111; font:600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform:uppercase; letter-spacing:1px; }
      .btn-primary { display:inline-block; margin-top: 18px; border: 1px solid #111; background:#111; color:#fff; padding: 10px 14px; font:inherit; font-size:14px; text-decoration:none; }
      .btn-primary:hover { background:#fff; color:#111; }
      code.kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#f2f2f2; padding: 2px 6px; }
      footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid #ddd; color:#666; font-size: 13px; line-height:1.55; max-width: 620px; }
      @media (max-width: 640px) {
        header { padding-bottom: 36px; }
        .card { box-shadow: 8px 8px 0 #111; padding: 18px; }
        .code-display { font-size: 26px; letter-spacing: 4px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header>
        <a class="brand" href="https://rudder.viraat.dev">${BRAND_SVG}<span>Rudder Cloud</span></a>
        <nav>
          <a href="https://rudder.viraat.dev">rudder.viraat.dev</a>
          <a href="https://github.com/viraatdas/rudder">GitHub</a>
        </nav>
      </header>
      <main>${options.body}</main>
      <footer>${options.footer ?? "You can close this tab once the CLI says you're signed in. Rudder Cloud uses Better Auth for OAuth — your provider tokens stay on this server."}</footer>
    </div>
  </body>
</html>`;
}

function renderGithubAppSetup(url: URL, res: ServerResponse): void {
  const org = url.searchParams.get("org")?.trim();
  const state = createSetupState();
  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  const manifest = {
    name: org ? `Rudder Cloud (${org})` : "Rudder Cloud",
    url: "https://rudder.viraat.dev",
    hook_attributes: {
      url: `${baseURL}/api/github/events`,
      active: false,
    },
    redirect_url: `${baseURL}/setup/github/callback`,
    callback_urls: [
      `${authBaseURL}/callback/github`,
    ],
    setup_url: `${baseURL}/setup/github`,
    description: "Rudder Cloud login and coding-agent orchestration.",
    public: false,
    request_oauth_on_install: false,
    default_permissions: {},
    default_events: [],
  };
  sendHtml(res, renderShell({
    title: "Set up GitHub OAuth · Rudder Cloud",
    body: `
      <section class="hero">
        <h1>GitHub OAuth.</h1>
        <p class="lede">This creates a GitHub App from a manifest and stores its OAuth client ID and secret in Rudder Cloud's persisted state.</p>
        <div class="card">
          <p class="muted" style="margin-top:0">Callback URL</p>
          <p><code class="kbd">${escapeHtml(`${authBaseURL}/callback/github`)}</code></p>
          <form action="${escapeHtml(action)}" method="post" style="margin-top:18px">
            <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
            <button class="btn-primary" type="submit">Create GitHub App</button>
          </form>
        </div>
      </section>
    `,
  }));
}

async function handleGithubAppSetupCallback(url: URL, res: ServerResponse): Promise<void> {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !verifySetupState(state)) {
    sendHtml(res, renderShell({
      title: "Setup expired · Rudder Cloud",
      body: `<section class="hero"><h1>Setup expired.</h1><p class="lede">Open <code class="kbd">/setup/github</code> and try again.</p></section>`,
    }), 400);
    return;
  }
  const app = await githubManifestConversion(code);
  const clientId = typeof app.client_id === "string" ? app.client_id : undefined;
  const clientSecret = typeof app.client_secret === "string" ? app.client_secret : undefined;
  if (!clientId || !clientSecret) {
    throw new Error("GitHub manifest conversion did not return OAuth client credentials");
  }
  setSetting("github_client_id", clientId);
  setSetting("github_client_secret", clientSecret);
  refreshAuthHandler(true);
  await persistDatabaseToS3();
  sendHtml(res, renderShell({
    title: "GitHub OAuth ready · Rudder Cloud",
    body: `
      <section class="hero">
        <h1>All set.</h1>
        <p class="lede">Rudder Cloud saved the GitHub App OAuth credentials. The sign-in page can now show the GitHub button.</p>
        <div class="card">
          <p class="muted" style="margin-top:0">Next</p>
          <p><a class="btn-primary" href="/cli/login">Go to sign in</a></p>
          <div class="device"><a href="/health">Check health</a></div>
        </div>
      </section>
    `,
  }));
}

async function handleOAuthCredentialSetup(
  req: IncomingMessage,
  res: ServerResponse,
  provider: "github" | "google",
): Promise<void> {
  const authContext = requireBearer(req);
  requireAdmin(authContext);
  const body = await readJsonBody(req);
  const clientId = stringField(body, "clientId") || stringField(body, "client_id");
  const clientSecret = stringField(body, "clientSecret") || stringField(body, "client_secret");
  if (!clientId || !clientSecret) {
    throw badRequest("clientId and clientSecret are required");
  }
  setSetting(`${provider}_client_id`, clientId.trim());
  setSetting(`${provider}_client_secret`, clientSecret.trim());
  refreshAuthHandler(true);
  await persistDatabaseToS3();
  sendJson(res, 200, {
    ok: true,
    provider,
    auth: configuredProviders(),
  });
}

async function handleCliGithubStart(url: URL, res: ServerResponse): Promise<void> {
  const deviceCode = url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now()) {
    renderExpiredPage(res);
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
    renderExpiredPage(res);
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
    renderSuccessPage(res, login.email);
    return;
  }
  if (poll.error === "slow_down") {
    githubLogin.intervalMs = Math.max(githubLogin.intervalMs + 5000, (poll.interval ?? 5) * 1000);
    githubLogin.nextPollAt = Date.now() + githubLogin.intervalMs;
  } else if (poll.error && poll.error !== "authorization_pending") {
    githubBrowserLogins.delete(deviceCode);
    sendHtml(res, renderShell({
      title: "GitHub login failed · Rudder Cloud",
      body: `
        <section class="hero">
          <h1>GitHub login failed.</h1>
          <p class="lede">${escapeHtml(poll.error_description || poll.error)}</p>
          <div class="card">
            <p class="muted" style="margin-top:0">Run the CLI again to try once more.</p>
            <p><code class="kbd">rudder login</code></p>
          </div>
        </section>
      `,
    }), 400);
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

async function githubManifestConversion(code: string): Promise<JsonRecord> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "rudder-cloud",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text();
  const parsed = text ? parseJson(text) : null;
  if (!response.ok) {
    throw new Error(responseErrorMessage(parsed) ?? text.trim() ?? `GitHub manifest conversion failed: ${response.status}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GitHub manifest conversion returned an unexpected response");
  }
  return parsed;
}

function createSetupState(): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 10 * 60 * 1000,
    nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${setupStateSignature(payload)}`;
}

function verifySetupState(state: string): boolean {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    return false;
  }
  const expected = setupStateSignature(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

function setupStateSignature(payload: string): string {
  return createHmac("sha256", requiredEnv("BETTER_AUTH_SECRET")).update(payload).digest("base64url");
}

function renderGithubDevicePage(res: ServerResponse, deviceCode: string, githubLogin: GithubBrowserLogin): void {
  const href = githubLogin.verificationUriComplete || githubLogin.verificationUri;
  const refreshSec = Math.ceil(githubLogin.intervalMs / 1000);
  const html = renderShell({
    title: "Authorize GitHub · Rudder Cloud",
    body: `
      <section class="hero">
        <h1>Authorize on GitHub.</h1>
        <p class="lede">Open GitHub, paste this code, then come back. This tab will finish on its own.</p>
        <div class="card">
          <span class="pill">Device code</span>
          <div class="code-display">${escapeHtml(githubLogin.userCode)}</div>
          <p class="muted">Waiting for GitHub approval&hellip;</p>
          <a class="btn-primary" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open GitHub</a>
          <div class="device">Stuck? Run <code>rudder login</code> again from the CLI.</div>
        </div>
      </section>
    `,
  }).replace(
    "</head>",
    `<meta http-equiv="refresh" content="${refreshSec};url=/cli/github/wait?device_code=${encodeURIComponent(deviceCode)}"></head>`,
  );
  sendHtml(res, html);
}

async function handleCliApprove(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const deviceCode = url.searchParams.get("device_code") || "";
  const login = deviceLogins.get(deviceCode);
  if (!login || login.expiresAt < Date.now()) {
    renderExpiredPage(res);
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
  renderSuccessPage(res, login.email);
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
  const bootstrapMatch = url.pathname.match(/^\/api\/rudder\/sail\/([^/]+)\/bootstrap$/);
  if (req.method === "POST" && bootstrapMatch) {
    const sail = getAccountSail(bootstrapMatch[1], authContext.accountId);
    if (!sail) {
      sendJson(res, 404, { error: "sail not found" });
      return;
    }
    const next = await refreshByoVmBootstrap(sail, authContext.accountId);
    sendJson(res, 200, next);
    return;
  }
  const match = url.pathname.match(/^\/api\/rudder\/sail\/([^/]+)\/(pause|resume|onload|stop)$/);
  if (req.method === "POST" && match) {
    const sail = getAccountSail(match[1], authContext.accountId);
    if (!sail) {
      sendJson(res, 404, { error: "sail not found" });
      return;
    }
    const next = await mutateSail(sail, authContext.accountId, match[2]);
    sendJson(res, 200, next);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

async function createSail(accountId: string, body: Json, preferredId?: string): Promise<Sail> {
  const runtime = sailRuntimeFromBody(body);
  ensureCloudRuntimeConfigured(runtime);
  const now = new Date().toISOString();
  const snapshot = await storeSnapshot(accountId, body);
  const id = preferredId || uniqueSailId(stringField(body, "name"));
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
    runtime,
    repoName: repoName ?? null,
    task: task ?? null,
    branch: branch ?? null,
    machineId: null,
    machineState: runtime === "byo-vm" ? "bootstrap-pending" : null,
    snapshotKey: snapshot.key,
    manifestJson: JSON.stringify(manifest ?? {}),
    workerTokenHash: tokenHash(workerToken),
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
  });

  if (runtime === "byo-vm") {
    const sail = getAccountSail(id, accountId) ?? {
      id,
      status: "queued",
      runtime,
      repoName,
      task,
      branch,
      machineState: "bootstrap-pending",
      snapshotKey: snapshot.key,
      createdAt: now,
      updatedAt: now,
    };
    return {
      ...sail,
      bootstrapCommand: await byoVmBootstrapCommand({
        sailId: id,
        accountId,
        snapshotKey: snapshot.key,
        workerToken,
        task,
        repoName,
      }),
    };
  }

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
    runtime,
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

function uniqueSailId(name?: string): string {
  const base = slugForSailId(name) || `${cloudWord()}-${cloudWord()}`;
  let id = base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!findSailById.get(id)) {
      return id;
    }
    id = `${base}-${randomBytes(2).toString("hex")}`;
  }
  return `cloud-${randomBytes(5).toString("hex")}`;
}

function slugForSailId(value?: string): string {
  const slug = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/g, "");
  return slug ? `cloud-${slug}` : "";
}

function cloudWord(): string {
  const words = [
    "amber",
    "atlas",
    "bright",
    "harbor",
    "orbit",
    "rapid",
    "river",
    "signal",
    "silver",
    "summit",
    "swift",
    "wave",
  ];
  return words[randomBytes(1)[0] % words.length] || "cloud";
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

async function mutateSail(sail: Sail, accountId: string, action: string): Promise<Sail> {
  if (sail.runtime === "fly") {
    return await mutateFlySail(sail, accountId, action);
  }
  throw badRequest("BYO VM sails cannot be paused, resumed, or stopped from Rudder Cloud. Stop the worker on your VM instead.");
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

async function refreshByoVmBootstrap(sail: Sail, accountId: string): Promise<Sail> {
  if (sail.runtime !== "byo-vm") {
    throw badRequest("bootstrap is only available for BYO VM sails");
  }
  if (!sail.snapshotKey) {
    throw badRequest("sail does not have a snapshot");
  }
  const workerToken = `rdrw_${randomBytes(32).toString("base64url")}`;
  const now = new Date().toISOString();
  updateWorkerToken.run({
    id: sail.id,
    accountId,
    workerTokenHash: tokenHash(workerToken),
    updatedAt: now,
  });
  const next = getAccountSail(sail.id, accountId) ?? { ...sail, updatedAt: now };
  return {
    ...next,
    bootstrapCommand: await byoVmBootstrapCommand({
      sailId: sail.id,
      accountId,
      snapshotKey: sail.snapshotKey,
      workerToken,
      task: sail.task,
      repoName: sail.repoName,
    }),
  };
}

async function byoVmBootstrapCommand(params: {
  sailId: string;
  accountId: string;
  snapshotKey: string;
  workerToken: string;
  task?: string;
  repoName?: string;
}): Promise<string> {
  const snapshotUrl = await signedSnapshotUrl(params.snapshotKey);
  const env: Array<[string, string]> = [
    ["RUDDER_SAIL_ID", params.sailId],
    ["RUDDER_ACCOUNT_ID", params.accountId],
    ["RUDDER_CLOUD_URL", baseURL],
    ["RUDDER_WORKER_TOKEN", params.workerToken],
    ["RUDDER_SNAPSHOT_URL", snapshotUrl],
    ["RUDDER_TASK", params.task || ""],
    ["RUDDER_REPO_NAME", params.repoName || ""],
  ];
  const lines = [
    "docker run --rm -it",
    ...env.map(([key, value]) => `  -e ${key}=${shellQuote(value)}`),
    `  ${shellQuote(flyWorkerImage)}`,
  ];
  return lines.map((line, index) => index < lines.length - 1 ? `${line} \\` : line).join("\n");
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
    machineState: state || status,
    lastHeartbeatAt: now,
    updatedAt: now,
  });
  sendJson(res, 200, { ok: true, status });
}

async function refreshAccountSails(accountId: string): Promise<void> {
  const sails = listAccountSails(accountId);
  for (const sail of sails) {
    if (sail.runtime !== "fly" || !flyApiToken || !flyAppName) {
      continue;
    }
    if (sail.status === "completed" || sail.status === "failed") {
      continue;
    }
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
    runtime: sailRuntimeValue(optionalString(value.runtime)),
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

function sailRuntimeFromBody(body: Json): SailRuntime {
  const worker = objectField(body, "worker");
  const raw = stringField(body, "runtime") || stringField(worker, "type") || stringField(worker, "runtime");
  return sailRuntimeValue(raw);
}

function sailRuntimeValue(raw: string | undefined): SailRuntime {
  const value = (raw || "fly").trim().toLowerCase();
  if (value === "fly" || value === "fly-machine" || value === "fly-machines") {
    return "fly";
  }
  if (value === "byo" || value === "byo-vm" || value === "manual" || value === "self-hosted" || value === "vm") {
    return "byo-vm";
  }
  throw badRequest(`unsupported cloud runtime: ${raw}`);
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

function requireAdmin(authContext: { email?: string }): void {
  const email = authContext.email?.toLowerCase();
  if (!email || !adminEmails.has(email)) {
    throw unauthorized();
  }
}

function requireWorkerBearer(req: IncomingMessage, sailRow: Record<string, unknown>): void {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const expected = optionalString(sailRow.worker_token_hash);
  if (!token.startsWith("rdrw_") || !expected || tokenHash(token) !== expected) {
    throw unauthorized();
  }
}

function createBetterAuth() {
  return betterAuth({
    baseURL: authBaseURL,
    secret: requiredEnv("BETTER_AUTH_SECRET"),
    database,
    socialProviders: socialProviders(),
  });
}

function refreshAuthHandler(force = false): void {
  const nextFingerprint = providerFingerprint();
  if (!force && nextFingerprint === authProviderFingerprint) {
    return;
  }
  authProviderFingerprint = nextFingerprint;
  auth = createBetterAuth();
  authHandler = toNodeHandler(auth.handler);
}

function providerFingerprint(): string {
  return JSON.stringify(configuredProviders());
}

function configuredProviders(): JsonRecord {
  return {
    google: Boolean(oauthValue("GOOGLE_CLIENT_ID", "google_client_id") && oauthValue("GOOGLE_CLIENT_SECRET", "google_client_secret")),
    github: Boolean(oauthValue("GITHUB_CLIENT_ID", "github_client_id") && oauthValue("GITHUB_CLIENT_SECRET", "github_client_secret")),
    githubDevice: Boolean(githubDeviceClientId),
  };
}

function socialProviders(): JsonRecord {
  const providers: JsonRecord = {};
  const googleClientId = oauthValue("GOOGLE_CLIENT_ID", "google_client_id");
  const googleClientSecret = oauthValue("GOOGLE_CLIENT_SECRET", "google_client_secret");
  const githubClientId = oauthValue("GITHUB_CLIENT_ID", "github_client_id");
  const githubClientSecret = oauthValue("GITHUB_CLIENT_SECRET", "github_client_secret");
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

function oauthValue(envName: string, settingKey: string): string | undefined {
  return process.env[envName] || settingValue(settingKey);
}

function settingValue(key: string): string | undefined {
  const row = getSetting.get(key) as Record<string, unknown> | undefined;
  return typeof row?.value === "string" && row.value.length > 0 ? row.value : undefined;
}

function setSetting(key: string, value: string): void {
  upsertSetting.run({ key, value, updatedAt: new Date().toISOString() });
}

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = database.prepare(`pragma table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  database.prepare(`alter table ${table} add column ${column} ${definition}`).run();
}

function renderHome(res: ServerResponse): void {
  sendHtml(res, renderShell({
    title: "Rudder Cloud",
    body: `
      <section class="hero">
        <h1>Rudder Cloud.</h1>
        <p class="lede">The control plane that lets Rudder hand off coding-agent runs to managed cloud workers. Sign in to connect a laptop.</p>
        <div class="card">
          <a class="provider" href="/cli/login"><span class="icon" aria-hidden="true">${BRAND_SVG}</span><span>Sign in to Rudder Cloud</span></a>
          <div class="device">Or run <code>rudder login</code> from the CLI to open this page with a device code attached.</div>
        </div>
      </section>
    `,
  }));
}

function renderSuccessPage(res: ServerResponse, email?: string): void {
  sendHtml(res, renderShell({
    title: "Signed in · Rudder Cloud",
    body: `
      <section class="hero">
        <h1>You're in.</h1>
        <p class="lede">${email ? `Signed in as <strong>${escapeHtml(email)}</strong>. ` : ""}You can close this tab. The Rudder CLI will pick up the session in a moment.</p>
        <div class="card">
          <span class="pill">Logged in</span>
          <p class="muted" style="margin-top:14px">Try it next:</p>
          <p><code class="kbd">rudder cloud list</code> &middot; <code class="kbd">rudder sail "fix the failing tests"</code></p>
        </div>
      </section>
    `,
  }));
}

function renderExpiredPage(res: ServerResponse, status = 400): void {
  sendHtml(res, renderShell({
    title: "Login expired · Rudder Cloud",
    body: `
      <section class="hero">
        <h1>Session expired.</h1>
        <p class="lede">This login link has timed out.</p>
        <div class="card">
          <p class="muted" style="margin-top:0">Run the command again to start a fresh session:</p>
          <p><code class="kbd">rudder login</code></p>
        </div>
      </section>
    `,
  }), status);
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

function objectField(value: Json | undefined, field: string): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const next = value[field];
  return next && typeof next === "object" && !Array.isArray(next) ? next : undefined;
}

function stringField(value: Json | undefined, field: string): string | undefined {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

function appendHeader(existing: number | string | string[] | undefined, value: string): string[] {
  if (Array.isArray(existing)) {
    return [...existing, value];
  }
  if (typeof existing === "string") {
    return [existing, value];
  }
  if (typeof existing === "number") {
    return [String(existing), value];
  }
  return [value];
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(/,(?=\s*[^;,]+=)/).map((cookie) => cookie.trim()).filter(Boolean);
}

function ensureCloudRuntimeConfigured(runtime: SailRuntime): void {
  ensureS3Configured();
  if (runtime === "fly") {
    ensureFlyConfigured();
  }
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
