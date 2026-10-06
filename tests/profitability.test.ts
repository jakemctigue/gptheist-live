import assert from "node:assert/strict";
import test from "node:test";
import { analyzePaperEntryEconomics, auditPaperProfitability, evaluatePaperCandidate, type ProfitabilitySnapshot } from "../src/profitability.js";
import { quotePaperBuy, quotePaperSell } from "../src/paperTrading.js";

const ledger = [
  [2, 0.019242, 1.609122],
  [1.958988, 0.023135, 1.645058],
  [1.925281, 0.020226, 1.720062],
  [1.902737, 0.033647, 1.73376],
  [1.882474, 0.029341, 1.343241]
] as const;

function snapshot(): ProfitabilitySnapshot {
  return {
    status: "RUNNING", startingUsd: 20, equityUsd: 18.256172, realizedPnlUsd: -1.743828,
    entryCount: 5, closedTradeCount: 5, lastTickAt: "2026-10-06T09:09:56.344Z", lastError: "RPC HTTP 429",
    positions: ledger.map(([notional, gas, proceeds], index) => ({
      id: `${index}`, status: "CLOSED", entryNotionalUsd: notional, entryGasUsd: gas,
      entryDebitUsd: Number((notional + gas).toFixed(6)), lastMarkUsd: proceeds, markStatus: "AVAILABLE",
      exitProceedsUsd: proceeds, realizedPnlUsd: Number((proceeds - notional - gas).toFixed(6))
    }))
  };
}

test("observed five-loss ledger reconciles in integer USD and labels attribution limits", () => {
  const result = auditPaperProfitability(snapshot(), Date.parse("2026-10-06T09:10:00Z"));
  assert.equal(result.health, "ERROR");
  assert.equal(result.realizedReconciles, true);
  assert.equal(result.equityReconciles, true);
  assert.equal(result.returnedLedger.realizedPnlUsdMicros, -1_743_828);
  assert.equal(result.returnedLedger.entryGasUsdMicros, 125_591);
  assert.equal(result.returnedLedger.wins, 0);
  assert.equal(result.returnedLedger.losses, 5);
  assert.equal(result.reportedReturnBps, -871);
  assert.ok(result.warnings.some((warning) => warning.includes("timestamp semantics depend on worker version")));
});

test("truncated position history cannot be treated as a complete aggregate", () => {
  const data = snapshot();
  data.positions = data.positions.slice(0, 2);
  const result = auditPaperProfitability(data, Date.parse("2026-10-06T09:10:00Z"));
  assert.equal(result.completeLedger, false);
  assert.equal(result.realizedReconciles, null);
  assert.equal(result.equityReconciles, null);
  assert.ok(result.warnings.some((warning) => warning.includes("incomplete")));
});

test("audit rejects duplicated or unreconciled rows and distinguishes stale and pending", () => {
  const duplicate = snapshot();
  duplicate.positions.push(duplicate.positions[0]!);
  assert.throws(() => auditPaperProfitability(duplicate, 0), /duplicate/);
  const bad = snapshot();
  bad.positions[0]!.realizedPnlUsd = 1;
  assert.throws(() => auditPaperProfitability(bad, 0), /reconcile/);
  const pending = snapshot();
  pending.positions[0] = { ...pending.positions[0]!, status: "OPEN", markStatus: "PENDING", exitProceedsUsd: null, realizedPnlUsd: null };
  pending.closedTradeCount = 4;
  pending.lastError = null;
  const result = auditPaperProfitability(pending, Date.parse("2026-10-06T10:00:00Z"));
  assert.equal(result.health, "STALE_OR_UNKNOWN");
  assert.ok(result.warnings.some((warning) => warning.includes("PENDING")));
  const wrongEquity = snapshot();
  wrongEquity.equityUsd = 20;
  assert.equal(auditPaperProfitability(wrongEquity, 0).equityReconciles, false);
});

const input = {
  quoteReserveWei: "1000000000000000000", tokenReserve: "1000000000000000000000000",
  entryNotionalUsdMicros: 2_000_000, ethUsdMicros: 2_000_000_000,
  entryGasUsdMicros: 20_000, exitGasUsdMicros: 20_000, feeBps: 500, slippageBps: 300
};

test("round-trip friction costs money without a market move and reports exact minimum reserve hurdle", () => {
  const result = analyzePaperEntryEconomics(input);
  assert.ok(result.immediateLossBps > 1_500);
  assert.ok(result.breakEvenQuoteReserveGrowthBps > 1_900);
  const buy = quotePaperBuy(input.quoteReserveWei, input.tokenReserve, "1000000000000000", 500, 300);
  const reserve = BigInt(result.breakEvenQuoteReserveWei);
  const netAt = (value: bigint) => Number(BigInt(quotePaperSell(value.toString(), input.tokenReserve, buy.modeledTokenOut, 500, 300).modeledQuoteOutWei) * BigInt(input.ethUsdMicros) / (10n ** 18n)) - input.exitGasUsdMicros;
  assert.ok(netAt(reserve) >= result.entryDebitUsdMicros);
  assert.ok(netAt(reserve - 1n) < result.entryDebitUsdMicros);
});

test("research entry gate rejects uneconomic costs even if prior observed momentum is positive", () => {
  const economics = analyzePaperEntryEconomics(input);
  const observations = [
    { observedAtMs: 1_000, quoteReserveWei: "100", tokenReserve: "1000" },
    { observedAtMs: 2_000, quoteReserveWei: "110", tokenReserve: "1000" },
    { observedAtMs: 3_000, quoteReserveWei: "120", tokenReserve: "1000" }
  ];
  const policy = { maxImmediateLossBps: 500, lookbackMs: 4_000, maxObservationAgeMs: 1_000, minimumSpanMs: 2_000, minimumMomentumBps: 500 };
  const result = evaluatePaperCandidate(economics, observations, 3_000, policy);
  assert.equal(result.momentumBps, 2_000);
  assert.equal(result.eligibleForSeparatePaperStudy, false);
  assert.ok(result.reasons.some((reason) => reason.includes("cost")));
});

test("future observations never qualify momentum and stale or duplicate observations cannot pass", () => {
  const economics = analyzePaperEntryEconomics({ ...input, feeBps: 0, slippageBps: 0, entryGasUsdMicros: 0, exitGasUsdMicros: 0 });
  const rows = [
    { observedAtMs: 1_000, quoteReserveWei: "100", tokenReserve: "1000" },
    { observedAtMs: 2_000, quoteReserveWei: "110", tokenReserve: "1000" },
    { observedAtMs: 3_000, quoteReserveWei: "120", tokenReserve: "1000" },
    { observedAtMs: 10_000, quoteReserveWei: "9000", tokenReserve: "1000" }
  ];
  const policy = { maxImmediateLossBps: 500, lookbackMs: 10_000, maxObservationAgeMs: 1_000, minimumSpanMs: 2_000, minimumMomentumBps: 500 };
  const valid = evaluatePaperCandidate(economics, rows, 3_000, policy);
  assert.equal(valid.momentumBps, 2_000);
  assert.equal(valid.eligibleForSeparatePaperStudy, true);
  assert.equal(evaluatePaperCandidate(economics, rows, 5_000, policy).eligibleForSeparatePaperStudy, false);
  assert.equal(evaluatePaperCandidate(economics, [rows[0]!, rows[0]!, rows[2]!], 3_000, policy).eligibleForSeparatePaperStudy, false);
});
