import type { LiveLaunch, LiveLaunchDecision, LiveSnapshot } from "./live.js";

const WINDOW_MS = 15 * 60_000;
const STALE_MS = 45_000;
const SAMPLE_INTERVAL_MS = 5_000;
const MAX_TRACKED = 72;
const MAX_SAMPLES = 180;
const MAX_AGE_MS = 60 * 60_000;

export type OpportunitySignal = "WARMING_UP" | "WAIT" | "ENTRY_REVIEW" | "EXIT_REVIEW" | "BLOCKED" | "STALE";
interface Sample { at: number; block: number; quote: bigint; tokens: bigint; liquidity: bigint }
interface Tracked { launch: LiveLaunchDecision; samples: Sample[]; firstSeen: number; seenAt: number }
export interface Opportunity {
  token: string;
  launch: LiveLaunchDecision;
  signal: OpportunitySignal;
  score: number;
  reasons: string[];
  observedAt: string | null;
  samples: number;
  windowSeconds: number;
  momentumBps: number | null;
  liquidityChangeBps: number | null;
  drawdownBps: number | null;
  reboundBps: number | null;
  priceIndex: number | null;
  chart: Array<{ at: string; index: number }>;
  plan: { entryLow: number; entryHigh: number; invalidation: number; profitReview: number; trailingReview: number } | null;
  canReviewBuy: boolean;
  canReviewSell: boolean;
}

// Cross multiplication preserves precision for token reserves beyond Number.MAX_SAFE_INTEGER.
function moveBps(next: Sample, base: Sample): number {
  const denominator = base.quote * next.tokens;
  const move = ((next.quote * base.tokens - denominator) * 10_000n) / denominator;
  return Number(move);
}
function liquidityBps(next: Sample, base: Sample): number | null {
  if (base.liquidity === 0n) return null;
  const move = ((next.liquidity - base.liquidity) * 10_000n) / base.liquidity;
  return Number(move);
}
function indexAt(sample: Sample, base: Sample): number { return Math.round((100 + moveBps(sample, base) / 100) * 100) / 100; }
function level(index: number, multiplier: number): number { return Math.round(index * multiplier * 100) / 100; }
const signedPct = (bps: number): string => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

/** Read-only market observations. Contains no wallet, signing, or transaction submission capability. */
export class OpportunityMonitor {
  private readonly tracked = new Map<string, Tracked>();
  private headBlock: number | null = null;
  private fetchedAt: number | null = null;
  private advancedAt: number | null = null;
  private failed = false;

  constructor(private readonly now: () => number = Date.now) {}

  markUnavailable(): void { this.failed = true; }

  retainedLaunches(): LiveLaunch[] {
    const now = this.now();
    return [...this.tracked.values()]
      .filter((item) => now - item.firstSeen < MAX_AGE_MS && now - item.seenAt < WINDOW_MS)
      .sort((a, b) => b.launch.assessment.score - a.launch.assessment.score || b.firstSeen - a.firstSeen)
      .slice(0, 24).map((item) => item.launch);
  }

