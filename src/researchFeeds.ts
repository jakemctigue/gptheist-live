/** Read-only feeds. This module has no signer and never calls a transaction submission API. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export interface FeedQuote {
  inputMint: string; outputMint: string; inputAmount: string; outputAmount: string;
  requestedAt: string; observedAt: string; router: string; feeBps: number;
  externalFeeLamports: number | null; buildStatus: "NOT_REQUESTED" | "BUILT" | "FAILED";
  expiresAt: string | null; raw: Record<string, unknown>;
}
export interface PriceObservation { base: string; usd: number; observedAt: string; sourceDate: string | null }
export class ResearchFeedError extends Error {
  constructor(public readonly code: string, public readonly attempts = 0) { super(code); }
}
const positiveAmount = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,24}$/.test(v);
export function parseOrder(raw: unknown, inputMint: string, outputMint: string, amount: string, requestedAt: string, observedAt: string): FeedQuote {
  if (!raw || typeof raw !== "object") throw new ResearchFeedError("INVALID_QUOTE");
  const x = raw as Record<string, unknown>;
  if (x.inputMint !== inputMint || x.outputMint !== outputMint || x.inAmount !== amount || !positiveAmount(x.outAmount)
    || typeof x.router !== "string" || !Array.isArray(x.routePlan) || x.routePlan.length === 0
    || !Number.isInteger(x.feeBps) || Number(x.feeBps) < 0 || Number(x.feeBps) >= 10_000) throw new ResearchFeedError("INVALID_QUOTE");
  const feeFields = [x.signatureFeeLamports, x.prioritizationFeeLamports, x.rentFeeLamports];
  const complete = feeFields.every(v => Number.isSafeInteger(v) && Number(v) >= 0);
  const total = complete ? feeFields.reduce<number>((s,v) => s + Number(v), 0) : null;
  if (total !== null && !Number.isSafeInteger(total)) throw new ResearchFeedError("INVALID_NETWORK_FEES");
  const expiresAt = typeof x.expireAt === "string" ? x.expireAt : null;
  if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(observedAt))) throw new ResearchFeedError("EXPIRED_QUOTE");
  const rawAllowed: Record<string, unknown> = {};
  for (const key of ["inputMint","outputMint","inAmount","outAmount","otherAmountThreshold","slippageBps","priceImpact","routePlan","feeMint","feeBps","platformFee","signatureFeeLamports","prioritizationFeeLamports","rentFeeLamports","gasless","router","requestId","contextSlot","lastValidBlockHeight","expireAt","errorCode"]) {
    if (x[key] !== undefined) rawAllowed[key] = x[key];
  }
  return { inputMint, outputMint, inputAmount: amount, outputAmount: x.outAmount, requestedAt, observedAt,
    router: x.router, feeBps: Number(x.feeBps), externalFeeLamports: total,
    buildStatus: x.transaction === "" || x.errorCode !== undefined ? "FAILED" : typeof x.transaction === "string" ? "BUILT" : "NOT_REQUESTED",
    expiresAt, raw: rawAllowed };
}

export function createResearchFeeds(apiKey: string | undefined, options: {
  fetcher?: typeof fetch; clock?: () => number; sleep?: (ms: number) => Promise<void>; maxRequests?: number;
} = {}) {
  const fetcher = options.fetcher ?? fetch;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let nextRequest = 0, requestCount = 0;
  async function get(url: string, key?: string): Promise<{ data: unknown; observedAt: string; sourceDate: string | null }> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (requestCount >= (options.maxRequests ?? 24)) throw new ResearchFeedError("REQUEST_BUDGET_EXHAUSTED", requestCount);
      await sleep(Math.max(0, nextRequest - clock()));
      nextRequest = clock() + 1_100; // One process is strictly below the shared free-tier 1 RPS ceiling.
      requestCount++;
      let response: Response;
      try { response = await fetcher(url, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(10_000), redirect: "error" }); }
      catch { if (attempt === 2) throw new ResearchFeedError("NETWORK_TIMEOUT_OR_FAILURE", attempt); await sleep(2_000); continue; }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await sleep(2_000); continue; }
      if (!response.ok) throw new ResearchFeedError(`HTTP_${response.status}`, attempt);
      const content = await response.text();
      if (content.length > 2_000_000) throw new ResearchFeedError("RESPONSE_TOO_LARGE", attempt);
      let data: unknown;
      try { data = JSON.parse(content); } catch { throw new ResearchFeedError("INVALID_JSON", attempt); }
      return { data, observedAt: new Date(clock()).toISOString(), sourceDate: response.headers.get("date") };
    }
    throw new ResearchFeedError("RETRY_EXHAUSTED");
  }
  async function order(inputMint: string, outputMint: string, amount: string): Promise<FeedQuote> {
    if (!apiKey?.trim()) throw new ResearchFeedError("JUPITER_KEY_MISSING");
    if (!positiveAmount(amount)) throw new ResearchFeedError("INVALID_AMOUNT");
    const requestedAt = new Date(clock()).toISOString();
    const query = new URLSearchParams({ inputMint, outputMint, amount });
    const result = await get(`https://api.jup.ag/swap/v2/order?${query}`, apiKey);
    return parseOrder(result.data, inputMint, outputMint, amount, requestedAt, result.observedAt);
  }
  return {
    get requestCount() { return requestCount; },
    order,
    async quotePair(usdcAtoms: string) {
      const entry = await order(USDC_MINT, SOL_MINT, usdcAtoms);
      const reverse = await order(SOL_MINT, USDC_MINT, entry.outputAmount);
      return { entry, reverse };
    },
    async candles(nowMs: number) {
      const end = Math.floor(nowMs / 86_400_000) * 86_400_000;
      const params = new URLSearchParams({ granularity: "86400", start: new Date(end - 250 * 86_400_000).toISOString(), end: new Date(end).toISOString() });
      return get(`https://api.exchange.coinbase.com/products/SOL-USD/candles?${params}`);
    },
    async price(base: "SOL" | "USDC"): Promise<PriceObservation> {
      const response = await get(`https://api.coinbase.com/v2/prices/${base}-USD/spot`);
      const x = response.data as { data?: { base?: unknown; currency?: unknown; amount?: unknown } };
      const usd = Number(x?.data?.amount);
      if (x?.data?.base !== base || x.data.currency !== "USD" || !Number.isFinite(usd) || usd <= 0) throw new ResearchFeedError("INVALID_PRICE");
      return { base, usd, observedAt: response.observedAt, sourceDate: response.sourceDate };
    }
  };
}
