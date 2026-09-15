import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, encodeFunctionResult, parseAbi, parseEther, parseUnits } from "viem";
import { PONS_FACTORY, type RpcCaller } from "../src/live.js";
import {
  preparePonsTrade,
  REQUIRED_TRADE_ACKNOWLEDGEMENT,
  TradeGateError,
  tradePolicyFromEnv,
  type TradePolicy
} from "../src/trading.js";

const token = "0x1111111111111111111111111111111111111111" as const;
const curve = "0x2222222222222222222222222222222222222222" as const;
const wallet = "0x3333333333333333333333333333333333333333" as const;
const zero = "0x0000000000000000000000000000000000000000" as const;

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)"
]);
const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)"
]);
const tokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);

const selector = (data: string): string => data.slice(0, 10);
const selectors = {
  launched: selector(encodeFunctionData({ abi: factoryAbi, functionName: "getLaunchedToken", args: [token] })),
  buy: selector(encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [1n, 1n, wallet] })),
  sell: selector(encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [1n, 1n, wallet] })),
  reserves: selector(encodeFunctionData({ abi: curveAbi, functionName: "getReserves" })),
  sellable: selector(encodeFunctionData({ abi: curveAbi, functionName: "sellableTokens" })),
  realQuote: selector(encodeFunctionData({ abi: curveAbi, functionName: "realQuoteReserve" })),
  fee: selector(encodeFunctionData({ abi: curveAbi, functionName: "feeBps" })),
  creatorTax: selector(encodeFunctionData({ abi: curveAbi, functionName: "creatorTaxBps" })),
  snipeTax: selector(encodeFunctionData({ abi: curveAbi, functionName: "currentSnipeTaxBps", args: [wallet] })),
  balance: selector(encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [wallet] })),
  decimals: selector(encodeFunctionData({ abi: tokenAbi, functionName: "decimals" }))
};

const policy: TradePolicy = {
  enabled: true,
  maxBuyWei: parseEther("0.05"),
  maxSlippageBps: 300,
  maxPriceImpactBps: 500,
  maxTotalFeeBps: 500,
  minBuyScore: 70,
  maxQuoteAgeBlocks: 300
};

function createRpc(options: { snipeTaxBps?: bigint; tokenBalance?: bigint; nativeBalance?: bigint } = {}): { rpc: RpcCaller; methods: string[] } {
  const methods: string[] = [];
  const snipeTaxBps = options.snipeTaxBps ?? 0n;
  const tokenBalance = options.tokenBalance ?? parseUnits("10000", 18);
  const nativeBalance = options.nativeBalance ?? parseEther("1");
  const rpc: RpcCaller = async (method, params = []) => {
    methods.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x1000";
    if (method === "eth_getBalance") return `0x${nativeBalance.toString(16)}`;
    if (method === "eth_estimateGas") return "0x30d40";
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method !== "eth_call") throw new Error(`unexpected method ${method}`);

    const request = params[0] as { to: string; data: string; from?: string };
    const callSelector = selector(request.data);
    if (request.from && (callSelector === selectors.buy || callSelector === selectors.sell)) return "0x";
    if (request.to.toLowerCase() === PONS_FACTORY && callSelector === selectors.launched) {
      return encodeFunctionResult({
        abi: factoryAbi,
        functionName: "getLaunchedToken",
        result: {
          token,
          curve,
          deployer: wallet,
          creatorFeeRecipient: wallet,
          pairToken: zero,
          graduationThreshold: parseEther("4.2"),
          poolFee: 0,
          tickSpacing: 60,
          creatorTaxBps: 100,
          buybackEnabled: false,
          phase: 0,
          sweptQuote: 0n,
          sweptTokens: 0n,
          sweptAt: 0n,
          exists: true
        }
      });
    }
    if (request.to.toLowerCase() === curve) {
      if (callSelector === selectors.reserves) return encodeFunctionResult({ abi: curveAbi, functionName: "getReserves", result: [parseEther("10"), parseUnits("1000000000", 18)] });
      if (callSelector === selectors.sellable) return encodeFunctionResult({ abi: curveAbi, functionName: "sellableTokens", result: parseUnits("500000000", 18) });
      if (callSelector === selectors.realQuote) return encodeFunctionResult({ abi: curveAbi, functionName: "realQuoteReserve", result: parseEther("2.1") });
      if (callSelector === selectors.fee) return encodeFunctionResult({ abi: curveAbi, functionName: "feeBps", result: 100n });
      if (callSelector === selectors.creatorTax) return encodeFunctionResult({ abi: curveAbi, functionName: "creatorTaxBps", result: 100n });
      if (callSelector === selectors.snipeTax) return encodeFunctionResult({ abi: curveAbi, functionName: "currentSnipeTaxBps", result: snipeTaxBps });
    }
    if (request.to.toLowerCase() === token) {
      if (callSelector === selectors.balance) return encodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", result: tokenBalance });
      if (callSelector === selectors.decimals) return encodeFunctionResult({ abi: tokenAbi, functionName: "decimals", result: 18 });
    }
    throw new Error(`unexpected eth_call ${request.to} ${callSelector}`);
  };
  return { rpc, methods };
}

