import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface ResearchPolicy {
  readonly version: "sol-daily-breakout-v1";
  readonly initialUsdMicros: number;
  readonly slippageStressBps: number;
  readonly fixedCostPerLegUsdMicros: number;
  readonly dailyOverheadUsdMicros: number | null;
  readonly quoteMaxAgeMs: number;
  readonly candleLagMs: number;
  readonly minimumDailyBars: number;
  readonly emaPeriod: number;
  readonly emaRiseDays: number;
  readonly breakoutDays: number;
  readonly atrDays: number;
  readonly exitLowDays: number;
  readonly maxHoldingDays: number;
  readonly riskBudgetBps: number;
  readonly maxEquityAllocationBps: number;
  readonly stopAtrMultiple: number;
}

export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly observedAt: string;
}

export interface CandleNormalizationResult {
  readonly candles: readonly Candle[];
  readonly errors: readonly string[];
  readonly revisions: readonly string[];
}

export interface DailySignal {
  readonly asOfTime: number | null;
  readonly entry: boolean;
  readonly exit: boolean;
  readonly reason: string | null;
  readonly close: number | null;
  readonly ema100: number | null;
  readonly ema100FiveDaysAgo: number | null;
  readonly priorTwentyHigh: number | null;
  readonly priorTenLow: number | null;
  readonly atr14: number | null;
  readonly stopPrice: number | null;
  readonly stopFraction: number | null;
}

export interface PaperPosition {
  readonly solLamports: string;
  readonly entryDebitMicros: number;
  readonly openedAt: string;
  readonly stopPrice: number;
  readonly tradeId: string;
}

export interface PaperLedger {
  readonly cashUsdMicros: number;
  readonly position: PaperPosition | null;
  readonly realizedPnlMicros: number;
  readonly enteredTrades: number;
  readonly closedTrades: number;
}

export interface PaperEntryQuote {
  readonly inputUsdMicros: number;
  readonly netOutputSolLamports: string;
  readonly observedAt: string;
  readonly requestedAt?: string;
  readonly expiresAt?: string | null;
  readonly router?: string;
  readonly configured?: boolean;
  /** A measured, converted external fee; null means it is unknown. */
  readonly externalFeeUsdMicros?: number | null;
}

export interface PaperExitQuote {
  readonly netOutputUsdMicros: number;
  readonly observedAt: string;
  readonly requestedAt?: string;
  readonly expiresAt?: string | null;
  readonly router?: string;
  readonly configured?: boolean;
  readonly externalFeeUsdMicros?: number | null;
}

export interface PaperDecision {
  readonly accepted: boolean;
  readonly reason: string | null;
  readonly debitMicros: number;
  readonly solLamports: string | null;
  readonly stopPrice: number | null;
  readonly tradeId: string | null;
}

export interface CostView {
  readonly routeCostsKnown: boolean;
  readonly fixedCostPerLegUsdMicros: number;
  readonly dailyOverheadUsdMicros: number | null;
  readonly slippageStressBps: number;
  readonly stressedRoundTripCostUsdMicros: number | null;
}

/** A non-mutating, quote-backed liquidation valuation for an open paper position. */
export interface PaperMark {
  readonly marked: boolean;
  readonly reason: string | null;
  readonly liquidationValueUsdMicros: number | null;
  readonly equityUsdMicros: number | null;
}

export function defaultResearchPolicy(overrides: Partial<Omit<ResearchPolicy, "version">> = {}): ResearchPolicy {
  const result: ResearchPolicy = {
    version: "sol-daily-breakout-v1",
    initialUsdMicros: 20_000_000,
    slippageStressBps: 100,
    fixedCostPerLegUsdMicros: 20_000,
    dailyOverheadUsdMicros: null,
    quoteMaxAgeMs: 10_000,
    candleLagMs: 300_000,
    minimumDailyBars: 200,
    emaPeriod: 100,
    emaRiseDays: 5,
    breakoutDays: 20,
    atrDays: 14,
    exitLowDays: 10,
    maxHoldingDays: 20,
    riskBudgetBps: 50,
    maxEquityAllocationBps: 2_500,
    stopAtrMultiple: 3,
    ...overrides,
  };
  const errors = validateResearchPolicy(result);
  if (errors.length > 0) throw new RangeError(`Invalid research policy: ${errors.join(", ")}`);
  return Object.freeze(result);
}

