import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MongoClient } from "mongodb";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { fetchLiveSnapshot, ROBINHOOD_CHAIN_ID, type LiveLaunch, type RpcCaller } from "./live.js";
import { readPonsLaunchResearch, type PonsMarketState } from "./market.js";

const BPS = 10_000n;
const MAX_CLOSED_POSITIONS = 5_000;
const MAX_SEEN_TOKENS = 20_000;
const CURVE_ABI = parseAbi([
  "function feeBps() view returns (uint256)",
  "function sellableTokens() view returns (uint256)"
]);

export interface PaperPolicy {
  stakeWei: bigint;
  maxOpenPositions: number;
  minScore: number;
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldMs: number;
  gasUnitsPerTrade: bigint;
}

export type PaperExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MAX_HOLD" | "LEFT_CURVE";

export interface PaperPosition {
  token: string;
  symbol: string;
  launch: LiveLaunch;
  score: number;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  openedBlock: number;
  stakeWei: string;
  feeBps: number;
  creatorTaxBps: number;
  entrySnipeTaxBps: number;
  tokens: string;
  entryGasWei: string;
  markWei: string;
  markAt: string;
  markBlock: number;
  markStale: boolean;
  closedAt?: string;
  closedBlock?: number;
  exitReason?: PaperExitReason;
  exitWei?: string;
  pnlWei?: string;
}

export interface PaperLedger {
  version: 1;
  chainId: typeof ROBINHOOD_CHAIN_ID;
  startedAt: string;
  startedBlock: number;
  policy: { stakeWei: string; maxOpenPositions: number; minScore: number; takeProfitBps: number; stopLossBps: number; maxHoldMs: number; gasUnitsPerTrade: string };
  positions: PaperPosition[];
  seenTokens: string[];
  /** Cumulative totals for closed positions trimmed from `positions`. */
  archived?: PaperArchive;
  skippedAtCapacity: number;
  cycles: number;
  lastCycleAt: string | null;
  lastBlock: number | null;
  lastError: string | null;
}

export interface PaperArchive {
  closed: number;
  wins: number;
  realizedPnlWei: string;
  deployedWei: string;
  exitReasons: Record<PaperExitReason, number>;
}

export interface PaperReport {
  mode: "paper-only";
  startedAt: string;
  lastCycleAt: string | null;
  lastBlock: number | null;
  cycles: number;
  lastError: string | null;
  stakeWei: string;
  opened: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRateBps: number | null;
  skippedAtCapacity: number;
  realizedPnlWei: string;
  unrealizedPnlWei: string;
  totalPnlWei: string;
  capitalDeployedWei: string;
  returnOnDeployedBps: number | null;
  exitReasons: Record<PaperExitReason, number>;
  positions: Array<Pick<PaperPosition, "token" | "symbol" | "status" | "openedAt" | "stakeWei" | "markWei" | "markStale" | "closedAt" | "exitReason" | "pnlWei">>;
}

function integerSetting(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function weiSetting(name: string, value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[1-9][0-9]{0,30}$/.test(value.trim())) throw new Error(`${name} must be a positive integer wei amount`);
  return BigInt(value.trim());
}

export function paperPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PaperPolicy {
  return {
    stakeWei: weiSetting("PAPER_STAKE_WEI", env.PAPER_STAKE_WEI, 1_000_000_000_000_000n),
    maxOpenPositions: integerSetting("PAPER_MAX_OPEN_POSITIONS", env.PAPER_MAX_OPEN_POSITIONS, 5, 1, 100),
    minScore: integerSetting("PAPER_MIN_SCORE", env.PAPER_MIN_SCORE, 70, 70, 100),
    takeProfitBps: integerSetting("PAPER_TAKE_PROFIT_BPS", env.PAPER_TAKE_PROFIT_BPS, 5_000, 1, 1_000_000),
    stopLossBps: integerSetting("PAPER_STOP_LOSS_BPS", env.PAPER_STOP_LOSS_BPS, 3_000, 1, 10_000),
    maxHoldMs: integerSetting("PAPER_MAX_HOLD_MINUTES", env.PAPER_MAX_HOLD_MINUTES, 1_440, 1, 43_200) * 60_000,
    gasUnitsPerTrade: BigInt(integerSetting("PAPER_GAS_UNITS_PER_TRADE", env.PAPER_GAS_UNITS_PER_TRADE, 250_000, 21_000, 5_000_000))
  };
}

