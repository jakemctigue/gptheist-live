import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RPC_URL, ROBINHOOD_CHAIN_ID, fetchLiveSnapshot, type LiveSnapshot, type RpcCaller } from "./live.js";
import { fetchDeployerHistory, resolveHistoryRange, type DeployerHistory, type HistoryRange } from "./history.js";
import { preparePonsTrade, publicTradePolicy, TradeGateError, tradePolicyFromEnv, type TradePolicy, type TradeRequest } from "./trading.js";
import { normalizedWallet, WalletAuth, WalletAuthError } from "./walletAuth.js";
import { aiProviderConfigFromEnv, publicAiProviderStatus, type AiProviderConfig } from "./providerConfig.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ASSETS = resolve(projectRoot, "assets/desk");
const WALLET_SESSION_COOKIE = "gptheist_wallet_session";
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} as const;

export interface DeskServerOptions {
  rpc?: RpcCaller;
  rpcUrl?: string;
  assetsRoot?: string;
  cacheMs?: number;
  failureCacheMs?: number;
  socialFetch?: typeof fetch;
  tradePolicy?: TradePolicy;
  historyCacheMs?: number;
  walletAuth?: WalletAuth;
  publicOrigin?: string;
  aiProviders?: AiProviderConfig;
}

export interface RpcCallerOptions {
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

export function createHttpRpcCaller(url?: string, options: RpcCallerOptions = {}): RpcCaller {
  let requestId = 0;
  let lastRequestAt = 0;
  let lastLogsAt = 0;
  const fetcher = options.fetch ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 400;
  const endpoints = (url ? url.split(",").map((value) => value.trim()).filter(Boolean) : [
    "https://robinhood-rpc.publicnode.com#nologs",
    DEFAULT_RPC_URL
  ]).map((value) => ({ url: value.replace(/#nologs$/, ""), logs: !value.endsWith("#nologs") }));
  const sleep = (milliseconds: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
  return async (method, params = []) => {
    const candidates = endpoints.filter((endpoint) => method !== "eth_getLogs" || endpoint.logs);
    if (candidates.length === 0) throw new Error("No configured RPC endpoint supports eth_getLogs");
    let lastError = "RPC request failed";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const endpoint = candidates[attempt % candidates.length];
      if (!endpoint) break;
      const now = Date.now();
      const minimumStart = Math.max(lastRequestAt + 80, method === "eth_getLogs" ? lastLogsAt + 500 : 0);
      if (minimumStart > now) await sleep(minimumStart - now);
      lastRequestAt = Date.now();
      if (method === "eth_getLogs") lastLogsAt = lastRequestAt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetcher(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "gptheist/1.1 read-only" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
          signal: controller.signal
        });
        const text = await response.text();
        if (response.status === 429 || response.status === 503) {
          lastError = `RPC HTTP ${response.status}`;
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        let value: { result?: unknown; error?: { message?: string } };
        try {
          value = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
        } catch {
          throw new Error("RPC returned invalid JSON");
        }
        if (value.error) throw new Error(value.error.message ?? "RPC request failed");
        if (!("result" in value)) throw new Error("RPC response is missing result");
        return value.result;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : lastError;
        if (attempt < 4) await sleep(retryDelayMs * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${method} failed after bounded retries: ${lastError}`);
  };
}

function send(response: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": type.includes("html") ? "no-store" : "no-cache", ...headers });
  response.end(body);
}

function requestOrigin(request: IncomingMessage, configuredOrigin?: string): string {
  if (configuredOrigin) return configuredOrigin;
  const host = request.headers.host;
  if (!host || host.length > 255 || !/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/.test(host)) {
    throw new WalletAuthError("INVALID_ORIGIN", "request host is invalid", 400);
  }
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedProtocol = typeof forwarded === "string" ? forwarded.split(",", 1)[0]?.trim().toLowerCase() : undefined;
  if (forwardedProtocol !== undefined && forwardedProtocol !== "http" && forwardedProtocol !== "https") {
    throw new WalletAuthError("INVALID_ORIGIN", "forwarded request protocol is invalid", 400);
  }
  return new URL(`${forwardedProtocol ?? "http"}://${host}`).origin;
}

function requireSameOrigin(request: IncomingMessage, configuredOrigin?: string): string {
  const expected = requestOrigin(request, configuredOrigin);
  if (request.headers.origin !== expected) {
    throw new WalletAuthError("ORIGIN_MISMATCH", "request origin is not allowed", 403);
  }
  return expected;
}

function sessionToken(request: IncomingMessage): string | null {
  const cookie = request.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== WALLET_SESSION_COOKIE) continue;
    const token = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  return null;
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${WALLET_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function authError(response: ServerResponse, error: WalletAuthError): void {
  send(response, error.status, "application/json; charset=utf-8", JSON.stringify({ error: error.message, code: error.code }));
}

async function readJsonBody(request: IncomingMessage, maximumBytes = 8_192): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new TradeGateError("CONTENT_TYPE", "content-type must be application/json", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new TradeGateError("BODY_TOO_LARGE", "request body exceeds 8192 bytes", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TradeGateError("INVALID_JSON", "request body must be valid JSON", 400);
  }
}

export function createDeskServer(options: DeskServerOptions = {}): Server {
  const rpc = options.rpc ?? createHttpRpcCaller(options.rpcUrl);
  const root = resolve(options.assetsRoot ?? DEFAULT_ASSETS);
  const cacheMs = options.cacheMs ?? 4_000;
  const failureCacheMs = options.failureCacheMs ?? 15_000;
  const socialFetch = options.socialFetch ?? fetch;
  const tradePolicy = options.tradePolicy ?? tradePolicyFromEnv();
  const walletAuth = options.walletAuth ?? new WalletAuth();
  const aiProviders = options.aiProviders ?? aiProviderConfigFromEnv();
  const configuredOrigin = options.publicOrigin ?? (process.env.GPTHEIST_PUBLIC_ORIGIN?.trim() || undefined);
  if (configuredOrigin) {
    const parsed = new URL(configuredOrigin);
    if (parsed.origin !== configuredOrigin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("GPTHEIST_PUBLIC_ORIGIN must be an http(s) origin without a path");
    }
  }
  const historyCacheMs = options.historyCacheMs ?? 30 * 60_000;
  const socialCache = new Map<string, { at: number; value: string }>();
  const historyCache = new Map<string, { at: number; value: DeployerHistory }>();
  const historyPending = new Map<string, Promise<DeployerHistory>>();
  let historyRangeCache: { at: number; value: HistoryRange } | null = null;
  let historyRangePending: Promise<HistoryRange> | null = null;
  let cached: { at: number; value: LiveSnapshot } | null = null;
  let cachedFailure: { at: number; message: string } | null = null;
  let pending: Promise<LiveSnapshot> | null = null;
  const snapshot = async (): Promise<LiveSnapshot> => {
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    if (cachedFailure && Date.now() - cachedFailure.at < failureCacheMs) throw new Error(cachedFailure.message);
    if (!pending) {
      pending = fetchLiveSnapshot(rpc).then((value) => {
        cached = { at: Date.now(), value };
        cachedFailure = null;
        return value;
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "upstream unavailable";
        cachedFailure = { at: Date.now(), message };
        throw error;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/trace": ["room.html", "text/html; charset=utf-8"],
    "/crew": ["room.html", "text/html; charset=utf-8"],
    "/method": ["room.html", "text/html; charset=utf-8"],
    "/vault": ["room.html", "text/html; charset=utf-8"],
    "/desk.css": ["desk.css", "text/css; charset=utf-8"],
    "/desk.js": ["desk.js", "text/javascript; charset=utf-8"],
    "/rooms.js": ["rooms.js", "text/javascript; charset=utf-8"]
  };

  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const path = requestUrl.pathname;
      if (path === "/api/auth/session") {
        if (request.method !== "GET") {
          send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
          return;
        }
        const session = walletAuth.readSession(sessionToken(request));
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(session
          ? { authenticated: true, wallet: session.wallet, expiresAt: session.expiresAt }
          : { authenticated: false }), { "cache-control": "no-store" });
        return;
      }
      if (path === "/api/providers") {
        if (request.method !== "GET") {
          send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
          return;
        }
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(publicAiProviderStatus(aiProviders)), { "cache-control": "no-store" });
        return;
      }
      if (path === "/api/auth/challenge") {
        if (request.method !== "POST") {
          send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
          return;
        }
        try {
          const origin = requireSameOrigin(request, configuredOrigin);
          const body = await readJsonBody(request);
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            throw new WalletAuthError("INVALID_AUTH_REQUEST", "authentication request must be a JSON object", 400);
          }
          const challenge = walletAuth.createChallenge((body as Record<string, unknown>).wallet, origin, request.socket.remoteAddress ?? "unknown");
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(challenge), { "cache-control": "no-store" });
        } catch (error: unknown) {
          if (error instanceof WalletAuthError) authError(response, error);
          else if (error instanceof TradeGateError) send(response, error.status, "application/json; charset=utf-8", JSON.stringify({ error: error.message, code: error.code }));
          else send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "authentication unavailable", code: "AUTH_UNAVAILABLE" }));
        }
        return;
      }
      if (path === "/api/auth/verify") {
        if (request.method !== "POST") {
          send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
          return;
        }
        try {
          const origin = requireSameOrigin(request, configuredOrigin);
          const verified = await walletAuth.verifyChallenge(await readJsonBody(request), origin, request.socket.remoteAddress ?? "unknown");
          const maxAge = Math.max(1, Math.floor((Date.parse(verified.session.expiresAt) - Date.now()) / 1_000));
          send(response, 200, "application/json; charset=utf-8", JSON.stringify({ authenticated: true, ...verified.session }), {
            "cache-control": "no-store",
            "set-cookie": sessionCookie(verified.token, maxAge, origin.startsWith("https://"))
          });
        } catch (error: unknown) {
          if (error instanceof WalletAuthError) authError(response, error);
          else if (error instanceof TradeGateError) send(response, error.status, "application/json; charset=utf-8", JSON.stringify({ error: error.message, code: error.code }));
          else send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "authentication unavailable", code: "AUTH_UNAVAILABLE" }));
        }
        return;
      }
      if (path === "/api/auth/logout") {
        if (request.method !== "POST") {
          send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
          return;
        }
        try {
          const origin = requireSameOrigin(request, configuredOrigin);
          walletAuth.destroySession(sessionToken(request));
          send(response, 200, "application/json; charset=utf-8", JSON.stringify({ authenticated: false }), {
            "cache-control": "no-store",
            "set-cookie": sessionCookie("", 0, origin.startsWith("https://"))
          });
        } catch (error: unknown) {
          if (error instanceof WalletAuthError) authError(response, error);
          else send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "authentication unavailable", code: "AUTH_UNAVAILABLE" }));
        }
        return;
      }
      if (path === "/api/trade/prepare") {
        if (request.method !== "POST") {
          send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
          return;
        }
        try {
          requireSameOrigin(request, configuredOrigin);
          const session = walletAuth.readSession(sessionToken(request));
          if (!session) throw new WalletAuthError("AUTH_REQUIRED", "authenticate the trading wallet with MetaMask first", 401);
          const body = await readJsonBody(request);
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            throw new TradeGateError("INVALID_REQUEST", "request body must be a JSON object", 400);
          }
          const requestedWallet = normalizedWallet((body as Record<string, unknown>).wallet);
          if (requestedWallet !== session.wallet) {
            throw new WalletAuthError("AUTH_WALLET_MISMATCH", "authenticated wallet does not match the trade wallet", 403);
          }
          const prepared = await preparePonsTrade(rpc, body as TradeRequest, tradePolicy);
          prepared.gates.splice(2, 0, { id: "WALLET_AUTHENTICATED", passed: true, detail: "Server verified the wallet's one-time signed login challenge" });
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(prepared));
        } catch (error: unknown) {
          if (error instanceof WalletAuthError) {
            authError(response, error);
          } else if (error instanceof TradeGateError) {
            send(response, error.status, "application/json; charset=utf-8", JSON.stringify({ error: error.message, code: error.code }));
          } else {
            send(response, 502, "application/json; charset=utf-8", JSON.stringify({ error: "trade preparation unavailable", code: "UPSTREAM_UNAVAILABLE" }));
          }
        }
        return;
      }
      if (request.method !== "GET") {
        send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method not allowed" }));
        return;
      }
      if (path === "/health") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ status: "ok", mode: "wallet-authenticated", chainId: ROBINHOOD_CHAIN_ID, trading: tradePolicy.enabled, providers: publicAiProviderStatus(aiProviders) }));
        return;
      }
      if (path === "/api/trade/policy") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(publicTradePolicy(tradePolicy)));
        return;
      }
      if (path === "/api/history") {
        const deployer = requestUrl.searchParams.get("deployer") ?? "";
        const beforeBlockText = requestUrl.searchParams.get("beforeBlock") ?? "";
        const beforeLogIndexText = requestUrl.searchParams.get("beforeLogIndex") ?? "";
        if (!/^0x[0-9a-fA-F]{40}$/.test(deployer) || !/^[0-9]+$/.test(beforeBlockText) || !/^[0-9]+$/.test(beforeLogIndexText)) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid history query" }));
          return;
        }
        const beforeBlock = Number(beforeBlockText);
        const beforeLogIndex = Number(beforeLogIndexText);
        if (!Number.isSafeInteger(beforeBlock) || !Number.isSafeInteger(beforeLogIndex)) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid history query" }));
          return;
        }
        const key = `${deployer.toLowerCase()}:${beforeBlock}:${beforeLogIndex}`;
        const hit = historyCache.get(key);
        if (hit && Date.now() - hit.at < historyCacheMs) {
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(hit.value));
          return;
        }
        try {
          let pendingHistory = historyPending.get(key);
          if (!pendingHistory) {
            pendingHistory = (async () => {
              if (!historyRangeCache || Date.now() - historyRangeCache.at >= historyCacheMs || beforeBlock > historyRangeCache.value.toBlock) {
                if (!historyRangePending) historyRangePending = resolveHistoryRange(rpc, 30);
                try {
                  historyRangeCache = { at: Date.now(), value: await historyRangePending };
                } finally {
                  historyRangePending = null;
                }
              }
              return fetchDeployerHistory(rpc, { deployer, beforeBlock, beforeLogIndex }, historyRangeCache.value);
            })();
            historyPending.set(key, pendingHistory);
          }
          const value = await pendingHistory;
          historyCache.set(key, { at: Date.now(), value });
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(value));
        } catch {
          send(response, 502, "application/json; charset=utf-8", JSON.stringify({ error: "historical on-chain research unavailable" }));
        } finally {
          historyPending.delete(key);
        }
        return;
      }
      if (path === "/api/social") {
        const handle = requestUrl.searchParams.get("handle") ?? "";
        if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid X handle" }));
          return;
        }
        const key = handle.toLowerCase();
        const hit = socialCache.get(key);
        if (hit && Date.now() - hit.at < 300_000) {
          send(response, 200, "application/json; charset=utf-8", hit.value);
          return;
        }
        const controller = new AbortController();
        const socialTimer = setTimeout(() => controller.abort(), 8_000);
        try {
          const upstream = await socialFetch(`https://api.fxtwitter.com/${key}`, {
            headers: { accept: "application/json", "user-agent": "gptheist/1.2 read-only" },
            signal: controller.signal
          });
          if (!upstream.ok) throw new Error(`profile HTTP ${upstream.status}`);
          const payload = await upstream.json() as { user?: Record<string, unknown> };
          const user = payload.user;
          if (!user || typeof user.screen_name !== "string" || typeof user.name !== "string" ||
              typeof user.followers !== "number" || typeof user.joined !== "string" || typeof user.protected !== "boolean") {
            throw new Error("invalid public profile response");
          }
          const value = JSON.stringify({
            status: "PUBLIC_PROFILE",
            handle: user.screen_name.slice(0, 15),
            name: user.name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
            followers: Math.max(0, Math.floor(user.followers)),
            joined: user.joined.slice(0, 80),
            protected: user.protected,
            verified: Boolean((user.verification as { verified?: unknown } | undefined)?.verified),
            source: "FxTwitter public profile mirror"
          });
          socialCache.set(key, { at: Date.now(), value });
          send(response, 200, "application/json; charset=utf-8", value);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message.slice(0, 120) : "profile unavailable";
          send(response, 502, "application/json; charset=utf-8", JSON.stringify({ status: "UNAVAILABLE", error: message }));
        } finally {
          clearTimeout(socialTimer);
        }
        return;
      }
      if (path === "/api/snapshot") {
        try {
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(await snapshot()));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message.slice(0, 200) : "upstream unavailable";
          send(response, 502, "application/json; charset=utf-8", JSON.stringify({ error: message, mode: "read-only" }));
        }
        return;
      }
      const asset = assets[path];
      if (!asset) {
        send(response, 404, "text/plain; charset=utf-8", "Not found\n");
        return;
      }
      send(response, 200, asset[1], await readFile(resolve(root, asset[0]), "utf8"));
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Internal error\n");
    }
  });
}

export async function startDeskServer(options: DeskServerOptions & { host?: string; port?: number } = {}): Promise<Server> {
  const server = createDeskServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  server.listen(port, host);
  await new Promise<void>((resolveReady, reject) => {
    server.once("listening", resolveReady);
    server.once("error", reject);
  });
  return server;
}
