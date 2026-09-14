import assert from "node:assert/strict";
import test from "node:test";
import { transactionSyncArgsFromEnv } from "../src/service.js";

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
