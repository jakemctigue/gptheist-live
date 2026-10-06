import { ROBINHOOD_CHAIN_ID, type RpcCaller } from "./live.js";

const READ_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_gasPrice"]);
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

interface FeedOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = env[key]?.trim() ? Number(env[key]) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} is invalid`);
  return value;
}

export function paperRpcUrlsFromEnv(env: NodeJS.ProcessEnv): string[] {
  let urls = env.ROBINHOOD_RPC_URL?.split(",").map((url) => url.trim().replace(/#nologs$/, "")).filter(Boolean) ?? [];
  if (urls.length === 0) {
    const key = env.ALCHEMY_API_KEY?.trim();
    if (!key || !/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw new Error("Configure ROBINHOOD_RPC_URL or a valid ALCHEMY_API_KEY");
    urls = [`https://robinhood-mainnet.g.alchemy.com/v2/${key}`];
  }
  const unique = [...new Set(urls)];
  if (unique.length > 5) throw new Error("Configure at most five paper RPC endpoints");
  for (const value of unique) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("ROBINHOOD_RPC_URL contains an invalid URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Paper RPC endpoints require HTTPS without URL credentials or fragments");
  }
  return unique;
}

function retryDelay(response: Response, now: number, fallback: number): number {
  const header = response.headers.get("retry-after");
  if (header === null) return fallback;
  const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1_000 : Date.parse(header) - now;
  return Number.isFinite(seconds) ? Math.max(fallback, seconds) : fallback;
}

class FeedError extends Error {
  constructor(message: string, readonly cooldownMs: number, readonly permanent = false) { super(message); }
}

class RpcApplicationError extends Error {}

export function createPaperRpcCaller(urls: readonly string[], options: FeedOptions = {}): RpcCaller {
  if (urls.length === 0 || urls.length > 5) throw new Error("Paper RPC needs one to five explicit endpoints");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const endpoints = urls.map((url) => ({ url, validated: false, disabled: false, nextAttemptAt: 0 }));
  let requestId = 0;
  async function request(url: string, method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const id = ++requestId;
      const response = await fetcher(url, {
        method: "POST", headers: { "content-type": "application/json", "user-agent": "gptheist/1.2 paper-only" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal
      });
      if (!response.ok) throw new FeedError(`RPC HTTP ${response.status}`, retryDelay(response, now(), response.status === 429 ? 60_000 : 30_000));
      const payload = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { code?: unknown } };
      if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id) {
        throw new FeedError("Invalid RPC response", 30_000);
      }
      if (payload.error) {
        const code = typeof payload.error.code === "number" ? payload.error.code : null;
        if (code === 429 || code === -32005) throw new FeedError("RPC quota error", 60_000);
        if (code === -32603) throw new FeedError("RPC internal error", 30_000);
        // A contract revert is an application result, not evidence the provider is down.
        throw new RpcApplicationError(`RPC application error${code === null ? "" : ` (${code})`}`);
      }
      if (!("result" in payload)) throw new FeedError("Invalid RPC response", 30_000);
      return payload.result;
    } catch (error: unknown) {
      // Provider error text can echo a credential-bearing URL; never propagate it.
      if (error instanceof FeedError || error instanceof RpcApplicationError) throw error;
      throw new FeedError("RPC transport or JSON failure", 30_000);
    } finally { clearTimeout(timer); }
  }
  return async (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new Error(`Paper RPC method is not permitted: ${method}`);
    const failures: string[] = [];
    for (const [index, endpoint] of endpoints.entries()) {
      if (endpoint.disabled || now() < endpoint.nextAttemptAt) continue;
      try {
        if (!endpoint.validated || method === "eth_chainId") {
          const chain = await request(endpoint.url, "eth_chainId", []);
          if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(ROBINHOOD_CHAIN_ID)) {
            throw new FeedError(`RPC endpoint ${index + 1} is not Robinhood Chain mainnet (${ROBINHOOD_CHAIN_ID})`, 0, true);
          }
          endpoint.validated = true;
          if (method === "eth_chainId") return chain;
        }
        return await request(endpoint.url, method, params);
      } catch (error: unknown) {
        if (error instanceof RpcApplicationError) throw error;
        const failure = error instanceof FeedError ? error : new FeedError("RPC failure", 30_000);
        endpoint.disabled = failure.permanent;
        endpoint.nextAttemptAt = now() + failure.cooldownMs;
        failures.push(`endpoint ${index + 1}: ${failure.message}`);
      }
    }
    throw new Error(`${method} unavailable: ${failures.join("; ") || "configured endpoints are cooling down or rejected"}`);
  };
}

export interface PaperEthUsdPrice {
  usdMicros: number;
  provider: "coinbase" | "alchemy";
  observedAt: Date;
  sourceTimestamp: Date;
  freshnessBasis: "http-response-date" | "provider-price-timestamp";
}