export function validateResearchPolicy(policy: ResearchPolicy): readonly string[] {
  const errors: string[] = [];
  const positiveIntegers: Array<[string, number]> = [
    ["initialUsdMicros", policy.initialUsdMicros], ["quoteMaxAgeMs", policy.quoteMaxAgeMs], ["minimumDailyBars", policy.minimumDailyBars], ["emaPeriod", policy.emaPeriod], ["emaRiseDays", policy.emaRiseDays], ["breakoutDays", policy.breakoutDays], ["atrDays", policy.atrDays], ["exitLowDays", policy.exitLowDays], ["maxHoldingDays", policy.maxHoldingDays],
  ];
  for (const [name, value] of positiveIntegers) if (!Number.isSafeInteger(value) || value <= 0) errors.push(`INVALID_${name}`);
  for (const [name, value] of [["fixedCostPerLegUsdMicros", policy.fixedCostPerLegUsdMicros], ["candleLagMs", policy.candleLagMs], ["slippageStressBps", policy.slippageStressBps], ["riskBudgetBps", policy.riskBudgetBps], ["maxEquityAllocationBps", policy.maxEquityAllocationBps]] as const) if (!Number.isSafeInteger(value) || value < 0) errors.push(`INVALID_${name}`);
  if (policy.slippageStressBps > 10_000 || policy.riskBudgetBps > 10_000 || policy.maxEquityAllocationBps > 10_000) errors.push("BPS_OUT_OF_RANGE");
  if (!Number.isFinite(policy.stopAtrMultiple) || policy.stopAtrMultiple <= 0) errors.push("INVALID_stopAtrMultiple");
  if (policy.dailyOverheadUsdMicros !== null && (!Number.isSafeInteger(policy.dailyOverheadUsdMicros) || policy.dailyOverheadUsdMicros < 0)) errors.push("INVALID_dailyOverheadUsdMicros");
  return errors;
}

export function hashResearchPolicy(policy: ResearchPolicy): string {
  return createHash("sha256").update(stableJson(policy)).digest("hex");
}

export function normalizeCoinbaseCandles(raw: unknown, observedAt: string, nowMs: number, lagMs: number): CandleNormalizationResult {
  const errors: string[] = [];
  const revisions: string[] = [];
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs) return { candles: [], errors: ["INVALID_OR_FUTURE_OBSERVED_AT"], revisions };
  if (!Array.isArray(raw)) return { candles: [], errors: ["CANDLE_PAYLOAD_NOT_ARRAY"], revisions };
  const byTime = new Map<number, Candle>();
  for (const [index, item] of raw.entries()) {
    if (!Array.isArray(item) || item.length < 6) { errors.push(`CANDLE_${index}_INVALID_SHAPE`); continue; }
    const values = item.slice(0, 6).map(Number);
    const [time, low, high, open, close, volume] = values;
    if ([time, low, high, open, close, volume].some((value) => !Number.isFinite(value)) || time === undefined || low === undefined || high === undefined || open === undefined || close === undefined || volume === undefined || !Number.isInteger(time) || time % (DAY_MS / 1000) !== 0 || time <= 0 || low <= 0 || high < low || open < low || open > high || close < low || close > high || volume < 0) {
      errors.push(`CANDLE_${index}_INVALID_VALUES`); continue;
    }
    if ((time * 1000) + DAY_MS + lagMs > nowMs) { revisions.push(`CANDLE_${time}_UNFINISHED`); continue; }
    const candle: Candle = { time, low, high, open, close, volume, observedAt };
    if (byTime.has(time)) { errors.push(`CANDLE_${time}_DUPLICATE`); continue; }
    byTime.set(time, candle);
  }
  return { candles: [...byTime.values()].sort((a, b) => a.time - b.time), errors, revisions };
}

export function validateDailyCandleWindow(candles: readonly Candle[], asOfMs: number, policy: ResearchPolicy): readonly string[] {
  const errors: string[] = [];
  if (candles.length < policy.minimumDailyBars) errors.push("INSUFFICIENT_COMPLETED_DAILY_BARS");
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    if ((candle.time * 1000) + DAY_MS + policy.candleLagMs > asOfMs) errors.push(`CANDLE_${candle.time}_NOT_COMPLETED_AT_AS_OF`);
    if (!Number.isFinite(Date.parse(candle.observedAt)) || Date.parse(candle.observedAt) > asOfMs) errors.push(`CANDLE_${candle.time}_FUTURE_OBSERVED_AT`);
    if (index > 0 && candle.time !== (candles[index - 1]?.time ?? 0) + DAY_MS / 1000) errors.push(`CANDLE_${candle.time}_DAILY_GAP`);
  }
  const last = candles.at(-1);
  if (last && asOfMs - ((last.time * 1000) + DAY_MS) > DAY_MS) errors.push("LAST_CANDLE_STALE");
  return errors;
}

