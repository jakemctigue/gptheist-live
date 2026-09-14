import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MongoClient, type Collection } from "mongodb";
import { PONS_FACTORY, TOKEN_LAUNCHED_TOPIC, decodeTokenLaunchedLog, type LiveLaunch, type RpcLog } from "./live.js";

const ROBINHOOD_CHAIN_ID = 4_663;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CONFIRMATIONS = 64;
const DEFAULT_MONTHS = 3;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_SAMPLE_SIZE = 32;
const MAX_BATCH_SIZE = 100;
const MAX_POLL_MS = 60_000;
const MIN_POLL_MS = 250;
const PONS_LOG_WINDOW_BLOCKS = 100_000;
const PONS_PLAN_SAMPLE_BLOCKS = 5_000;
const RETENTION_SECONDS = 93 * 24 * 60 * 60;

type JsonObject = Record<string, unknown>;
type ImportScope = "pons-launches" | "all";

interface RpcEnvelope {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RpcBlock extends JsonObject {
  number: string;
  hash: string;
  timestamp: string;
  transactions: unknown[];
}

interface StoredTransaction extends JsonObject {
  scope: ImportScope;
  chainId: number;
  hash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  timestamp: Date;
  from: string;
  to: string | null;
  valueWei: string;
  gasLimit: string;
  gasPriceWei: string | null;
  maxFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  nonce: number;
  transactionType: number | null;
  functionSelector: string | null;
  inputBytes: number | null;
  blockBaseFeePerGasWei: string | null;
  ingestionMode: "backfill" | "follow";
  ingestionLagMs: number;
  ponsLaunches: LiveLaunch[];
  firstIngestedAt: Date;
  lastSeenAt: Date;
}

interface ImportCheckpoint {
  _id: string;
  chainId: number;
  scope: ImportScope;
  since: Date;
  startBlock: number;
  targetEndBlock: number;
  nextBlock: number;
  scannedBlocks: number;
  storedTransactions: number;
  updatedAt: Date;
  confirmations: number;
  pollMs: number;
  status: "running" | "paused" | "complete";
}

interface ImportOptions {
  plan: boolean;
  follow: boolean;
  scope: ImportScope;
  months: number;
  from?: Date;
  toBlock?: number;
  confirmations: number;
  batchSize: number;
  sampleSize: number;
  pollMs: number;
  maxBlocks?: number;
  jobId?: string;
}

interface BlockTimestamp {
  timestamp: number;
}

interface ImportPlan {
  chainId: number;
  scope: ImportScope;
  since: Date;
  startBlock: number;
  endBlock: number;
  blockCount: number;
  sampledBlocks: number;
  sampledTransactions: number;
  averageTransactionsPerBlock: number;
  estimatedTransactions: number;
  estimatedUncompressedMongoGiB: number;
}

class RpcHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "RpcHttpError";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function redactRuntimeError(message: string): string {
  let safe = message;
  for (const secret of [process.env.MONGODB_URI, process.env.ROBINHOOD_RPC_URL, process.env.ALCHEMY_API_KEY]) {
    if (secret && secret.length >= 8) safe = safe.split(secret).join("<redacted>");
  }
  return safe
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, "$1<credentials>@")
    .replace(/(https:\/\/[A-Za-z0-9.-]+\/v2\/)[A-Za-z0-9_-]+/gi, "$1<key>");
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

export function parseHexQuantity(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} is not a valid hex quantity`);
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return parsed;
}

export function subtractUtcMonths(value: Date, months: number): Date {
  const copy = new Date(value.getTime());
  const originalDay = copy.getUTCDate();
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() - months);
  const daysInTargetMonth = new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth() + 1, 0)).getUTCDate();
  copy.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return copy;
}

export function parseImportArgs(args: string[]): ImportOptions {
  const result: ImportOptions = {
    plan: false,
    follow: false,
    scope: "pons-launches",
    months: DEFAULT_MONTHS,
    confirmations: DEFAULT_CONFIRMATIONS,
    batchSize: DEFAULT_BATCH_SIZE,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    pollMs: DEFAULT_POLL_MS
  };
  const readValue = (index: number, option: string): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plan") {
      result.plan = true;
    } else if (arg === "--follow") {
      result.follow = true;
    } else if (arg === "--scope") {
      const value = readValue(index, arg);
      if (value !== "pons-launches" && value !== "all") throw new Error("--scope must be pons-launches or all");
      result.scope = value;
      index += 1;
    } else if (arg === "--months") {
      result.months = parsePositiveInteger(readValue(index, arg), arg);
      index += 1;
    } else if (arg === "--from") {
      const parsed = new Date(readValue(index, arg));
      if (Number.isNaN(parsed.getTime())) throw new Error("--from must be an ISO-8601 date or timestamp");
      result.from = parsed;
      index += 1;
    } else if (arg === "--to-block") {
      const value = readValue(index, arg);
      const parsed = value.startsWith("0x") ? parseHexQuantity(value, arg) : parsePositiveInteger(value, arg);
      result.toBlock = parsed;
      index += 1;
    } else if (arg === "--confirmations") {
      const value = Number(readValue(index, arg));
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("--confirmations must be a non-negative integer");
      result.confirmations = value;
      index += 1;
    } else if (arg === "--batch-size") {
      result.batchSize = parsePositiveInteger(readValue(index, arg), arg);
      if (result.batchSize > MAX_BATCH_SIZE) throw new Error(`--batch-size cannot exceed ${MAX_BATCH_SIZE}`);
      index += 1;
    } else if (arg === "--sample-size") {
      result.sampleSize = parsePositiveInteger(readValue(index, arg), arg);
      if (result.sampleSize > MAX_BATCH_SIZE) throw new Error(`--sample-size cannot exceed ${MAX_BATCH_SIZE}`);
      index += 1;
    } else if (arg === "--poll-ms") {
      result.pollMs = parsePositiveInteger(readValue(index, arg), arg);
      if (result.pollMs < MIN_POLL_MS || result.pollMs > MAX_POLL_MS) {
        throw new Error(`--poll-ms must be from ${MIN_POLL_MS} to ${MAX_POLL_MS}`);
      }
      index += 1;
    } else if (arg === "--max-blocks") {
      result.maxBlocks = parsePositiveInteger(readValue(index, arg), arg);
      index += 1;
    } else if (arg === "--job-id") {
      const value = readValue(index, arg);
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) throw new Error("--job-id contains unsupported characters");
      result.jobId = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("HELP");
    } else {
      throw new Error(`Unknown option: ${arg ?? ""}`);
    }
  }
  if (result.plan && result.follow) throw new Error("--plan and --follow cannot be combined");
  return result;
}

function rpcUrlFromEnvironment(): string {
  const explicit = process.env.ROBINHOOD_RPC_URL?.split(",")[0]?.trim().replace(/#nologs$/, "");
  if (explicit) {
    if (!/^https:\/\//i.test(explicit)) throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
    return explicit;
  }
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new Error("Missing ALCHEMY_API_KEY (or ROBINHOOD_RPC_URL) in .env");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw new Error("ALCHEMY_API_KEY has an invalid format");
  return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
}

class RpcClient {
  readonly #url: string;
  #nextId = 1;

  constructor(url: string) {
    this.#url = url;
  }

  async #post(body: JsonObject | JsonObject[]): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "gptheist/1.1 transaction-import" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const payload = await response.json() as unknown;
        if (response.status === 429 || response.status >= 500) {
          throw new RpcHttpError(`retryable Alchemy HTTP ${response.status}`, true);
        }
        if (!response.ok) {
          const envelope = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as RpcEnvelope : null;
          const detail = envelope?.error?.message ? `: ${envelope.error.message}` : "";
          throw new RpcHttpError(`Alchemy HTTP ${response.status}${detail}`, false);
        }
        return payload;
      } catch (error: unknown) {
        lastError = error;
        if (error instanceof RpcHttpError && !error.retryable) throw error;
        if (attempt === 5) break;
        const jitter = Math.floor(Math.random() * 250);
        await delay(Math.min(8_000, 400 * (2 ** attempt)) + jitter);
      } finally {
        clearTimeout(timer);
      }
    }
    const message = lastError instanceof Error ? lastError.message : "unknown RPC failure";
    throw new Error(`Robinhood RPC request failed after retries: ${message.replace(this.#url, "<rpc>")}`);
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const id = this.#nextId++;
    const payload = await this.#post({ jsonrpc: "2.0", id, method, params });
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error(`Invalid JSON-RPC response for ${method}`);
    }
    const envelope = payload as RpcEnvelope;
    if (envelope.error) throw new Error(`JSON-RPC ${String(envelope.error.code ?? "error")}: ${envelope.error.message ?? method}`);
    return envelope.result;
  }

