import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, type AnyBulkWriteOperation, type Collection, type Document } from "mongodb";
import { toEventSelector } from "viem";

type JsonObject = Record<string, unknown>;
type MarketNetwork = "ethereum" | "solana";
type IngestionMode = "backfill" | "follow";

const DEFAULT_HOURS = 48;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_ETHEREUM_CONFIRMATIONS = 12;
const DEFAULT_EVM_BATCH_SIZE = 50;
const DEFAULT_SOLANA_PAGE_SIZE = 1_000;
const SOLANA_HISTORY_PAGE_STRIDE = 10;
const MAX_RETRIES = 3;
const MAX_RPC_BATCH_SIZE = 20;
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const RETENTION_SECONDS = 93 * 24 * 60 * 60;

export const EVM_MARKET_EVENTS = {
  "uniswap-v2-like": "Swap(address,uint256,uint256,uint256,uint256,address)",
  "uniswap-v3-like": "Swap(address,address,int256,int256,uint160,uint128,int24)",
  "uniswap-v4": "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  balancer: "Swap(bytes32,address,address,uint256,uint256)",
  curve: "TokenExchange(address,int128,uint256,int128,uint256)",
  "curve-underlying": "TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"
} as const;

export const EVM_MARKET_TOPICS = Object.fromEntries(
  Object.entries(EVM_MARKET_EVENTS).map(([protocol, signature]) => [toEventSelector(signature), protocol])
) as Record<string, string>;

export const EVM_MARKET_POOLS = {
  "uniswap-v3-weth-usdc-005": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
  "uniswap-v3-weth-usdc-030": "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
  "uniswap-v2-weth-usdc": "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc",
  "uniswap-v3-weth-usdt-030": "0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36",
  "uniswap-v2-weth-usdt": "0x0d4a11d5EEaac28EC3F61d100daF4d40471f1852"
} as const;

export const DEFAULT_SOLANA_MARKETS = {
  "raydium-sol-usdc-amm": "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
  "raydium-sol-usdc-clmm": "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
  "orca-sol-usdc-whirlpool": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"
} as const;

const SOLANA_MARKET_PROGRAMS: Record<string, string> = {
  "raydium-sol-usdc-amm": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "raydium-sol-usdc-clmm": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "orca-sol-usdc-whirlpool": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
};

export interface MarketImportOptions {
  plan: boolean;
  follow: boolean;
  hours: number;
  pollMs: number;
  ethereumConfirmations: number;
  evmBatchSize: number;
  solanaPageSize: number;
  networks: MarketNetwork[];
  maxEvmBlocks?: number;
  maxSolanaPages?: number;
}