export function signalForCandles(candles: readonly Candle[], asOfMs: number, policy: ResearchPolicy, position: PaperPosition | null = null): DailySignal {
  const valid = validateDailyCandleWindow(candles, asOfMs, policy);
  if (valid.length > 0) return emptySignal(valid[0] ?? "INVALID_CANDLES");
  const current = candles.at(-1);
  if (!current) return emptySignal("NO_CANDLES");
  const closes = candles.map((candle) => candle.close);
  const ema = emaSeries(closes, policy.emaPeriod);
  const currentEma = ema.at(-1) ?? null;
  const priorEma = ema.at(-(policy.emaRiseDays + 1)) ?? null;
  const priorTwenty = candles.slice(-(policy.breakoutDays + 1), -1);
  const priorTen = candles.slice(-(policy.exitLowDays + 1), -1);
  const atr = atrAtEnd(candles, policy.atrDays);
  if (currentEma === null || priorEma === null || atr === null || priorTwenty.length !== policy.breakoutDays || priorTen.length !== policy.exitLowDays) return emptySignal("INDICATOR_WARMUP");
  const priorTwentyHigh = Math.max(...priorTwenty.map((candle) => candle.high));
  const priorTenLow = Math.min(...priorTen.map((candle) => candle.low));
  const candidateStop = current.close - policy.stopAtrMultiple * atr;
  const stopPrice = position ? Math.max(position.stopPrice, candidateStop) : candidateStop;
  // A decision occurs only after this daily candle has completed; using its open
  // would defer the max-holding exit by one full bar.
  const exit = position !== null && (current.close <= stopPrice || current.close < priorTenLow || daysSince(position.openedAt, asOfMs / 1000) >= policy.maxHoldingDays);
  return {
    asOfTime: current.time,
    entry: position === null && current.close > priorTwentyHigh && current.close > currentEma && currentEma > priorEma,
    exit,
    reason: exit ? "CLOSE_CONFIRMED_EXIT" : null,
    close: current.close,
    ema100: currentEma,
    ema100FiveDaysAgo: priorEma,
    priorTwentyHigh,
    priorTenLow,
    atr14: atr,
    stopPrice,
    stopFraction: (policy.stopAtrMultiple * atr) / current.close,
  };
}

export function initialPaperLedger(policy: ResearchPolicy): PaperLedger {
  return { cashUsdMicros: policy.initialUsdMicros, position: null, realizedPnlMicros: 0, enteredTrades: 0, closedTrades: 0 };
}

export const initialLedger = initialPaperLedger;

export function quotePaperEntry(ledger: PaperLedger, signal: DailySignal, quote: PaperEntryQuote, asOfMs: number, policy: ResearchPolicy): PaperDecision {
  if (ledger.position) return reject("POSITION_ALREADY_OPEN");
  if (!signal.entry || signal.stopFraction === null || signal.atr14 === null || signal.asOfTime === null) return reject("NO_ENTRY_SIGNAL");
  if (quote.configured === false) return reject("QUOTE_SOURCE_UNCONFIGURED");
  if (quote.externalFeeUsdMicros === null) return reject("UNKNOWN_EXTERNAL_FEE");
  if (!fresh(quote.observedAt, asOfMs, policy.quoteMaxAgeMs)) return reject("STALE_QUOTE");
  if (!causalEntryQuote(quote, signal.asOfTime, asOfMs, policy)) return reject("NON_CAUSAL_OR_EXPIRED_QUOTE");
  const sol = parseLamports(quote.netOutputSolLamports);
  if (sol === null || sol <= 0n || !Number.isSafeInteger(quote.inputUsdMicros) || quote.inputUsdMicros <= 0) return reject("INVALID_ENTRY_QUOTE");
  const legCost = legCostMicros(quote.externalFeeUsdMicros, policy);
  if (legCost === null) return reject("INVALID_EXTERNAL_FEE");
  const debit = quote.inputUsdMicros + legCost;
  const equity = ledger.cashUsdMicros;
  const maximumNotional = Math.min(Math.floor(equity * policy.maxEquityAllocationBps / 10_000), Math.floor(equity * policy.riskBudgetBps / 10_000 / signal.stopFraction));
  if (quote.inputUsdMicros > maximumNotional) return reject("OVERSIZE_FOR_RISK_POLICY");
  const stressRoundTrip = 2 * (Math.ceil(quote.inputUsdMicros * policy.slippageStressBps / 10_000) + legCost);
  if (stressRoundTrip > quote.inputUsdMicros * signal.stopFraction / 3) return reject("COST_GATE_REJECTED");
  if (debit + legCost > ledger.cashUsdMicros) return reject("INSUFFICIENT_CASH_WITH_EXIT_RESERVE");
  if (sol > BigInt(Number.MAX_SAFE_INTEGER)) return reject("UNREPRESENTABLE_ENTRY_QUOTE");
  const fillPrice = quote.inputUsdMicros * 1000 / Number(sol);
  const stopPrice = fillPrice - policy.stopAtrMultiple * signal.atr14;
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return reject("INVALID_INITIAL_STOP");
  return { accepted: true, reason: null, debitMicros: debit, solLamports: sol.toString(), stopPrice, tradeId: `sol-${signal.asOfTime}-${ledger.enteredTrades + 1}` };
}

