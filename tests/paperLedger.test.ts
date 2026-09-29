import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, parseAbi, parseEther, type Hex } from "viem";
import { TOKEN_LAUNCHED_TOPIC, type RpcCaller } from "../src/live.js";
import { PONS_SELECTORS } from "../src/market.js";
import {
  FilePaperLedgerStore,
  createPaperLedger,
  paperBuy,
  paperReport,
  paperSellValue,
  runPaperCycle,
  stepPaperLedger,
  type PaperLedger,
  type PaperPolicy
} from "../src/paperLedger.js";

const token = "0x1111111111111111111111111111111111111111";
const curve = "0x2222222222222222222222222222222222222222";
const deployer = "0x3333333333333333333333333333333333333333";
const word = (value: string): string => value.replace(/^0x/, "").padStart(64, "0");
const uintWord = (value: bigint): string => value.toString(16).padStart(64, "0");
const multicallAbi = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"
]);
const tokenAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)"
]);
const curveAbi = parseAbi(["function feeBps() view returns (uint256)", "function sellableTokens() view returns (uint256)"]);
const feeSelector = encodeFunctionData({ abi: curveAbi, functionName: "feeBps" });
const sellableSelector = encodeFunctionData({ abi: curveAbi, functionName: "sellableTokens" });

const policy: PaperPolicy = {
  stakeWei: parseEther("0.001"),
  maxOpenPositions: 5,
  minScore: 70,
  takeProfitBps: 5_000,
  stopLossBps: 3_000,
  maxHoldMs: 24 * 60 * 60_000,
  gasUnitsPerTrade: 250_000n
};

interface Chain {
  quoteReserve: bigint;
  tokenReserve: bigint;
  phase: number;
  head: number;
}

function mockChain(chain: Chain): RpcCaller {
  const factoryRecord = (): string => `0x${[
    word(token), word(curve), word(deployer), word(deployer), word("0x0"),
    uintWord(parseEther("4.2")), word("0x0"), word("0xc8"), word("0x64"),
    word("0x0"), uintWord(BigInt(chain.phase)), word("0x0"), word("0x0"), word("0x0"), word("0x1")
  ].join("")}`;
  const answer = (callData: string): Hex => {
    const selector = callData.slice(0, 10);
    if (selector === PONS_SELECTORS.getLaunchedToken) return factoryRecord() as Hex;
    if (selector === PONS_SELECTORS.getReserves) return `0x${uintWord(chain.quoteReserve)}${uintWord(chain.tokenReserve)}`;
    if (selector === PONS_SELECTORS.realQuoteReserve) return `0x${uintWord(parseEther("2.1"))}`;
    if (selector === PONS_SELECTORS.currentSnipeTaxBps) return `0x${uintWord(0n)}`;
    if (selector === encodeFunctionData({ abi: tokenAbi, functionName: "name" })) return encodeFunctionResult({ abi: tokenAbi, functionName: "name", result: "Paper Cat" });
    if (selector === encodeFunctionData({ abi: tokenAbi, functionName: "symbol" })) return encodeFunctionResult({ abi: tokenAbi, functionName: "symbol", result: "PCAT" });
    return encodeFunctionResult({
      abi: tokenAbi,
      functionName: "getTokenInfo",
      result: [deployer, "", "", { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }]
    });
  };
  return async (method, params = []) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return `0x${chain.head.toString(16)}`;
    if (method === "eth_gasPrice") return "0x989680";
    if (method === "eth_getLogs") return [{
      address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
      blockNumber: "0x1000",
      transactionHash: `0x${"b".repeat(64)}`,
      logIndex: "0x0",
      topics: [TOKEN_LAUNCHED_TOPIC, `0x${word(token)}`, `0x${word(curve)}`, `0x${word(deployer)}`],
      data: `0x${word("0x0")}${word("0x0")}${uintWord(parseEther("4.2"))}`
    }];
    if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
    const request = params[0] as { to: string; data: string };
    if (request.data === feeSelector) return `0x${uintWord(100n)}`;
    if (request.data === sellableSelector) return `0x${uintWord(parseEther("800000000"))}`;
    const { args } = decodeFunctionData({ abi: multicallAbi, data: request.data as Hex });
    return encodeFunctionResult({
      abi: multicallAbi,
      functionName: "aggregate3",
      result: args[0].map((call) => ({ success: true, returnData: answer(call.callData) }))
    });
  };
}

function freshChain(): Chain {
  return { quoteReserve: parseEther("1.68"), tokenReserve: parseEther("970000000"), phase: 0, head: 0x2000 };
}

async function openOne(chain: Chain, at: Date): Promise<PaperLedger> {
  const ledger = await runPaperCycle(mockChain(chain), createPaperLedger(policy, at, chain.head), policy, at);
  assert.equal(ledger.positions.length, 1);
  return ledger;
}