test("trade policy is disabled by default and rejects malformed environment limits", () => {
  const defaults = tradePolicyFromEnv({});
  assert.equal(defaults.enabled, false);
  assert.throws(() => tradePolicyFromEnv({ LIVE_TRADING_ENABLED: "sometimes" }), /must be true or false/);
  assert.throws(() => tradePolicyFromEnv({ TRADE_MAX_SLIPPAGE_BPS: "50000" }), /must be from/);
});

test("disabled trading fails before any RPC or wallet operation", async () => {
  let calls = 0;
  await assert.rejects(
    preparePonsTrade(async () => { calls += 1; return null; }, {}, { ...policy, enabled: false }),
    (error: unknown) => error instanceof TradeGateError && error.code === "TRADING_DISABLED"
  );
  assert.equal(calls, 0);
});

test("prepares and simulates a capped native-ETH Pons buy without signing", async () => {
  const { rpc, methods } = createRpc();
  const prepared = await preparePonsTrade(rpc, {
    side: "BUY",
    token,
    curve,
    wallet,
    amount: "0.01",
    slippageBps: 100,
    acknowledgement: REQUIRED_TRADE_ACKNOWLEDGEMENT
  }, policy);

  assert.equal(prepared.status, "PREPARED");
  assert.equal(prepared.chainId, 4663);
  assert.equal(prepared.transaction.from, wallet);
  assert.equal(prepared.transaction.to, curve);
  assert.equal(prepared.transaction.value, "0x2386f26fc10000");
  assert.equal(prepared.amountIn, parseEther("0.01").toString());
  assert.equal(prepared.quoteBlock, 4096);
  assert.equal(prepared.expiresAfterBlock, 4396);
  assert.equal(prepared.gates.at(-1)?.id, "WALLET_APPROVAL");
  assert.equal(prepared.gates.every((gate) => gate.passed), true);
  assert.match(prepared.auditId, /^[0-9a-f]{24}$/);
  assert.equal(methods.includes("eth_estimateGas"), true);
  assert.equal(methods.includes("eth_gasPrice"), true);
});

test("allows buys above the former equity percentage cap and retains the absolute cap", async () => {
  const { rpc } = createRpc({ nativeBalance: parseEther("1") });
  const capPolicy = { ...policy, maxBuyWei: parseEther("1") };
  const request = {
    side: "BUY" as const,
    token,
    curve,
    wallet,
    slippageBps: 100,
    acknowledgement: REQUIRED_TRADE_ACKNOWLEDGEMENT
  };
  const prepared = await preparePonsTrade(rpc, { ...request, amount: "0.34" }, capPolicy);
  assert.equal(prepared.amountIn, parseEther("0.34").toString());
  await assert.rejects(
    preparePonsTrade(rpc, { ...request, amount: "1.000000000000000001" }, capPolicy),
    (error: unknown) => error instanceof TradeGateError && error.code === "BUY_CAP"
  );
});

test("blocks a buy when opening tax breaches the combined fee gate", async () => {
  const { rpc } = createRpc({ snipeTaxBps: 600n });
  await assert.rejects(
    preparePonsTrade(rpc, {
      side: "BUY",
      token,
      curve,
      wallet,
      amount: "0.01",
      slippageBps: 100,
      acknowledgement: REQUIRED_TRADE_ACKNOWLEDGEMENT
    }, policy),
    (error: unknown) => error instanceof TradeGateError && error.code === "FEE_LIMIT"
  );
});

test("allows selling the full token balance and blocks an overdraft", async () => {
  const { rpc } = createRpc({ tokenBalance: parseUnits("20", 18) });
  const prepared = await preparePonsTrade(rpc, {
    side: "SELL",
    token,
    curve,
    wallet,
    amount: "20",
    slippageBps: 100,
    acknowledgement: REQUIRED_TRADE_ACKNOWLEDGEMENT
  }, policy);
  assert.equal(prepared.side, "SELL");
  assert.equal(prepared.transaction.value, undefined);
  assert.equal(prepared.amountIn, parseUnits("20", 18).toString());

  await assert.rejects(
    preparePonsTrade(rpc, {
      side: "SELL",
      token,
      curve,
      wallet,
      amount: "21",
      slippageBps: 100,
      acknowledgement: REQUIRED_TRADE_ACKNOWLEDGEMENT
    }, policy),
    (error: unknown) => error instanceof TradeGateError && error.code === "TOKEN_BALANCE"
  );
});