export function enterPaper(ledger: PaperLedger, decision: PaperDecision, openedAt: string): PaperLedger {
  if (!decision.accepted || decision.solLamports === null || decision.stopPrice === null || decision.tradeId === null) return ledger;
  if (ledger.position || !Number.isSafeInteger(decision.debitMicros) || decision.debitMicros < 0 || decision.debitMicros > ledger.cashUsdMicros || parseLamports(decision.solLamports) === null) return ledger;
  return { ...ledger, cashUsdMicros: ledger.cashUsdMicros - decision.debitMicros, position: { solLamports: decision.solLamports, entryDebitMicros: decision.debitMicros, openedAt, stopPrice: decision.stopPrice, tradeId: decision.tradeId }, enteredTrades: ledger.enteredTrades + 1 };
}

export function markPaper(ledger: PaperLedger, quote: PaperExitQuote, asOfMs: number, policy: ResearchPolicy): PaperMark {
  if (!ledger.position) return { marked: false, reason: "NO_POSITION", liquidationValueUsdMicros: null, equityUsdMicros: null };
  if (quote.configured === false) return { marked: false, reason: "QUOTE_SOURCE_UNCONFIGURED", liquidationValueUsdMicros: null, equityUsdMicros: null };
  if (quote.externalFeeUsdMicros === null) return { marked: false, reason: "UNKNOWN_EXTERNAL_FEE", liquidationValueUsdMicros: null, equityUsdMicros: null };
  if (!fresh(quote.observedAt, asOfMs, policy.quoteMaxAgeMs)) return { marked: false, reason: "STALE_QUOTE", liquidationValueUsdMicros: null, equityUsdMicros: null };
  if (!validExpiry(quote, asOfMs)) return { marked: false, reason: "EXPIRED_OR_INVALID_QUOTE", liquidationValueUsdMicros: null, equityUsdMicros: null };
  if (!Number.isSafeInteger(quote.netOutputUsdMicros) || quote.netOutputUsdMicros < 0) return { marked: false, reason: "INVALID_EXIT_QUOTE", liquidationValueUsdMicros: null, equityUsdMicros: null };
  const legCost = legCostMicros(quote.externalFeeUsdMicros, policy);
  if (legCost === null) return { marked: false, reason: "INVALID_EXTERNAL_FEE", liquidationValueUsdMicros: null, equityUsdMicros: null };
  const liquidationValueUsdMicros = quote.netOutputUsdMicros - legCost;
  if (ledger.cashUsdMicros + liquidationValueUsdMicros < 0) return { marked:false,reason:"INSUFFICIENT_EXIT_CASH",liquidationValueUsdMicros:null,equityUsdMicros:null };
  return { marked: true, reason: null, liquidationValueUsdMicros, equityUsdMicros: ledger.cashUsdMicros + liquidationValueUsdMicros };
}

