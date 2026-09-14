import { createHash } from "node:crypto";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex
} from "viem";
import { PONS_FACTORY, ROBINHOOD_CHAIN_ID, type RpcCaller } from "./live.js";
import { assessPonsLaunch } from "./market.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BPS = 10_000n;
const TRADE_ACKNOWLEDGEMENT = "I UNDERSTAND THIS SUBMITS A REAL TRADE";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_AMOUNT = /^(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,36})?$/;

const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)"
]);
const CURVE_ABI = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)"
]);
const TOKEN_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);

export interface TradePolicy {
  enabled: boolean;
  maxBuyWei: bigint;
  maxBuyWalletBps: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxTotalFeeBps: number;
  minBuyScore: number;
  maxQuoteAgeBlocks: number;
}

export interface PublicTradePolicy {
  enabled: boolean;
  chainId: typeof ROBINHOOD_CHAIN_ID;
  venue: "Pons v2 curve";
  supportedSides: ["BUY", "SELL"];
  supportedPair: "native ETH";
  maxBuyWei: string;
  maxBuyWalletBps: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxTotalFeeBps: number;
  minBuyScore: number;
  maxQuoteAgeBlocks: number;
  signing: "browser wallet only";
}

export interface TradeRequest {
  side?: unknown;
  token?: unknown;
  curve?: unknown;
  wallet?: unknown;
  amount?: unknown;
  slippageBps?: unknown;
  acknowledgement?: unknown;
}

export interface TradeGateResult {
  id: string;
  passed: true;
  detail: string;
}

export interface PreparedTrade {
  status: "PREPARED";
  auditId: string;
  preparedAt: string;
  chainId: typeof ROBINHOOD_CHAIN_ID;
  venue: "Pons v2 curve";
  side: "BUY" | "SELL";
  token: string;
  curve: string;
  wallet: string;
  amountIn: string;
  amountInDecimals: number;
  expectedOut: string;
  minOut: string;
  outputDecimals: number;
  feeBps: number;
  creatorTaxBps: number;
  snipeTaxBps: number;
  totalFeeBps: number;
  priceImpactBps: number;
  quoteBlock: number;
  expiresAfterBlock: number;
  estimatedGas: string;
  estimatedGasCostWei: string;
  gates: TradeGateResult[];
  transaction: {
    from: string;
    to: string;
    data: string;
    value?: string;
  };
}

export class TradeGateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "TradeGateError";
    this.code = code;
    this.status = status;
  }
}

function parseIntegerSetting(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseBigIntSetting(name: string, value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]{0,77}$/.test(value)) throw new Error(`${name} must be a positive base-unit integer`);
  return BigInt(value);
}

export function tradePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): TradePolicy {
  const enabledText = (env.LIVE_TRADING_ENABLED ?? "false").trim().toLowerCase();
  if (enabledText !== "true" && enabledText !== "false") throw new Error("LIVE_TRADING_ENABLED must be true or false");
  return {
    enabled: enabledText === "true",
    maxBuyWei: parseBigIntSetting("TRADE_MAX_BUY_WEI", env.TRADE_MAX_BUY_WEI, 50_000_000_000_000_000n),
    maxBuyWalletBps: parseIntegerSetting("TRADE_MAX_BUY_WALLET_BPS", env.TRADE_MAX_BUY_WALLET_BPS, 1_000, 1, 10_000),
    maxSlippageBps: parseIntegerSetting("TRADE_MAX_SLIPPAGE_BPS", env.TRADE_MAX_SLIPPAGE_BPS, 300, 1, 2_000),
    maxPriceImpactBps: parseIntegerSetting("TRADE_MAX_PRICE_IMPACT_BPS", env.TRADE_MAX_PRICE_IMPACT_BPS, 500, 1, 5_000),
    maxTotalFeeBps: parseIntegerSetting("TRADE_MAX_TOTAL_FEE_BPS", env.TRADE_MAX_TOTAL_FEE_BPS, 500, 1, 5_000),
    minBuyScore: parseIntegerSetting("TRADE_MIN_BUY_SCORE", env.TRADE_MIN_BUY_SCORE, 70, 1, 100),
    maxQuoteAgeBlocks: parseIntegerSetting("TRADE_MAX_QUOTE_AGE_BLOCKS", env.TRADE_MAX_QUOTE_AGE_BLOCKS, 300, 10, 10_000)
  };
}

