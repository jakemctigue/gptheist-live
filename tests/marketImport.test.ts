import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredSolanaPrograms,
  DEFAULT_SOLANA_PROGRAMS,
  EVM_MARKET_TOPICS,
  parseMarketImportArgs
} from "../src/marketImport.js";

test("market import defaults to a bounded 48-hour cross-chain backfill", () => {
  assert.deepEqual(parseMarketImportArgs([]), {
    plan: false,
    follow: false,
    hours: 48,
    pollMs: 5_000,
    ethereumConfirmations: 12,
    evmBatchSize: 50,
    solanaPageSize: 1_000,
    networks: ["ethereum", "solana"]
  });
  assert.deepEqual(parseMarketImportArgs(["--plan", "--networks", "solana", "--max-solana-pages", "2"]), {
    plan: true,
    follow: false,
    hours: 48,
    pollMs: 5_000,
    ethereumConfirmations: 12,
    evmBatchSize: 50,
    solanaPageSize: 1_000,
    networks: ["solana"],
    maxSolanaPages: 2
  });
  assert.throws(() => parseMarketImportArgs(["--networks", "bitcoin"]), /ethereum and\/or solana/);
  assert.throws(() => parseMarketImportArgs(["--plan", "--follow"]), /cannot be combined/);
});

test("market filters cover common EVM swap shapes and configured Solana programs", () => {
  assert.equal(Object.keys(EVM_MARKET_TOPICS).length, 6);
  assert.equal(Object.keys(configuredSolanaPrograms({})).length, Object.keys(DEFAULT_SOLANA_PROGRAMS).length);
  assert.deepEqual(configuredSolanaPrograms({ MARKET_SOLANA_PROGRAMS: "router:11111111111111111111111111111111" }), {
    router: "11111111111111111111111111111111"
  });
  assert.throws(() => configuredSolanaPrograms({ MARKET_SOLANA_PROGRAMS: "broken" }), /name:programId/);
});
