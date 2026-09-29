import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { ROBINHOOD_CHAIN_ID, type LiveLaunch, type RpcCaller } from "./live.js";
import { assessPonsLaunch, readPonsLaunchResearch, type VerifiedPonsMarketState } from "./market.js";

const RUN_ID = "paper-month-v1";
const STRATEGY_VERSION = "pons-forward-v1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USD_MICROS = 1_000_000;
const BPS = 10_000n;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const LEASE_MS = 2 * 60_000;

export interface PaperTradingConfig {
  enabled: boolean;
  startingUsdMicros: number;
  durationDays: number;
  pollMs: number;
  positionBps: number;
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldMs: number;
  maxTotalFeeBps: number;
  maxPriceImpactBps: number;
  modeledSlippageBps: number;
  modeledGasUnits: number;
  maxCandidatesPerTick: number;
  candidateMaxAgeMs: number;
}

interface StrategySnapshot extends Document {
  version: typeof STRATEGY_VERSION;
  positionBps: number;
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldMs: number;
  maxOpenPositions: 1;
  maxEntriesPerUtcDay: 1;
  maxTotalFeeBps: number;
  maxPriceImpactBps: number;
  modeledSlippageBps: number;
  modeledGasUnits: number;
  entryScoreMinimum: 70;
  pair: "ETH";
  phase: "CURVE";
}

interface PaperRun extends Document {
  _id: string;
  mode: "paper-only";
  status: "RUNNING" | "COMPLETE";
  startingUsdMicros: number;
  cashUsdMicros: number;
  realizedPnlUsdMicros: number;
  unrealizedPnlUsdMicros: number;
  equityUsdMicros: number;
  profitUsdMicros: number;
  entryCount: number;
  closedTradeCount: number;
  winCount: number;
  lossCount: number;
  startedAt: Date;
  endsAt: Date;
  lastTickAt: Date | null;
  lastEntryAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date;
  strategy: StrategySnapshot;
}

interface PaperPosition extends Document {
  _id: string;
  runId: typeof RUN_ID;
  status: "OPEN" | "CLOSED";
  launch: LiveLaunch;
  assessmentScore: number;
  assessmentReasons: string[];
  openedAt: Date;
  closedAt: Date | null;
  closeReason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_STOP" | "MONTH_END" | "MONTH_END_STALE_MARK" | null;
  entryEthUsdMicros: number;
  entryNotionalUsdMicros: number;
  entryGasUsdMicros: number;
  entryDebitUsdMicros: number;
  grossQuoteWei: string;
  tokenAmount: string;
  entryFeeBps: number;
  entryPriceImpactBps: number;
  modeledSlippageBps: number;
  lastMarkAt: Date | null;
  lastMarkUsdMicros: number;
  lastMarkReturnBps: number | null;
  lastMarkStatus: "PENDING" | "AVAILABLE" | "UNAVAILABLE";
  lastMarkError: string | null;
  exitProceedsUsdMicros: number | null;
  realizedPnlUsdMicros: number | null;
}

interface StoredLaunchTransaction extends Document {
  timestamp: Date;
  blockNumber: number;
  ponsLaunches: LiveLaunch[];
}

interface CandidateLaunch {
  launch: LiveLaunch;
  timestamp: Date;
}

export interface PaperBuyQuote {
  grossQuoteWei: string;
  feeWei: string;
  effectiveQuoteWei: string;
  expectedTokenOut: string;
  modeledTokenOut: string;
  priceImpactBps: number;
}

export interface PaperSellQuote {
  tokenIn: string;
  expectedQuoteWei: string;
  feeWei: string;
  modeledQuoteOutWei: string;
  priceImpactBps: number;
}

export interface PaperScenarioResult {
  startingUsdMicros: number;
  endingUsdMicros: number;
  profitUsdMicros: number;
  returnBps: number;
  trades: number;
  assumption: "net position returns after all costs";
}

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = (env[name] ?? String(fallback)).trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

