import { quotePaperBuy, quotePaperSell } from "./paperTrading.js";

const BPS = 10_000n;
const ETH_WEI = 10n ** 18n;

export interface ProfitabilityPosition {
  id: string;
  status: "OPEN" | "CLOSED";
  entryNotionalUsd: number;
  entryGasUsd: number;
  entryDebitUsd: number;
  lastMarkUsd: number;
  markStatus: "PENDING" | "AVAILABLE" | "UNAVAILABLE";
  exitProceedsUsd: number | null;
  realizedPnlUsd: number | null;
}

export interface ProfitabilitySnapshot {
  status: string;
  startingUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  entryCount: number;
  closedTradeCount: number;
  lastTickAt: string | null;
  lastError: string | null;
  positions: ProfitabilityPosition[];
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}

function dollarsToMicros(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error(`${name} exceeds the safe integer range`);
  return micros;
}

/** Audit returned rows separately from run totals: the hosted API may truncate rows. */
export function auditPaperProfitability(snapshot: ProfitabilitySnapshot, nowMs: number, maxTickAgeMs = 180_000) {
  nonnegativeInteger(nowMs, "nowMs");
  nonnegativeInteger(maxTickAgeMs, "maxTickAgeMs");
  nonnegativeInteger(snapshot.entryCount, "entryCount");
  nonnegativeInteger(snapshot.closedTradeCount, "closedTradeCount");
  if (snapshot.closedTradeCount > snapshot.entryCount) throw new Error("closed trades exceed entries");
  const starting = dollarsToMicros(snapshot.startingUsd, "startingUsd");
  if (starting <= 0) throw new Error("startingUsd must be positive");
  const equity = dollarsToMicros(snapshot.equityUsd, "equityUsd");
  const reportedRealized = dollarsToMicros(snapshot.realizedPnlUsd, "realizedPnlUsd");
  const ids = new Set<string>();
  let debit = 0, proceeds = 0, entryGas = 0, realized = 0, openMarks = 0, wins = 0, losses = 0, flat = 0, closed = 0;
  const warnings: string[] = [];
  for (const position of snapshot.positions) {
    if (ids.has(position.id)) throw new Error("duplicate position id");
    ids.add(position.id);
    if (position.status !== "OPEN" && position.status !== "CLOSED") throw new Error("invalid position status");
    const rowDebit = dollarsToMicros(position.entryDebitUsd, "entryDebitUsd");
    const rowNotional = dollarsToMicros(position.entryNotionalUsd, "entryNotionalUsd");
    const rowGas = dollarsToMicros(position.entryGasUsd, "entryGasUsd");
    if (rowDebit < 0 || rowNotional < 0 || rowGas < 0) throw new Error("entry values must be nonnegative");
    if (rowDebit !== rowNotional + rowGas) throw new Error("entry debit does not reconcile to notional plus gas");
    debit += rowDebit;
    entryGas += rowGas;
    if (position.status === "CLOSED") {
      if (position.exitProceedsUsd === null || position.realizedPnlUsd === null) throw new Error("closed position lacks proceeds or realized P&L");
      const rowProceeds = dollarsToMicros(position.exitProceedsUsd, "exitProceedsUsd");
      const rowPnl = dollarsToMicros(position.realizedPnlUsd, "realizedPnlUsd");
      if (rowProceeds < 0 || rowPnl !== rowProceeds - rowDebit) throw new Error("closed position does not reconcile");
      proceeds += rowProceeds;
      realized += rowPnl;
      closed += 1;
      if (rowPnl > 0) wins += 1;
      else if (rowPnl < 0) losses += 1;
      else flat += 1;
    } else {
      const mark = dollarsToMicros(position.lastMarkUsd, "lastMarkUsd");
      if (mark < 0) throw new Error("mark must be nonnegative");
      openMarks += mark;
      if (position.markStatus !== "AVAILABLE") warnings.push(`${position.id}: ${position.markStatus} valuation; equity is not a fresh liquidation estimate`);
    }
  }
  for (const amount of [debit, proceeds, entryGas, realized, openMarks]) {
    if (!Number.isSafeInteger(amount)) throw new Error("ledger aggregate exceeds the safe integer range");
  }
  if (snapshot.positions.length > snapshot.entryCount || closed > snapshot.closedTradeCount) throw new Error("returned ledger exceeds run totals");
  const completeLedger = snapshot.positions.length === snapshot.entryCount && closed === snapshot.closedTradeCount;
  if (!completeLedger) warnings.push("Returned positions are incomplete; do not equate row aggregates with full-run totals");
  const reconciled = completeLedger ? realized === reportedRealized : null;
  if (reconciled === false) warnings.push("Reported realized P&L differs from the complete ledger");
  const ledgerCash = starting - debit + proceeds;
  const ledgerEquity = ledgerCash + openMarks;
  if (!Number.isSafeInteger(ledgerCash) || !Number.isSafeInteger(ledgerEquity)) throw new Error("reconstructed equity exceeds the safe integer range");
  const equityReconciles = completeLedger ? ledgerEquity === equity : null;
  if (equityReconciles === false) warnings.push("Reported equity differs from the complete ledger and returned marks");
  const tickMs = snapshot.lastTickAt === null ? Number.NaN : Date.parse(snapshot.lastTickAt);
  const ageMs = Number.isFinite(tickMs) ? nowMs - tickMs : null;
  const attemptFresh = ageMs !== null && ageMs >= 0 && ageMs <= maxTickAgeMs;
  const health = snapshot.lastError !== null ? "ERROR" : !attemptFresh ? "STALE_OR_UNKNOWN" : "NO_REPORTED_ERROR";
  warnings.push("lastTickAt alone does not independently verify market-data freshness; timestamp semantics depend on worker version");
  return {
    mode: "paper-only" as const,
    health,
    completeLedger,
    realizedReconciles: reconciled,
    equityReconciles,
    startingUsdMicros: starting,
    reportedEquityUsdMicros: equity,
    reportedProfitUsdMicros: equity - starting,
    reportedReturnBps: Math.trunc((equity - starting) * 10_000 / starting),
    returnedLedger: { entries: ids.size, closed, wins, losses, flat, debitUsdMicros: debit, proceedsUsdMicros: proceeds, entryGasUsdMicros: entryGas, realizedPnlUsdMicros: realized, reconstructedCashUsdMicros: ledgerCash, reconstructedEquityUsdMicros: ledgerEquity },
    costAttribution: "Entry gas is measured; exit gas, taxes, slippage and market movement cannot be separated from this API" as const,
    warnings
  };
}

