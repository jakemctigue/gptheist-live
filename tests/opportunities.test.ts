import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { OpportunityMonitor } from "../src/opportunities.js";
import { assessPonsLaunch } from "../src/market.js";
import type { LiveLaunchDecision, LiveSnapshot, RpcCaller } from "../src/live.js";
import { createDeskServer } from "../src/server.js";

const token = `0x${"11".repeat(20)}`, curve = `0x${"22".repeat(20)}`;
const start = Date.parse("2026-09-29T12:00:00.000Z");
function snapshot(at: number, block: number, price = 10000, reserve = 10000): LiveSnapshot {
  const market = { status: "VERIFIED" as const, phase: "CURVE" as const, creatorFeeRecipient: `0x${"33".repeat(20)}`,
    creatorTaxBps: 100, buybackEnabled: false, quoteReserve: (BigInt(price) * 10n ** 24n).toString(),
    tokenReserve: (10n ** 36n).toString(), realQuoteReserve: (BigInt(reserve) * 10n ** 24n).toString(),
    graduationThreshold: (10n ** 32n).toString(), progressBps: 4000, currentSnipeTaxBps: 0 };
  const assessment = assessPonsLaunch("ETH", market);
  const launch: LiveLaunchDecision = { token, curve, deployer: market.creatorFeeRecipient,
    pairToken: `0x${"00".repeat(20)}`, launchConfigId: "0", graduationThreshold: market.graduationThreshold,
    blockNumber: 1, logIndex: 0, transactionHash: `0x${"44".repeat(32)}`, pairLabel: "ETH", market,
    metadata: { status: "UNAVAILABLE", reason: "Test metadata" }, assessment, verdict: assessment.verdict,
    handoffs: [], deployerResearch: { windowBlocks: 25000, priorLaunches: 0, priorGraduations: 0 } };
  return { chainId: 4663, headBlock: block, fetchedAt: new Date(at).toISOString(), source: "Robinhood Chain RPC",
    mode: "read-only", historyWindowBlocks: 25000, launches: [launch] };
}
function harness() {
  let now = start;
  const monitor = new OpportunityMonitor(() => now);
  const feed = (seconds: number, price = 10000, reserve = 10000, block = seconds + 1) => {
    now = start + seconds * 1000; monitor.observe(snapshot(now, block, price, reserve)); return monitor.read().opportunities[0]!;
  };
  const advance = (seconds: number) => { now = start + seconds * 1000; };
  const warm = () => { feed(0); feed(15, 10050, 10050); feed(30, 10100, 10100); feed(45, 10200, 10200); return feed(60, 10300, 10300); };
  return { monitor, feed, advance, warm };
}

test("requires real distinct-block history before suggesting an entry", () => {
  const h = harness();
  assert.equal(h.feed(0).signal, "WARMING_UP");
  assert.equal(h.feed(15).canReviewBuy, false);
  const entry = h.warm();
  assert.equal(entry.signal, "ENTRY_REVIEW");
  assert.equal(entry.momentumBps, 300);
  assert.equal(entry.liquidityChangeBps, 300);
  assert.equal(entry.priceIndex, 103);
  assert.equal(entry.score, 100);
  assert.equal(entry.canReviewBuy, true);
  assert.deepEqual(entry.plan, { entryLow: 101, entryHigh: 108, invalidation: 96, profitReview: 118.45, trailingReview: 96.82 });
  assert.match(entry.reasons.join(" "), /not a probability/);
});

test("blocks chasing fast pumps and requires positive real liquidity support", () => {
  const h = harness(); h.warm();
  assert.equal(h.feed(75, 14000, 14000).signal, "WAIT");
  const flat = harness(); flat.feed(0); flat.feed(15, 10100); flat.feed(30, 10200); flat.feed(45, 10300);
  assert.equal(flat.feed(60, 10400).canReviewBuy, false);
});

test("exit reviews respond to drawdowns and liquidity drains without claiming holdings", () => {
  const h = harness(); h.warm();
  const exit = h.feed(75, 9500, 9500);
  assert.equal(exit.signal, "EXIT_REVIEW");
  assert.equal(exit.canReviewBuy, false);
  assert.equal(exit.canReviewSell, true);
  assert.match(exit.reasons.join(" "), /If you hold/);
  const drain = harness(); drain.warm();
  assert.equal(drain.feed(75, 10400, 8000).signal, "EXIT_REVIEW");
});