export function createPaperLedger(policy: PaperPolicy, startedAt: Date, startedBlock: number): PaperLedger {
  return {
    version: 1,
    chainId: ROBINHOOD_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    startedBlock,
    policy: {
      stakeWei: policy.stakeWei.toString(),
      maxOpenPositions: policy.maxOpenPositions,
      minScore: policy.minScore,
      takeProfitBps: policy.takeProfitBps,
      stopLossBps: policy.stopLossBps,
      maxHoldMs: policy.maxHoldMs,
      gasUnitsPerTrade: policy.gasUnitsPerTrade.toString()
    },
    positions: [],
    seenTokens: [],
    skippedAtCapacity: 0,
    cycles: 0,
    lastCycleAt: null,
    lastBlock: null,
    lastError: null
  };
}

export function paperBuy(stakeWei: bigint, quoteReserve: bigint, tokenReserve: bigint, feeBps: number, creatorTaxBps: number, snipeTaxBps: number, sellable: bigint): { tokens: bigint; netIn: bigint } {
  const totalBps = BigInt(feeBps + creatorTaxBps + snipeTaxBps);
  if (totalBps >= BPS || quoteReserve <= 0n || tokenReserve <= 0n) return { tokens: 0n, netIn: 0n };
  const netIn = stakeWei - (stakeWei * BigInt(feeBps)) / BPS - (stakeWei * BigInt(creatorTaxBps)) / BPS - (stakeWei * BigInt(snipeTaxBps)) / BPS;
  const out = (netIn * tokenReserve) / (quoteReserve + netIn);
  return { tokens: out > sellable ? sellable : out, netIn };
}