export function createPaperEthUsdPriceReader(env: NodeJS.ProcessEnv, options: FeedOptions = {}): () => Promise<PaperEthUsdPrice> {
  const providers = (env.PAPER_ETH_USD_PROVIDERS ?? "alchemy").split(",").map((value) => value.trim().toLowerCase());
  if (providers.length < 1 || providers.length > 2 || providers.some((provider) => provider !== "coinbase" && provider !== "alchemy")) {
    throw new Error("PAPER_ETH_USD_PROVIDERS must be coinbase, alchemy, or an explicit ordered combination");
  }
  const key = env.ALCHEMY_API_KEY?.trim();
  if (providers.includes("alchemy") && (!key || !/^[A-Za-z0-9_-]{10,200}$/.test(key))) throw new Error("Alchemy ETH/USD provider needs ALCHEMY_API_KEY");
  const ttl = boundedInteger(env, "PAPER_ETH_USD_CACHE_MS", 60_000, 1_000, 300_000);
  const maxAge = boundedInteger(env, "PAPER_ETH_USD_MAX_AGE_MS", 120_000, 30_000, 900_000);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cooldowns = new Map<string, number>();
  let cached: PaperEthUsdPrice | undefined;
  let pending: Promise<PaperEthUsdPrice> | undefined;
  function fresh(price: PaperEthUsdPrice): boolean {
    const observedAge = now() - price.observedAt.getTime();
    const sourceAge = now() - price.sourceTimestamp.getTime();
    return observedAge >= 0 && observedAge < ttl && sourceAge >= -30_000 && sourceAge <= maxAge;
  }
  async function load(): Promise<PaperEthUsdPrice> {
    const failures: string[] = [];
    for (const provider of [...new Set(providers)]) {
      if (now() < (cooldowns.get(provider) ?? 0)) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        const response = await fetcher(provider === "coinbase" ? COINBASE_SPOT_URL : `https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?symbols=ETH`, {
          headers: { accept: "application/json", "cache-control": "no-cache", "user-agent": "gptheist/1.2 paper-only" }, signal: controller.signal
        });
        if (!response.ok) throw new FeedError(`${provider} Prices HTTP ${response.status}`, retryDelay(response, now(), 60_000));
        const payload: unknown = await response.json();
        let amount: unknown;
        let timestamp: number;
        if (provider === "coinbase") {
          const data = (payload as { data?: { base?: unknown; currency?: unknown; amount?: unknown } } | null)?.data;
          if (!data || data.currency !== "USD" || (data.base !== undefined && data.base !== "ETH")) throw new Error("invalid ETH/USD schema");
          amount = data.amount;
          timestamp = Date.parse(response.headers.get("date") ?? "");
          const age = Number(response.headers.get("age") ?? "0");
          if (!Number.isFinite(age) || age < 0 || age * 1_000 > maxAge) throw new Error("stale cached ETH/USD response");
          timestamp -= age * 1_000;
        } else {
          const data = (payload as { data?: Array<{ symbol?: unknown; prices?: Array<{ currency?: unknown; value?: unknown; lastUpdatedAt?: unknown }> }> } | null)?.data;
          const token = data?.find((entry) => entry.symbol === "ETH");
          const price = token?.prices?.find((entry) => typeof entry.currency === "string" && entry.currency.toLowerCase() === "usd");
          amount = price?.value;
          timestamp = typeof price?.lastUpdatedAt === "string" ? Date.parse(price.lastUpdatedAt) : Number.NaN;
        }
        const numeric = typeof amount === "string" && /^(?:\d+)(?:\.\d+)?$/.test(amount) ? Number(amount) : Number.NaN;
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000) throw new Error("invalid ETH/USD price");
        if (!Number.isFinite(timestamp) || now() - timestamp > maxAge || timestamp - now() > 30_000) throw new Error("stale or missing ETH/USD timestamp");
        cached = {
          usdMicros: Math.round(numeric * 1_000_000), provider: provider as PaperEthUsdPrice["provider"],
          observedAt: new Date(now()), sourceTimestamp: new Date(timestamp),
          freshnessBasis: provider === "coinbase" ? "http-response-date" : "provider-price-timestamp"
        };
        return cached;
      } catch (error: unknown) {
        cooldowns.set(provider, now() + (error instanceof FeedError ? error.cooldownMs : 30_000));
        failures.push(error instanceof FeedError ? error.message : `${provider} ETH/USD schema or freshness check failed`);
      } finally { clearTimeout(timer); }
    }
    throw new Error(`ETH/USD unavailable: ${failures.join("; ") || "configured price providers are cooling down"}`);
  }
  return async () => {
    if (cached && fresh(cached)) return cached;
    if (!pending) pending = load().finally(() => { pending = undefined; });
    return pending;
  };
}