export function paperTradingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperTradingConfig {
  return {
    enabled: booleanFromEnv(env, "PAPER_TRADING_ENABLED", false),
    startingUsdMicros: integerFromEnv(env, "PAPER_STARTING_USD_MICROS", 20 * USD_MICROS, USD_MICROS, 1_000_000 * USD_MICROS),
    durationDays: integerFromEnv(env, "PAPER_DURATION_DAYS", 30, 1, 365),
    pollMs: integerFromEnv(env, "PAPER_POLL_MS", 60_000, 5_000, 3_600_000),
    positionBps: integerFromEnv(env, "PAPER_POSITION_BPS", 1_000, 1, 10_000),
    takeProfitBps: integerFromEnv(env, "PAPER_TAKE_PROFIT_BPS", 5_000, 1, 100_000),
    stopLossBps: integerFromEnv(env, "PAPER_STOP_LOSS_BPS", 2_000, 1, 9_999),
    maxHoldMs: integerFromEnv(env, "PAPER_MAX_HOLD_MINUTES", 24 * 60, 1, 30 * 24 * 60) * 60_000,
    maxTotalFeeBps: integerFromEnv(env, "PAPER_MAX_TOTAL_FEE_BPS", 500, 0, 9_999),
    maxPriceImpactBps: integerFromEnv(env, "PAPER_MAX_PRICE_IMPACT_BPS", 500, 1, 9_999),
    modeledSlippageBps: integerFromEnv(env, "PAPER_MODELED_SLIPPAGE_BPS", 300, 0, 9_999),
    modeledGasUnits: integerFromEnv(env, "PAPER_MODELED_GAS_UNITS", 350_000, 21_000, 10_000_000),
    maxCandidatesPerTick: integerFromEnv(env, "PAPER_MAX_CANDIDATES", 40, 1, 200),
    candidateMaxAgeMs: integerFromEnv(env, "PAPER_CANDIDATE_MAX_AGE_MINUTES", 15, 1, 24 * 60) * 60_000
  };
}

function strategySnapshot(config: PaperTradingConfig): StrategySnapshot {
  return {
    version: STRATEGY_VERSION,
    positionBps: config.positionBps,
    takeProfitBps: config.takeProfitBps,
    stopLossBps: config.stopLossBps,
    maxHoldMs: config.maxHoldMs,
    maxOpenPositions: 1,
    maxEntriesPerUtcDay: 1,
    maxTotalFeeBps: config.maxTotalFeeBps,
    maxPriceImpactBps: config.maxPriceImpactBps,
    modeledSlippageBps: config.modeledSlippageBps,
    modeledGasUnits: config.modeledGasUnits,
    entryScoreMinimum: 70,
    pair: "ETH",
    phase: "CURVE"
  };
}