export function paperSellValue(tokens: bigint, quoteReserve: bigint, tokenReserve: bigint, feeBps: number, creatorTaxBps: number): bigint {
  if (tokens <= 0n || quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  const gross = (tokens * quoteReserve) / (tokenReserve + tokens);
  return gross - (gross * BigInt(feeBps)) / BPS - (gross * BigInt(creatorTaxBps)) / BPS;
}

function pnlWei(position: PaperPosition, exitNetWei: bigint): bigint {
  return exitNetWei - BigInt(position.stakeWei) - BigInt(position.entryGasWei);
}

export function paperExitReason(position: PaperPosition, policy: PaperPolicy, now: Date, market: PonsMarketState | undefined): PaperExitReason | null {
  if (market?.status === "VERIFIED" && market.phase !== "CURVE") return "LEFT_CURVE";
  const stake = BigInt(position.stakeWei);
  const pnl = pnlWei(position, BigInt(position.markWei));
  if (pnl * BPS >= stake * BigInt(policy.takeProfitBps)) return "TAKE_PROFIT";
  if (-pnl * BPS >= stake * BigInt(policy.stopLossBps)) return "STOP_LOSS";
  if (now.getTime() - Date.parse(position.openedAt) >= policy.maxHoldMs) return "MAX_HOLD";
  return null;
}

async function readCurveEntryTerms(rpc: RpcCaller, curve: Address, blockTag: Hex): Promise<{ feeBps: number; sellable: bigint }> {
  const call = async (functionName: "feeBps" | "sellableTokens"): Promise<bigint> => {
    const raw = await rpc("eth_call", [{ to: curve, data: encodeFunctionData({ abi: CURVE_ABI, functionName }) }, blockTag]);
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error(`invalid ${functionName} response`);
    return decodeFunctionResult({ abi: CURVE_ABI, functionName, data: raw as Hex });
  };
  const feeBps = await call("feeBps");
  if (feeBps > 10_000n) throw new Error("curve fee is outside protocol bounds");
  return { feeBps: Number(feeBps), sellable: await call("sellableTokens") };
}

async function readGasPrice(rpc: RpcCaller): Promise<bigint> {
  const raw = await rpc("eth_gasPrice");
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error("invalid gas price response");
  return BigInt(raw);
}

function remember(list: string[], token: string): string[] {
  const next = [...list, token];
  return next.length > MAX_SEEN_TOKENS ? next.slice(next.length - MAX_SEEN_TOKENS) : next;
}

export async function runPaperCycle(rpc: RpcCaller, ledger: PaperLedger, policy: PaperPolicy, now: Date = new Date()): Promise<PaperLedger> {
  const snapshot = await fetchLiveSnapshot(rpc);
  const blockTag = `0x${snapshot.headBlock.toString(16)}` as Hex;
  const gasPrice = await readGasPrice(rpc);
  const tradeGas = policy.gasUnitsPerTrade * gasPrice;
  const nowIso = now.toISOString();
  const positions = ledger.positions.map((position) => ({ ...position }));
  let seenTokens = ledger.seenTokens;
  let skippedAtCapacity = ledger.skippedAtCapacity;

  const open = positions.filter((position) => position.status === "OPEN");
  const research = await readPonsLaunchResearch(rpc, open.map((position) => position.launch), blockTag);
  open.forEach((position, index) => {
    const market = research[index]?.market;
    if (market?.status === "VERIFIED" && market.phase === "CURVE") {
      const exitNet = paperSellValue(BigInt(position.tokens), BigInt(market.quoteReserve), BigInt(market.tokenReserve), position.feeBps, position.creatorTaxBps) - tradeGas;
      position.markWei = (exitNet > 0n ? exitNet : 0n).toString();
      position.markAt = nowIso;
      position.markBlock = snapshot.headBlock;
      position.markStale = false;
    } else {
      position.markStale = true;
    }
    const reason = paperExitReason(position, policy, now, market);
    if (reason) {
      position.status = "CLOSED";
      position.closedAt = nowIso;
      position.closedBlock = snapshot.headBlock;
      position.exitReason = reason;
      position.exitWei = position.markWei;
      position.pnlWei = pnlWei(position, BigInt(position.markWei)).toString();
    }
  });

  let openCount = positions.filter((position) => position.status === "OPEN").length;
  const seen = new Set(seenTokens);
  const candidates = snapshot.launches
    .filter((launch) => launch.verdict === "WATCH" && launch.assessment.score >= policy.minScore &&
      launch.pairLabel === "ETH" && launch.market.status === "VERIFIED" && launch.market.phase === "CURVE" && !seen.has(launch.token))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const launch of candidates) {
    if (launch.market.status !== "VERIFIED") continue;
    seenTokens = remember(seenTokens, launch.token);
    if (openCount >= policy.maxOpenPositions) {
      skippedAtCapacity += 1;
      continue;
    }
    const terms = await readCurveEntryTerms(rpc, launch.curve as Address, blockTag);
    const quoteReserve = BigInt(launch.market.quoteReserve);
    const tokenReserve = BigInt(launch.market.tokenReserve);
    const { tokens, netIn } = paperBuy(policy.stakeWei, quoteReserve, tokenReserve, terms.feeBps, launch.market.creatorTaxBps, launch.market.currentSnipeTaxBps, terms.sellable);
    if (tokens <= 0n || tokens >= tokenReserve) continue;
    const markNet = paperSellValue(tokens, quoteReserve + netIn, tokenReserve - tokens, terms.feeBps, launch.market.creatorTaxBps) - tradeGas;
    const { verdict: _verdict, pairLabel: _pair, market: _market, metadata, assessment, handoffs: _handoffs, deployerResearch: _research, ...base } = launch;
    positions.push({
      token: launch.token,
      symbol: metadata.status === "DECLARED" ? metadata.symbol : launch.token.slice(0, 10),
      launch: base,
      score: assessment.score,
      status: "OPEN",
      openedAt: nowIso,
      openedBlock: snapshot.headBlock,
      stakeWei: policy.stakeWei.toString(),
      feeBps: terms.feeBps,
      creatorTaxBps: launch.market.creatorTaxBps,
      entrySnipeTaxBps: launch.market.currentSnipeTaxBps,
      tokens: tokens.toString(),
      entryGasWei: tradeGas.toString(),
      markWei: (markNet > 0n ? markNet : 0n).toString(),
      markAt: nowIso,
      markBlock: snapshot.headBlock,
      markStale: false
    });
    openCount += 1;
  }

  const closed = positions.filter((position) => position.status === "CLOSED");
  const trimCount = Math.max(0, closed.length - MAX_CLOSED_POSITIONS);
  const keptClosed = closed.slice(trimCount);
  const archived = archiveClosed(ledger.archived, closed.slice(0, trimCount));
  return {
    ...ledger,
    positions: [...keptClosed, ...positions.filter((position) => position.status === "OPEN")],
    ...(archived ? { archived } : {}),
    seenTokens,
    skippedAtCapacity,
    cycles: ledger.cycles + 1,
    lastCycleAt: nowIso,
    lastBlock: snapshot.headBlock,
    lastError: null
  };
}

