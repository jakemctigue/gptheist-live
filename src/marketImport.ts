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
const MAX_RETRIES = 6;
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

function apiKey(): string {
  const value = process.env.ALCHEMY_API_KEY?.trim();
  if (!value) throw new Error("Missing ALCHEMY_API_KEY");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(value)) throw new Error("ALCHEMY_API_KEY has an invalid format");
  return value;
}

function endpoint(network: MarketNetwork): string {
  const explicit = network === "ethereum" ? process.env.ETHEREUM_RPC_URL?.trim() : process.env.SOLANA_RPC_URL?.trim();
  if (explicit) {
    if (!/^https:\/\//i.test(explicit)) throw new Error(`${network.toUpperCase()}_RPC_URL must use HTTPS`);
    return explicit;
  }
  const key = apiKey();
  return network === "ethereum"
    ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
    : `https://solana-mainnet.g.alchemy.com/v2/${key}`;
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

class JsonRpcClient {
  #nextId = 1;
  constructor(readonly url: string, readonly label: string) {}

  async post(body: JsonObject | JsonObject[]): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "gptheist/1.2 market-import" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const payload = await response.json() as unknown;
        if (response.status === 429 || response.status >= 500) throw new Error(`retryable HTTP ${response.status}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return payload;
      } catch (error: unknown) {
        lastError = error;
        if (attempt === MAX_RETRIES - 1) break;
        await delay(Math.min(10_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250));
      } finally {
        clearTimeout(timer);
      }
    }
    const message = lastError instanceof Error ? lastError.message : "unknown RPC failure";
    throw new Error(`${this.label} RPC failed after retries: ${message.replace(this.url, "<rpc>")}`);
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const id = this.#nextId++;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const payload = await this.post({ jsonrpc: "2.0", id, method, params });
      if (!isObject(payload)) throw new Error(`${this.label} returned an invalid response for ${method}`);
      const envelope = payload as unknown as RpcEnvelope;
      if (!envelope.error) return envelope.result;
      const message = envelope.error.message ?? String(envelope.error.code ?? "error");
      if (!retryableRpcError(message) || attempt === MAX_RETRIES - 1) throw new Error(`${this.label} ${method}: ${message}`);
      await delay(Math.min(10_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250));
    }
    throw new Error(`${this.label} ${method}: retry budget exhausted`);
  }

  async batch(requests: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    if (requests.length === 0) return [];
    const bodies = requests.map((request) => ({ jsonrpc: "2.0", id: this.#nextId++, ...request }));
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const payload = await this.post(bodies);
      if (!Array.isArray(payload)) throw new Error(`${this.label} returned an invalid batch response`);
      const byId = new Map<number, RpcEnvelope>();
      for (const item of payload) if (isObject(item) && typeof item.id === "number") byId.set(item.id, item as unknown as RpcEnvelope);
      const ordered = bodies.map((body) => {
        const response = byId.get(body.id);
        if (!response) throw new Error(`${this.label} omitted batch response ${body.id}`);
        return { body, response };
      });
      const retryable = ordered.some(({ response }) => response.error && retryableRpcError(response.error.message ?? String(response.error.code ?? "error")));
      if (retryable && attempt < MAX_RETRIES - 1) {
        await delay(Math.min(10_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250));
        continue;
      }
      return ordered.map(({ body, response }) => {
        if (response.error) throw new Error(`${this.label} ${body.method}: ${response.error.message ?? "RPC error"}`);
        return response.result;
      });
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

async function evmLogs(rpc: JsonRpcClient, fromBlock: number, toBlock: number, depth = 0): Promise<EvmLog[]> {
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
    const canSplit = /block range|response size|too many results|more than \d+|query returned more|limit exceeded/.test(message);
    if (!canSplit || fromBlock >= toBlock || depth >= 24) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    return [...await evmLogs(rpc, fromBlock, middle, depth + 1), ...await evmLogs(rpc, middle + 1, toBlock, depth + 1)];
  }
}

async function evmBlock(rpc: JsonRpcClient, blockNumber: number, fullTransactions: boolean): Promise<EvmBlock> {
  const value = await rpc.call("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, fullTransactions]);
  if (!isObject(value) || !Array.isArray(value.transactions) || typeof value.hash !== "string" || typeof value.timestamp !== "string") {
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

async function storeEvmRange(
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
      if (!transaction || !isObject(receipt)) continue;
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

async function importEthereum(
  rpc: JsonRpcClient,
  transactions: Collection<MarketTransaction>,
  checkpoints: Collection<EvmCheckpoint>,
  options: MarketImportOptions,
  since: Date,
  followOnly = false
): Promise<{ nextBlock: number; stored: number }> {
  const chainId = hexNumber(await rpc.call("eth_chainId"), "eth_chainId");
  if (chainId !== 1) throw new Error(`Ethereum endpoint returned chain id ${chainId}`);
  const head = hexNumber(await rpc.call("eth_blockNumber"), "eth_blockNumber");
  const endBlock = Math.max(1, head - options.ethereumConfirmations);
  const checkpointId = "market:ethereum:eth-usd:v2";
  const checkpoint = await checkpoints.findOne({ _id: checkpointId });
  const effectiveSince = checkpoint?.since ?? since;
  const startByTime = await firstEvmBlockAtOrAfter(rpc, endBlock, Math.floor(effectiveSince.getTime() / 1_000));
  let nextBlock = Math.max(startByTime, checkpoint?.nextBlock ?? startByTime);
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
    "  ALCHEMY_API_KEY (required unless both RPC URLs are configured)",
    "  ETHEREUM_RPC_URL / SOLANA_RPC_URL (optional overrides)",
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
  const ethereumRpc = options.networks.includes("ethereum") ? new JsonRpcClient(endpoint("ethereum"), "Ethereum") : null;
  const solanaRpc = options.networks.includes("solana") ? new JsonRpcClient(endpoint("solana"), "Solana") : null;
  const markets = configuredSolanaMarkets();
  const plan: JsonObject = { event: "market-import-plan", since: since.toISOString(), networks: options.networks };
  if (ethereumRpc) {
    const chainId = hexNumber(await ethereumRpc.call("eth_chainId"), "eth_chainId");
    const head = hexNumber(await ethereumRpc.call("eth_blockNumber"), "eth_blockNumber");
    const endBlock = Math.max(1, head - options.ethereumConfirmations);
    const startBlock = await firstEvmBlockAtOrAfter(ethereumRpc, endBlock, Math.floor(since.getTime() / 1_000));
    plan.ethereum = { chainId, startBlock, endBlock, blocks: endBlock - startBlock + 1, pools: Object.keys(EVM_MARKET_POOLS).length, eventTopics: Object.keys(EVM_MARKET_TOPICS).length };
  }
  if (solanaRpc) {
    const slot = await solanaRpc.call("getSlot", [{ commitment: "finalized" }]);
    plan.solana = { slot, markets: Object.keys(markets).length };
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  if (options.plan) return;

  const mongoUri = process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";
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
