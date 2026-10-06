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

test("market sync recognizes stored dRPC endpoints for only the configured networks", () => {
  assert.equal(marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "true", DRPC_ETHEREUM_RPC_URL: "configured", DRPC_SOLANA_RPC_URL: "configured" }), true);
  assert.equal(marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "true", MARKET_IMPORT_NETWORKS: "ethereum", DRPC_ETHEREUM_RPC_URL: "configured" }), true);
  assert.equal(marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "true", MARKET_IMPORT_NETWORKS: "solana", DRPC_ETHEREUM_RPC_URL: "configured" }), false);
  assert.throws(() => marketSyncEnabled({ MARKET_TRANSACTION_SYNC_ENABLED: "true", MARKET_IMPORT_NETWORKS: "robinhood" }), /ethereum and\/or solana/);
});

test("market sync can bound checkpoint catch-up per tick", () => {
  const args = marketSyncArgsFromEnv({ MARKET_EVM_MAX_BLOCKS_PER_TICK: "100", MARKET_IMPORT_POLL_MS: "60000" });
  assert.deepEqual(args.slice(-4), ["--poll-ms", "60000", "--max-evm-blocks", "100"]);
  assert.throws(() => marketSyncArgsFromEnv({ MARKET_EVM_MAX_BLOCKS_PER_TICK: "0" }), /1 to 1000/);
  assert.throws(() => marketSyncArgsFromEnv({ MARKET_EVM_MAX_BLOCKS_PER_TICK: "100000" }), /1 to 1000/);
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