function archiveClosed(archive: PaperArchive | undefined, trimmed: PaperPosition[]): PaperArchive | undefined {
  if (trimmed.length === 0) return archive;
  const exitReasons: Record<PaperExitReason, number> = { TAKE_PROFIT: 0, STOP_LOSS: 0, MAX_HOLD: 0, LEFT_CURVE: 0, ...archive?.exitReasons };
  for (const position of trimmed) if (position.exitReason) exitReasons[position.exitReason] += 1;
  return {
    closed: (archive?.closed ?? 0) + trimmed.length,
    wins: (archive?.wins ?? 0) + trimmed.filter((position) => BigInt(position.pnlWei ?? "0") > 0n).length,
    realizedPnlWei: trimmed.reduce((sum, position) => sum + BigInt(position.pnlWei ?? "0"), BigInt(archive?.realizedPnlWei ?? "0")).toString(),
    deployedWei: trimmed.reduce((sum, position) => sum + BigInt(position.stakeWei), BigInt(archive?.deployedWei ?? "0")).toString(),
    exitReasons
  };
}

export function paperReport(ledger: PaperLedger): PaperReport {
  const archived = ledger.archived;
  const closedPositions = ledger.positions.filter((position) => position.status === "CLOSED");
  const open = ledger.positions.filter((position) => position.status === "OPEN");
  const closedCount = closedPositions.length + (archived?.closed ?? 0);
  const realized = closedPositions.reduce((sum, position) => sum + BigInt(position.pnlWei ?? "0"), BigInt(archived?.realizedPnlWei ?? "0"));
  const unrealized = open.reduce((sum, position) => sum + pnlWei(position, BigInt(position.markWei)), 0n);
  const deployed = ledger.positions.reduce((sum, position) => sum + BigInt(position.stakeWei), BigInt(archived?.deployedWei ?? "0"));
  const wins = closedPositions.filter((position) => BigInt(position.pnlWei ?? "0") > 0n).length + (archived?.wins ?? 0);
  const exitReasons: Record<PaperExitReason, number> = { TAKE_PROFIT: 0, STOP_LOSS: 0, MAX_HOLD: 0, LEFT_CURVE: 0, ...archived?.exitReasons };
  for (const position of closedPositions) if (position.exitReason) exitReasons[position.exitReason] += 1;
  const total = realized + unrealized;
  return {
    mode: "paper-only",
    startedAt: ledger.startedAt,
    lastCycleAt: ledger.lastCycleAt,
    lastBlock: ledger.lastBlock,
    cycles: ledger.cycles,
    lastError: ledger.lastError,
    stakeWei: ledger.policy.stakeWei,
    opened: ledger.positions.length + (archived?.closed ?? 0),
    open: open.length,
    closed: closedCount,
    wins,
    losses: closedCount - wins,
    winRateBps: closedCount === 0 ? null : Math.round((wins * 10_000) / closedCount),
    skippedAtCapacity: ledger.skippedAtCapacity,
    realizedPnlWei: realized.toString(),
    unrealizedPnlWei: unrealized.toString(),
    totalPnlWei: total.toString(),
    capitalDeployedWei: deployed.toString(),
    returnOnDeployedBps: deployed === 0n ? null : Number((total * BPS) / deployed),
    exitReasons,
    positions: ledger.positions.slice(-50).reverse().map((position) => ({
      token: position.token,
      symbol: position.symbol,
      status: position.status,
      openedAt: position.openedAt,
      stakeWei: position.stakeWei,
      markWei: position.markWei,
      markStale: position.markStale,
      ...(position.closedAt ? { closedAt: position.closedAt } : {}),
      ...(position.exitReason ? { exitReason: position.exitReason } : {}),
      ...(position.pnlWei ? { pnlWei: position.pnlWei } : {})
    }))
  };
}