interface RpcEnvelope {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface EvmLog extends JsonObject {
  address: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  data: string;
  topics: string[];
  removed?: boolean;
}

interface EvmBlock extends JsonObject {
  number: string;
  hash: string;
  timestamp: string;
  transactions: JsonObject[];
}

interface MarketTransaction extends JsonObject {
  _id: string;
  network: MarketNetwork;
  chainId: number | null;
  hash: string;
  blockNumber: number;
  blockHash: string | null;
  transactionIndex: number | null;
  timestamp: Date;
  protocols: string[];
  marketAddresses?: string[];
  ingestionMode: IngestionMode;
  ingestionLagMs: number;
  firstIngestedAt: Date;
  lastSeenAt: Date;
}

interface EvmCheckpoint {
  _id: string;
  network: "ethereum";
  since: Date;
  nextBlock: number;
  scannedBlocks: number;
  storedTransactions: number;
  updatedAt: Date;
}

interface SolanaCheckpoint {
  _id: string;
  network: "solana";
  protocol: string;
  marketAddress: string;
  since: Date;
  before?: string;
  newestSignature?: string;
  historyComplete: boolean;
  storedTransactions: number;
  updatedAt: Date;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

export function parseMarketImportArgs(args: string[]): MarketImportOptions {
  const result: MarketImportOptions = {
    plan: false,
    follow: false,
    hours: DEFAULT_HOURS,
    pollMs: DEFAULT_POLL_MS,
    ethereumConfirmations: DEFAULT_ETHEREUM_CONFIRMATIONS,
    evmBatchSize: DEFAULT_EVM_BATCH_SIZE,
    solanaPageSize: DEFAULT_SOLANA_PAGE_SIZE,
    networks: ["ethereum", "solana"]
  };
  const valueAfter = (index: number, option: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plan") result.plan = true;
    else if (arg === "--follow") result.follow = true;
    else if (arg === "--hours") {
      result.hours = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--poll-ms") {
      result.pollMs = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--ethereum-confirmations") {
      result.ethereumConfirmations = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--evm-batch-size") {
      result.evmBatchSize = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--solana-page-size") {
      result.solanaPageSize = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--networks") {
      const values = valueAfter(index, arg).split(",").map((value) => value.trim()).filter(Boolean);
      if (values.length === 0 || values.some((value) => value !== "ethereum" && value !== "solana")) {
        throw new Error("--networks must contain ethereum and/or solana");
      }
      result.networks = [...new Set(values)] as MarketNetwork[];
      index += 1;
    } else if (arg === "--max-evm-blocks") {
      result.maxEvmBlocks = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--max-solana-pages") {
      result.maxSolanaPages = positiveInteger(valueAfter(index, arg), arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") throw new Error("HELP");
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.plan && result.follow) throw new Error("--plan and --follow cannot be combined");
  if (result.pollMs < 1_000 || result.pollMs > 300_000) throw new Error("--poll-ms must be from 1000 to 300000");
  if (result.evmBatchSize > 1_000) throw new Error("--evm-batch-size cannot exceed 1000");
  if (result.solanaPageSize > 1_000) throw new Error("--solana-page-size cannot exceed 1000");
  return result;
}

function apiKey(env: NodeJS.ProcessEnv): string {
  const value = env.ALCHEMY_API_KEY?.trim();
  if (!value) throw new Error("Missing ALCHEMY_API_KEY");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(value)) throw new Error("ALCHEMY_API_KEY has an invalid format");
  return value;
}

export function marketRpcEndpoint(network: MarketNetwork, env: NodeJS.ProcessEnv = process.env): string {
  const name = network === "ethereum" ? "ETHEREUM_RPC_URL" : "SOLANA_RPC_URL";
  const explicit = env[name]?.trim() || env[`DRPC_${name}`]?.trim();
  if (explicit) {
    let url: URL;
    try { url = new URL(explicit); } catch { throw new Error(`${name} must be a valid HTTPS endpoint`); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${name} must use HTTPS without embedded credentials or a fragment`);
    if (url.hostname === "lb.drpc.live" && url.pathname.split("/")[1] !== network) {
      throw new Error(`${name} dRPC endpoint targets the wrong network`);
    }
    return explicit;
  }
  const key = apiKey(env);
  return network === "ethereum"
    ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
    : `https://solana-mainnet.g.alchemy.com/v2/${key}`;
}

export async function verifyMarketRpcNetwork(network: MarketNetwork, rpc: Pick<JsonRpcClient, "call">): Promise<void> {
  if (network === "ethereum") {
    const chainId = hexNumber(await rpc.call("eth_chainId"), "eth_chainId");
    if (chainId !== 1) throw new Error(`Ethereum endpoint returned chain id ${chainId}; expected Ethereum mainnet (1)`);
  } else if (await rpc.call("getGenesisHash") !== SOLANA_MAINNET_GENESIS_HASH) {
    throw new Error("Solana endpoint must target mainnet-beta");
  }
}

export function configuredSolanaMarkets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.MARKET_SOLANA_MARKETS?.trim();
  if (!raw) return { ...DEFAULT_SOLANA_MARKETS };
  const result: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const [name, marketAddress, extra] = entry.split(":").map((value) => value.trim());
    if (!name || !marketAddress || extra || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(marketAddress)) {
      throw new Error("MARKET_SOLANA_MARKETS must be comma-separated name:address pairs");
    }
    result[name] = marketAddress;
  }
  return result;
}

class MarketRpcError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(message); }
}

export class JsonRpcClient {
  #nextId = 1;
  #nextRequestAt = 0;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly url: string,
    readonly label: string,
    readonly transport: typeof fetch = fetch,
    readonly sleep: (milliseconds: number) => Promise<void> = delay,
    readonly now: () => number = Date.now
  ) {}

