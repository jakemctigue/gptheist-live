import type { LiveLaunchDecision } from "./live.js";
import type { PonsMarketState } from "./market.js";
import type { TradePolicy } from "./trading.js";

export const PAPER_MODE = "paper-only" as const;
const MIN_PROGRESS_BPS = 100;
const MAX_PROGRESS_BPS = 2_500;
const MAX_POSITIONS = 3;
const RESERVE_FRACTION = 100n;

export interface PaperPosition {
  token: string;
  curve: string;
  symbol: string;
  side: "BUY";
  score: number;
  sizeWei: string;
  progressBps: number;
  creatorTaxBps: number;
  snipeTaxBps: number;
  reasons: string[];
  executed: false;
}

export interface PaperBook {
  mode: typeof PAPER_MODE;
  executed: false;
  chainId: number;
  headBlock: number;
  account: {
    kind: "alchemy-session" | "unconfigured";
    address: string | null;
  };
  rules: string[];
  positions: PaperPosition[];
  considered: number;
  skipped: number;
}

export function paperRules(): string[] {
  return [
    "WATCH verdict and score at or above the buy minimum",
    "Native ETH pair on an active curve",
    "Curve progress from 1.00% through 25.00%",
    "Creator tax plus current snipe tax within the total fee cap",
    "Positive real quote reserve",
    "Simulated size is the smaller of the absolute buy cap and 1% of real quote reserve",
    "At most three positions, highest score first",
    "No order is signed or submitted"
  ];
}

function verifiedMarket(market: PonsMarketState): market is Extract<PonsMarketState, { status: "VERIFIED" }> {
  return market.status === "VERIFIED";
}

function symbolFor(launch: LiveLaunchDecision): string {
  if (launch.metadata.status === "DECLARED" && launch.metadata.symbol.trim() !== "") return launch.metadata.symbol;
  return `${launch.token.slice(0, 6)}…${launch.token.slice(-4)}`;
}

function paperSize(realQuoteReserve: bigint, maxBuyWei: bigint): bigint {
  if (realQuoteReserve <= 0n || maxBuyWei <= 0n) return 0n;
  const reserveSlice = realQuoteReserve / RESERVE_FRACTION;
  return reserveSlice < maxBuyWei ? reserveSlice : maxBuyWei;
}

export function planPaperBook(
  launches: readonly LiveLaunchDecision[],
  policy: Pick<TradePolicy, "maxBuyWei" | "maxTotalFeeBps" | "minBuyScore">,
  accountAddress: string | null,
  context: { chainId: number; headBlock: number }
): PaperBook {
  const eligible: PaperPosition[] = [];
  for (const launch of launches) {
    if (launch.verdict !== "WATCH" || launch.pairLabel !== "ETH" || launch.assessment.score < policy.minBuyScore) continue;
    if (!verifiedMarket(launch.market) || launch.market.phase !== "CURVE") continue;
    if (launch.market.progressBps < MIN_PROGRESS_BPS || launch.market.progressBps > MAX_PROGRESS_BPS) continue;
    const totalFeeBps = launch.market.creatorTaxBps + launch.market.currentSnipeTaxBps;
    if (totalFeeBps > policy.maxTotalFeeBps) continue;
    const realQuoteReserve = BigInt(launch.market.realQuoteReserve);
    const sizeWei = paperSize(realQuoteReserve, policy.maxBuyWei);
    if (sizeWei <= 0n) continue;
    eligible.push({
      token: launch.token,
      curve: launch.curve,
      symbol: symbolFor(launch),
      side: "BUY",
      score: launch.assessment.score,
      sizeWei: sizeWei.toString(),
      progressBps: launch.market.progressBps,
      creatorTaxBps: launch.market.creatorTaxBps,
      snipeTaxBps: launch.market.currentSnipeTaxBps,
      reasons: [
        `Score ${launch.assessment.score}/100`,
        `Curve progress ${(launch.market.progressBps / 100).toFixed(2)}%`,
        `Combined tax ${totalFeeBps} bps`,
        "Paper size only; executed=false"
      ],
      executed: false
    });
  }
  eligible.sort((left, right) => right.score - left.score || right.progressBps - left.progressBps || left.token.localeCompare(right.token));
  const positions = eligible.slice(0, MAX_POSITIONS);
  return {
    mode: PAPER_MODE,
    executed: false,
    chainId: context.chainId,
    headBlock: context.headBlock,
    account: accountAddress
      ? { kind: "alchemy-session", address: accountAddress }
      : { kind: "unconfigured", address: null },
    rules: paperRules(),
    positions,
    considered: launches.length,
    skipped: launches.length - positions.length
  };
}