export function publicTradePolicy(policy: TradePolicy): PublicTradePolicy {
  return {
    enabled: policy.enabled,
    chainId: ROBINHOOD_CHAIN_ID,
    venue: "Pons v2 curve",
    supportedSides: ["BUY", "SELL"],
    supportedPair: "native ETH",
    maxBuyWei: policy.maxBuyWei.toString(),
    maxBuyWalletBps: policy.maxBuyWalletBps,
    maxSlippageBps: policy.maxSlippageBps,
    maxPriceImpactBps: policy.maxPriceImpactBps,
    maxTotalFeeBps: policy.maxTotalFeeBps,
    minBuyScore: policy.minBuyScore,
    maxQuoteAgeBlocks: policy.maxQuoteAgeBlocks,
    signing: "browser wallet only"
  };
}

function normalizedAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TradeGateError("INVALID_ADDRESS", `${label} must be a 20-byte address`, 400);
  return value.toLowerCase() as Address;
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new TradeGateError("INVALID_RPC", `RPC returned an invalid ${label}`, 502);
  return BigInt(value);
}

function parseUnits(value: unknown, decimals: number): bigint {
  if (typeof value !== "string" || !DECIMAL_AMOUNT.test(value)) {
    throw new TradeGateError("INVALID_AMOUNT", "amount must be a positive decimal without exponent notation", 400);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new TradeGateError("INVALID_AMOUNT", `amount has more than ${decimals} decimal places`, 400);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction || "0").padEnd(decimals, "0"));
  if (units <= 0n) throw new TradeGateError("INVALID_AMOUNT", "amount must be greater than zero", 400);
  return units;
}