  #redact(message: string): string {
    return message.split(this.url).join("<rpc>").replace(/https?:\/\/[^\s"'<>]+/gi, "<rpc>");
  }

  async post(body: JsonObject | JsonObject[]): Promise<unknown> {
    const operation = this.#queue.then(async () => {
      const waitMs = this.#nextRequestAt - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      // Pace subrequests as well as HTTP calls: batching does not make RPC methods free.
      this.#nextRequestAt = this.now() + (Array.isArray(body) ? body.length : 1) * 100;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await this.transport(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "gptheist/1.2 market-import" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const retryAfterMs = Number.isFinite(retryAfter) ? Math.min(30_000, Math.max(0, retryAfter * 1_000)) : 0;
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable) this.#nextRequestAt = Math.max(this.#nextRequestAt, this.now() + Math.max(500, retryAfterMs));
          const payload = !retryable ? await response.json().catch(() => null) as unknown : null;
          const detail = isObject(payload) && isObject(payload.error) && typeof payload.error.message === "string"
            ? `: ${this.#redact(payload.error.message).slice(0, 200)}` : "";
          throw new MarketRpcError(`${this.label} HTTP ${response.status}${detail}`, retryable, retryAfterMs);
        }
        const payload = await response.json() as unknown;
        return payload;
      } finally {
        clearTimeout(timer);
      }
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async call(method: string, params: unknown[] = [], maxAttempts = MAX_RETRIES): Promise<unknown> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRIES) throw new Error("Invalid RPC attempt budget");
    const id = this.#nextId++;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const payload = await this.post({ jsonrpc: "2.0", id, method, params });
        if (!isObject(payload) || payload.id !== id || payload.jsonrpc !== "2.0" || (!payload.error && !("result" in payload))) {
          throw new MarketRpcError(`${this.label} returned an invalid response for ${method}`, false);
        }
        const envelope = payload as unknown as RpcEnvelope;
        if (!envelope.error) return envelope.result;
        const message = envelope.error.message ?? String(envelope.error.code ?? "error");
        throw new MarketRpcError(`${this.label} ${method}: ${this.#redact(message)}`, retryableRpcError(message));
      } catch (error: unknown) {
        const failure = error instanceof MarketRpcError ? error : new MarketRpcError(`${this.label} transport failure`, true);
        if (!failure.retryable || attempt === maxAttempts - 1) throw failure;
        await this.sleep(Math.max(failure.retryAfterMs, 500 * (2 ** attempt)));
      }
    }
    throw new Error(`${this.label} ${method}: retry budget exhausted`);
  }

  async batch(requests: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_RPC_BATCH_SIZE) {
      const results: unknown[] = [];
      for (let offset = 0; offset < requests.length; offset += MAX_RPC_BATCH_SIZE) {
        results.push(...await this.batch(requests.slice(offset, offset + MAX_RPC_BATCH_SIZE)));
      }
      return results;
    }
    const bodies = requests.map((request) => ({ jsonrpc: "2.0", id: this.#nextId++, ...request }));
    let pending = bodies;
    const completed = new Map<number, unknown>();
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const payload = await this.post(pending);
        if (!Array.isArray(payload)) throw new MarketRpcError(`${this.label} returned an invalid batch response`, false);
        const byId = new Map<number, RpcEnvelope>();
        for (const item of payload) {
          if (!isObject(item) || item.jsonrpc !== "2.0" || typeof item.id !== "number" || byId.has(item.id) || (!item.error && !("result" in item))) {
            throw new MarketRpcError(`${this.label} returned an invalid batch envelope`, false);
          }
          byId.set(item.id, item as unknown as RpcEnvelope);
        }
        const remaining: typeof bodies = [];
        for (const body of pending) {
          const response = byId.get(body.id);
          if (!response) throw new MarketRpcError(`${this.label} omitted batch response ${body.id}`, false);
          if (!response.error) completed.set(body.id, response.result);
          else {
            const message = response.error.message ?? "RPC error";
            if (!retryableRpcError(message)) throw new MarketRpcError(`${this.label} ${body.method}: ${this.#redact(message)}`, false);
            remaining.push(body);
          }
        }
        pending = remaining;
        if (pending.length === 0) return bodies.map((body) => completed.get(body.id));
        throw new MarketRpcError(`${this.label} batch rate limit`, true);
      } catch (error: unknown) {
        const failure = error instanceof MarketRpcError ? error : new MarketRpcError(`${this.label} transport failure`, true);
        // Some providers serve historical receipts singly but fail JSON-RPC batches.
        // Reuse the remaining budget per item instead of multiplying retry loops.
        if (/HTTP 500$/.test(failure.message) && attempt < MAX_RETRIES - 1) {
          for (const body of pending) {
            completed.set(body.id, await this.call(body.method, body.params, MAX_RETRIES - attempt - 1));
          }
          return bodies.map((body) => completed.get(body.id));
        }
        if (!failure.retryable || attempt === MAX_RETRIES - 1) throw failure;
        await this.sleep(Math.max(failure.retryAfterMs, 500 * (2 ** attempt)));
      }
    }
    throw new Error(`${this.label} batch: retry budget exhausted`);
  }
}

