import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { toNodeHandler } from "better-auth/node";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type DeviceLogin = {
  deviceCode: string;
  token?: string;
  accountId?: string;
  email?: string;
  expiresAt: number;
};

type Sail = {
  id: string;
  status: "queued" | "running" | "paused" | "completed" | "failed";
  repoName?: string;
  task?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
};

const port = Number(process.env.PORT || 3000);
const baseURL = requiredEnv("BETTER_AUTH_URL", `http://localhost:${port}`);
const dataDir = process.env.RUDDER_CLOUD_DATA_DIR || path.join(os.homedir(), ".rudder-cloud");
const dbPath = process.env.RUDDER_CLOUD_DB || path.join(dataDir, "rudder-cloud.sqlite");
const deviceLogins = new Map<string, DeviceLogin>();
const sails = new Map<string, Sail>();

await fs.mkdir(dataDir, { recursive: true });

const auth = betterAuth({
  baseURL,
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  database: new Database(dbPath),
  socialProviders: {
    google: {
      clientId: requiredEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    },
    github: {
      clientId: requiredEnv("GITHUB_CLIENT_ID"),
      clientSecret: requiredEnv("GITHUB_CLIENT_SECRET"),
    },
  },
});

const authHandler = toNodeHandler(auth.handler);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", baseURL);
    if (url.pathname.startsWith("/api/auth")) {
      authHandler(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cli/login") {
      await handleCliLoginStart(req, res);
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

async function handleCliLoginStart(_req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const responseBody: Record<string, Json> = {
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

function renderLoginPage(url: URL, res: ServerResponse): void {
  const deviceCode = url.searchParams.get("device_code") || "";
  const callbackURL = `/cli/approve?device_code=${encodeURIComponent(deviceCode)}`;
  sendHtml(res, `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rudder Cloud Login</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:48px;color:#111}a{display:block;margin:12px 0;color:#111}</style></head>
<body><h1>Rudder Cloud</h1><p>Choose a provider to finish CLI login.</p>
<a href="/api/auth/sign-in/social?provider=google&callbackURL=${encodeURIComponent(callbackURL)}">Continue with Google</a>
<a href="/api/auth/sign-in/social?provider=github&callbackURL=${encodeURIComponent(callbackURL)}">Continue with GitHub</a>
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
  const token = `rdr_${randomBytes(32).toString("base64url")}`;
  login.token = token;
  login.accountId = String(session.user.id || tokenHash(token));
  login.email = typeof session.user.email === "string" ? session.user.email : undefined;
  sendHtml(res, "<p>Rudder Cloud login complete. You can close this tab.</p>");
}

async function handleSailApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  requireBearer(req);
  if (req.method === "GET" && url.pathname === "/api/rudder/sail") {
    sendJson(res, 200, { sails: [...sails.values()] });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rudder/sail/launch") {
    const body = await readJsonBody(req);
    const sail = createSail(body);
    sendJson(res, 200, sail);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rudder/sail/onload") {
    const body = await readJsonBody(req);
    const sail = createSail(body, stringField(body, "runId"));
    sendJson(res, 200, sail);
    return;
  }
  const match = url.pathname.match(/^\/api\/rudder\/sail\/([^/]+)\/(pause|resume|onload)$/);
  if (req.method === "POST" && match) {
    const sail = sails.get(match[1]);
    if (!sail) {
      sendJson(res, 404, { error: "sail not found" });
      return;
    }
    sail.status = match[2] === "pause" ? "paused" : "running";
    sail.updatedAt = new Date().toISOString();
    sendJson(res, 200, sail);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function createSail(body: Json, preferredId?: string): Sail {
  const now = new Date().toISOString();
  const sail: Sail = {
    id: preferredId || `sail_${randomBytes(5).toString("hex")}`,
    status: "queued",
    repoName: stringField(body, "repoName"),
    task: stringField(body, "task"),
    createdAt: now,
    updatedAt: now,
  };
  sails.set(sail.id, sail);
  return sail;
}

function requireBearer(req: IncomingMessage): void {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer rdr_")) {
    const error = new Error("unauthorized");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
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

function stringField(value: Json, field: string): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value[field] === "string"
    ? value[field]
    : undefined;
}

function sendJson(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
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

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
