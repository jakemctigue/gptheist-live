import assert from "node:assert/strict";
import test from "node:test";
import { marketSyncArgsFromEnv, marketSyncEnabled, transactionSyncArgsFromEnv } from "../src/service.js";

test("production sync uses the stable three-month MongoDB checkpoint at one-second cadence", () => {
  const args = transactionSyncArgsFromEnv({});
  assert.deepEqual(args.slice(1), [
    "--scope", "pons-launches",
    "--months", "3",
    "--follow",
    "--poll-ms", "1000",
    "--confirmations", "1",
    "--batch-size", "100",
    "--job-id", "robinhood-three-months"
  ]);
});

test("market sync defaults to a 48-hour Ethereum and Solana import followed by polling", () => {
  assert.deepEqual(marketSyncArgsFromEnv({}).slice(1), [
    "--hours", "48",
    "--networks", "ethereum,solana",
    "--evm-batch-size", "10",
    "--follow",
    "--poll-ms", "5000"
  ]);
  assert.equal(marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "true", ALCHEMY_API_KEY: "configured" }), true);
  assert.equal(marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "false", ALCHEMY_API_KEY: "configured" }), false);
  assert.throws(() => marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "yes" }), /must be true or false/);
});

test("production sync accepts explicit operational overrides without putting secrets in arguments", () => {
  const args = transactionSyncArgsFromEnv({
    ROBINHOOD_POLL_MS: "750",
    TRANSACTION_SYNC_SCOPE: "all",
    TRANSACTION_SYNC_CONFIRMATIONS: "3",
    TRANSACTION_SYNC_BATCH_SIZE: "20",
    TRANSACTION_SYNC_JOB_ID: "durable-mainnet"
  });
  assert.deepEqual(args.slice(1), [
    "--scope", "all",
    "--months", "3",
    "--follow",
    "--poll-ms", "750",
    "--confirmations", "3",
    "--batch-size", "20",
    "--job-id", "durable-mainnet"
  ]);
});
