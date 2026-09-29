import assert from "node:assert/strict";
import test from "node:test";
import {
  paperTradingConfigFromEnv,
  quotePaperBuy,
  quotePaperSell,
  simulatePaperMonth
} from "../src/paperTrading.js";
import { paperTradingEnabled } from "../src/service.js";

test("paper strategy defaults to a disabled fixed-risk $20 month", () => {
  const config = paperTradingConfigFromEnv({});
  assert.equal(config.enabled, false);
  assert.equal(config.startingUsdMicros, 20_000_000);
  assert.equal(config.durationDays, 30);
  assert.equal(config.positionBps, 1_000);
  assert.equal(config.takeProfitBps, 5_000);
  assert.equal(config.stopLossBps, 2_000);
  assert.equal(config.maxHoldMs, 24 * 60 * 60_000);
  assert.equal(config.maxTotalFeeBps, 500);
  assert.equal(config.maxPriceImpactBps, 500);
  assert.equal(config.modeledSlippageBps, 300);
});

test("paper worker requires an explicit true switch", () => {
  assert.equal(paperTradingEnabled({}), false);
  assert.equal(paperTradingEnabled({ PAPER_TRADING_ENABLED: "true" }), true);
  assert.throws(() => paperTradingEnabled({ PAPER_TRADING_ENABLED: "yes" }), /true or false/);
});

test("paper quotes deduct modeled fees and slippage without preparing a transaction", () => {
  const buy = quotePaperBuy("1000000", "5000000", "100000", 200, 300);
  assert.deepEqual(buy, {
    grossQuoteWei: "100000",
    feeWei: "2000",
    effectiveQuoteWei: "98000",
    expectedTokenOut: "446265",
    modeledTokenOut: "432877",
    priceImpactBps: 892
  });

  const sell = quotePaperSell("1000000", "5000000", "500000", 200, 300);
  assert.deepEqual(sell, {
    tokenIn: "500000",
    expectedQuoteWei: "90909",
    feeWei: "1818",
    modeledQuoteOutWei: "86418",
    priceImpactBps: 909
  });
});

test("illustrative month scenarios expose downside and uncertainty", () => {
  const conservative = simulatePaperMonth(20_000_000, 1_000, [1500, 1500, 1500, 1500, -4000, -4000, -4000, -4000, -4000, -4000]);
  const base = simulatePaperMonth(20_000_000, 1_000, [4000, 4000, 4000, 4000, 4000, -3000, -3000, -3000, -3000, -3000]);
  const optimistic = simulatePaperMonth(20_000_000, 1_000, [8000, 8000, 8000, 8000, 8000, 8000, -3000, -3000, -3000, -3000]);
  assert.ok(conservative.endingUsdMicros < 20_000_000);
  assert.ok(base.endingUsdMicros > 20_000_000);
  assert.ok(optimistic.endingUsdMicros > base.endingUsdMicros);
  assert.equal(base.assumption, "net position returns after all costs");
});

test("paper quote inputs reject impossible fee settings", () => {
  assert.throws(() => quotePaperBuy("1", "1", "1", 10_000, 0), /0 to 9999/);
  assert.throws(() => quotePaperSell("1", "1", "1", 0, 10_000), /0 to 9999/);
});