function parseUnsigned(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`);
  return BigInt(value);
}

function validateBps(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 10_000) {
    throw new Error(`${name} must be an integer from 0 to 9999`);
  }
  return BigInt(value);
}

export function quotePaperBuy(
  quoteReserveValue: string,
  tokenReserveValue: string,
  grossQuoteValue: string,
  feeBpsValue: number,
  slippageBpsValue: number
): PaperBuyQuote {
  const quoteReserve = parseUnsigned(quoteReserveValue, "quoteReserve");
  const tokenReserve = parseUnsigned(tokenReserveValue, "tokenReserve");
  const grossQuote = parseUnsigned(grossQuoteValue, "grossQuote");
  const feeBps = validateBps(feeBpsValue, "feeBps");
  const slippageBps = validateBps(slippageBpsValue, "slippageBps");
  if (quoteReserve === 0n || tokenReserve === 0n || grossQuote === 0n) throw new Error("paper buy values must be positive");
  const fee = grossQuote * feeBps / BPS;
  const effectiveQuote = grossQuote - fee;
  const expectedTokenOut = tokenReserve * effectiveQuote / (quoteReserve + effectiveQuote);
  const modeledTokenOut = expectedTokenOut * (BPS - slippageBps) / BPS;
  const impact = effectiveQuote * BPS / (quoteReserve + effectiveQuote);
  return {
    grossQuoteWei: grossQuote.toString(),
    feeWei: fee.toString(),
    effectiveQuoteWei: effectiveQuote.toString(),
    expectedTokenOut: expectedTokenOut.toString(),
    modeledTokenOut: modeledTokenOut.toString(),
    priceImpactBps: Number(impact)
  };
}

export function quotePaperSell(
  quoteReserveValue: string,
  tokenReserveValue: string,
  tokenInValue: string,
  feeBpsValue: number,
  slippageBpsValue: number
): PaperSellQuote {
  const quoteReserve = parseUnsigned(quoteReserveValue, "quoteReserve");
  const tokenReserve = parseUnsigned(tokenReserveValue, "tokenReserve");
  const tokenIn = parseUnsigned(tokenInValue, "tokenIn");
  const feeBps = validateBps(feeBpsValue, "feeBps");
  const slippageBps = validateBps(slippageBpsValue, "slippageBps");
  if (quoteReserve === 0n || tokenReserve === 0n || tokenIn === 0n) throw new Error("paper sell values must be positive");
  const expectedQuote = quoteReserve * tokenIn / (tokenReserve + tokenIn);
  const fee = expectedQuote * feeBps / BPS;
  const afterFee = expectedQuote - fee;
  const modeledQuoteOut = afterFee * (BPS - slippageBps) / BPS;
  const impact = tokenIn * BPS / (tokenReserve + tokenIn);
  return {
    tokenIn: tokenIn.toString(),
    expectedQuoteWei: expectedQuote.toString(),
    feeWei: fee.toString(),
    modeledQuoteOutWei: modeledQuoteOut.toString(),
    priceImpactBps: Number(impact)
  };
}

export function simulatePaperMonth(
  startingUsdMicros: number,
  positionBps: number,
  netPositionReturnBps: readonly number[]
): PaperScenarioResult {
  if (!Number.isSafeInteger(startingUsdMicros) || startingUsdMicros < 0) throw new Error("startingUsdMicros must be non-negative");
  if (!Number.isSafeInteger(positionBps) || positionBps < 1 || positionBps > 10_000) throw new Error("positionBps must be from 1 to 10000");
  let equity = startingUsdMicros;
  for (const tradeReturnBps of netPositionReturnBps) {
    if (!Number.isSafeInteger(tradeReturnBps) || tradeReturnBps < -10_000) throw new Error("net position return must be an integer at or above -10000 bps");
    const position = Math.trunc(equity * positionBps / 10_000);
    equity += Math.trunc(position * tradeReturnBps / 10_000);
  }
  const profit = equity - startingUsdMicros;
  return {
    startingUsdMicros,
    endingUsdMicros: equity,
    profitUsdMicros: profit,
    returnBps: startingUsdMicros === 0 ? 0 : Math.trunc(profit * 10_000 / startingUsdMicros),
    trades: netPositionReturnBps.length,
    assumption: "net position returns after all costs"
  };
}

function rpcUrlFromEnvironment(env: NodeJS.ProcessEnv): string {
  const explicit = env.ROBINHOOD_RPC_URL?.split(",")[0]?.trim().replace(/#nologs$/, "");
  if (explicit) {
    if (!/^https:\/\//i.test(explicit)) throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
    return explicit;
  }
  const key = env.ALCHEMY_API_KEY?.trim();
  if (!key || !/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw new Error("PAPER_TRADING requires a valid ALCHEMY_API_KEY");
  return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
}

function createPaperRpcCaller(url: string, fetcher: typeof fetch = fetch): RpcCaller {
  const allowed = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_gasPrice"]);
  let requestId = 0;
  return async (method, params = []) => {
    if (!allowed.has(method)) throw new Error(`Paper RPC method is not permitted: ${method}`);
    let lastError = "RPC request failed";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "gptheist/1.2 paper-only" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
          signal: controller.signal
        });
        const payload = await response.json() as { result?: unknown; error?: { message?: string } };
        if (response.status === 429 || response.status >= 500) {
          lastError = `RPC HTTP ${response.status}`;
        } else if (!response.ok) {
          throw new Error(`RPC HTTP ${response.status}`);
        } else if (payload.error) {
          throw new Error(payload.error.message ?? "RPC error");
        } else if (!("result" in payload)) {
          throw new Error("RPC response is missing result");
        } else {
          return payload.result;
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : lastError;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300 * 2 ** attempt));
    }
    throw new Error(`${method} failed after bounded retries: ${lastError.slice(0, 160)}`);
  };
}

function alchemyKey(env: NodeJS.ProcessEnv): string {
  const key = env.ALCHEMY_API_KEY?.trim();
  if (!key || !/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw new Error("PAPER_TRADING requires ALCHEMY_API_KEY for ETH/USD marks");
  return key;
}

async function fetchEthUsdMicros(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<number> {
  const key = alchemyKey(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetcher(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?symbols=ETH`, {
      headers: { accept: "application/json", "user-agent": "gptheist/1.2 paper-only" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Alchemy Prices HTTP ${response.status}`);
    const payload = await response.json() as {
      data?: Array<{ prices?: Array<{ currency?: string; value?: string; lastUpdatedAt?: string }> }>;
    };
    const price = payload.data?.[0]?.prices?.find((candidate) => candidate.currency?.toLowerCase() === "usd");
    const numeric = price?.value === undefined ? Number.NaN : Number(price.value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000) throw new Error("Alchemy returned an invalid ETH/USD price");
    if (price?.lastUpdatedAt) {
      const updatedAt = Date.parse(price.lastUpdatedAt);
      if (!Number.isFinite(updatedAt) || Math.abs(Date.now() - updatedAt) > 15 * 60_000) {
        throw new Error("Alchemy returned a stale ETH/USD price");
      }
    }
    return Math.round(numeric * USD_MICROS);
  } finally {
    clearTimeout(timer);
  }
}

function parseHexBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is invalid`);
  return BigInt(value);
}

function weiToUsdMicros(wei: bigint, ethUsdMicros: number): number {
  const value = wei * BigInt(ethUsdMicros) / WEI_PER_ETH;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Paper USD value exceeds the safe integer range");
  return Number(value);
}

function usdMicrosToWei(usdMicros: number, ethUsdMicros: number): bigint {
  if (!Number.isSafeInteger(usdMicros) || usdMicros <= 0 || !Number.isSafeInteger(ethUsdMicros) || ethUsdMicros <= 0) {
    throw new Error("Paper USD conversion values must be positive safe integers");
  }
  return BigInt(usdMicros) * WEI_PER_ETH / BigInt(ethUsdMicros);
}

function safeError(error: unknown, env: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : "unknown paper-trading error";
  for (const secret of [env.MONGODB_URI, env.ROBINHOOD_RPC_URL, env.ALCHEMY_API_KEY]) {
    if (secret && secret.length >= 8) message = message.split(secret).join("<redacted>");
  }
  return message
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, "$1<credentials>@")
    .replace(/(https:\/\/[A-Za-z0-9.-]+\/v2\/)[A-Za-z0-9_-]+/gi, "$1<key>")
    .slice(0, 240);
}

