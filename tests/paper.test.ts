import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { LiveLaunchDecision } from "../src/live.js";
import { planPaperBook } from "../src/paper.js";
import { createDeskServer } from "../src/server.js";

const policy = { maxBuyWei: 50_000_000_000_000_000n, maxTotalFeeBps: 500, minBuyScore: 70 };

function launch(patch: { token: string; score: number; progressBps: number; symbol?: string; verdict?: "WATCH" | "VETO"; realQuoteReserve?: string }): LiveLaunchDecision {
  return {
    token: patch.token,
    curve: "0x2222222222222222222222222222222222222222",
    deployer: "0x3333333333333333333333333333333333333333",
    pairToken: "0x0000000000000000000000000000000000000000",
    launchConfigId: "0",
    graduationThreshold: "4200000000000000000",
    blockNumber: 10,
    transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    logIndex: 1,
    verdict: patch.verdict ?? "WATCH",
    pairLabel: "ETH",
    market: {
      status: "VERIFIED",
      creatorFeeRecipient: "0x0000000000000000000000000000000000000001",
      creatorTaxBps: 100,
      buybackEnabled: false,
      phase: "CURVE",
      quoteReserve: "1000000000000000000",
      tokenReserve: "1000000000000000000",
      realQuoteReserve: patch.realQuoteReserve ?? "10000000000000000000",
      graduationThreshold: "4200000000000000000",
      progressBps: patch.progressBps,
      currentSnipeTaxBps: 100
    },
    metadata: { status: "DECLARED", name: "Paper", symbol: patch.symbol ?? "PAPER", logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } },
    assessment: { verdict: patch.verdict ?? "WATCH", score: patch.score, reasons: [], blockers: [], unknowns: [] },
    handoffs: [],
    deployerResearch: { windowBlocks: 25_000, priorLaunches: 0, priorGraduations: 0 }
  };
}

test("paper book keeps the highest eligible curve and never marks a position executed", () => {
  const early = launch({ token: "0x1111111111111111111111111111111111111111", score: 80, progressBps: 400 });
  const better = launch({ token: "0x4444444444444444444444444444444444444444", score: 91, progressBps: 800, symbol: "BEST" });
  const late = launch({ token: "0x5555555555555555555555555555555555555555", score: 99, progressBps: 8_000 });
  const veto = launch({ token: "0x6666666666666666666666666666666666666666", score: 95, progressBps: 500, verdict: "VETO" });
  const book = planPaperBook([late, veto, early, better], policy, "0xAbcdef0000000000000000000000000000000001", { chainId: 4663, headBlock: 42 });
  assert.equal(book.mode, "paper-only");
  assert.equal(book.executed, false);
  assert.equal(book.account.kind, "alchemy-session");
  assert.deepEqual(book.positions.map((position) => position.symbol), ["BEST", "PAPER"]);
  assert.equal(book.positions[0]?.executed, false);
  assert.equal(book.positions[0]?.sizeWei, "50000000000000000");
  assert.equal(book.positions[1]?.sizeWei, "50000000000000000");
});

test("paper size uses one percent of real reserves when that is below the buy cap", () => {
  const thin = launch({ token: "0x1111111111111111111111111111111111111111", score: 80, progressBps: 400, realQuoteReserve: "2000000000000000000" });
  const book = planPaperBook([thin], policy, null, { chainId: 4663, headBlock: 7 });
  assert.equal(book.account.kind, "unconfigured");
  assert.equal(book.positions[0]?.sizeWei, "20000000000000000");
  assert.equal(book.positions[0]?.executed, false);
});

test("desk paper endpoint returns an empty executed-false book without live trading", async (t) => {
  const rpc = async (method: string): Promise<unknown> => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x2000";
    if (method === "eth_getLogs") return [];
    throw new Error(`unexpected method ${method}`);
  };
  const server = createDeskServer({ rpc });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/paper`);
  assert.equal(response.status, 200);
  const book = await response.json() as { mode: string; executed: boolean; positions: unknown[]; account: { kind: string } };
  assert.equal(book.mode, "paper-only");
  assert.equal(book.executed, false);
  assert.deepEqual(book.positions, []);
  assert.equal(book.account.kind, "unconfigured");
});
