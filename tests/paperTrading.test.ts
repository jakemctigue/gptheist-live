import assert from "node:assert/strict";
import test from "node:test";
import type { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";
import {
  createPaperLeaseFence,
  PaperLeaseLostError,
  paperCollectionWithLease,
  paperTick,
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

function leaseHarness() {
  let time = 1_000;
  let owner = "worker-a";
  let expiresAt = 121_000;
  let committedWrites = 0;
  let attemptedWrites = 0;
  let endedSessions = 0;
  let retry = false;
  let onRetry = (): void => {};
  const events: { type: string; session: ClientSession | undefined }[] = [];
  const runs = {
    updateOne: async (filter: { leaseOwner: string; leaseExpiresAt: { $gt: Date } }, update: { $set: { leaseExpiresAt: Date } }, options: { session?: ClientSession }) => {
      events.push({ type: "lease", session: options.session });
      if (owner !== filter.leaseOwner || expiresAt <= filter.leaseExpiresAt.$gt.getTime()) return { matchedCount: 0 };
      expiresAt = update.$set.leaseExpiresAt.getTime();
      return { matchedCount: 1 };
    }
  } as unknown as Parameters<typeof createPaperLeaseFence>[1];
  const client = { startSession: () => {
    const session = {
      withTransaction: async <T>(callback: () => Promise<T>) => {
        const previousExpiry = expiresAt, previousWrites = committedWrites;
        if (retry) {
          retry = false;
          await callback();
          // Model a transient write conflict: the first callback's writes roll back.
          expiresAt = previousExpiry;
          committedWrites = previousWrites;
          onRetry();
        }
        try { return await callback(); }
        catch (error) { expiresAt = previousExpiry; committedWrites = previousWrites; throw error; }
      },
      endSession: async () => { endedSessions += 1; }
    } as unknown as ClientSession;
    return session;
  } } as unknown as MongoClient;
  const ledger = {
    insertOne: async (_document: Document, options: { session?: ClientSession }) => {
      events.push({ type: "insert", session: options.session });
      attemptedWrites += 1; committedWrites += 1;
      return { insertedId: "unchanged-position-id" };
    },
    updateOne: async (_filter: Document, _update: Document, options: { session?: ClientSession }) => {
      events.push({ type: "update", session: options.session });
      attemptedWrites += 1; committedWrites += 1;
      return { matchedCount: 1 };
    }
  } as unknown as Collection<Document & { _id: string }>;
  const lease = createPaperLeaseFence(client, runs, "worker-a", () => new Date(time));
  return {
    lease, ledger: paperCollectionWithLease(ledger, lease), events,
    setTime: (value: number) => { time = value; },
    replaceOwner: () => { owner = "worker-b"; },
    retryNextWrite: (callback = (): void => {}) => { retry = true; onRetry = callback; },
    get committedWrites() { return committedWrites; },
    get attemptedWrites() { return attemptedWrites; },
    get endedSessions() { return endedSessions; },
    get expiresAt() { return expiresAt; }
  };
}

test("expired or replaced paper lease owners cannot insert positions or rewrite ledger totals", async () => {
  for (const invalidate of ["expired", "replaced"] as const) {
    const harness = leaseHarness();
    if (invalidate === "expired") harness.setTime(121_000);
    else harness.replaceOwner();
    await assert.rejects(harness.lease.renew(), PaperLeaseLostError);
    await assert.rejects(harness.ledger.insertOne({ _id: "new-position" }), PaperLeaseLostError);
    await assert.rejects(harness.ledger.updateOne({ _id: "paper-month-v1" }, { $set: { entryCount: 1 } }), PaperLeaseLostError);
    assert.equal(harness.attemptedWrites, 0);
    assert.equal(harness.committedWrites, 0);
    assert.equal(harness.endedSessions, 2);
  }
});

test("paper lease fence renews and writes ledger in the same transaction session", async () => {
  const harness = leaseHarness();
  harness.setTime(120_000);
  await harness.ledger.insertOne({ _id: "unchanged-position-id" });
  assert.equal(harness.expiresAt, 240_000);
  assert.equal(harness.committedWrites, 1);
  assert.deepEqual(harness.events.map((event) => event.type), ["lease", "insert"]);
  assert.ok(harness.events[0]!.session);
  assert.equal(harness.events[0]!.session, harness.events[1]!.session);
  assert.equal(harness.endedSessions, 1);
});

test("Mongo transaction retry rechecks ownership and never duplicates committed paper rows", async () => {
  const success = leaseHarness();
  success.retryNextWrite();
  await success.ledger.insertOne({ _id: "unchanged-position-id" });
  assert.equal(success.attemptedWrites, 2, "driver may rerun the callback after rollback");
  assert.equal(success.committedWrites, 1);
  const replaced = leaseHarness();
  replaced.retryNextWrite(() => replaced.replaceOwner());
  await assert.rejects(replaced.ledger.insertOne({ _id: "unchanged-position-id" }), PaperLeaseLostError);
  assert.equal(replaced.attemptedWrites, 1, "replaced owner must not execute the retried ledger write");
  assert.equal(replaced.committedWrites, 0);
  assert.equal(replaced.endedSessions, 1);
});

test("long paper ticks renew before bounded provider calls and keep feeds outside transaction retries", async () => {
  const harness = leaseHarness();
  const now = new Date(1_000);
  const run = { status: "RUNNING", startingUsdMicros: 20_000_000, cashUsdMicros: 20_000_000,
    startedAt: now, endsAt: new Date(86_400_000) } as Parameters<typeof paperTick>[2];
  const cursor = { sort: () => cursor, limit: () => cursor, next: async () => null, toArray: async () => [] };
  const database = { collection: (name: string) => {
    if (name === "paper_trade_runs") return {
      findOne: async () => run,
      updateOne: async (_filter: Document, _update: Document, options: { session?: ClientSession }) => {
        // paperTick fences this raw run collection before calling updateOne.
        assert.ok(options.session);
        return { matchedCount: 1 };
      }
    };
    return { findOne: async () => null, find: () => cursor };
  } } as unknown as Db;
  let rpcCalls = 0, priceCalls = 0;
  harness.retryNextWrite();
  const status = await paperTick(database, async (method) => {
    rpcCalls += 1;
    harness.setTime(1_000 + rpcCalls * 70_000);
    return method === "eth_chainId" ? "0x1237" : "0x42";
  }, run, paperTradingConfigFromEnv({}), async () => {
    priceCalls += 1;
    return { usdMicros: 2_000_000_000, provider: "coinbase", observedAt: now, sourceTimestamp: now, freshnessBasis: "http-response-date" };
  }, now, harness.lease);
  assert.equal(status, "RUNNING");
  assert.equal(rpcCalls, 3);
  assert.equal(priceCalls, 1);
  assert.ok(harness.expiresAt > 211_000, "sequential calls may exceed the original 120-second lease");
});