export interface EntryEconomicsInput {
  quoteReserveWei: string;
  tokenReserve: string;
  entryNotionalUsdMicros: number;
  ethUsdMicros: number;
  entryGasUsdMicros: number;
  exitGasUsdMicros: number;
  feeBps: number;
  slippageBps: number;
}

/** Exact baseline quote math, using the same reserves on both legs and integer flooring. */
export function analyzePaperEntryEconomics(input: EntryEconomicsInput) {
  for (const [name, value] of Object.entries({
    entryNotionalUsdMicros: input.entryNotionalUsdMicros,
    ethUsdMicros: input.ethUsdMicros,
    entryGasUsdMicros: input.entryGasUsdMicros,
    exitGasUsdMicros: input.exitGasUsdMicros
  })) nonnegativeInteger(value, name);
  if (input.entryNotionalUsdMicros === 0 || input.ethUsdMicros === 0) throw new Error("notional and ETH/USD must be positive");
  const grossWei = BigInt(input.entryNotionalUsdMicros) * ETH_WEI / BigInt(input.ethUsdMicros);
  const buy = quotePaperBuy(input.quoteReserveWei, input.tokenReserve, grossWei.toString(), input.feeBps, input.slippageBps);
  if (buy.modeledTokenOut === "0") throw new Error("modeled token amount rounds to zero");
  const exitAtReserve = (reserve: bigint): number => {
    const sell = quotePaperSell(reserve.toString(), input.tokenReserve, buy.modeledTokenOut, input.feeBps, input.slippageBps);
    const grossMicros = BigInt(sell.modeledQuoteOutWei) * BigInt(input.ethUsdMicros) / ETH_WEI;
    const net = grossMicros - BigInt(input.exitGasUsdMicros);
    if (net > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("modeled proceeds exceed safe integer range");
    return Number(net > 0n ? net : 0n);
  };
  const debit = input.entryNotionalUsdMicros + input.entryGasUsdMicros;
  if (!Number.isSafeInteger(debit)) throw new Error("entry debit exceeds safe integer range");
  const reserve = BigInt(input.quoteReserveWei);
  const immediateProceeds = exitAtReserve(reserve);
  let low = reserve, high = reserve;
  while (exitAtReserve(high) < debit) high *= 2n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (exitAtReserve(middle) >= debit) high = middle;
    else low = middle + 1n;
  }
  const hurdleBps = ((high - reserve) * BPS + reserve - 1n) / reserve;
  if (hurdleBps > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("break-even growth exceeds safe integer range");
  return {
    entryDebitUsdMicros: debit,
    immediateProceedsUsdMicros: immediateProceeds,
    immediateLossUsdMicros: debit - immediateProceeds,
    immediateLossBps: Math.ceil((debit - immediateProceeds) * 10_000 / debit),
    buyPriceImpactBps: buy.priceImpactBps,
    breakEvenQuoteReserveWei: high.toString(),
    breakEvenQuoteReserveGrowthBps: Number(hurdleBps),
    assumptions: "Token reserve, ETH/USD, fees and gas fixed; quote reserve alone grows. This is a cost hurdle, not a return forecast." as const
  };
}

export interface ReserveObservation {
  observedAtMs: number;
  quoteReserveWei: string;
  tokenReserve: string;
}

/** Separate candidate research gate; never used to rewrite the fixed month baseline. */
export function evaluatePaperCandidate(
  economics: ReturnType<typeof analyzePaperEntryEconomics>,
  observations: ReserveObservation[],
  asOfMs: number,
  policy: { maxImmediateLossBps: number; lookbackMs: number; maxObservationAgeMs: number; minimumSpanMs: number; minimumMomentumBps: number }
) {
  for (const [name, value] of Object.entries({ asOfMs, ...policy })) nonnegativeInteger(value, name);
  const reasons: string[] = [];
  if (economics.immediateLossBps > policy.maxImmediateLossBps) reasons.push("Round-trip cost exceeds the permitted loss budget");
  const usable = observations.filter((row) => row.observedAtMs <= asOfMs && row.observedAtMs >= asOfMs - policy.lookbackMs)
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  const first = usable[0], last = usable[usable.length - 1];
  let momentumBps: number | null = null;
  if (new Set(usable.map((row) => row.observedAtMs)).size < 3 || !first || !last || last.observedAtMs - first.observedAtMs < policy.minimumSpanMs) {
    reasons.push("Insufficient fresh pre-decision reserve observations");
  } else {
    if (asOfMs - last.observedAtMs > policy.maxObservationAgeMs) reasons.push("Latest reserve observation is stale");
    for (const observation of usable) {
      if (!/^[1-9][0-9]*$/.test(observation.quoteReserveWei) || !/^[1-9][0-9]*$/.test(observation.tokenReserve)) throw new Error("reserves must be positive decimal integers");
      nonnegativeInteger(observation.observedAtMs, "observedAtMs");
    }
    const numerator = BigInt(last.quoteReserveWei) * BigInt(first.tokenReserve);
    const denominator = BigInt(first.quoteReserveWei) * BigInt(last.tokenReserve);
    const momentum = (numerator - denominator) * BPS / denominator;
    if (momentum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("momentum exceeds safe integer range");
    momentumBps = Number(momentum);
    if (momentumBps < policy.minimumMomentumBps) reasons.push("Observed momentum is below the research threshold");
  }
  return { candidateVersion: "pons-cost-momentum-research-v1", eligibleForSeparatePaperStudy: reasons.length === 0, momentumBps, reasons };
}