  observe(snapshot: LiveSnapshot): void {
    const at = Date.parse(snapshot.fetchedAt);
    const now = this.now();
    if (!Number.isFinite(at) || at > now + 5_000 || now - at > STALE_MS ||
        !Number.isSafeInteger(snapshot.headBlock) || snapshot.headBlock < 0 || snapshot.chainId !== 4663) {
      this.markUnavailable();
      return;
    }
    if (this.headBlock !== null && snapshot.headBlock < this.headBlock) this.tracked.clear();
    if (this.headBlock !== snapshot.headBlock) this.advancedAt = at;
    this.headBlock = snapshot.headBlock;
    this.fetchedAt = at;
    this.failed = false;
    for (const launch of snapshot.launches) {
      let item = this.tracked.get(launch.token);
      if (!item || item.launch.curve !== launch.curve) {
        item = { launch, samples: [], firstSeen: at, seenAt: at };
        this.tracked.set(launch.token, item);
      }
      item.launch = launch;
      item.seenAt = at;
      item.samples = item.samples.filter((sample) => at - sample.at <= WINDOW_MS);
      const market = launch.market;
      if (market.status !== "VERIFIED" || market.phase !== "CURVE" || launch.pairLabel !== "ETH") {
        item.samples = [];
        continue;
      }
      try {
        const quote = BigInt(market.quoteReserve), tokens = BigInt(market.tokenReserve), liquidity = BigInt(market.realQuoteReserve);
        if (quote <= 0n || tokens <= 0n || liquidity < 0n) { item.samples = []; continue; }
        const previous = item.samples.at(-1);
        // Repeated or unchanged heads never create momentum or refresh stale evidence.
        if (previous && (snapshot.headBlock <= previous.block || at - previous.at < SAMPLE_INTERVAL_MS)) continue;
        if (previous && at - previous.at > STALE_MS) item.samples = [];
        item.samples.push({ at, block: snapshot.headBlock, quote, tokens, liquidity });
        item.samples = item.samples.slice(-MAX_SAMPLES);
      } catch { item.samples = []; }
    }
    for (const [token, item] of this.tracked) if (now - item.seenAt > WINDOW_MS) this.tracked.delete(token);
    while (this.tracked.size > MAX_TRACKED) {
      const oldest = [...this.tracked.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0];
      if (oldest) this.tracked.delete(oldest[0]);
    }
  }

  read(): { mode: "approval-required"; engine: "observed-market-rules-v1"; status: "LIVE" | "STALE" | "WARMING_UP";
    fetchedAt: string | null; headBlock: number | null; staleAfterMs: number; opportunities: Opportunity[] } {
    const now = this.now();
    const stale = this.failed || (this.fetchedAt !== null && now - this.fetchedAt > STALE_MS) ||
      (this.advancedAt !== null && now - this.advancedAt > STALE_MS);
    const opportunities = [...this.tracked.values()].map((item) => this.assess(item, now, stale));
    const priority: Record<OpportunitySignal, number> = { EXIT_REVIEW: 0, ENTRY_REVIEW: 1, WAIT: 2, WARMING_UP: 3, BLOCKED: 4, STALE: 5 };
    opportunities.sort((a, b) => priority[a.signal] - priority[b.signal] || b.score - a.score);
    return { mode: "approval-required", engine: "observed-market-rules-v1",
      status: stale ? "STALE" : opportunities.some((item) => item.samples >= 4 && item.windowSeconds >= 60 && item.signal !== "STALE") ? "LIVE" : "WARMING_UP",
      fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(), headBlock: this.headBlock,
      staleAfterMs: STALE_MS, opportunities };
  }

