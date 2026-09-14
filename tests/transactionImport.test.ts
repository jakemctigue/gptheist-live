import assert from "node:assert/strict";
import test from "node:test";
import {
  findFirstBlockAtOrAfter,
  normalizeTransaction,
  parseHexQuantity,
  parseImportArgs,
  redactRuntimeError,
  subtractUtcMonths
} from "../src/transactionImport.js";

test("subtractUtcMonths clamps month-end dates", () => {
  assert.equal(subtractUtcMonths(new Date("2026-05-31T12:34:56.000Z"), 3).toISOString(), "2026-02-28T12:34:56.000Z");
});

test("parseImportArgs applies defaults and validates batch size", () => {
  assert.deepEqual(parseImportArgs(["--plan", "--months", "3", "--max-blocks", "250"]), {
    plan: true,
    follow: false,
    scope: "pons-launches",
    months: 3,
    confirmations: 64,
    batchSize: 25,
    sampleSize: 32,
    pollMs: 1_000,
    maxBlocks: 250
  });
  assert.throws(() => parseImportArgs(["--batch-size", "101"]), /cannot exceed 100/);
  assert.deepEqual(parseImportArgs(["--follow", "--poll-ms", "1000", "--confirmations", "1"]), {
    plan: false,
    follow: true,
    scope: "pons-launches",
    months: 3,
    confirmations: 1,
    batchSize: 25,
    sampleSize: 32,
    pollMs: 1_000
  });
  assert.throws(() => parseImportArgs(["--follow", "--poll-ms", "100"]), /must be from 250 to 60000/);
  assert.throws(() => parseImportArgs(["--scope", "everything"]), /must be pons-launches or all/);
  assert.throws(() => parseImportArgs(["--plan", "--follow"]), /cannot be combined/);
});

test("findFirstBlockAtOrAfter returns the lower timestamp boundary", async () => {
  const result = await findFirstBlockAtOrAfter(100, 550, async (blockNumber) => ({ timestamp: blockNumber * 10 }));
  assert.equal(result, 55);
});

test("redactRuntimeError removes database credentials and hosted RPC keys", () => {
  assert.equal(
    redactRuntimeError("mongodb+srv://user:pass@example.test/db https://chain.example/v2/secret_key"),
    "mongodb+srv://<credentials>@example.test/db https://chain.example/v2/<key>"
  );
});

test("normalizeTransaction creates queryable block and address fields", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  const hash = `0x${"a".repeat(64)}`;
  const from = `0x${"b".repeat(40)}`;
  const to = `0x${"c".repeat(40)}`;
  const block = {
    number: "0x2a",
    hash: `0x${"d".repeat(64)}`,
    timestamp: "0x64",
    transactions: []
  };
  const result = normalizeTransaction({
    hash,
    from,
    to,
    blockNumber: "0x2a",
    transactionIndex: "0x3",
    value: "0xde0b6b3a7640000",
    gas: "0x5208",
    gasPrice: "0x3b9aca00",
    nonce: "0x7",
    type: "0x2",
    input: "0x1234"
  }, { ...block, baseFeePerGas: "0x1dcd6500" }, now, "follow");
  assert.equal(result.chainId, 4_663);
  assert.equal(result.blockNumber, 42);
  assert.equal(result.transactionIndex, 3);
  assert.equal(result.timestamp.toISOString(), "1970-01-01T00:01:40.000Z");
  assert.equal(result.valueWei, "1000000000000000000");
  assert.equal(result.gasLimit, "21000");
  assert.equal(result.gasPriceWei, "1000000000");
  assert.equal(result.nonce, 7);
  assert.equal(result.transactionType, 2);
  assert.equal(result.functionSelector, null);
  assert.equal(result.inputBytes, 2);
  assert.equal(result.blockBaseFeePerGasWei, "500000000");
  assert.equal(result.ingestionMode, "follow");
  assert.equal(result.scope, "all");
  assert.deepEqual(result.ponsLaunches, []);
  assert.equal(result.ingestionLagMs, now.getTime() - 100_000);
  assert.equal(parseHexQuantity("0x2a", "test"), 42);
});