function retryableRpcError(message: string): boolean {
  return /compute units per second|rate limit|too many requests|throughput|\b429\b/i.test(message);
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item);
    }
  }));
  return results;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hexNumber(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range`);
  return parsed;
}

function decimalHex(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(value).toString(10);
}

function evmLog(value: unknown): value is EvmLog {
  if (!isObject(value)) return false;
  return typeof value.address === "string" && typeof value.blockNumber === "string" &&
    typeof value.blockHash === "string" && typeof value.transactionHash === "string" &&
    typeof value.transactionIndex === "string" && typeof value.logIndex === "string" &&
    typeof value.data === "string" && Array.isArray(value.topics) && value.topics.every((topic) => typeof topic === "string");
}

export async function evmLogs(rpc: JsonRpcClient, fromBlock: number, toBlock: number, depth = 0): Promise<EvmLog[]> {
  try {
    const result = await rpc.call("eth_getLogs", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: Object.values(EVM_MARKET_POOLS),
      topics: [Object.keys(EVM_MARKET_TOPICS)]
    }]);
    if (!Array.isArray(result)) throw new Error("invalid eth_getLogs response");
    return result.filter(evmLog).filter((log) => !log.removed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    // Some load balancers reject historical numeric ranges while serving the
    // same canonical logs through the standard EIP-234 blockHash filter.
    if (/unknown state/.test(message) && toBlock >= fromBlock && toBlock - fromBlock < 1_000) {
      const logs: EvmLog[] = [];
      for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
        const block = await evmBlock(rpc, blockNumber, false);
        if (hexNumber(block.number, "block.number") !== blockNumber || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
          throw new Error("Invalid Ethereum header during blockHash log recovery");
        }
        const result = await rpc.call("eth_getLogs", [{
          blockHash: block.hash,
          address: Object.values(EVM_MARKET_POOLS),
          topics: [Object.keys(EVM_MARKET_TOPICS)]
        }]);
        if (!Array.isArray(result) || result.some((log) => !evmLog(log) ||
          log.blockHash.toLowerCase() !== block.hash.toLowerCase() || hexNumber(log.blockNumber, "log.blockNumber") !== blockNumber)) {
          throw new Error("Invalid Ethereum blockHash logs response");
        }
        logs.push(...result.filter(evmLog).filter((log) => !log.removed));
      }
      return logs;
    }
    const canSplit = /block range|response size|too many results|more than \d+|query returned more|limit exceeded/.test(message);
    if (!canSplit || fromBlock >= toBlock || depth >= 24) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    return [...await evmLogs(rpc, fromBlock, middle, depth + 1), ...await evmLogs(rpc, middle + 1, toBlock, depth + 1)];
  }
}

async function evmBlock(rpc: JsonRpcClient, blockNumber: number, fullTransactions: boolean): Promise<EvmBlock> {
  const value = await rpc.call("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, fullTransactions]);
  if (!isObject(value) || value.number !== `0x${blockNumber.toString(16)}` || !Array.isArray(value.transactions) || typeof value.hash !== "string" || typeof value.timestamp !== "string") {
    throw new Error(`Invalid Ethereum block ${blockNumber}`);
  }
  return value as unknown as EvmBlock;
}

async function firstEvmBlockAtOrAfter(rpc: JsonRpcClient, endBlock: number, timestamp: number): Promise<number> {
  let low = 1;
  let high = endBlock;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const block = await evmBlock(rpc, middle, false);
    if (hexNumber(block.timestamp, "block.timestamp") < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function transactionByHash(block: EvmBlock): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const transaction of block.transactions) {
    if (isObject(transaction) && typeof transaction.hash === "string") result.set(transaction.hash.toLowerCase(), transaction);
  }
  return result;
}

async function ensureIndexes(transactions: Collection<MarketTransaction>): Promise<void> {
  await Promise.all([
    transactions.createIndex({ network: 1, hash: 1 }, { unique: true, name: "network_hash_unique" }),
    transactions.createIndex({ timestamp: 1 }, { expireAfterSeconds: RETENTION_SECONDS, name: "timestamp_retention_ttl" }),
    transactions.createIndex({ network: 1, protocols: 1, timestamp: -1 }, { name: "network_protocol_timestamp" }),
    transactions.createIndex({ network: 1, blockNumber: 1 }, { name: "network_block" })
  ]);
}

export async function storeEvmRange(
  rpc: JsonRpcClient,
  transactions: Collection<MarketTransaction>,
  fromBlock: number,
  toBlock: number,
  mode: IngestionMode
): Promise<number> {
  const logs = await evmLogs(rpc, fromBlock, toBlock);
  if (logs.length === 0) return 0;
  const logsByBlock = new Map<number, EvmLog[]>();
  for (const log of logs) {
    const blockNumber = hexNumber(log.blockNumber, "log.blockNumber");
    const list = logsByBlock.get(blockNumber) ?? [];
    list.push(log);
    logsByBlock.set(blockNumber, list);
  }
  const storedByBlock = await mapConcurrent([...logsByBlock.keys()].sort((left, right) => left - right), 3, async (blockNumber) => {
    const block = await evmBlock(rpc, blockNumber, true);
    const txs = transactionByHash(block);
    const blockLogs = logsByBlock.get(blockNumber) ?? [];
    if (blockLogs.some((log) => log.blockHash.toLowerCase() !== block.hash.toLowerCase())) {
      throw new Error(`Ethereum block ${blockNumber} changed while hydrating logs`);
    }
    const grouped = new Map<string, EvmLog[]>();
    for (const log of blockLogs) {
      const hash = log.transactionHash.toLowerCase();
      const list = grouped.get(hash) ?? [];
      list.push(log);
      grouped.set(hash, list);
    }
    const hashes = [...grouped.keys()];
    const receipts = await rpc.batch(hashes.map((hash) => ({ method: "eth_getTransactionReceipt", params: [hash] })));
    const now = new Date();
    const operations: AnyBulkWriteOperation<MarketTransaction>[] = [];
    for (let index = 0; index < hashes.length; index += 1) {
      const hash = hashes[index];
      if (!hash) continue;
      const transaction = txs.get(hash);
      const receipt = receipts[index];
      const matchedLogs = grouped.get(hash) ?? [];
      if (!transaction || !isObject(receipt)) throw new Error(`Missing Ethereum transaction or receipt ${hash}`);
      if (typeof receipt.blockHash !== "string" || receipt.blockHash.toLowerCase() !== block.hash.toLowerCase() ||
          receipt.blockNumber !== `0x${blockNumber.toString(16)}` ||
          typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== hash) {
        throw new Error(`Inconsistent Ethereum receipt ${hash}`);
      }
      const timestamp = new Date(hexNumber(block.timestamp, "block.timestamp") * 1_000);
      const protocols = [...new Set(matchedLogs.map((log) => EVM_MARKET_TOPICS[(log.topics[0] ?? "").toLowerCase()] ?? "unknown-swap"))];
      const document: MarketTransaction = {
        _id: `ethereum:${hash}`,
        network: "ethereum",
        chainId: 1,
        hash,
        blockNumber,
        blockHash: block.hash.toLowerCase(),
        transactionIndex: hexNumber(transaction.transactionIndex ?? matchedLogs[0]?.transactionIndex, "transactionIndex"),
        timestamp,
        protocols,
        from: typeof transaction.from === "string" ? transaction.from.toLowerCase() : null,
        to: typeof transaction.to === "string" ? transaction.to.toLowerCase() : null,
        valueWei: decimalHex(transaction.value, "transaction.value"),
        gasLimit: decimalHex(transaction.gas, "transaction.gas"),
        gasUsed: decimalHex(receipt.gasUsed, "receipt.gasUsed"),
        effectiveGasPriceWei: decimalHex(receipt.effectiveGasPrice, "receipt.effectiveGasPrice"),
        status: typeof receipt.status === "string" ? hexNumber(receipt.status, "receipt.status") : null,
        input: typeof transaction.input === "string" ? transaction.input : null,
        events: matchedLogs.map((log) => ({
          address: log.address.toLowerCase(),
          logIndex: hexNumber(log.logIndex, "log.logIndex"),
          topic0: (log.topics[0] ?? "").toLowerCase(),
          topics: log.topics.map((topic) => topic.toLowerCase()),
          data: log.data
        })),
        ingestionMode: mode,
        ingestionLagMs: Math.max(0, now.getTime() - timestamp.getTime()),
        firstIngestedAt: now,
        lastSeenAt: now
      };
      const { firstIngestedAt: _firstIngestedAt, ...mutableDocument } = document;
      operations.push({ updateOne: {
        filter: { _id: document._id },
        update: { $set: { ...mutableDocument, lastSeenAt: now }, $setOnInsert: { firstIngestedAt: now } },
        upsert: true
      } });
    }
    return operations.length > 0 ? (await transactions.bulkWrite(operations, { ordered: false })).upsertedCount : 0;
  });
  return storedByBlock.reduce((total, count) => total + count, 0);
}

export async function ethereumResumeBlock(
  checkpoint: Pick<EvmCheckpoint, "nextBlock"> | null,
  findStartByTime: () => Promise<number>
): Promise<number> {
  if (checkpoint) {
    if (!Number.isSafeInteger(checkpoint.nextBlock) || checkpoint.nextBlock < 1) throw new Error("Invalid Ethereum checkpoint nextBlock");
    return checkpoint.nextBlock;
  }
  return findStartByTime();
}

async function importEthereum(
  rpc: JsonRpcClient,
  transactions: Collection<MarketTransaction>,
  checkpoints: Collection<EvmCheckpoint>,
  options: MarketImportOptions,
  since: Date,
  followOnly = false
): Promise<{ nextBlock: number; stored: number }> {
  const head = hexNumber(await rpc.call("eth_blockNumber"), "eth_blockNumber");
  const endBlock = Math.max(1, head - options.ethereumConfirmations);
  const checkpointId = "market:ethereum:eth-usd:v2";
  const checkpoint = await checkpoints.findOne({ _id: checkpointId });
  const effectiveSince = checkpoint?.since ?? since;
  let nextBlock = await ethereumResumeBlock(checkpoint, () => firstEvmBlockAtOrAfter(rpc, endBlock, Math.floor(effectiveSince.getTime() / 1_000)));
  let stored = checkpoint?.storedTransactions ?? 0;
  if (followOnly && nextBlock > endBlock) return { nextBlock, stored };
  const hardEnd = options.maxEvmBlocks ? Math.min(endBlock, nextBlock + options.maxEvmBlocks - 1) : endBlock;
  for (let fromBlock = nextBlock; fromBlock <= hardEnd; fromBlock += options.evmBatchSize) {
    const toBlock = Math.min(hardEnd, fromBlock + options.evmBatchSize - 1);
    const added = await storeEvmRange(rpc, transactions, fromBlock, toBlock, followOnly ? "follow" : "backfill");
    stored += added;
    nextBlock = toBlock + 1;
    await checkpoints.updateOne({ _id: checkpointId }, { $set: {
      network: "ethereum", since: effectiveSince, nextBlock, storedTransactions: stored, updatedAt: new Date()
    }, $inc: { scannedBlocks: toBlock - fromBlock + 1 } }, { upsert: true });
    process.stdout.write(`${JSON.stringify({ event: "ethereum-progress", fromBlock, toBlock, matchedTransactions: added, nextBlock })}\n`);
  }
  return { nextBlock, stored };
}

interface SolanaSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  sampleWeight?: number;
}

function solanaSignature(value: unknown): value is SolanaSignature {
  return isObject(value) && typeof value.signature === "string" && typeof value.slot === "number" &&
    (typeof value.blockTime === "number" || value.blockTime === null);
}

function sampleSolanaSignatures(entries: SolanaSignature[], perMinute = 5): SolanaSignature[] {
  const groups = new Map<number, SolanaSignature[]>();
  for (const entry of entries) {
    if (entry.blockTime === null) continue;
    const minute = Math.floor(entry.blockTime / 60);
    const group = groups.get(minute) ?? [];
    group.push(entry);
    groups.set(minute, group);
  }
  return [...groups.values()].flatMap((group) => {
    const selected = group.slice(0, perMinute);
    const sampleWeight = group.length / selected.length;
    return selected.map((entry) => ({ ...entry, sampleWeight }));
  });
}

function solanaMarketSwap(protocol: string, logMessages: unknown): logMessages is string[] {
  if (!Array.isArray(logMessages) || !logMessages.every((value) => typeof value === "string")) return false;
  const program = SOLANA_MARKET_PROGRAMS[protocol];
  if (!program || !logMessages.some((line) => line.includes(`Program ${program} invoke`))) return false;
  return protocol === "raydium-sol-usdc-amm"
    ? logMessages.some((line) => line.includes("ray_log:"))
    : logMessages.some((line) => /Instruction: (Swap|SwapV2)\b/.test(line));
}

async function storeSolanaTransactions(
  rpc: JsonRpcClient,
  transactions: Collection<MarketTransaction>,
  signatures: SolanaSignature[],
  protocol: string,
  marketAddress: string,
  mode: IngestionMode
): Promise<number> {
  let stored = 0;
  for (let offset = 0; offset < signatures.length; offset += 20) {
    const batch = signatures.slice(offset, offset + 20);
    const results = await rpc.batch(batch.map((entry) => ({
      method: "getTransaction",
      params: [entry.signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]
    }))); 
    const now = new Date();
    const operations: AnyBulkWriteOperation<MarketTransaction>[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const summary = batch[index];
      const result = results[index];
      if (!summary || !isObject(result)) continue;
      const blockTime = typeof result.blockTime === "number" ? result.blockTime : summary.blockTime;
      if (blockTime === null) continue;
      const timestamp = new Date(blockTime * 1_000);
      const meta = isObject(result.meta) ? result.meta : {};
      const transaction = isObject(result.transaction) ? result.transaction : {};
      if (!solanaMarketSwap(protocol, meta.logMessages)) continue;
      const relevantLogs = meta.logMessages.filter((line) => /ray_log:|Instruction: (Swap|SwapV2)\b|Program data:/.test(line));
      const documentId = `solana:${summary.signature}`;
      operations.push({ updateOne: {
        filter: { _id: documentId },
        update: {
          $set: {
            network: "solana", chainId: null, hash: summary.signature, blockNumber: summary.slot,
            blockHash: null, transactionIndex: null, timestamp,
            success: meta.err === null,
            feeLamports: typeof meta.fee === "number" ? String(meta.fee) : null,
            computeUnitsConsumed: typeof meta.computeUnitsConsumed === "number" ? String(meta.computeUnitsConsumed) : null,
            message: isObject(transaction.message) ? transaction.message : null,
            logMessages: relevantLogs,
            preTokenBalances: meta.preTokenBalances ?? null,
            postTokenBalances: meta.postTokenBalances ?? null,
            sampleWeight: summary.sampleWeight ?? 1,
            ingestionMode: mode,
            ingestionLagMs: Math.max(0, now.getTime() - timestamp.getTime()),
            lastSeenAt: now
          },
          $setOnInsert: { firstIngestedAt: now },
          $addToSet: { protocols: { $each: [protocol] }, marketAddresses: { $each: [marketAddress] } }
        } as Document,
        upsert: true
      } });
    }
    if (operations.length > 0) stored += (await transactions.bulkWrite(operations, { ordered: false })).upsertedCount;
  }
  return stored;
}

async function backfillSolanaProgram(
  rpc: JsonRpcClient,
  transactions: Collection<MarketTransaction>,
  checkpoints: Collection<SolanaCheckpoint>,
  options: MarketImportOptions,
  since: Date,
  protocol: string,
  marketAddress: string
): Promise<void> {
  const checkpointId = `market:solana:${marketAddress}`;
  let checkpoint = await checkpoints.findOne({ _id: checkpointId });
  if (checkpoint?.historyComplete) return;
  const effectiveSince = checkpoint?.since ?? since;
  let before = checkpoint?.before;
  let newestSignature = checkpoint?.newestSignature;
  let storedTransactions = checkpoint?.storedTransactions ?? 0;
  let page = 0;
  while (true) {
    if (options.maxSolanaPages !== undefined && page >= options.maxSolanaPages) break;
    const config: JsonObject = { limit: options.solanaPageSize, commitment: "finalized" };
    if (before) config.before = before;
    const result = await rpc.call("getSignaturesForAddress", [marketAddress, config]);
    if (!Array.isArray(result)) throw new Error(`Invalid signatures response for ${protocol}`);
    const entries = result.filter(solanaSignature);
    if (!newestSignature && entries[0]) newestSignature = entries[0].signature;
    const inRange = entries.filter((entry) => entry.blockTime !== null && entry.blockTime * 1_000 >= effectiveSince.getTime() && entry.err === null);
    const oldest = entries.at(-1);
    const complete = entries.length < options.solanaPageSize || !oldest || oldest.blockTime === null || oldest.blockTime * 1_000 < effectiveSince.getTime();
    const sampled = page % SOLANA_HISTORY_PAGE_STRIDE === 0 || complete
      ? sampleSolanaSignatures(inRange).map((entry) => ({ ...entry, sampleWeight: (entry.sampleWeight ?? 1) * (complete ? 1 : SOLANA_HISTORY_PAGE_STRIDE) }))
      : [];
    storedTransactions += await storeSolanaTransactions(rpc, transactions, [...sampled].reverse(), protocol, marketAddress, "backfill");
    page += 1;
    before = oldest?.signature;
    await checkpoints.updateOne({ _id: checkpointId }, { $set: {
      network: "solana", protocol, marketAddress, since: effectiveSince,
      ...(before ? { before } : {}),
      ...(newestSignature ? { newestSignature } : {}),
      historyComplete: complete, storedTransactions, updatedAt: new Date()
    } }, { upsert: true });
    process.stdout.write(`${JSON.stringify({ event: "solana-progress", protocol, page, signatures: entries.length, inRange: inRange.length, sampled: sampled.length, historyComplete: complete })}\n`);
    if (complete || entries.length === 0) break;
    checkpoint = await checkpoints.findOne({ _id: checkpointId });
    before = checkpoint?.before;
  }
}

async function followSolanaProgram(
  rpc: JsonRpcClient,
  transactions: Collection<MarketTransaction>,
  checkpoints: Collection<SolanaCheckpoint>,
  options: MarketImportOptions,
  since: Date,
  protocol: string,
  marketAddress: string
): Promise<void> {
  const checkpointId = `market:solana:${marketAddress}`;
  const checkpoint = await checkpoints.findOne({ _id: checkpointId });
  const effectiveSince = checkpoint?.since ?? since;
  const config: JsonObject = { limit: options.solanaPageSize, commitment: "finalized" };
  if (checkpoint?.newestSignature) config.until = checkpoint.newestSignature;
  const result = await rpc.call("getSignaturesForAddress", [marketAddress, config]);
  if (!Array.isArray(result)) throw new Error(`Invalid signatures response for ${protocol}`);
  const entries = result.filter(solanaSignature).filter((entry) => entry.err === null);
  const sampled = sampleSolanaSignatures(entries);
  const added = await storeSolanaTransactions(rpc, transactions, [...sampled].reverse(), protocol, marketAddress, "follow");
  const newestSignature = entries[0]?.signature ?? checkpoint?.newestSignature;
  await checkpoints.updateOne({ _id: checkpointId }, { $set: {
    network: "solana", protocol, marketAddress, since: effectiveSince,
    ...(newestSignature ? { newestSignature } : {}),
    historyComplete: true,
    storedTransactions: (checkpoint?.storedTransactions ?? 0) + added, updatedAt: new Date()
  } }, { upsert: true });
  if (entries.length > 0) process.stdout.write(`${JSON.stringify({ event: "solana-follow", protocol, transactions: entries.length })}\n`);
}

function helpText(): string {
  return [
    "Import filtered Ethereum and Solana market transactions into MongoDB.",
    "",
    "Options:",
    "  --plan                         Verify endpoints and report the 48-hour range",
    "  --follow                       Continue polling after the historical import",
    "  --hours <n>                    Historical lookback (default: 48)",
    "  --networks <list>              ethereum,solana (default: both)",
    "  --poll-ms <n>                  Follow cadence (default: 5000)",
    "  --ethereum-confirmations <n>   Finality lag (default: 12)",
    "  --evm-batch-size <n>           Blocks per checkpoint batch (default: 50)",
    "  --solana-page-size <n>         Signatures per page (default: 1000)",
    "  --max-evm-blocks <n>           Bounded pilot limit",
    "  --max-solana-pages <n>         Bounded pilot pages per program",
    "",
    "Environment:",
    "  ETHEREUM_RPC_URL / SOLANA_RPC_URL (explicit overrides)",
    "  DRPC_ETHEREUM_RPC_URL / DRPC_SOLANA_RPC_URL (dRPC overrides)",
    "  ALCHEMY_API_KEY (legacy fallback for networks without an explicit URL)",
    "  MARKET_SOLANA_MARKETS=name:address,... (optional pool override)",
    "  MONGODB_URI and GPTHEIST_MONGODB_DB"
  ].join("\n");
}

export async function runMarketImport(args: string[]): Promise<void> {
  let options: MarketImportOptions;
  try {
    options = parseMarketImportArgs(args);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    throw error;
  }
  const since = new Date(Date.now() - options.hours * 60 * 60 * 1_000);
  const ethereumRpc = options.networks.includes("ethereum") ? new JsonRpcClient(marketRpcEndpoint("ethereum"), "Ethereum") : null;
  const solanaRpc = options.networks.includes("solana") ? new JsonRpcClient(marketRpcEndpoint("solana"), "Solana") : null;
  const markets = configuredSolanaMarkets();
  const plan: JsonObject = { event: "market-import-plan", since: since.toISOString(), networks: options.networks };
  if (ethereumRpc) {
    await verifyMarketRpcNetwork("ethereum", ethereumRpc);
    const head = hexNumber(await ethereumRpc.call("eth_blockNumber"), "eth_blockNumber");
    const endBlock = Math.max(1, head - options.ethereumConfirmations);
    const ethereumPlan: JsonObject = { chainId: 1, endBlock, pools: Object.keys(EVM_MARKET_POOLS).length, eventTopics: Object.keys(EVM_MARKET_TOPICS).length };
    if (options.plan) {
      const startBlock = await firstEvmBlockAtOrAfter(ethereumRpc, endBlock, Math.floor(since.getTime() / 1_000));
      Object.assign(ethereumPlan, { startBlock, blocks: endBlock - startBlock + 1 });
    }
    plan.ethereum = ethereumPlan;
  }
  if (solanaRpc) {
    await verifyMarketRpcNetwork("solana", solanaRpc);
    const slot = await solanaRpc.call("getSlot", [{ commitment: "finalized" }]);
    plan.solana = { slot, markets: Object.keys(markets).length };
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  if (options.plan) return;

  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri) throw new Error("MONGODB_URI is required for hosted market ingestion");
  const databaseName = process.env.GPTHEIST_MONGODB_DB?.trim() || "gptheist";
  const client = new MongoClient(mongoUri, { appName: "gptheist-market-import" });
  let interrupted = false;
  const interrupt = (): void => { interrupted = true; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await client.connect();
    const database = client.db(databaseName);
    await database.command({ ping: 1 });
    const transactions = database.collection<MarketTransaction>("market_transactions");
    await ensureIndexes(transactions);
    const evmCheckpoints = database.collection<EvmCheckpoint>("market_ingestion_checkpoints");
    const solanaCheckpoints = database.collection<SolanaCheckpoint>("market_ingestion_checkpoints");
    const importSolana = async (): Promise<void> => {
      if (!solanaRpc) return;
      await Promise.all(Object.entries(markets).map(async ([protocol, marketAddress]) => {
        if (!interrupted) await backfillSolanaProgram(solanaRpc, transactions, solanaCheckpoints, options, since, protocol, marketAddress);
      }));
    };
    await Promise.all([
      ethereumRpc ? importEthereum(ethereumRpc, transactions, evmCheckpoints, options, since) : Promise.resolve(),
      importSolana()
    ]);
    while (options.follow && !interrupted) {
      const followSolana = async (): Promise<void> => {
        if (!solanaRpc) return;
        await Promise.all(Object.entries(markets).map(async ([protocol, marketAddress]) => {
          if (!interrupted) await followSolanaProgram(solanaRpc, transactions, solanaCheckpoints, options, since, protocol, marketAddress);
        }));
      };
      await Promise.all([
        ethereumRpc ? importEthereum(ethereumRpc, transactions, evmCheckpoints, options, since, true) : Promise.resolve(),
        followSolana()
      ]);
      if (!interrupted) await delay(options.pollMs);
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await client.close();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runMarketImport(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "market import failed";
    process.stderr.write(`Market import failed: ${message}\n`);
    process.exitCode = 1;
  });
}
