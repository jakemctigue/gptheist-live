import assert from "node:assert/strict";
import test from "node:test";
import { defaultResearchPolicy, enterPaper, exitPaper, hashResearchPolicy, initialPaperLedger, normalizeCoinbaseCandles, quotePaperEntry, signalForCandles, type Candle } from "../src/researchCore.js";

const policy = defaultResearchPolicy({ fixedCostPerLegUsdMicros: 0, initialUsdMicros: 20_000_000 });
const start = 1_699_920_000;
const asOf = (start + 200 * 86_400) * 1000 + 600_000;
function candles(): Candle[] { return Array.from({ length: 200 }, (_, index) => { const close = 100 + index * 0.1; return { time: start + index * 86_400, open: close - 0.2, high: close + 1, low: close - 1, close, volume: 1, observedAt: new Date(asOf).toISOString() }; }); }

test("normalization rejects unfinished, duplicate and malformed candles", () => {
  const midnight = Math.floor(start / 86_400) * 86_400;
  const result = normalizeCoinbaseCandles([[midnight, 99, 101, 100, 100, 1], [midnight, 99, 101, 100, 100, 1], [midnight + 220 * 86400, 99, 101, 100, 100, 1], ["no"]], new Date(asOf).toISOString(), asOf, 300_000);
  assert.equal(result.candles.length, 1); assert.match(result.errors.join(" "), /DUPLICATE|INVALID/); assert.match(result.revisions.join(" "), /UNFINISHED/);
});

test("daily signals are causal and a gap abstains", () => {
  const data = candles();
  const last = data.at(-1)!;
  const changed = [...data.slice(0, -1), { ...last, close: last.high + 10, high: last.high + 10 }];
  const signal = signalForCandles(changed, asOf, policy);
  assert.equal(signal.entry, true);
  assert.equal(signalForCandles(changed.filter((_, index) => index !== 50), asOf, policy).entry, false);
});

test("close-confirmed trailing exit is causal", () => {
  const data = candles(); const last = data.at(-1)!;
  const falling = [...data.slice(0, -1), { ...last, close: 80, low: 79, high: 101 }];
  const position = { solLamports: "1000000", entryDebitMicros: 1_000_000, openedAt: new Date((start + 190 * 86400) * 1000).toISOString(), stopPrice: 95, tradeId: "x" };
  assert.equal(signalForCandles(falling, asOf, policy, position).exit, true);
});

test("max holding period exits on the twentieth completed day", () => {
  const position = { solLamports: "1000000", entryDebitMicros: 1_000_000, openedAt: new Date((start + 180 * 86400) * 1000).toISOString(), stopPrice: 1, tradeId: "holding-boundary" };
  assert.equal(signalForCandles(candles(), asOf, policy, position).exit, true);
});

test("maximum hold uses actual decision time including publication lag", () => {
  const position = { solLamports:"1000000",entryDebitMicros:1_000_000,openedAt:new Date(asOf-20*86400000).toISOString(),stopPrice:1,tradeId:"lag-boundary" };
  assert.equal(signalForCandles(candles(),asOf,policy,position).exit,true);
  const laterEntry={...position,openedAt:new Date(asOf-20*86400000+1000).toISOString()};
  assert.equal(signalForCandles(candles(),asOf,policy,laterEntry).exit,false);
});

test("entry rejects oversize, insufficient cash and failed cost gate", () => {
  const signal = { ...signalForCandles([...candles().slice(0, -1), { ...candles().at(-1)!, close: 200, high: 200 }], asOf, policy), entry: true, stopFraction: 0.03, stopPrice: 190 };
  const quote = { inputUsdMicros: 5_000_000, netOutputSolLamports: "10000000", observedAt: new Date(asOf).toISOString(), requestedAt: new Date(asOf).toISOString() };
  assert.equal(quotePaperEntry(initialPaperLedger(policy), signal, quote, asOf, policy).reason, "OVERSIZE_FOR_RISK_POLICY");
  assert.equal(quotePaperEntry({ ...initialPaperLedger(policy), cashUsdMicros: 1 }, signal, { ...quote, inputUsdMicros: 1000 }, asOf, policy).reason, "OVERSIZE_FOR_RISK_POLICY");
  const costly = defaultResearchPolicy({ fixedCostPerLegUsdMicros: 20_000 });
  assert.equal(quotePaperEntry(initialPaperLedger(costly), signal, { ...quote, inputUsdMicros: 100_000 }, asOf, costly).reason, "COST_GATE_REJECTED");
});

test("risk sizing allows a smaller feasible quoted notional", () => {
  const signal = { ...signalForCandles(candles(), asOf, policy), entry: true, stopFraction: 0.1, stopPrice: 90 };
  const decision = quotePaperEntry(initialPaperLedger(policy), signal, { inputUsdMicros: 900_000, netOutputSolLamports: "8000000", observedAt: new Date(asOf).toISOString(), requestedAt: new Date(asOf).toISOString() }, asOf, policy);
  assert.equal(decision.accepted, true);
  assert.equal(decision.debitMicros, 900_000);
});

test("paper ledger charges each fixed cost once across a round trip", () => {
  const p = defaultResearchPolicy({ fixedCostPerLegUsdMicros: 20_000 });
  const decision = { accepted: true, reason: null, debitMicros: 1_020_000, solLamports: "1000000000", stopPrice: 90, tradeId: "t" };
  const entered = enterPaper(initialPaperLedger(p), decision, new Date(asOf).toISOString());
  const closed = exitPaper(entered, { netOutputUsdMicros: 1_100_000, observedAt: new Date(asOf).toISOString() }, asOf, p);
  assert.equal(closed.cashUsdMicros, 20_060_000); assert.equal(closed.realizedPnlMicros, 60_000); assert.equal(closed.closedTrades, 1);
});

test("policy hash is stable across equivalent property order", () => {
  const one = defaultResearchPolicy(); const two = Object.freeze(Object.fromEntries(Object.entries(one).reverse())) as typeof one;
  assert.equal(hashResearchPolicy(one), hashResearchPolicy(two));
});

test("exit fees exceeding sale output consume cash instead of disappearing",()=>{
  const p=defaultResearchPolicy();
  const entered=enterPaper(initialPaperLedger(p),{accepted:true,reason:null,debitMicros:1020000,solLamports:"100000",stopPrice:1,tradeId:"fees"},new Date(asOf).toISOString());
  const exited=exitPaper(entered,{netOutputUsdMicros:10000,externalFeeUsdMicros:20000,observedAt:new Date(asOf).toISOString()},asOf,p);
  assert.equal(exited.cashUsdMicros,18_970_000);assert.equal(exited.realizedPnlMicros,-1_030_000);
});