function rpcHex(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function priceImpactBps(spotOut: bigint, quotedOut: bigint): number {
  if (spotOut <= 0n || quotedOut >= spotOut) return 0;
  const value = ((spotOut - quotedOut) * BPS) / spotOut;
  return Number(value > BPS ? BPS : value);
}

function minAfterSlippage(value: bigint, slippageBps: number): bigint {
  const minimum = (value * (BPS - BigInt(slippageBps))) / BPS;
  if (minimum <= 0n) throw new TradeGateError("MIN_OUTPUT_ZERO", "trade is too small after slippage protection");
  return minimum;
}

async function callContract(rpc: RpcCaller, to: Address, data: Hex, blockTag: Hex): Promise<Hex> {
  const raw = await rpc("eth_call", [{ to, data }, blockTag]);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new TradeGateError("INVALID_RPC", "RPC returned malformed contract data", 502);
  return raw as Hex;
}

export async function preparePonsTrade(rpc: RpcCaller, input: TradeRequest, policy: TradePolicy): Promise<PreparedTrade> {
  if (!policy.enabled) throw new TradeGateError("TRADING_DISABLED", "Live trading is disabled by server policy", 403);
  if (input.acknowledgement !== TRADE_ACKNOWLEDGEMENT) {
    throw new TradeGateError("ACKNOWLEDGEMENT_REQUIRED", `acknowledgement must equal: ${TRADE_ACKNOWLEDGEMENT}`, 400);
  }
  if (input.side !== "BUY" && input.side !== "SELL") throw new TradeGateError("INVALID_SIDE", "side must be BUY or SELL", 400);
  if (!Number.isSafeInteger(input.slippageBps) || Number(input.slippageBps) < 1 || Number(input.slippageBps) > policy.maxSlippageBps) {
    throw new TradeGateError("SLIPPAGE_LIMIT", `slippageBps must be from 1 to ${policy.maxSlippageBps}`, 400);
  }
  const side = input.side;
  const slippageBps = Number(input.slippageBps);
  const token = normalizedAddress(input.token, "token");
  const requestedCurve = normalizedAddress(input.curve, "curve");
  const wallet = normalizedAddress(input.wallet, "wallet");
  const gates: TradeGateResult[] = [
    { id: "SERVER_ENABLED", passed: true, detail: "Live trading is enabled by server policy" },
    { id: "HUMAN_ACKNOWLEDGED", passed: true, detail: "The irreversible-trade acknowledgement matched" }
  ];

  const chainHex = await rpc("eth_chainId");
  if (typeof chainHex !== "string" || quantity(chainHex, "chain id") !== BigInt(ROBINHOOD_CHAIN_ID)) {
    throw new TradeGateError("CHAIN_MISMATCH", `RPC must report Robinhood Chain ${ROBINHOOD_CHAIN_ID}`, 502);
  }
  gates.push({ id: "CHAIN_ALLOWLIST", passed: true, detail: `RPC and transaction are pinned to chain ${ROBINHOOD_CHAIN_ID}` });

  const headHexRaw = await rpc("eth_blockNumber");
  const head = quantity(headHexRaw, "head block");
  if (head > BigInt(Number.MAX_SAFE_INTEGER)) throw new TradeGateError("INVALID_RPC", "head block exceeds the supported integer range", 502);
  const blockTag = rpcHex(head);

  const launchData = encodeFunctionData({ abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] });
  const launchRaw = await callContract(rpc, PONS_FACTORY as Address, launchData, blockTag);
  const launch = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getLaunchedToken", data: launchRaw });
  const canonicalCurve = launch.curve.toLowerCase() as Address;
  if (!launch.exists || launch.token.toLowerCase() !== token || canonicalCurve !== requestedCurve) {
    throw new TradeGateError("FACTORY_PROVENANCE", "token and curve do not match an active Pons v2 factory record");
  }
  if (launch.pairToken.toLowerCase() !== ZERO_ADDRESS) {
    throw new TradeGateError("PAIR_NOT_ALLOWED", "execution currently allows native-ETH Pons curves only");
  }
  if (launch.phase !== 0) throw new TradeGateError("CURVE_CLOSED", "this launch is no longer trading on its Pons curve");
  gates.push(
    { id: "FACTORY_ALLOWLIST", passed: true, detail: "Token and curve match the configured Pons v2 factory" },
    { id: "PAIR_ALLOWLIST", passed: true, detail: "The launch uses native ETH as its quote asset" },
    { id: "VENUE_PHASE", passed: true, detail: "The factory reports the launch in active curve phase" }
  );

  const reservesRaw = await callContract(rpc, canonicalCurve, encodeFunctionData({ abi: CURVE_ABI, functionName: "getReserves" }), blockTag);
  const [quoteReserve, tokenReserve] = decodeFunctionResult({ abi: CURVE_ABI, functionName: "getReserves", data: reservesRaw });
  if (quoteReserve <= 0n || tokenReserve <= 0n) throw new TradeGateError("EMPTY_RESERVES", "curve reserves are empty or invalid");
  const feeBps = Number(decodeFunctionResult({
    abi: CURVE_ABI,
    functionName: "feeBps",
    data: await callContract(rpc, canonicalCurve, encodeFunctionData({ abi: CURVE_ABI, functionName: "feeBps" }), blockTag)
  }));
  const creatorTaxBps = Number(decodeFunctionResult({
    abi: CURVE_ABI,
    functionName: "creatorTaxBps",
    data: await callContract(rpc, canonicalCurve, encodeFunctionData({ abi: CURVE_ABI, functionName: "creatorTaxBps" }), blockTag)
  }));
  const snipeTaxBps = side === "BUY" ? Number(decodeFunctionResult({
    abi: CURVE_ABI,
    functionName: "currentSnipeTaxBps",
    data: await callContract(rpc, canonicalCurve, encodeFunctionData({ abi: CURVE_ABI, functionName: "currentSnipeTaxBps", args: [wallet] }), blockTag)
  })) : 0;
  const totalFeeBps = feeBps + creatorTaxBps + snipeTaxBps;
  if (![feeBps, creatorTaxBps, snipeTaxBps].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000) || totalFeeBps >= 10_000) {
    throw new TradeGateError("INVALID_FEES", "curve fee values are outside protocol bounds", 502);
  }
  if (totalFeeBps > policy.maxTotalFeeBps) {
    throw new TradeGateError("FEE_LIMIT", `combined fee and tax ${totalFeeBps} bps exceeds the ${policy.maxTotalFeeBps} bps gate`);
  }
  gates.push({ id: "FEE_LIMIT", passed: true, detail: `Combined fee and applicable tax are ${totalFeeBps} bps` });

  const realQuoteReserve = decodeFunctionResult({
    abi: CURVE_ABI,
    functionName: "realQuoteReserve",
    data: await callContract(rpc, canonicalCurve, encodeFunctionData({ abi: CURVE_ABI, functionName: "realQuoteReserve" }), blockTag)
  });
  if (side === "BUY") {
    const progress = launch.graduationThreshold === 0n ? 0n : (realQuoteReserve * BPS) / launch.graduationThreshold;
    const assessment = assessPonsLaunch("ETH", {
      status: "VERIFIED",
      creatorFeeRecipient: launch.creatorFeeRecipient.toLowerCase(),
      creatorTaxBps,
      buybackEnabled: launch.buybackEnabled,
      phase: "CURVE",
      quoteReserve: quoteReserve.toString(),
      tokenReserve: tokenReserve.toString(),
      realQuoteReserve: realQuoteReserve.toString(),
      graduationThreshold: launch.graduationThreshold.toString(),
      progressBps: Number(progress > BPS ? BPS : progress),
      currentSnipeTaxBps: snipeTaxBps
    });
    if (assessment.verdict !== "WATCH" || assessment.score < policy.minBuyScore) {
      throw new TradeGateError("WATCH_GATE", `buy requires a WATCH assessment at or above ${policy.minBuyScore}/100`);
    }
    gates.push({ id: "WATCH_GATE", passed: true, detail: `Current on-chain assessment is WATCH at ${assessment.score}/100` });
  }

  const tokenDecimals = Number(decodeFunctionResult({
    abi: TOKEN_ABI,
    functionName: "decimals",
    data: await callContract(rpc, token, encodeFunctionData({ abi: TOKEN_ABI, functionName: "decimals" }), blockTag)
  }));
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new TradeGateError("TOKEN_DECIMALS", "token decimals are outside the supported range");
  }

  const inputDecimals = side === "BUY" ? 18 : tokenDecimals;
  const outputDecimals = side === "BUY" ? tokenDecimals : 18;
  const amountIn = parseUnits(input.amount, inputDecimals);
  let expectedOut: bigint;
  let impact: number;
  let transactionData: Hex;
  let transactionValue: Hex | undefined;

  if (side === "BUY") {
    if (amountIn > policy.maxBuyWei) throw new TradeGateError("BUY_CAP", `buy exceeds the ${policy.maxBuyWei.toString()} wei per-trade cap`);
    const balance = quantity(await rpc("eth_getBalance", [wallet, blockTag]), "wallet balance");
    if (amountIn * BPS > balance * BigInt(policy.maxBuyWalletBps)) {
      throw new TradeGateError("POSITION_CAP", `buy exceeds ${policy.maxBuyWalletBps} bps of the wallet's current ETH balance`);
    }
    const sellable = decodeFunctionResult({
      abi: CURVE_ABI,
      functionName: "sellableTokens",
      data: await callContract(rpc, canonicalCurve, encodeFunctionData({ abi: CURVE_ABI, functionName: "sellableTokens" }), blockTag)
    });
    if (sellable <= 0n) throw new TradeGateError("CURVE_CLOSED", "the curve has no sellable tokens remaining");
    const fee = (amountIn * BigInt(feeBps)) / BPS;
    const creatorTax = (amountIn * BigInt(creatorTaxBps)) / BPS;
    const snipeTax = (amountIn * BigInt(snipeTaxBps)) / BPS;
    const netIn = amountIn - fee - creatorTax - snipeTax;
    expectedOut = (netIn * tokenReserve) / (quoteReserve + netIn);
    if (expectedOut > sellable) expectedOut = sellable;
    const minimumOut = minAfterSlippage(expectedOut, slippageBps);
    const spotOut = (netIn * tokenReserve) / quoteReserve;
    impact = priceImpactBps(spotOut, expectedOut);
    if (impact > policy.maxPriceImpactBps) throw new TradeGateError("PRICE_IMPACT", `estimated price impact ${impact} bps exceeds the ${policy.maxPriceImpactBps} bps gate`);
    transactionData = encodeFunctionData({ abi: CURVE_ABI, functionName: "buy", args: [amountIn, minimumOut, wallet] });
    transactionValue = rpcHex(amountIn);
  } else {
    const balance = decodeFunctionResult({
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      data: await callContract(rpc, token, encodeFunctionData({ abi: TOKEN_ABI, functionName: "balanceOf", args: [wallet] }), blockTag)
    });
    if (amountIn > balance) throw new TradeGateError("TOKEN_BALANCE", "sell amount exceeds the wallet's token balance");
    const grossOut = (amountIn * quoteReserve) / (tokenReserve + amountIn);
    expectedOut = grossOut - (grossOut * BigInt(feeBps)) / BPS - (grossOut * BigInt(creatorTaxBps)) / BPS;
    const minimumOut = minAfterSlippage(expectedOut, slippageBps);
    const spotOut = (amountIn * quoteReserve) / tokenReserve;
    impact = priceImpactBps(spotOut, grossOut);
    if (impact > policy.maxPriceImpactBps) throw new TradeGateError("PRICE_IMPACT", `estimated price impact ${impact} bps exceeds the ${policy.maxPriceImpactBps} bps gate`);
    transactionData = encodeFunctionData({ abi: CURVE_ABI, functionName: "sell", args: [amountIn, minimumOut, wallet] });
  }

  const minimumOut = minAfterSlippage(expectedOut, slippageBps);
  gates.push(
    { id: "AMOUNT_CAP", passed: true, detail: side === "BUY" ? "Buy amount is within absolute and wallet-relative caps" : "Sell amount is within the wallet token balance" },
    { id: "SLIPPAGE_LIMIT", passed: true, detail: `Minimum output enforces ${slippageBps} bps slippage` },
    { id: "PRICE_IMPACT", passed: true, detail: `Estimated price impact is within ${policy.maxPriceImpactBps} bps` }
  );

  const transaction: { from: Address; to: Address; data: Hex; value?: Hex } = {
    from: wallet,
    to: canonicalCurve,
    data: transactionData
  };
  if (transactionValue !== undefined) transaction.value = transactionValue;
  await rpc("eth_call", [transaction, blockTag]);
  const estimatedGas = quantity(await rpc("eth_estimateGas", [transaction]), "gas estimate");
  const gasPrice = quantity(await rpc("eth_gasPrice"), "gas price");
  const estimatedGasCost = (estimatedGas * gasPrice * 120n) / 100n;
  const nativeBalance = quantity(await rpc("eth_getBalance", [wallet, blockTag]), "wallet balance");
  const requiredNative = estimatedGasCost + (transactionValue === undefined ? 0n : amountIn);
  if (nativeBalance < requiredNative) throw new TradeGateError("GAS_BALANCE", "wallet lacks enough native ETH for the trade and buffered gas");
  gates.push(
    { id: "SIMULATION", passed: true, detail: "Pinned-block eth_call completed without a contract revert" },
    { id: "GAS_BALANCE", passed: true, detail: "Wallet balance covers trade value and a 20% gas-cost buffer" },
    { id: "WALLET_APPROVAL", passed: true, detail: "The browser wallet must still display and approve the transaction" }
  );

  const preparedAt = new Date().toISOString();
  const quoteBlock = Number(head);
  const auditPayload = {
    preparedAt,
    chainId: ROBINHOOD_CHAIN_ID,
    side,
    token,
    curve: canonicalCurve,
    wallet,
    amountIn: amountIn.toString(),
    expectedOut: expectedOut.toString(),
    minOut: minimumOut.toString(),
    quoteBlock
  };
  const auditId = createHash("sha256").update(JSON.stringify(auditPayload)).digest("hex").slice(0, 24);
  return {
    status: "PREPARED",
    auditId,
    preparedAt,
    chainId: ROBINHOOD_CHAIN_ID,
    venue: "Pons v2 curve",
    side,
    token,
    curve: canonicalCurve,
    wallet,
    amountIn: amountIn.toString(),
    amountInDecimals: inputDecimals,
    expectedOut: expectedOut.toString(),
    minOut: minimumOut.toString(),
    outputDecimals,
    feeBps,
    creatorTaxBps,
    snipeTaxBps,
    totalFeeBps,
    priceImpactBps: impact,
    quoteBlock,
    expiresAfterBlock: quoteBlock + policy.maxQuoteAgeBlocks,
    estimatedGas: estimatedGas.toString(),
    estimatedGasCostWei: estimatedGasCost.toString(),
    gates,
    transaction
  };
}

export const REQUIRED_TRADE_ACKNOWLEDGEMENT = TRADE_ACKNOWLEDGEMENT;