  async logs(filter: JsonObject, fromBlock: number, toBlock: number, depth = 0): Promise<RpcLog[]> {
    try {
      const payload = await this.call("eth_getLogs", [{
        ...filter,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`
      }]);
      if (!Array.isArray(payload)) throw new Error("RPC endpoint returned invalid logs");
      return payload.filter(isRpcLog);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown log query failure";
      if (fromBlock >= toBlock || depth >= 20 || !/response size|block range|too many|limit/i.test(message)) throw error;
      const middle = Math.floor((fromBlock + toBlock) / 2);
      return [
        ...await this.logs(filter, fromBlock, middle, depth + 1),
        ...await this.logs(filter, middle + 1, toBlock, depth + 1)
      ];
    }
  }

  async blocks(blockNumbers: number[], fullTransactions: boolean, attempt = 0): Promise<RpcBlock[]> {
    try {
      const requests = blockNumbers.map((blockNumber) => ({
        jsonrpc: "2.0",
        id: this.#nextId++,
        method: "eth_getBlockByNumber",
        params: [`0x${blockNumber.toString(16)}`, fullTransactions]
      }));
      const payload = await this.#post(requests);
      if (!Array.isArray(payload)) throw new Error("RPC endpoint did not return a JSON-RPC batch response");
      const responses = new Map<number, RpcEnvelope>();
      for (const item of payload) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const envelope = item as RpcEnvelope;
        responses.set(envelope.id, envelope);
      }
      return requests.map((request, index) => {
        const envelope = responses.get(request.id);
        if (!envelope) throw new Error(`Missing RPC response for block ${String(blockNumbers[index])}`);
        if (envelope.error) throw new Error(`Block ${String(blockNumbers[index])} RPC error: ${envelope.error.message ?? "unknown"}`);
        return validateBlock(envelope.result, blockNumbers[index] ?? -1);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown block request failure";
      if (!/compute units|capacity|rate limit|too many|429/i.test(message)) throw error;
      if (blockNumbers.length > 1) {
        const middle = Math.ceil(blockNumbers.length / 2);
        const left = await this.blocks(blockNumbers.slice(0, middle), fullTransactions);
        await delay(250);
        const right = await this.blocks(blockNumbers.slice(middle), fullTransactions);
        return [...left, ...right];
      }
      if (attempt >= 6) throw error;
      await delay(Math.min(8_000, 500 * (2 ** attempt)));
      return this.blocks(blockNumbers, fullTransactions, attempt + 1);
    }
  }
}

function validateBlock(value: unknown, expectedNumber: number): RpcBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Block ${expectedNumber} was not found`);
  }
  const block = value as JsonObject;
  const number = parseHexQuantity(block.number, "block.number");
  if (number !== expectedNumber || typeof block.hash !== "string" || typeof block.timestamp !== "string" || !Array.isArray(block.transactions)) {
    throw new Error(`Block ${expectedNumber} has an invalid response shape`);
  }
  return block as RpcBlock;
}

export async function findFirstBlockAtOrAfter(
  endBlock: number,
  targetTimestamp: number,
  getBlock: (blockNumber: number) => Promise<BlockTimestamp>
): Promise<number> {
  let low = 1;
  let high = endBlock;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const block = await getBlock(middle);
    if (block.timestamp < targetTimestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sampleNumbers(startBlock: number, endBlock: number, count: number): number[] {
  const range = endBlock - startBlock + 1;
  const actualCount = Math.min(count, range);
  if (actualCount === 1) return [startBlock];
  const result = new Set<number>();
  for (let index = 0; index < actualCount; index += 1) {
    result.add(Math.round(startBlock + ((range - 1) * index) / (actualCount - 1)));
  }
  return [...result];
}

function isTransaction(value: unknown): value is JsonObject & { hash: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as JsonObject).hash === "string";
}

function isRpcLog(value: unknown): value is RpcLog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const log = value as JsonObject;
  return typeof log.address === "string" && typeof log.blockNumber === "string" &&
    typeof log.transactionHash === "string" && typeof log.logIndex === "string" &&
    typeof log.data === "string" && Array.isArray(log.topics) &&
    log.topics.every((topic) => typeof topic === "string");
}

function parseHexBigInteger(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} is not a valid hex quantity`);
  }
  return BigInt(value).toString(10);
}

function parseOptionalHexBigInteger(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : parseHexBigInteger(value, label);
}

function transactionInputBytes(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return null;
  return (value.length - 2) / 2;
}

function transactionFunctionSelector(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{8}/.test(value) ? value.slice(0, 10).toLowerCase() : null;
}

export function normalizeTransaction(
  transaction: JsonObject,
  block: RpcBlock,
  now: Date,
  ingestionMode: StoredTransaction["ingestionMode"] = "backfill",
  scope: ImportScope = "all",
  ponsLaunches: LiveLaunch[] = []
): StoredTransaction {
  const hash = transaction.hash;
  const from = transaction.from;
  const to = transaction.to;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Transaction hash is invalid");
  if (typeof from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(from)) throw new Error(`Transaction ${hash} has an invalid sender`);
  if (to !== null && (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to))) {
    throw new Error(`Transaction ${hash} has an invalid recipient`);
  }
  const blockNumberHex = typeof transaction.blockNumber === "string" ? transaction.blockNumber : block.number;
  const transactionIndexHex = typeof transaction.transactionIndex === "string" ? transaction.transactionIndex : "0x0";
  const timestamp = new Date(parseHexQuantity(block.timestamp, "block.timestamp") * 1_000);
  return {
    scope,
    chainId: ROBINHOOD_CHAIN_ID,
    hash: hash.toLowerCase(),
    blockNumber: parseHexQuantity(blockNumberHex, "transaction.blockNumber"),
    blockHash: block.hash.toLowerCase(),
    transactionIndex: parseHexQuantity(transactionIndexHex, "transaction.transactionIndex"),
    timestamp,
    from: from.toLowerCase(),
    to: typeof to === "string" ? to.toLowerCase() : null,
    valueWei: parseHexBigInteger(transaction.value, "transaction.value"),
    gasLimit: parseHexBigInteger(transaction.gas, "transaction.gas"),
    gasPriceWei: parseOptionalHexBigInteger(transaction.gasPrice, "transaction.gasPrice"),
    maxFeePerGasWei: parseOptionalHexBigInteger(transaction.maxFeePerGas, "transaction.maxFeePerGas"),
    maxPriorityFeePerGasWei: parseOptionalHexBigInteger(transaction.maxPriorityFeePerGas, "transaction.maxPriorityFeePerGas"),
    nonce: parseHexQuantity(transaction.nonce, "transaction.nonce"),
    transactionType: transaction.type === undefined || transaction.type === null
      ? null
      : parseHexQuantity(transaction.type, "transaction.type"),
    functionSelector: transactionFunctionSelector(transaction.input),
    inputBytes: transactionInputBytes(transaction.input),
    blockBaseFeePerGasWei: parseOptionalHexBigInteger(block.baseFeePerGas, "block.baseFeePerGas"),
    ingestionMode,
    ingestionLagMs: Math.max(0, now.getTime() - timestamp.getTime()),
    ponsLaunches,
    firstIngestedAt: now,
    lastSeenAt: now
  };
}

async function buildPlan(rpc: RpcClient, options: ImportOptions): Promise<ImportPlan> {
  const chainId = parseHexQuantity(await rpc.call("eth_chainId"), "eth_chainId");
  if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`RPC chain id is ${chainId}, expected ${ROBINHOOD_CHAIN_ID}`);
  const head = parseHexQuantity(await rpc.call("eth_blockNumber"), "eth_blockNumber");
  const endBlock = options.toBlock ?? Math.max(1, head - options.confirmations);
  if (endBlock > head) throw new Error("--to-block cannot be above the current chain head");
  const end = (await rpc.blocks([endBlock], false))[0];
  if (!end) throw new Error("Unable to read the end block");
  const anchor = new Date(parseHexQuantity(end.timestamp, "end block timestamp") * 1_000);
  const since = options.from ?? subtractUtcMonths(anchor, options.months);
  const startBlock = await findFirstBlockAtOrAfter(endBlock, Math.floor(since.getTime() / 1_000), async (blockNumber) => {
    const block = (await rpc.blocks([blockNumber], false))[0];
    if (!block) throw new Error(`Unable to read block ${blockNumber}`);
    return { timestamp: parseHexQuantity(block.timestamp, "block timestamp") };
  });
  if (startBlock > endBlock) throw new Error("Requested time range starts after the end block");
  const blockCount = endBlock - startBlock + 1;
  let sampledBlockCount = 0;
  let sampledTransactions = 0;
  let averageTransactionBytes = 1_100;
  if (options.scope === "pons-launches") {
    const sampleStarts = sampleNumbers(startBlock, endBlock, options.sampleSize);
    for (const sampleStart of sampleStarts) {
      const sampleEnd = Math.min(endBlock, sampleStart + PONS_PLAN_SAMPLE_BLOCKS - 1);
      const logs = await rpc.logs({ address: PONS_FACTORY, topics: [TOKEN_LAUNCHED_TOPIC] }, sampleStart, sampleEnd);
      sampledBlockCount += sampleEnd - sampleStart + 1;
      sampledTransactions += new Set(logs.map((log) => log.transactionHash.toLowerCase())).size;
    }
  } else {
    const numbers = sampleNumbers(startBlock, endBlock, options.sampleSize);
    const sampledBlocks = await rpc.blocks(numbers, true);
    sampledBlockCount = sampledBlocks.length;
    let sampledBytes = 0;
    for (const block of sampledBlocks) {
      for (const transaction of block.transactions) {
        if (!isTransaction(transaction)) continue;
        sampledTransactions += 1;
        sampledBytes += Buffer.byteLength(JSON.stringify(transaction));
      }
    }
    averageTransactionBytes = sampledTransactions === 0 ? 600 : sampledBytes / sampledTransactions;
  }
  const averageTransactionsPerBlock = sampledBlockCount === 0 ? 0 : sampledTransactions / sampledBlockCount;
  const estimatedTransactions = Math.round(blockCount * averageTransactionsPerBlock);
  const estimatedMongoBytes = estimatedTransactions * (averageTransactionBytes + 350);
  return {
    chainId,
    scope: options.scope,
    since,
    startBlock,
    endBlock,
    blockCount,
    sampledBlocks: sampledBlockCount,
    sampledTransactions,
    averageTransactionsPerBlock: Number(averageTransactionsPerBlock.toFixed(3)),
    estimatedTransactions,
    estimatedUncompressedMongoGiB: Number((estimatedMongoBytes / (1024 ** 3)).toFixed(2))
  };
}

async function ensureIndexes(transactions: Collection<StoredTransaction>): Promise<void> {
  await Promise.all([
    transactions.createIndex({ chainId: 1, hash: 1 }, { unique: true, name: "chain_hash_unique" }),
    transactions.createIndex({ timestamp: 1 }, { expireAfterSeconds: RETENTION_SECONDS, name: "timestamp_retention_ttl" }),
    transactions.createIndex({ chainId: 1, "ponsLaunches.token": 1, timestamp: -1 }, { name: "chain_pons_token_timestamp" }),
    transactions.createIndex({ chainId: 1, "ponsLaunches.deployer": 1, timestamp: -1 }, { name: "chain_pons_deployer_timestamp" })
  ]);
  const obsolete = new Set(["chain_scope_timestamp", "chain_block_position", "chain_pons_curve_timestamp"]);
  const existing = await transactions.listIndexes().toArray();
  for (const index of existing) {
    if (index.name && obsolete.has(index.name)) await transactions.dropIndex(index.name);
  }
}

interface LoadedBatch {
  documents: StoredTransaction[];
  hydratedBlocks: number;
}

async function loadAllTransactions(
  rpc: RpcClient,
  fromBlock: number,
  toBlock: number,
  now: Date,
  ingestionMode: StoredTransaction["ingestionMode"]
): Promise<LoadedBatch> {
  const numbers = Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index);
  const blocks = await rpc.blocks(numbers, true);
  const documents: StoredTransaction[] = [];
  for (const block of blocks) {
    for (const transaction of block.transactions) {
      if (isTransaction(transaction)) documents.push(normalizeTransaction(transaction, block, now, ingestionMode, "all"));
    }
  }
  return { documents, hydratedBlocks: blocks.length };
}

async function loadPonsLaunchTransactions(
  rpc: RpcClient,
  fromBlock: number,
  toBlock: number,
  blockBatchSize: number,
  now: Date,
  ingestionMode: StoredTransaction["ingestionMode"]
): Promise<LoadedBatch> {
  const logs = await rpc.logs({ address: PONS_FACTORY, topics: [TOKEN_LAUNCHED_TOPIC] }, fromBlock, toBlock);
  const launchesByHash = new Map<string, LiveLaunch[]>();
  const blockNumbers = new Set<number>();
  for (const log of logs) {
    const launch = decodeTokenLaunchedLog(log);
    if (!launch) continue;
    const hash = launch.transactionHash.toLowerCase();
    const launches = launchesByHash.get(hash) ?? [];
    launches.push(launch);
    launchesByHash.set(hash, launches);
    blockNumbers.add(launch.blockNumber);
  }
  const documents: StoredTransaction[] = [];
  const remainingHashes = new Set(launchesByHash.keys());
  const numbers = [...blockNumbers].sort((left, right) => left - right);
  for (let offset = 0; offset < numbers.length; offset += blockBatchSize) {
    const blocks = await rpc.blocks(numbers.slice(offset, offset + blockBatchSize), true);
    for (const block of blocks) {
      for (const transaction of block.transactions) {
        if (!isTransaction(transaction)) continue;
        const hash = transaction.hash.toLowerCase();
        const launches = launchesByHash.get(hash);
        if (!launches) continue;
        documents.push(normalizeTransaction(transaction, block, now, ingestionMode, "pons-launches", launches));
        remainingHashes.delete(hash);
      }
    }
  }
  if (remainingHashes.size > 0) {
    throw new Error(`Unable to hydrate ${remainingHashes.size} Pons launch transaction(s) from their reported blocks`);
  }
  return { documents, hydratedBlocks: numbers.length };
}

async function importBlocks(rpc: RpcClient, options: ImportOptions, plan: ImportPlan): Promise<void> {
  const mongoUri = process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";
  const databaseName = process.env.GPTHEIST_MONGODB_DB?.trim() || "gptheist";
  const client = new MongoClient(mongoUri, { appName: "gptheist-robinhood-import" });
  const requestedJobId = options.jobId ?? `robinhood-transactions-${plan.since.toISOString().slice(0, 10)}`;
  const checkpointId = `${ROBINHOOD_CHAIN_ID}:${options.scope}:${requestedJobId}`;
  let interrupted = false;
  const interrupt = (): void => { interrupted = true; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await client.connect();
    const database = client.db(databaseName);
    await database.command({ ping: 1 });
    const transactions = database.collection<StoredTransaction>("robinhood_transactions");
    const checkpoints = database.collection<ImportCheckpoint>("ingestion_checkpoints");
    await ensureIndexes(transactions);
    const checkpoint = await checkpoints.findOne({ _id: checkpointId });
    const reusableCheckpoint = checkpoint !== null && checkpoint.chainId === ROBINHOOD_CHAIN_ID && checkpoint.scope === options.scope && checkpoint.startBlock <= plan.startBlock;
    let nextBlock = reusableCheckpoint
      ? Math.max(plan.startBlock, checkpoint.nextBlock)
      : plan.startBlock;
    const checkpointSince = reusableCheckpoint ? checkpoint.since : plan.since;
    let scannedBlocks = reusableCheckpoint ? checkpoint.scannedBlocks : 0;
    let storedTransactions = reusableCheckpoint ? checkpoint.storedTransactions : 0;
    let processedThisRun = 0;
    let targetEndBlock = plan.endBlock;
    let lastReportedTarget = targetEndBlock;
    process.stdout.write(`${JSON.stringify({ event: "import-start", database: databaseName, collection: transactions.collectionName, checkpointId, scope: options.scope, nextBlock, targetEndBlock, follow: options.follow, pollMs: options.pollMs, confirmations: options.confirmations })}\n`);
    while (!interrupted) {
      const remainingLimit = options.maxBlocks === undefined ? Number.POSITIVE_INFINITY : options.maxBlocks - processedThisRun;
      if (remainingLimit <= 0) break;
      if (nextBlock > targetEndBlock) {
        if (!options.follow) break;
        await delay(options.pollMs);
        if (interrupted) break;
        const head = parseHexQuantity(await rpc.call("eth_blockNumber"), "eth_blockNumber");
        targetEndBlock = Math.max(1, head - options.confirmations);
        if (targetEndBlock !== lastReportedTarget) {
          process.stdout.write(`${JSON.stringify({ event: "poll", headBlock: head, targetEndBlock, nextBlock, pollMs: options.pollMs })}\n`);
          lastReportedTarget = targetEndBlock;
        }
        continue;
      }
      const maximumRange = options.scope === "pons-launches" ? PONS_LOG_WINDOW_BLOCKS : options.batchSize;
      const batchEnd = Math.min(targetEndBlock, nextBlock + maximumRange - 1, nextBlock + remainingLimit - 1);
      const now = new Date();
      const ingestionMode: StoredTransaction["ingestionMode"] = batchEnd <= plan.endBlock ? "backfill" : "follow";
      const loaded = options.scope === "pons-launches"
        ? await loadPonsLaunchTransactions(rpc, nextBlock, batchEnd, options.batchSize, now, ingestionMode)
        : await loadAllTransactions(rpc, nextBlock, batchEnd, now, ingestionMode);
      const documents = loaded.documents;
      if (documents.length > 0) {
        await transactions.bulkWrite(documents.map((document) => {
          const { firstIngestedAt, ...current } = document;
          return {
            updateOne: {
              filter: { chainId: document.chainId, hash: document.hash },
              update: {
                $set: current,
                $setOnInsert: { firstIngestedAt }
              },
              upsert: true
            }
          };
        }), { ordered: false });
      }
      const rangeBlocks = batchEnd - nextBlock + 1;
      scannedBlocks += rangeBlocks;
      storedTransactions += documents.length;
      processedThisRun += rangeBlocks;
      nextBlock = batchEnd + 1;
      const status: ImportCheckpoint["status"] = options.follow ? "running" : nextBlock > plan.endBlock ? "complete" : "running";
      await checkpoints.updateOne({ _id: checkpointId }, {
        $set: {
          chainId: ROBINHOOD_CHAIN_ID,
          scope: options.scope,
          since: checkpointSince,
          startBlock: reusableCheckpoint ? checkpoint.startBlock : plan.startBlock,
          targetEndBlock,
          nextBlock,
          scannedBlocks,
          storedTransactions,
          updatedAt: new Date(),
          confirmations: options.confirmations,
          pollMs: options.pollMs,
          status
        }
      }, { upsert: true });
      process.stdout.write(`${JSON.stringify({ event: "batch", throughBlock: batchEnd, scannedBlocks: rangeBlocks, hydratedBlocks: loaded.hydratedBlocks, transactions: documents.length, nextBlock })}\n`);
    }
    const finalStatus: ImportCheckpoint["status"] = !options.follow && nextBlock > plan.endBlock ? "complete" : "paused";
    await checkpoints.updateOne({ _id: checkpointId }, {
      $set: { status: finalStatus, targetEndBlock, nextBlock, confirmations: options.confirmations, pollMs: options.pollMs, updatedAt: new Date() }
    }, { upsert: true });
    process.stdout.write(`${JSON.stringify({ event: "import-finish", status: finalStatus, nextBlock, targetEndBlock, scannedBlocks, storedTransactions })}\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await client.close();
  }
}

function helpText(): string {
  return [
    "Import Robinhood Chain transactions into MongoDB.",
    "",
    "Usage:",
    "  npm run transactions:plan",
    "  npm run transactions:import -- [options]",
    "",
    "Options:",
    "  --plan                 Estimate the range and storage without writing",
    "  --follow               Keep polling for new blocks after the backfill",
    "  --scope <name>         pons-launches (default) or all",
    "  --months <n>           Calendar months to look back (default: 3)",
    "  --from <ISO date>      Explicit UTC start date instead of --months",
    "  --to-block <n|0x...>   Fixed inclusive end block",
    "  --confirmations <n>    Blocks behind head to stop (default: 64)",
    "  --batch-size <1..100>  JSON-RPC blocks per request (default: 25)",
    "  --sample-size <1..100> Plan sample size (default: 32)",
    "  --poll-ms <250..60000> Follow-mode poll interval (default: 1000)",
    "  --max-blocks <n>       Pause after n blocks; rerun to resume",
    "  --job-id <id>          Stable checkpoint name",
    "",
    "Environment:",
    "  ALCHEMY_API_KEY or ROBINHOOD_RPC_URL (required)",
    "  MONGODB_URI (default: mongodb://127.0.0.1:27017)",
    "  GPTHEIST_MONGODB_DB (default: gptheist)"
  ].join("\n");
}

export async function runTransactionImportCli(args: string[]): Promise<void> {
  let options: ImportOptions;
  try {
    options = parseImportArgs(args);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    throw error;
  }
  const rpc = new RpcClient(rpcUrlFromEnvironment());
  const plan = await buildPlan(rpc, options);
  process.stdout.write(`${JSON.stringify({
    event: "plan",
    ...plan,
    since: plan.since.toISOString()
  })}\n`);
  if (options.plan) return;
  let consecutiveFailures = 0;
  for (;;) {
    try {
      await importBlocks(rpc, options, plan);
      return;
    } catch (error: unknown) {
      if (!options.follow) throw error;
      consecutiveFailures += 1;
      const retryMs = Math.min(30_000, options.pollMs * (2 ** Math.min(consecutiveFailures - 1, 5)));
      const message = redactRuntimeError(error instanceof Error ? error.message : "unknown import failure");
      process.stdout.write(`${JSON.stringify({ event: "retry", consecutiveFailures, retryMs, message })}\n`);
      await delay(retryMs);
    }
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runTransactionImportCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Transaction import failed: ${redactRuntimeError(message)}\n`);
    process.exitCode = 1;
  });
}