  private assess(item: Tracked, now: number, unavailable: boolean): Opportunity {
    const { launch, samples } = item;
    const last = samples.at(-1), first = samples[0];
    const result: Opportunity = { token: launch.token, launch, signal: "WARMING_UP", score: 0,
      reasons: [], observedAt: last ? new Date(last.at).toISOString() : null, samples: samples.length,
      windowSeconds: first && last ? Math.floor((last.at - first.at) / 1_000) : 0,
      momentumBps: null, liquidityChangeBps: null, drawdownBps: null, reboundBps: null, priceIndex: null,
      chart: [], plan: null, canReviewBuy: false, canReviewSell: false };
    if (unavailable || now - item.seenAt > STALE_MS || (last && now - last.at > STALE_MS)) {
      result.signal = "STALE";
      result.reasons = ["Market data is stale or unavailable. Fresh on-chain evidence is required before review."];
      return result;
    }
    if (launch.market.status !== "VERIFIED" || launch.market.phase !== "CURVE" || launch.pairLabel !== "ETH") {
      result.signal = "BLOCKED";
      result.reasons = [launch.market.status === "VERIFIED" ? "Only verified native-ETH bonding curves are supported; pool migration requires a different venue." : launch.market.reason];
      return result;
    }
    if (!last || !first) { result.reasons = ["Valid reserve observations are not yet available."]; return result; }
    const baseline = [...samples].reverse().find((sample) => sample.at <= last.at - 60_000);
    const recent = samples.filter((sample) => sample.at >= last.at - 5 * 60_000);
    let low = recent[0] ?? first, high = low;
    for (const sample of recent) {
      if (sample.quote * low.tokens < low.quote * sample.tokens) low = sample;
      if (sample.quote * high.tokens > high.quote * sample.tokens) high = sample;
    }
    result.priceIndex = indexAt(last, first);
    result.chart = samples.map((sample) => ({ at: new Date(sample.at).toISOString(), index: indexAt(sample, first) }));
    result.drawdownBps = moveBps(last, high);
    result.reboundBps = moveBps(last, low);
    if (!baseline || samples.length < 4) {
      result.reasons = ["Collecting at least 60 seconds and four distinct-block observations. No entry proposed yet."];
      return result;
    }
    const momentum = moveBps(last, baseline), liquidity = liquidityBps(last, baseline);
    result.momentumBps = momentum;
    result.liquidityChangeBps = liquidity;
    result.reasons = [`1-minute price movement ${signedPct(momentum)}.`,
      liquidity === null ? "Real reserve change cannot be measured from a zero baseline." : `1-minute real reserve change ${signedPct(liquidity)}.`,
      `Pullback from the observed 5-minute high ${signedPct(result.drawdownBps)}.`];
    const riskPoints = Math.round(launch.assessment.score * 0.6);
    const momentumPoints = momentum >= 100 && momentum <= 1_200 ? 20 : 0;
    const reservePoints = liquidity !== null && liquidity > 0 ? 10 : 0;
    const entryPoints = result.reboundBps >= 100 && result.reboundBps <= 800 ? 10 : 0;
    result.score = Math.max(0, Math.min(100, riskPoints + momentumPoints + reservePoints + entryPoints));
    result.reasons.push(`Score: venue checks ${riskPoints}/60, momentum ${momentumPoints}/20, reserves ${reservePoints}/10, entry zone ${entryPoints}/10. This is not a probability of profit.`);
    const lowIndex = indexAt(low, first), highIndex = indexAt(high, first);
    result.plan = { entryLow: level(lowIndex, 1.01), entryHigh: level(lowIndex, 1.08),
      invalidation: level(lowIndex, 0.96), profitReview: level(result.priceIndex, 1.15), trailingReview: level(highIndex, 0.94) };
    result.canReviewSell = true; // Conditional exit only; holdings and execution are verified by the quote gates.
    if (result.drawdownBps <= -600 || momentum <= -400 || (liquidity !== null && liquidity <= -500)) {
      result.signal = "EXIT_REVIEW";
      result.reasons.unshift("If you hold this token, review an exit: momentum or liquidity has weakened. No sale has been submitted.");
    } else if (launch.assessment.verdict === "VETO") {
      result.signal = "BLOCKED";
      result.reasons.unshift(...launch.assessment.blockers);
    } else if (result.score >= 75 && momentumPoints > 0 && reservePoints > 0 && entryPoints > 0) {
      result.signal = "ENTRY_REVIEW";
      result.canReviewBuy = true;
      result.reasons.unshift("Measured upward momentum and reserve growth inside the entry review zone.");
    } else {
      result.signal = "WAIT";
      result.reasons.unshift(momentum > 1_200 || result.reboundBps > 800 ? "Price has moved beyond the entry criteria. Wait for new evidence." : "The entry criteria are not aligned yet.");
    }
    result.reasons.push("Levels use observed reserve ratios, exclude fees and gas, and are review triggers only. No position or fill is assumed.");
    return result;
  }
}
