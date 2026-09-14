import assert from "node:assert/strict";
import test from "node:test";
import { fetchDeployerHistory } from "../src/history.js";
import { POOL_GRADUATED_TOPIC, PONS_FACTORY, TOKEN_LAUNCHED_TOPIC, type RpcCaller, type RpcLog } from "../src/live.js";

const deployer = "0x3333333333333333333333333333333333333333";
const curve = "0x2222222222222222222222222222222222222222";
const pair = "0x0000000000000000000000000000000000000000";
const oldToken = "0x1111111111111111111111111111111111111111";
const selectedToken = "0x4444444444444444444444444444444444444444";
const word = (value: string): string => value.replace(/^0x/, "").padStart(64, "0");
const topic = (value: string): string => `0x${word(value)}`;

function launch(token: string, blockNumber: number, logIndex: number): RpcLog {
  return {
    address: PONS_FACTORY,
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: `0x${String(blockNumber).padStart(64, "0")}`,
    logIndex: `0x${logIndex.toString(16)}`,
    topics: [TOKEN_LAUNCHED_TOPIC, topic(token), topic(curve), topic(deployer)],
    data: `0x${word(pair)}${word("0x0")}${word("0x3a4")}`
  };
}

test("loads an exact 30-day block boundary and counts a deployer's prior launch outcomes", async () => {
  const methods: string[] = [];
  const rpc: RpcCaller = async (method, params = []) => {
    methods.push(method);
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getBlockByNumber") {
      const block = Number.parseInt(String(params[0]).slice(2), 16);
      return { number: params[0], timestamp: `0x${(block * 300).toString(16)}` };
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as { topics: unknown[] };
      if (filter.topics[0] === TOKEN_LAUNCHED_TOPIC) return [launch(oldToken, 2_000, 0), launch(selectedToken, 9_999, 1)];
      if (filter.topics[0] === POOL_GRADUATED_TOPIC) return [{
        address: PONS_FACTORY,
        blockNumber: "0xbb8",
        transactionHash: `0x${"a".repeat(64)}`,
        logIndex: "0x0",
        topics: [POOL_GRADUATED_TOPIC, topic(oldToken)],
        data: "0x"
      }];
    }
    throw new Error(`unexpected method ${method}`);
  };

  const result = await fetchDeployerHistory(rpc, {
    deployer,
    beforeBlock: 9_999,
    beforeLogIndex: 1,
    days: 30
  });
  assert.equal(result.historyWindowDays, 30);
  assert.equal(result.fromBlock, 1_360);
  assert.equal(result.toBlock, 10_000);
  assert.equal(result.historyWindowBlocks, 8_641);
  assert.equal(result.priorLaunches, 1);
  assert.equal(result.priorGraduations, 1);
  assert.equal(result.fromTimestamp, "1970-01-05T17:20:00.000Z");
  assert.equal(methods.filter((method) => method === "eth_getLogs").length, 2);
  assert.equal(methods.filter((method) => method === "eth_getBlockByNumber").length > 10, true);
});

test("rejects malformed deployer history requests before RPC access", async () => {
  let calls = 0;
  await assert.rejects(
    fetchDeployerHistory(async () => { calls += 1; return null; }, { deployer: "not-an-address", beforeBlock: 1, beforeLogIndex: 0 }),
    /20-byte address/
  );
  assert.equal(calls, 0);
});
