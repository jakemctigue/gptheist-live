import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { defaultResearchPolicy, normalizeCoinbaseCandles, signalForCandles, initialLedger, quotePaperEntry,
  enterPaper, exitPaper, markPaper, validateDailyCandleWindow, type Candle, type PaperLedger, type PaperExitQuote, type ResearchPolicy } from "./researchCore.js";
import { createResearchFeeds, ResearchFeedError, SOL_MINT, USDC_MINT, type FeedQuote } from "./researchFeeds.js";
import { ResearchStore, type ResearchExperiment, type ResearchEvent, type ResearchState } from "./researchStore.js";

const DAY = 86_400_000, HOUR = 3_600_000;
interface Config { enabled: boolean; experimentId: string; policy: ResearchPolicy; sampleUsdMicros: number; apiKey: string | undefined }
interface Payload extends Record<string, unknown> {
  ledger: PaperLedger; candles: readonly Candle[]; lastDecisionBar: number | null;
  lastMark: { equityUsdMicros: number | null; at: string; status: string } | null;
  passive: { startAt: string; startPrice: number; units: number; cashMicros: number; markPrice: number; markAt: string } | null;
  firstObservedAt: string; requests: number; errors: number;
  cumulativeStressCostMicros: number;
  evidenceBytes: number; collectionPaused: boolean;
}
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_INVALID`);
  return value;
}
export function researchEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env.RESEARCH_ENABLED ?? "false").trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error("RESEARCH_ENABLED_INVALID");
  return value === "true";
}
export function researchConfig(env: NodeJS.ProcessEnv): Config {
  const experimentId = env.RESEARCH_EXPERIMENT_ID?.trim() || "sol-calibration-v1";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(experimentId)) throw new Error("RESEARCH_EXPERIMENT_ID_INVALID");
  return {
    enabled: researchEnabled(env), experimentId, apiKey: env.JUPITER_API_KEY?.trim(),
    sampleUsdMicros: integer(env, "RESEARCH_SAMPLE_USD_MICROS", 1_000_000, 100_000, 1_000_000_000),
    policy: defaultResearchPolicy({ initialUsdMicros: integer(env,"RESEARCH_STARTING_USD_MICROS",20_000_000,1_000_000,1_000_000_000),
      fixedCostPerLegUsdMicros: integer(env,"RESEARCH_FIXED_LEG_COST_MICROS",20_000,0,1_000_000),
      slippageStressBps: integer(env,"RESEARCH_SLIPPAGE_STRESS_BPS",100,0,2_000),
      dailyOverheadUsdMicros: env.RESEARCH_DAILY_OVERHEAD_MICROS === undefined ? null : integer(env,"RESEARCH_DAILY_OVERHEAD_MICROS",0,0,1_000_000_000) })
  };
}
export function researchBucket(nowMs: number): number { return Math.floor((nowMs - 300_000) / HOUR); }
function safeCode(error: unknown): string { return error instanceof ResearchFeedError ? error.code : "RESEARCH_OPERATION_FAILED"; }
function safeMicros(value: number): number {
  const rounded = Math.floor(value); if (!Number.isSafeInteger(rounded) || rounded < 0) throw new ResearchFeedError("AMOUNT_OUT_OF_RANGE"); return rounded;
}
function externalFee(quote: FeedQuote, solUsd: number): number | null {
  return quote.externalFeeLamports === null ? null : Math.ceil(quote.externalFeeLamports * solUsd / 1_000);
}
function exitQuote(quote: FeedQuote, usdcUsd: number, solUsd: number): PaperExitQuote {
  return { netOutputUsdMicros: safeMicros(Number(quote.outputAmount) * usdcUsd), observedAt: quote.observedAt,
    requestedAt: quote.requestedAt, expiresAt: quote.expiresAt, router: quote.router,
    configured: quote.externalFeeLamports !== null && quote.buildStatus !== "FAILED", externalFeeUsdMicros: externalFee(quote, solUsd) };
}
async function codeHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of ["research.js","researchCore.js","researchFeeds.js","researchStore.js"]) hash.update(await readFile(resolve(dirname(fileURLToPath(import.meta.url)),file)));
  return hash.digest("hex");
}
async function rulesFor(config: Config): Promise<Record<string, unknown>> {
  return { policy: config.policy, sampleUsdMicros: config.sampleUsdMicros, codeHash: await codeHash(),
    sources: { signal: "Coinbase Exchange SOL-USD completed UTC daily bars", quotes: "Jupiter Swap V2 SOL/USDC", valuation: "Coinbase USDC-USD and SOL-USD spot" },
    cadenceMs: HOUR, quoteRequestsPerTickLimit: 24, evidenceByteBudget:100_000_000,warmupDays: 250, candleLagMs: 300_000,
    pons: { modeledSlippageBps: 300, maximumImmediateLossBps: 500, extraPolling: false },
    evidence: "quoted-paper-only; costs include explicit assumptions; execution unverified" };
}
export function rulesHash(rules: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify(rules)).digest("hex"); }
function initialPayload(policy: ResearchPolicy, now: string): Payload {
  return { ledger: initialLedger(policy), candles: [], lastDecisionBar: null, lastMark: null, passive: null, firstObservedAt: now, requests: 0, errors: 0,cumulativeStressCostMicros:0,evidenceBytes:0,collectionPaused:false };
}
export function summarizeResearch(experiment: ResearchExperiment, p: Payload, nowMs: number) {
  const policy = experiment.rules.policy as ResearchPolicy;
  const marked = p.ledger.position ? p.lastMark?.equityUsdMicros ?? null : p.ledger.cashUsdMicros;
  const elapsedDays = Math.max(0, (nowMs - Date.parse(experiment.createdAt)) / DAY);
  const overhead = policy.dailyOverheadUsdMicros === null ? null : Math.ceil(elapsedDays * policy.dailyOverheadUsdMicros);
  const openStress = p.ledger.position && marked !== null ? Math.ceil(Math.max(0,marked-p.ledger.cashUsdMicros)*policy.slippageStressBps/10_000) : 0;
  const stressedEquity = marked === null ? null : marked - (p.cumulativeStressCostMicros ?? 0) - openStress;
  const passiveValue = p.passive ? safeMicros(p.passive.units * p.passive.markPrice * 1e6) + p.passive.cashMicros - policy.fixedCostPerLegUsdMicros : null;
  return { experimentId: experiment._id, phase: experiment.phase, rulesHash: experiment.rulesHash, asOf: new Date(nowMs).toISOString(),
    evidence: "QUOTED_PAPER_NOT_EXECUTION", automaticPromotion: false,
    initialUsdMicros: policy.initialUsdMicros, cashUsdMicros: p.ledger.cashUsdMicros, equityUsdMicros: marked,
    markAt: p.lastMark?.at ?? null, markStatus: p.ledger.position ? (p.lastMark && nowMs-Date.parse(p.lastMark.at)>policy.quoteMaxAgeMs ? "STALE_LAST_KNOWN_QUOTE" : p.lastMark?.status ?? "UNAVAILABLE") : "CASH",
    realizedPnlMicros: p.ledger.realizedPnlMicros, closedTrades: p.ledger.closedTrades, openPosition: p.ledger.position !== null,
    overheadUsdMicros: overhead, overheadStatus: overhead === null ? "UNKNOWN_NOT_ZERO" : "USER_ESTIMATE",
    netAfterOverheadMicros: overhead === null || marked === null ? null : marked - policy.initialUsdMicros - overhead,
    cashBenchmarkMicros: policy.initialUsdMicros,
    passiveBenchmark: { equityMicros: passiveValue, source: "COINBASE_PRICE_PROXY_NOT_EXECUTABLE", startAt: p.passive?.startAt ?? null, markAt: p.passive?.markAt ?? null },
    stress: { extraSlippageBpsPerLeg: policy.slippageStressBps, fixedCostPerLegMicros: policy.fixedCostPerLegUsdMicros,
      stressedEquityUsdMicros:stressedEquity,stressedNetPnlMicros:stressedEquity===null?null:stressedEquity-policy.initialUsdMicros,
      stressedAfterOverheadMicros:stressedEquity===null||overhead===null?null:stressedEquity-policy.initialUsdMicros-overhead,
      openPositionTotalLossEquityMicros: p.ledger.cashUsdMicros, note: "Quoted base P&L does not measure realized slippage, failures or rent recovery" },
    requests: p.requests, errors: p.errors, evidenceBytes:p.evidenceBytes,collectionPaused:p.collectionPaused,confirmationDays: elapsedDays,
    sufficientSampleForReview: experiment.phase === "CONFIRMATION" && elapsedDays >= 90 && p.ledger.closedTrades >= 30,
    promotion: "DISABLED_REQUIRES_INDEPENDENT_VENUE_EXECUTION_AND_STATISTICAL_REVIEW" };
}

export async function researchTick(store: ResearchStore, experiment: ResearchExperiment, state: ResearchState, config: Config, nowMs = Date.now(), dependencies: {
  feeds?: ReturnType<typeof createResearchFeeds>; clock?: () => number;
} = {}): Promise<void> {
  const clock = dependencies.clock ?? Date.now;
  const bucket = researchBucket(nowMs);
  if (state.lastBucket !== null && bucket <= state.lastBucket) { await store.release(experiment._id); return; }
  const now = new Date(nowMs).toISOString(), date = new Date(nowMs-config.policy.candleLagMs).toISOString().slice(0,10);
  const p = (state.payload.ledger ? structuredClone(state.payload) : initialPayload(config.policy,now)) as Payload;
  if (p.collectionPaused) { await store.release(experiment._id); return; }
  const events: ResearchEvent[] = [];
  const add = (kind: string, body: Record<string, unknown>) => events.push({ _id: `${experiment._id}:${bucket}:${events.length}`, experimentId: experiment._id, kind, at: now, ...body });
  const feeds = dependencies.feeds ?? createResearchFeeds(config.apiKey);
  let candleDay = state.candleDay;
  const errors = (error: unknown, operation: string) => { p.errors++; add("outage",{ operation, code: safeCode(error) }); };
  if (state.lastBucket !== null && bucket > state.lastBucket + 1) add("coverage-gap",{ firstMissingBucket:state.lastBucket+1,lastMissingBucket:bucket-1,reason:"WORKER_NOT_OBSERVED" });
  try {
    if (candleDay !== date) {
      try {
        const result = await feeds.candles(nowMs);
        const normalized = normalizeCoinbaseCandles(result.data, result.observedAt, clock(), config.policy.candleLagMs);
        const old = new Map(p.candles.map(c => [c.time,c]));
        const revisions = normalized.candles.filter(c => { const prev = old.get(c.time); return prev && ["open","high","low","close","volume"].some(k => prev[k as keyof Candle] !== c[k as keyof Candle]); }).map(c => c.time);
        add("candles",{ source: "Coinbase Exchange SOL-USD", requestedAt: now, observedAt: result.observedAt, sourceDate: result.sourceDate,
          candles: normalized.candles, errors: normalized.errors, excluded: normalized.revisions, revisedBars: revisions });
        p.candles = normalized.errors.length ? [] : normalized.candles;
        // A revision is retained, but invalidates this day's decision instead of rewriting old fills.
        if (revisions.length) p.candles = [];
        candleDay = date;
      } catch (error) { errors(error,"candles"); }
    }
    add("pons-gate",{ reason: "COST_MODEL_INFEASIBLE", modeledSlippageBpsPerLeg: 300, roundTripLossFloorBps: 591,
      limitBps: 500, reserves: null, reservesStatus: "NOT_NEEDED_FOR_PROVEN_COST_FLOOR", additionalRpcRequests: 0 });
    const signal = signalForCandles(p.candles, clock(), config.policy, p.ledger.position);
    const latest = p.candles.at(-1);
    const latestExpected = Math.floor((nowMs - config.policy.candleLagMs) / DAY) * DAY / 1000 - DAY / 1000;
    const freshBar = latest?.time === latestExpected;
    const unseenBar = latest !== undefined && latest.time !== p.lastDecisionBar;
    const eligibleConfirmationBar = experiment.phase === "CALIBRATION" || (latest !== undefined && (latest.time * 1000 + DAY) >= Date.parse(experiment.createdAt));
    const actionable = freshBar && unseenBar && eligibleConfirmationBar && signal.reason !== "INSUFFICIENT_COMPLETED_DAILY_BARS";
    let operation = "prices";
    try {
      const usd = await feeds.price("USDC"); const sol = await feeds.price("SOL");
      operation = "hourly-quote-pair";
      const pair = await feeds.quotePair(String(safeMicros(config.sampleUsdMicros / usd.usd)));
      add("quote-pair",{ purpose: "HOURLY_CALIBRATION", pair, usdcUsd: usd, solUsd: sol, costsEmbedded: true, execution: "UNVERIFIED" });
      if (!p.passive && latest && freshBar) {
        const available = Math.max(0,config.policy.initialUsdMicros - 2*config.policy.fixedCostPerLegUsdMicros);
        p.passive = { startAt: now, startPrice: sol.usd, units: available/1e6/sol.usd, cashMicros: config.policy.fixedCostPerLegUsdMicros,markPrice:sol.usd,markAt:sol.observedAt };
      }
      if (p.passive) p.passive = {...p.passive,markPrice:sol.usd,markAt:sol.observedAt};
      if (p.ledger.position) {
        operation = "position-reverse-quote";
        const q = await feeds.order(SOL_MINT,USDC_MINT,p.ledger.position.solLamports);
        add("quote",{ purpose: "POSITION_EXIT_OR_MARK",quote:q,usdcUsd:usd,solUsd:sol });
        const converted = exitQuote(q,usd.usd,sol.usd);
        const mark = markPaper(p.ledger,converted,clock(),config.policy);
        p.lastMark = { equityUsdMicros: mark.equityUsdMicros, at:q.observedAt,status:mark.marked ? "QUOTED" : mark.reason ?? "UNAVAILABLE" };
        const timeExitDue = clock()-Date.parse(p.ledger.position.openedAt) >= config.policy.maxHoldingDays*DAY;
        if ((actionable && signal.exit) || timeExitDue) {
          const before = p.ledger;
          p.ledger = exitPaper(p.ledger,converted,clock(),config.policy);
          if (!p.ledger.position) { p.cumulativeStressCostMicros += Math.ceil(converted.netOutputUsdMicros*config.policy.slippageStressBps/10_000); add("paper-fill",{ side:"SELL",before,after:p.ledger,quote:q,signal,accounting:"QUOTE_PLUS_ESTIMATED_EXTERNAL_COST" }); }
        } else if (actionable && signal.stopPrice !== null) p.ledger = { ...p.ledger,position:{ ...p.ledger.position!,stopPrice:signal.stopPrice } };
      } else if (actionable && signal.entry && signal.stopFraction !== null) {
        operation = "candidate-entry-quotes";
        const notional = safeMicros(Math.min(p.ledger.cashUsdMicros*0.25,p.ledger.cashUsdMicros*0.005/signal.stopFraction));
        if (notional > 0) {
          const candidate = await feeds.quotePair(String(safeMicros(notional/usd.usd)));
          add("quote-pair",{ purpose:"CANDIDATE_ENTRY",pair:candidate,usdcUsd:usd,solUsd:sol });
          const decision = quotePaperEntry(p.ledger,signal,{ inputUsdMicros:safeMicros(Number(candidate.entry.inputAmount)*usd.usd),
            netOutputSolLamports:candidate.entry.outputAmount,observedAt:candidate.entry.observedAt,requestedAt:candidate.entry.requestedAt,
            expiresAt:candidate.entry.expiresAt,externalFeeUsdMicros:externalFee(candidate.entry,sol.usd),
            configured:candidate.entry.externalFeeLamports !== null && candidate.reverse.externalFeeLamports !== null && candidate.entry.buildStatus !== "FAILED" && candidate.reverse.buildStatus !== "FAILED" },clock(),config.policy);
          const roundTripCredit = safeMicros(Number(candidate.reverse.outputAmount)*usd.usd) - Math.max(config.policy.fixedCostPerLegUsdMicros,externalFee(candidate.reverse,sol.usd) ?? 0);
          const loss = decision.debitMicros - roundTripCredit;
          const proposedLedger = enterPaper(p.ledger,decision,candidate.entry.observedAt);
          const proposedMark = markPaper(proposedLedger,exitQuote(candidate.reverse,usd.usd,sol.usd),clock(),config.policy);
          const costPermitted = loss >= 0 && loss <= notional*signal.stopFraction/3 && proposedMark.marked;
          add("decision",{ signal,decision,roundTripCreditMicros:roundTripCredit,roundTripLossMicros:loss,costPermitted });
          if (decision.accepted && costPermitted) {
            const before = p.ledger; p.ledger = proposedLedger;
            p.cumulativeStressCostMicros += Math.ceil(notional*config.policy.slippageStressBps/10_000);
            const entryMark = markPaper(p.ledger,exitQuote(candidate.reverse,usd.usd,sol.usd),clock(),config.policy);
            p.lastMark = { equityUsdMicros:entryMark.equityUsdMicros,at:candidate.reverse.observedAt,status:entryMark.marked ? "QUOTED" : "UNAVAILABLE" };
            add("paper-fill",{ side:"BUY",before,after:p.ledger,quote:candidate.entry,accounting:"QUOTE_PLUS_ESTIMATED_EXTERNAL_COST" });
          }
        }
      } else add("decision",{ signal,decision:{accepted:false,reason:!freshBar ? "CANDLE_GAP_OR_STALE" : !eligibleConfirmationBar ? "PRE_FREEZE_BAR" : !unseenBar ? "BAR_ALREADY_PROCESSED" : "NO_SIGNAL"} });
      if (actionable && latest && !(signal.exit && p.ledger.position)) p.lastDecisionBar = latest.time;
    } catch (error) { errors(error,operation); if (p.ledger.position) p.lastMark = { equityUsdMicros:null,at:now,status:"UNAVAILABLE" }; }
    p.requests += feeds.requestCount;
    add("tick",{ requests:feeds.requestCount,sourceDataComplete: freshBar,ledger:p.ledger });
    if (state.candleDay !== candleDay || state.lastBucket === null) add("daily-report",{ report:summarizeResearch(experiment,p,clock()) });
    const newBytes=Buffer.byteLength(JSON.stringify(events));
    if (p.evidenceBytes+newBytes>100_000_000) {
      const previous=state.payload as Payload;
      await store.commit(state,{...previous,collectionPaused:true},bucket,state.candleDay,[{
        _id:`${experiment._id}:${bucket}:budget`,experimentId:experiment._id,kind:"collection-paused",at:now,reason:"EVIDENCE_BYTE_BUDGET_EXCEEDED",discardedTick:true
      }]);
    } else { p.evidenceBytes+=newBytes;await store.commit(state,p,bucket,candleDay,events); }
  } catch (error) { await store.release(experiment._id); throw error; }
}

export async function runResearch(env: NodeJS.ProcessEnv = process.env, args = process.argv.slice(2)): Promise<void> {
  const config = researchConfig(env);
  if (!config.enabled && !args.includes("--report") && !args.includes("--freeze")) { console.log(JSON.stringify({ event:"research-disabled" })); return; }
  if (!env.MONGODB_URI) throw new Error("RESEARCH_REQUIRES_HOSTED_MONGODB_URI");
  const dbName = env.GPTHEIST_MONGODB_DB || "gptheist";
  if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(dbName)) throw new Error("RESEARCH_DATABASE_NAME_INVALID");
  const client = new MongoClient(env.MONGODB_URI,{appName:"gptheist-research",serverSelectionTimeoutMS:10_000});
  const abort = new AbortController(); const stop = () => abort.abort();
  process.once("SIGINT",stop); process.once("SIGTERM",stop);
  try {
    await client.connect(); const store = new ResearchStore(client,client.db(dbName));
    if (args.includes("--report")) {
      const exp = await store.experiment(config.experimentId), state = await store.state(config.experimentId);
      console.log(JSON.stringify(exp && state?.payload.ledger ? summarizeResearch(exp,state.payload as Payload,Date.now()) : { status:"NO_OBSERVATIONS" },null,2)); return;
    }
    await store.indexes();
    const rules = await rulesFor(config), hash = rulesHash(rules);
    if (args.includes("--freeze")) {
      const newId = args[args.indexOf("--freeze")+1];
      if (!newId || !/^[a-zA-Z0-9_-]{1,80}$/.test(newId) || newId === config.experimentId) throw new Error("FREEZE_REQUIRES_NEW_EXPERIMENT_ID");
      const source = await store.experiment(config.experimentId), state = await store.state(config.experimentId);
      if (!source || source.phase !== "CALIBRATION" || source.rulesHash !== hash || !state?.payload.ledger) throw new Error("FREEZE_REQUIRES_MATCHING_CALIBRATION");
      const calibration = state.payload as Payload;
      if (validateDailyCandleWindow(calibration.candles,Date.now(),config.policy).length) throw new Error("FREEZE_REQUIRES_VALID_COMPLETE_CANDLES");
      if (!(await store.events(source._id,"quote-pair",1)).length || !(await store.events(source._id,"candles",1)).length) throw new Error("FREEZE_REQUIRES_QUOTES_AND_CANDLES");
      if (await store.experiment(newId)) throw new Error("FREEZE_TARGET_ALREADY_EXISTS");
      await store.ensureExperiment({ _id:newId,phase:"CONFIRMATION",rules,rulesHash:hash,createdAt:new Date().toISOString(),parentId:source._id,
        confirmationDesign:{ minimumDays:90,minimumClosedTrades:30,automaticPromotion:false } });
      console.log(JSON.stringify({event:"research-frozen",experimentId:newId,rulesHash:hash,automaticPromotion:false})); return;
    }
    const existing = await store.experiment(config.experimentId);
    const experiment = await store.ensureExperiment(existing ? {...existing,rulesHash:hash} : {
      _id:config.experimentId,phase:"CALIBRATION",rules,rulesHash:hash,createdAt:new Date().toISOString(),parentId:null,
      confirmationDesign:{minimumDays:90,minimumClosedTrades:30,automaticPromotion:false} });
    do {
      const state = await store.acquire(experiment._id);
      if (state) await researchTick(store,experiment,state,config);
      if (args.includes("--once")) break;
      await new Promise<void>(resolveWait => { const timer=setTimeout(done,60_000); function done() {clearTimeout(timer);abort.signal.removeEventListener("abort",done);resolveWait();} abort.signal.addEventListener("abort",done,{once:true});if(abort.signal.aborted)done(); });
    } while (!abort.signal.aborted);
  } finally { process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);await client.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runResearch().catch(error => { console.error(JSON.stringify({event:"research-error",code:safeCode(error)}));process.exitCode=1; });
}