test("RPC failure, stale samples, and a frozen chain immediately suppress review", () => {
  const h = harness(); h.warm(); h.monitor.markUnavailable();
  assert.equal(h.monitor.read().status, "STALE");
  assert.equal(h.monitor.read().opportunities[0]!.canReviewSell, false);
  h.feed(75, 10400, 10400); h.advance(121);
  assert.equal(h.monitor.read().opportunities[0]!.signal, "STALE");
  const frozen = harness(); frozen.feed(0, 10000, 10000, 1);
  for (const seconds of [15, 30, 45, 60]) frozen.feed(seconds, 11000, 11000, 1);
  assert.equal(frozen.monitor.read().status, "STALE");
  assert.equal(frozen.monitor.read().opportunities[0]!.samples, 1);
});

test("a long observation gap or backwards head rebuilds the history", () => {
  const h = harness(); h.warm();
  assert.equal(h.feed(120, 10400, 10400).signal, "WARMING_UP");
  assert.equal(h.monitor.read().opportunities[0]!.samples, 1);
  assert.equal(h.feed(135, 10000, 10000, 1).samples, 1);
});

test("unsupported venues, invalid reserves and high taxes cannot suggest a buy", () => {
  for (const mutation of [
    (s: LiveSnapshot) => { s.launches[0]!.market = { status: "UNAVAILABLE", reason: "No on-chain evidence" }; },
    (s: LiveSnapshot) => { if (s.launches[0]!.market.status === "VERIFIED") s.launches[0]!.market.phase = "POOL"; },
    (s: LiveSnapshot) => { if (s.launches[0]!.market.status === "VERIFIED") s.launches[0]!.market.tokenReserve = "0"; },
    (s: LiveSnapshot) => { s.launches[0]!.assessment = { verdict: "VETO", score: 60, reasons: [], blockers: ["High tax"], unknowns: [] }; }
  ]) {
    const h = harness(); h.warm(); const next = snapshot(start + 60000, 100, 10300, 10300); mutation(next); h.monitor.observe(next);
    assert.equal(h.monitor.read().opportunities[0]!.canReviewBuy, false);
  }
});

test("zero liquidity baseline does not invent a percentage and polling history is bounded", () => {
  const h = harness(); h.feed(0, 10000, 0); h.feed(15, 10100, 0); h.feed(30, 10200, 0); h.feed(45, 10300, 0);
  const row = h.feed(60, 10400, 10000);
  assert.equal(row.liquidityChangeBps, null); assert.equal(row.canReviewBuy, false);
  for (let seconds = 65; seconds <= 2000; seconds += 5) h.feed(seconds, 10400, 10000);
  assert.ok(h.monitor.read().opportunities[0]!.samples <= 180);
  assert.ok(h.monitor.read().opportunities[0]!.windowSeconds <= 900);
  h.advance(3700); assert.equal(h.monitor.retainedLaunches().length, 0);
});

test("HTTP opportunities are read-only and do not prepare or submit transactions", async (t) => {
  const calls: string[] = [];
  const rpc: RpcCaller = async (method) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x2000";
    if (method === "eth_getLogs") return [];
    throw new Error("Unexpected RPC");
  };
  const h = harness(), server = createDeskServer({ rpc, monitor: h.monitor });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fetch(`${base}/api/snapshot`); h.warm();
  const response = await fetch(`${base}/api/opportunities`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as ReturnType<OpportunityMonitor["read"]>;
  assert.equal(body.mode, "approval-required"); assert.equal(body.opportunities[0]!.signal, "ENTRY_REVIEW");
  assert.equal((await fetch(`${base}/api/opportunities`, { method: "POST", body: "{}" })).status, 405);
  assert.ok(calls.every((method) => ["eth_chainId", "eth_blockNumber", "eth_getLogs"].includes(method)));
  assert.equal((await fetch(`${base}/monitor.js`)).status, 200);
  assert.equal((await fetch(`${base}/monitor.css`)).status, 200);
});