function collections(database: Db): {
  runs: Collection<PaperRun>;
  positions: Collection<PaperPosition>;
  transactions: Collection<StoredLaunchTransaction>;
} {
  return {
    runs: database.collection<PaperRun>("paper_trade_runs"),
    positions: database.collection<PaperPosition>("paper_trade_positions"),
    transactions: database.collection<StoredLaunchTransaction>("robinhood_transactions")
  };
}

async function ensureStorage(database: Db): Promise<void> {
  const { positions } = collections(database);
  await Promise.all([
    positions.createIndex({ runId: 1, status: 1, openedAt: -1 }, { name: "paper_run_status_opened" }),
    positions.createIndex({ runId: 1, "launch.token": 1 }, { name: "paper_run_token" })
  ]);
}

async function ensureRun(runs: Collection<PaperRun>, config: PaperTradingConfig, now: Date): Promise<PaperRun> {
  const strategy = strategySnapshot(config);
  await runs.updateOne({ _id: RUN_ID }, {
    $setOnInsert: {
      _id: RUN_ID,
      mode: "paper-only",
      status: "RUNNING",
      startingUsdMicros: config.startingUsdMicros,
      cashUsdMicros: config.startingUsdMicros,
      realizedPnlUsdMicros: 0,
      unrealizedPnlUsdMicros: 0,
      equityUsdMicros: config.startingUsdMicros,
      profitUsdMicros: 0,
      entryCount: 0,
      closedTradeCount: 0,
      winCount: 0,
      lossCount: 0,
      startedAt: now,
      endsAt: new Date(now.getTime() + config.durationDays * 24 * 60 * 60_000),
      lastTickAt: null,
      lastEntryAt: null,
      completedAt: null,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: new Date(0),
      strategy
    }
  }, { upsert: true });
  const run = await runs.findOne({ _id: RUN_ID });
  if (!run) throw new Error("Paper run could not be initialized");
  if (run.startingUsdMicros !== config.startingUsdMicros ||
      JSON.stringify(run.strategy) !== JSON.stringify(strategy)) {
    throw new Error("Paper strategy is immutable after the month starts; restore the original PAPER_* settings");
  }
  return run;
}

async function acquireLease(runs: Collection<PaperRun>, owner: string, now: Date): Promise<PaperRun | null> {
  return runs.findOneAndUpdate({
    _id: RUN_ID,
    $or: [
      { leaseOwner: owner },
      { leaseOwner: null },
      { leaseExpiresAt: { $lte: now } }
    ]
  }, {
    $set: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
  }, { returnDocument: "after" });
}

async function releaseLease(runs: Collection<PaperRun>, owner: string): Promise<void> {
  await runs.updateOne({ _id: RUN_ID, leaseOwner: owner }, {
    $set: { leaseOwner: null, leaseExpiresAt: new Date(0) }
  });
}

