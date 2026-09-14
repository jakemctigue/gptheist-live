import { POOL_GRADUATED_TOPIC, PONS_FACTORY, TOKEN_LAUNCHED_TOPIC, decodeTokenLaunchedLog, type LiveLaunch, type RpcCaller, type RpcLog } from "./live.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_HISTORY_LOGS = 2_000;
const TOKEN_TOPIC_BATCH = 50;

export interface DeployerHistoryRequest {
  deployer: string;
  beforeBlock: number;
  beforeLogIndex: number;
  days?: number;
}

export interface DeployerHistory {
  source: "Robinhood Chain RPC";
  mode: "read-only";
  deployer: string;
  historyWindowDays: number;
  historyWindowBlocks: number;
  fromBlock: number;
  toBlock: number;
  fromTimestamp: string;
  fetchedAt: string;
  priorLaunches: number;
  priorGraduations: number;
}

export interface HistoryRange {
  historyWindowDays: number;
  fromBlock: number;
  toBlock: number;
  fromTimestamp: string;
}

function parseHexInteger(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`RPC returned an invalid ${label}`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`RPC returned an unsupported ${label}`);
  return parsed;
}

function addressTopic(address: string): string {
  if (!ADDRESS.test(address)) throw new Error("deployer must be a 20-byte address");
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function isRpcLog(value: unknown): value is RpcLog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const log = value as Record<string, unknown>;
  return typeof log.address === "string" && typeof log.blockNumber === "string" &&
    typeof log.transactionHash === "string" && typeof log.logIndex === "string" &&
    typeof log.data === "string" && Array.isArray(log.topics) && log.topics.every((topic) => typeof topic === "string");
}

async function blockTimestamp(rpc: RpcCaller, block: number): Promise<number> {
  const raw = await rpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("RPC returned an invalid block");
  return parseHexInteger((raw as Record<string, unknown>).timestamp, "block timestamp");
}

async function firstBlockAtOrAfter(rpc: RpcCaller, headBlock: number, targetTimestamp: number): Promise<number> {
  let low = 0;
  let high = headBlock;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await blockTimestamp(rpc, middle) < targetTimestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function fetchLogsAdaptive(
  rpc: RpcCaller,
  filter: Record<string, unknown>,
  fromBlock: number,
  toBlock: number,
  depth = 0
): Promise<RpcLog[]> {
  try {
    const raw = await rpc("eth_getLogs", [{ ...filter, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }]);
    if (!Array.isArray(raw)) throw new Error("RPC returned invalid logs");
    return raw.filter(isRpcLog);
  } catch (error: unknown) {
    if (fromBlock >= toBlock || depth >= 8) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    const left = await fetchLogsAdaptive(rpc, filter, fromBlock, middle, depth + 1);
    const right = await fetchLogsAdaptive(rpc, filter, middle + 1, toBlock, depth + 1);
    if (left.length + right.length > MAX_HISTORY_LOGS) throw new Error(`deployer history exceeds the ${MAX_HISTORY_LOGS} event safety cap`);
    return [...left, ...right];
  }
}

export async function resolveHistoryRange(rpc: RpcCaller, days = 30): Promise<HistoryRange> {
  if (!Number.isSafeInteger(days) || days < 1 || days > 31) throw new Error("days must be an integer from 1 to 31");
  const headHex = await rpc("eth_blockNumber");
  const headBlock = parseHexInteger(headHex, "head block");
  const headTimestamp = await blockTimestamp(rpc, headBlock);
  const targetTimestamp = headTimestamp - days * 24 * 60 * 60;
  const fromBlock = await firstBlockAtOrAfter(rpc, headBlock, targetTimestamp);
  const fromTimestamp = await blockTimestamp(rpc, fromBlock);
  return {
    historyWindowDays: days,
    fromBlock,
    toBlock: headBlock,
    fromTimestamp: new Date(fromTimestamp * 1_000).toISOString()
  };
}

export async function fetchDeployerHistory(rpc: RpcCaller, request: DeployerHistoryRequest, existingRange?: HistoryRange): Promise<DeployerHistory> {
  const deployer = request.deployer.toLowerCase();
  if (!ADDRESS.test(deployer)) throw new Error("deployer must be a 20-byte address");
  if (!Number.isSafeInteger(request.beforeBlock) || request.beforeBlock < 0) throw new Error("beforeBlock must be a non-negative integer");
  if (!Number.isSafeInteger(request.beforeLogIndex) || request.beforeLogIndex < 0) throw new Error("beforeLogIndex must be a non-negative integer");
  const days = request.days ?? 30;
  if (!Number.isSafeInteger(days) || days < 1 || days > 31) throw new Error("days must be an integer from 1 to 31");
  const range = existingRange?.historyWindowDays === days ? existingRange : await resolveHistoryRange(rpc, days);
  const fromBlock = range.fromBlock;
  const headBlock = range.toBlock;
  const historyLogs = await fetchLogsAdaptive(rpc, {
    address: PONS_FACTORY,
    topics: [TOKEN_LAUNCHED_TOPIC, null, null, addressTopic(deployer)]
  }, fromBlock, headBlock);
  if (historyLogs.length > MAX_HISTORY_LOGS) throw new Error(`deployer history exceeds the ${MAX_HISTORY_LOGS} event safety cap`);

  const launches = historyLogs.map(decodeTokenLaunchedLog).filter((launch): launch is LiveLaunch => launch !== null);
  const prior = launches.filter((launch) => launch.blockNumber < request.beforeBlock ||
    (launch.blockNumber === request.beforeBlock && launch.logIndex < request.beforeLogIndex));
  const tokenTopics = [...new Set(prior.map((launch) => addressTopic(launch.token)))];
  const graduationLogs: RpcLog[] = [];
  for (let offset = 0; offset < tokenTopics.length; offset += TOKEN_TOPIC_BATCH) {
    graduationLogs.push(...await fetchLogsAdaptive(rpc, {
      address: PONS_FACTORY,
      topics: [POOL_GRADUATED_TOPIC, tokenTopics.slice(offset, offset + TOKEN_TOPIC_BATCH)]
    }, fromBlock, headBlock));
  }
  const graduatedTokens = new Set(graduationLogs.flatMap((log) => {
    if (log.address.toLowerCase() !== PONS_FACTORY || log.topics[0]?.toLowerCase() !== POOL_GRADUATED_TOPIC || log.topics.length < 2) return [];
    return [log.topics[1]?.toLowerCase()];
  }).filter((topic): topic is string => typeof topic === "string"));

  return {
    source: "Robinhood Chain RPC",
    mode: "read-only",
    deployer,
    historyWindowDays: days,
    historyWindowBlocks: headBlock - fromBlock + 1,
    fromBlock,
    toBlock: headBlock,
    fromTimestamp: range.fromTimestamp,
    fetchedAt: new Date().toISOString(),
    priorLaunches: prior.length,
    priorGraduations: prior.filter((launch) => graduatedTokens.has(addressTopic(launch.token))).length
  };
}