export interface PaperLedgerStore {
  load(): Promise<PaperLedger | null>;
  save(ledger: PaperLedger): Promise<void>;
}

function parseLedger(value: unknown): PaperLedger | null {
  if (typeof value !== "object" || value === null) return null;
  const ledger = value as Partial<PaperLedger>;
  if (ledger.version !== 1 || ledger.chainId !== ROBINHOOD_CHAIN_ID || !Array.isArray(ledger.positions) || !Array.isArray(ledger.seenTokens)) {
    throw new Error("paper ledger has an unsupported format");
  }
  return ledger as PaperLedger;
}

export class FilePaperLedgerStore implements PaperLedgerStore {
  constructor(readonly path: string) {}

  async load(): Promise<PaperLedger | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return parseLedger(JSON.parse(text) as unknown);
  }

  async save(ledger: PaperLedger): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

interface StoredLedger extends PaperLedger {
  _id: string;
}

export class MongoPaperLedgerStore implements PaperLedgerStore {
  readonly #uri: string;
  readonly #database: string;
  readonly #id: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#uri = env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";
    this.#database = env.GPTHEIST_MONGODB_DB?.trim() || "gptheist";
    this.#id = env.PAPER_LEDGER_ID?.trim() || "forward-watch";
  }

  async #withClient<T>(work: (client: MongoClient) => Promise<T>): Promise<T> {
    const client = new MongoClient(this.#uri, { serverSelectionTimeoutMS: 8_000, appName: "gptheist-paper-ledger" });
    try {
      await client.connect();
      return await work(client);
    } finally {
      await client.close();
    }
  }

  load(): Promise<PaperLedger | null> {
    return this.#withClient(async (client) => {
      const stored = await client.db(this.#database).collection<StoredLedger>("paper_ledgers").findOne({ _id: this.#id });
      if (!stored) return null;
      const { _id: _ignored, ...ledger } = stored;
      return parseLedger(ledger);
    });
  }

  save(ledger: PaperLedger): Promise<void> {
    return this.#withClient(async (client) => {
      await client.db(this.#database).collection<StoredLedger>("paper_ledgers").replaceOne({ _id: this.#id }, ledger, { upsert: true });
    });
  }
}

export function paperLedgerStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PaperLedgerStore {
  const choice = env.PAPER_LEDGER_STORE?.trim().toLowerCase() || (env.MONGODB_URI?.trim() ? "mongodb" : "file");
  if (choice === "mongodb") return new MongoPaperLedgerStore(env);
  if (choice === "file") return new FilePaperLedgerStore(env.PAPER_LEDGER_PATH?.trim() || "paper/ledger.json");
  throw new Error("PAPER_LEDGER_STORE must be file or mongodb");
}

export function lockedPaperPolicy(ledger: PaperLedger): PaperPolicy {
  return {
    stakeWei: BigInt(ledger.policy.stakeWei),
    maxOpenPositions: ledger.policy.maxOpenPositions,
    minScore: ledger.policy.minScore,
    takeProfitBps: ledger.policy.takeProfitBps,
    stopLossBps: ledger.policy.stopLossBps,
    maxHoldMs: ledger.policy.maxHoldMs,
    gasUnitsPerTrade: BigInt(ledger.policy.gasUnitsPerTrade)
  };
}

/** The policy is fixed when a ledger starts; later environment changes require a new ledger id or path. */
export async function stepPaperLedger(rpc: RpcCaller, store: PaperLedgerStore, initialPolicy: PaperPolicy, now: Date = new Date()): Promise<PaperLedger> {
  let ledger = await store.load();
  if (!ledger) {
    const head = await rpc("eth_blockNumber");
    if (typeof head !== "string" || !/^0x[0-9a-fA-F]+$/.test(head)) throw new Error("RPC returned an invalid head block");
    ledger = createPaperLedger(initialPolicy, now, Number.parseInt(head.slice(2), 16));
  }
  try {
    ledger = await runPaperCycle(rpc, ledger, lockedPaperPolicy(ledger), now);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "paper cycle failed";
    ledger = { ...ledger, lastError: message.slice(0, 300), lastCycleAt: now.toISOString() };
  }
  await store.save(ledger);
  return ledger;
}