export function exitPaper(ledger: PaperLedger, quote: PaperExitQuote, asOfMs: number, policy: ResearchPolicy): PaperLedger {
  if (!ledger.position || quote.configured === false || quote.externalFeeUsdMicros === null || !fresh(quote.observedAt, asOfMs, policy.quoteMaxAgeMs) || !validExpiry(quote, asOfMs) || !Number.isSafeInteger(quote.netOutputUsdMicros) || quote.netOutputUsdMicros < 0) return ledger;
  const legCost = legCostMicros(quote.externalFeeUsdMicros, policy);
  if (legCost === null) return ledger;
  const credit = quote.netOutputUsdMicros - legCost;
  if (ledger.cashUsdMicros + credit < 0) return ledger;
  const pnl = credit - ledger.position.entryDebitMicros;
  return { cashUsdMicros: ledger.cashUsdMicros + credit, position: null, realizedPnlMicros: ledger.realizedPnlMicros + pnl, enteredTrades: ledger.enteredTrades, closedTrades: ledger.closedTrades + 1 };
}

export function stressCostView(notionalUsdMicros: number, routeCostsKnown: boolean, policy: ResearchPolicy): CostView {
  const stressedRoundTripCostUsdMicros = routeCostsKnown && Number.isSafeInteger(notionalUsdMicros) && notionalUsdMicros >= 0
    ? 2 * (Math.ceil(notionalUsdMicros * policy.slippageStressBps / 10_000) + policy.fixedCostPerLegUsdMicros)
    : null;
  return { routeCostsKnown, fixedCostPerLegUsdMicros: policy.fixedCostPerLegUsdMicros, dailyOverheadUsdMicros: policy.dailyOverheadUsdMicros, slippageStressBps: policy.slippageStressBps, stressedRoundTripCostUsdMicros };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emaSeries(values: readonly number[], period: number): number[] {
  const multiplier = 2 / (period + 1);
  let current = values[0] ?? 0;
  return values.map((value, index) => { current = index === 0 ? value : value * multiplier + current * (1 - multiplier); return current; });
}

function atrAtEnd(candles: readonly Candle[], days: number): number | null {
  if (candles.length < days + 1) return null;
  const slice = candles.slice(-(days + 1));
  let total = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const candle = slice[index]; const previous = slice[index - 1];
    if (!candle || !previous) return null;
    total += Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  }
  return total / days;
}

function fresh(observedAt: string, asOfMs: number, maxAgeMs: number): boolean {
  const time = Date.parse(observedAt);
  return Number.isFinite(time) && time <= asOfMs && asOfMs - time <= maxAgeMs;
}
function causalEntryQuote(quote: PaperEntryQuote, signalTime: number, asOfMs: number, policy: ResearchPolicy): boolean {
  const requested = quote.requestedAt ? Date.parse(quote.requestedAt) : Number.NaN;
  const expires = quote.expiresAt === undefined || quote.expiresAt === null ? null : Date.parse(quote.expiresAt);
  const earliest = signalTime * 1000 + DAY_MS + policy.candleLagMs;
  return Number.isFinite(requested) && requested >= earliest && requested <= asOfMs && validExpiry(quote, asOfMs) && (expires === null || expires >= requested);
}
function validExpiry(quote: Pick<PaperEntryQuote | PaperExitQuote, "expiresAt" | "observedAt">, asOfMs: number): boolean {
  if (quote.expiresAt === undefined || quote.expiresAt === null) return true;
  const expires = Date.parse(quote.expiresAt); const observed = Date.parse(quote.observedAt);
  return Number.isFinite(expires) && Number.isFinite(observed) && expires >= observed && expires >= asOfMs;
}

function parseLamports(value: string): bigint | null { try { return /^\d+$/.test(value) ? BigInt(value) : null; } catch { return null; } }
function legCostMicros(external: number | null | undefined, policy: ResearchPolicy): number | null {
  if (external !== undefined && external !== null && (!Number.isSafeInteger(external) || external < 0)) return null;
  return Math.max(policy.fixedCostPerLegUsdMicros, external ?? 0);
}
function reject(reason: string): PaperDecision { return { accepted: false, reason, debitMicros: 0, solLamports: null, stopPrice: null, tradeId: null }; }
function emptySignal(reason: string): DailySignal { return { asOfTime: null, entry: false, exit: false, reason, close: null, ema100: null, ema100FiveDaysAgo: null, priorTwentyHigh: null, priorTenLow: null, atr14: null, stopPrice: null, stopFraction: null }; }
function daysSince(openedAt: string, currentTime: number): number { const opened = Date.parse(openedAt); return Number.isFinite(opened) ? (currentTime * 1000 - opened) / DAY_MS : Number.POSITIVE_INFINITY; }

export const SOL_LAMPORTS_PER_SOL = LAMPORTS_PER_SOL;