function sameUtcDay(left: Date, right: Date): boolean {
  return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
}

async function candidateLaunches(
  transactions: Collection<StoredLaunchTransaction>,
  since: Date,
  limit: number
): Promise<CandidateLaunch[]> {
  const documents = await transactions.find({
    timestamp: { $gte: since },
    "ponsLaunches.0": { $exists: true }
  }, {
    projection: { _id: 0, timestamp: 1, blockNumber: 1, ponsLaunches: 1 }
  }).sort({ timestamp: -1, blockNumber: -1 }).limit(limit).toArray();
  const seen = new Set<string>();
  const result: CandidateLaunch[] = [];
  for (const document of documents) {
    for (const launch of document.ponsLaunches) {
      const key = `${launch.transactionHash}:${launch.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ launch, timestamp: document.timestamp });
    }
  }
  return result.sort((left, right) => right.launch.blockNumber - left.launch.blockNumber || right.launch.logIndex - left.launch.logIndex);
}

function positionId(launch: LiveLaunch): string {
  return `${RUN_ID}:${launch.transactionHash}:${launch.logIndex}`;
}

function totalFeeBps(market: VerifiedPonsMarketState): number {
  return market.creatorTaxBps + market.currentSnipeTaxBps;
}

async function openPosition(
  database: Db,
  rpc: RpcCaller,
  run: PaperRun,
  config: PaperTradingConfig,
  now: Date,
  headHex: string,
  gasPriceWei: bigint,
  ethUsdMicros: number
): Promise<void> {
  const { positions, transactions } = collections(database);
  const latest = await positions.find({ runId: RUN_ID }).sort({ openedAt: -1 }).limit(1).next();
  if (latest && sameUtcDay(latest.openedAt, now)) return;
  if (await positions.findOne({ runId: RUN_ID, status: "OPEN" })) return;
  const since = new Date(Math.max(run.startedAt.getTime(), now.getTime() - config.candidateMaxAgeMs));
  const candidates = await candidateLaunches(transactions, since, config.maxCandidatesPerTick);
  for (const candidate of candidates) {
    const launch = candidate.launch;
    if (candidate.timestamp < since || launch.pairToken !== ZERO_ADDRESS) continue;
    const id = positionId(launch);
    if (await positions.findOne({ _id: id })) continue;
    const research = (await readPonsLaunchResearch(rpc, [launch], headHex))[0];
    if (!research || research.market.status !== "VERIFIED" || research.market.phase !== "CURVE") continue;
    const assessment = assessPonsLaunch("ETH", research.market);
    if (assessment.verdict !== "WATCH" || assessment.score < 70) continue;
    const feeBps = totalFeeBps(research.market);
    if (feeBps > config.maxTotalFeeBps || feeBps >= 10_000) continue;
    const entryNotionalUsdMicros = Math.trunc(run.cashUsdMicros * config.positionBps / 10_000);
    if (entryNotionalUsdMicros < 100_000) continue;
    const grossQuoteWei = usdMicrosToWei(entryNotionalUsdMicros, ethUsdMicros);
    if (grossQuoteWei === 0n) continue;
    const quote = quotePaperBuy(
      research.market.quoteReserve,
      research.market.tokenReserve,
      grossQuoteWei.toString(),
      feeBps,
      config.modeledSlippageBps
    );
    if (quote.priceImpactBps > config.maxPriceImpactBps || BigInt(quote.modeledTokenOut) === 0n) continue;
    const entryGasUsdMicros = weiToUsdMicros(gasPriceWei * BigInt(config.modeledGasUnits), ethUsdMicros);
    const entryDebitUsdMicros = entryNotionalUsdMicros + entryGasUsdMicros;
    if (entryDebitUsdMicros > run.cashUsdMicros) continue;
    const position: PaperPosition = {
      _id: id,
      runId: RUN_ID,
      status: "OPEN",
      launch,
      assessmentScore: assessment.score,
      assessmentReasons: assessment.reasons,
      openedAt: now,
      closedAt: null,
      closeReason: null,
      entryEthUsdMicros: ethUsdMicros,
      entryNotionalUsdMicros,
      entryGasUsdMicros,
      entryDebitUsdMicros,
      grossQuoteWei: quote.grossQuoteWei,
      tokenAmount: quote.modeledTokenOut,
      entryFeeBps: feeBps,
      entryPriceImpactBps: quote.priceImpactBps,
      modeledSlippageBps: config.modeledSlippageBps,
      lastMarkAt: null,
      lastMarkUsdMicros: 0,
      lastMarkReturnBps: null,
      lastMarkStatus: "PENDING",
      lastMarkError: null,
      exitProceedsUsdMicros: null,
      realizedPnlUsdMicros: null
    };
    try {
      await positions.insertOne(position);
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code !== 11000) throw error;
    }
    return;
  }
}

type CloseReason = Exclude<PaperPosition["closeReason"], null>;

async function closePosition(
  positions: Collection<PaperPosition>,
  position: PaperPosition,
  proceedsUsdMicros: number,
  reason: CloseReason,
  now: Date
): Promise<void> {
  await positions.updateOne({ _id: position._id, status: "OPEN" }, {
    $set: {
      status: "CLOSED",
      closedAt: now,
      closeReason: reason,
      exitProceedsUsdMicros: proceedsUsdMicros,
      realizedPnlUsdMicros: proceedsUsdMicros - position.entryDebitUsdMicros
    }
  });
}

async function markOpenPosition(
  database: Db,
  rpc: RpcCaller,
  position: PaperPosition,
  config: PaperTradingConfig,
  now: Date,
  headHex: string,
  gasPriceWei: bigint,
  ethUsdMicros: number,
  monthEnded: boolean
): Promise<void> {
  const { positions } = collections(database);
  const research = (await readPonsLaunchResearch(rpc, [position.launch], headHex))[0];
  if (!research || research.market.status !== "VERIFIED" || research.market.phase !== "CURVE") {
    const reason = !research ? "market research missing" : research.market.status !== "VERIFIED"
      ? research.market.reason : `curve valuation unavailable in ${research.market.phase} phase`;
    await positions.updateOne({ _id: position._id, status: "OPEN" }, {
      $set: { lastMarkAt: now, lastMarkStatus: "UNAVAILABLE", lastMarkError: reason.slice(0, 160) }
    });
    if (monthEnded) await closePosition(positions, position, position.lastMarkUsdMicros, "MONTH_END_STALE_MARK", now);
    return;
  }
  const feeBps = totalFeeBps(research.market);
  let markUsdMicros = 0;
  let markError: string | null = null;
  if (feeBps >= 10_000) {
    markError = "combined current taxes are 100% or more; conservative paper mark is zero";
  } else {
    const quote = quotePaperSell(
      research.market.quoteReserve,
      research.market.tokenReserve,
      position.tokenAmount,
      feeBps,
      config.modeledSlippageBps
    );
    const gasWei = gasPriceWei * BigInt(config.modeledGasUnits);
    const quoteWei = BigInt(quote.modeledQuoteOutWei);
    markUsdMicros = weiToUsdMicros(quoteWei > gasWei ? quoteWei - gasWei : 0n, ethUsdMicros);
  }
  const returnBps = position.entryDebitUsdMicros === 0
    ? 0
    : Math.trunc((markUsdMicros - position.entryDebitUsdMicros) * 10_000 / position.entryDebitUsdMicros);
  await positions.updateOne({ _id: position._id, status: "OPEN" }, {
    $set: {
      lastMarkAt: now,
      lastMarkUsdMicros: markUsdMicros,
      lastMarkReturnBps: returnBps,
      lastMarkStatus: "AVAILABLE",
      lastMarkError: markError
    }
  });
  const heldMs = now.getTime() - position.openedAt.getTime();
  const reason: CloseReason | null = monthEnded ? "MONTH_END"
    : returnBps >= config.takeProfitBps ? "TAKE_PROFIT"
      : returnBps <= -config.stopLossBps ? "STOP_LOSS"
        : heldMs >= config.maxHoldMs ? "TIME_STOP" : null;
  if (reason) await closePosition(positions, position, markUsdMicros, reason, now);
}

async function refreshRunTotals(
  runs: Collection<PaperRun>,
  positions: Collection<PaperPosition>,
  run: PaperRun,
  now: Date,
  status: PaperRun["status"] = run.status
): Promise<void> {
  const entries = await positions.find({ runId: RUN_ID }).sort({ openedAt: 1 }).toArray();
  let cash = run.startingUsdMicros;
  let realized = 0;
  let unrealized = 0;
  let closed = 0;
  let wins = 0;
  let losses = 0;
  for (const position of entries) {
    cash -= position.entryDebitUsdMicros;
    if (position.status === "CLOSED") {
      const proceeds = position.exitProceedsUsdMicros ?? 0;
      const pnl = position.realizedPnlUsdMicros ?? proceeds - position.entryDebitUsdMicros;
      cash += proceeds;
      realized += pnl;
      closed += 1;
      if (pnl > 0) wins += 1;
      else losses += 1;
    } else {
      unrealized += position.lastMarkUsdMicros - position.entryDebitUsdMicros;
    }
  }
  const openMarks = entries.filter((position) => position.status === "OPEN")
    .reduce((sum, position) => sum + position.lastMarkUsdMicros, 0);
  const equity = cash + openMarks;
  const lastEntryAt = entries.length > 0 ? entries[entries.length - 1]?.openedAt ?? null : null;
  await runs.updateOne({ _id: RUN_ID }, {
    $set: {
      status,
      cashUsdMicros: cash,
      realizedPnlUsdMicros: realized,
      unrealizedPnlUsdMicros: unrealized,
      equityUsdMicros: equity,
      profitUsdMicros: equity - run.startingUsdMicros,
      entryCount: entries.length,
      closedTradeCount: closed,
      winCount: wins,
      lossCount: losses,
      lastTickAt: now,
      lastEntryAt,
      completedAt: status === "COMPLETE" ? now : null,
      lastError: null
    }
  });
}

async function paperTick(
  database: Db,
  rpc: RpcCaller,
  run: PaperRun,
  config: PaperTradingConfig,
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<PaperRun["status"]> {
  const { runs, positions } = collections(database);
  const chainHex = await rpc("eth_chainId");
  if (typeof chainHex !== "string" || Number.parseInt(chainHex.slice(2), 16) !== ROBINHOOD_CHAIN_ID) {
    throw new Error(`Paper RPC must be Robinhood Chain mainnet (${ROBINHOOD_CHAIN_ID})`);
  }
  const headHex = await rpc("eth_blockNumber");
  if (typeof headHex !== "string" || !/^0x[0-9a-fA-F]+$/.test(headHex)) throw new Error("Paper RPC returned an invalid head block");
  const gasPriceWei = parseHexBigInt(await rpc("eth_gasPrice"), "eth_gasPrice");
  const ethUsdMicros = await fetchEthUsdMicros(env);
  const monthEnded = now >= run.endsAt;
  const open = await positions.findOne({ runId: RUN_ID, status: "OPEN" });
  if (open) await markOpenPosition(database, rpc, open, config, now, headHex, gasPriceWei, ethUsdMicros, monthEnded);
  if (!monthEnded && !(await positions.findOne({ runId: RUN_ID, status: "OPEN" }))) {
    const current = await runs.findOne({ _id: RUN_ID });
    if (!current) throw new Error("Paper run disappeared during its tick");
    await refreshRunTotals(runs, positions, current, now);
    const refreshed = await runs.findOne({ _id: RUN_ID });
    if (!refreshed) throw new Error("Paper run totals could not be refreshed");
    await openPosition(database, rpc, refreshed, config, now, headHex, gasPriceWei, ethUsdMicros);
  }
  const latestRun = await runs.findOne({ _id: RUN_ID });
  if (!latestRun) throw new Error("Paper run could not be reloaded");
  const status: PaperRun["status"] = monthEnded ? "COMPLETE" : "RUNNING";
  await refreshRunTotals(runs, positions, latestRun, now, status);
  return status;
}

function mongoConfiguration(env: NodeJS.ProcessEnv): { uri: string; databaseName: string } {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) throw new Error("PAPER_TRADING requires hosted MONGODB_URI; no local fallback is allowed");
  const databaseName = env.GPTHEIST_MONGODB_DB?.trim() || "gptheist";
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(databaseName)) throw new Error("GPTHEIST_MONGODB_DB is invalid");
  return { uri, databaseName };
}

function publicPosition(position: PaperPosition): Record<string, unknown> {
  return {
    id: position._id,
    status: position.status,
    token: position.launch.token,
    curve: position.launch.curve,
    launchTransaction: position.launch.transactionHash,
    assessmentScore: position.assessmentScore,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    closeReason: position.closeReason,
    entryNotionalUsd: position.entryNotionalUsdMicros / USD_MICROS,
    entryGasUsd: position.entryGasUsdMicros / USD_MICROS,
    entryDebitUsd: position.entryDebitUsdMicros / USD_MICROS,
    lastMarkUsd: position.lastMarkUsdMicros / USD_MICROS,
    lastMarkReturnBps: position.lastMarkReturnBps,
    markStatus: position.lastMarkStatus,
    markError: position.lastMarkError,
    exitProceedsUsd: position.exitProceedsUsdMicros === null ? null : position.exitProceedsUsdMicros / USD_MICROS,
    realizedPnlUsd: position.realizedPnlUsdMicros === null ? null : position.realizedPnlUsdMicros / USD_MICROS
  };
}

export async function readPaperTradingStatus(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const config = paperTradingConfigFromEnv(env);
  const common = {
    enabled: config.enabled,
    mode: "paper-only",
    execution: "disabled",
    strategyVersion: STRATEGY_VERSION,
    disclaimer: "Forward observation only. This is not a historical backtest, profit guarantee, or instruction to trade."
  } as const;
  if (!config.enabled) return { ...common, status: "DISABLED" };
  const { uri, databaseName } = mongoConfiguration(env);
  const client = new MongoClient(uri, { appName: "gptheist-paper-status" });
  try {
    await client.connect();
    const { runs, positions } = collections(client.db(databaseName));
    const run = await runs.findOne({ _id: RUN_ID });
    if (!run) return { ...common, status: "PENDING" };
    const recent = await positions.find({ runId: RUN_ID }).sort({ openedAt: -1 }).limit(25).toArray();
    return {
      ...common,
      status: run.status,
      startedAt: run.startedAt,
      endsAt: run.endsAt,
      completedAt: run.completedAt,
      startingUsd: run.startingUsdMicros / USD_MICROS,
      cashUsd: run.cashUsdMicros / USD_MICROS,
      equityUsd: run.equityUsdMicros / USD_MICROS,
      profitUsd: run.profitUsdMicros / USD_MICROS,
      realizedPnlUsd: run.realizedPnlUsdMicros / USD_MICROS,
      unrealizedPnlUsd: run.unrealizedPnlUsdMicros / USD_MICROS,
      entryCount: run.entryCount,
      closedTradeCount: run.closedTradeCount,
      wins: run.winCount,
      losses: run.lossCount,
      lastTickAt: run.lastTickAt,
      lastError: run.lastError,
      strategy: run.strategy,
      positions: recent.map(publicPosition)
    };
  } finally {
    await client.close();
  }
}

async function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveWait();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runPaperTrading(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = paperTradingConfigFromEnv(env);
  if (!config.enabled) {
    process.stdout.write(`${JSON.stringify({ event: "paper-disabled", mode: "paper-only" })}\n`);
    return;
  }
  const { uri, databaseName } = mongoConfiguration(env);
  const rpc = createPaperRpcCaller(rpcUrlFromEnvironment(env));
  alchemyKey(env);
  const client = new MongoClient(uri, { appName: "gptheist-paper-month" });
  const owner = randomUUID();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.connect();
    const database = client.db(databaseName);
    await database.command({ ping: 1 });
    await ensureStorage(database);
    const { runs } = collections(database);
    await ensureRun(runs, config, new Date());
    process.stdout.write(`${JSON.stringify({ event: "paper-start", runId: RUN_ID, mode: "paper-only", startingUsd: config.startingUsdMicros / USD_MICROS, durationDays: config.durationDays })}\n`);
    while (!controller.signal.aborted) {
      const now = new Date();
      const run = await ensureRun(runs, config, now);
      if (run.status === "COMPLETE") break;
      const leased = await acquireLease(runs, owner, now);
      if (!leased) {
        await waitForPoll(Math.min(config.pollMs, 15_000), controller.signal);
        continue;
      }
      try {
        const status = await paperTick(database, rpc, leased, config, env, now);
        const refreshed = await runs.findOne({ _id: RUN_ID });
        process.stdout.write(`${JSON.stringify({ event: "paper-tick", status, at: now.toISOString(), equityUsd: refreshed ? refreshed.equityUsdMicros / USD_MICROS : null, entries: refreshed?.entryCount ?? null })}\n`);
        if (status === "COMPLETE") break;
      } catch (error: unknown) {
        const message = safeError(error, env);
        await runs.updateOne({ _id: RUN_ID }, { $set: { lastTickAt: now, lastError: message } });
        process.stderr.write(`${JSON.stringify({ event: "paper-error", at: now.toISOString(), message })}\n`);
      } finally {
        await releaseLease(runs, owner);
      }
      await waitForPoll(config.pollMs, controller.signal);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client.close();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runPaperTrading().catch((error: unknown) => {
    process.stderr.write(`Paper trading failed: ${safeError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