test("curve round trip loses exactly the fees and price impact, never gains", () => {
  const quote = parseEther("1.68");
  const supply = parseEther("970000000");
  const { tokens, netIn } = paperBuy(policy.stakeWei, quote, supply, 100, 100, 0, supply);
  assert.equal(netIn, policy.stakeWei - policy.stakeWei / 50n);
  const back = paperSellValue(tokens, quote + netIn, supply - tokens, 100, 100);
  assert.ok(back < policy.stakeWei);
  assert.ok(back > (policy.stakeWei * 95n) / 100n);
});

test("opens a WATCH launch once at the live curve price, net of fees and gas", async () => {
  const chain = freshChain();
  const start = new Date("2026-09-29T18:00:00.000Z");
  const ledger = await openOne(chain, start);
  const position = ledger.positions[0]!;
  assert.equal(position.status, "OPEN");
  assert.equal(position.symbol, "PCAT");
  assert.equal(position.stakeWei, policy.stakeWei.toString());
  assert.equal(position.entryGasWei, (250_000n * 10_000_000n).toString());
  assert.ok(BigInt(position.markWei) < policy.stakeWei);

  const again = await runPaperCycle(mockChain(chain), ledger, policy, new Date(start.getTime() + 60_000));
  assert.equal(again.positions.length, 1);
  assert.equal(again.cycles, 2);
  const report = paperReport(again);
  assert.equal(report.open, 1);
  assert.ok(BigInt(report.unrealizedPnlWei) < 0n);
});

test("closes at take-profit when the curve price rises past the locked threshold", async () => {
  const chain = freshChain();
  const start = new Date("2026-09-29T18:00:00.000Z");
  const ledger = await openOne(chain, start);
  chain.quoteReserve *= 2n;
  chain.tokenReserve /= 2n;
  const next = await runPaperCycle(mockChain(chain), ledger, policy, new Date(start.getTime() + 60_000));
  const position = next.positions[0]!;
  assert.equal(position.status, "CLOSED");
  assert.equal(position.exitReason, "TAKE_PROFIT");
  const report = paperReport(next);
  assert.equal(report.wins, 1);
  assert.ok(BigInt(report.realizedPnlWei) > 0n);
});

test("closes at stop-loss when the curve price falls", async () => {
  const chain = freshChain();
  const start = new Date("2026-09-29T18:00:00.000Z");
  const ledger = await openOne(chain, start);
  chain.quoteReserve /= 2n;
  chain.tokenReserve *= 2n;
  const next = await runPaperCycle(mockChain(chain), ledger, policy, new Date(start.getTime() + 60_000));
  assert.equal(next.positions[0]?.exitReason, "STOP_LOSS");
  assert.equal(paperReport(next).losses, 1);
});

test("closes at the last curve mark when the launch leaves the curve, and at max hold", async () => {
  const start = new Date("2026-09-29T18:00:00.000Z");
  const graduating = freshChain();
  const ledger = await openOne(graduating, start);
  const mark = ledger.positions[0]!.markWei;
  graduating.phase = 2;
  const graduated = await runPaperCycle(mockChain(graduating), ledger, policy, new Date(start.getTime() + 60_000));
  assert.equal(graduated.positions[0]?.exitReason, "LEFT_CURVE");
  assert.equal(graduated.positions[0]?.exitWei, mark);
  assert.equal(graduated.positions[0]?.markStale, true);

  const holding = freshChain();
  const held = await runPaperCycle(mockChain(holding), await openOne(holding, start), policy, new Date(start.getTime() + policy.maxHoldMs));
  assert.equal(held.positions[0]?.exitReason, "MAX_HOLD");
});

test("persists the ledger and keeps the policy locked when the environment changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gptheist-paper-"));
  try {
    const store = new FilePaperLedgerStore(join(directory, "ledger.json"));
    const chain = freshChain();
    await stepPaperLedger(mockChain(chain), store, policy, new Date("2026-09-29T18:00:00.000Z"));
    const loosened = { ...policy, stopLossBps: 9_000, stakeWei: parseEther("1") };
    const ledger = await stepPaperLedger(mockChain(chain), store, loosened, new Date("2026-09-29T18:01:00.000Z"));
    assert.equal(ledger.cycles, 2);
    assert.equal(ledger.policy.stopLossBps, 3_000);
    assert.equal(ledger.policy.stakeWei, policy.stakeWei.toString());
    assert.equal(ledger.positions.length, 1);
    assert.equal((await store.load())?.cycles, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("records RPC failures without losing the saved ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gptheist-paper-"));
  try {
    const store = new FilePaperLedgerStore(join(directory, "ledger.json"));
    await stepPaperLedger(mockChain(freshChain()), store, policy, new Date("2026-09-29T18:00:00.000Z"));
    const failing: RpcCaller = async (method) => {
      if (method === "eth_chainId") throw new Error("upstream timeout");
      return "0x0";
    };
    const ledger = await stepPaperLedger(failing, store, policy, new Date("2026-09-29T18:01:00.000Z"));
    assert.equal(ledger.lastError, "upstream timeout");
    assert.equal(ledger.positions.length, 1);
    assert.equal(ledger.cycles, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
