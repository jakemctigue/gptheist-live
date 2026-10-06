import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredSolanaMarkets,
  DEFAULT_SOLANA_MARKETS,
  EVM_MARKET_POOLS,
  EVM_MARKET_TOPICS,
  parseMarketImportArgs,
  marketRpcEndpoint,
  verifyMarketRpcNetwork,
  SOLANA_MAINNET_GENESIS_HASH,
  ethereumResumeBlock,
  JsonRpcClient,
  evmLogs,
  storeEvmRange
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

test("market endpoints use explicit network URLs, then stored dRPC aliases, then optional Alchemy", () => {
  const env = {
    DRPC_ETHEREUM_RPC_URL: "https://lb.drpc.live/ethereum/test-key",
    DRPC_SOLANA_RPC_URL: "https://lb.drpc.live/solana/test-key",
    ALCHEMY_API_KEY: "legacy_test_key"
  };
  assert.equal(marketRpcEndpoint("ethereum", env), env.DRPC_ETHEREUM_RPC_URL);
  assert.equal(marketRpcEndpoint("solana", env), env.DRPC_SOLANA_RPC_URL);
  assert.equal(marketRpcEndpoint("ethereum", { ...env, ETHEREUM_RPC_URL: "https://explicit.test/eth" }), "https://explicit.test/eth");
  assert.equal(marketRpcEndpoint("ethereum", { ALCHEMY_API_KEY: env.ALCHEMY_API_KEY }), "https://eth-mainnet.g.alchemy.com/v2/legacy_test_key");
  assert.throws(() => marketRpcEndpoint("ethereum", { DRPC_ETHEREUM_RPC_URL: env.DRPC_SOLANA_RPC_URL }), /wrong network/);
  assert.throws(() => marketRpcEndpoint("ethereum", { ETHEREUM_RPC_URL: "https://user:secret@rpc.test" }), /embedded credentials/);
  assert.throws(() => marketRpcEndpoint("ethereum", { ETHEREUM_RPC_URL: "http://rpc.test" }), /HTTPS/);
  assert.throws(() => marketRpcEndpoint("solana", {}), /Missing ALCHEMY_API_KEY/);
});

test("market ingestion checks Ethereum chain 1 and Solana mainnet before touching MongoDB", async () => {
  await verifyMarketRpcNetwork("ethereum", { call: async () => "0x1" });
  await assert.rejects(verifyMarketRpcNetwork("ethereum", { call: async () => "0x1237" }), /expected Ethereum mainnet/);
  assert.equal(SOLANA_MAINNET_GENESIS_HASH, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  await verifyMarketRpcNetwork("solana", { call: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
  await assert.rejects(verifyMarketRpcNetwork("solana", { call: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), /mainnet-beta/);
  await assert.rejects(verifyMarketRpcNetwork("solana", { call: async () => "devnet-genesis" }), /mainnet-beta/);
});

test("resuming Ethereum reuses the checkpoint instead of binary searching history every poll", async () => {
  let historySearches = 0;
  const findStart = async (): Promise<number> => { historySearches += 1; return 100; };
  assert.equal(await ethereumResumeBlock(null, findStart), 100);
  for (let poll = 0; poll < 100; poll += 1) assert.equal(await ethereumResumeBlock({ nextBlock: 101 + poll }, findStart), 101 + poll);
  assert.equal(historySearches, 1);
  await assert.rejects(ethereumResumeBlock({ nextBlock: Number.NaN }, findStart), /Invalid Ethereum checkpoint/);
});

test("RPC denies paid-plan errors immediately, bounds rate-limit attempts, and honors Retry-After", async () => {
  let requests = 0;
  const waits: number[] = [];
  const denied = new JsonRpcClient("https://private.test/secret", "Solana", (async () => {
    requests += 1;
    return Response.json({ error: { message: "paid plan required for https://private.test/secret" } }, { status: 400 });
  }) as typeof fetch, async (ms) => { waits.push(ms); });
  await assert.rejects(denied.call("getGenesisHash"), /HTTP 400: paid plan required for <rpc>/);
  assert.equal(requests, 1);
  const limited = new JsonRpcClient("https://private.test/secret", "Ethereum", (async () => {
    requests += 1;
    return new Response("not json", { status: 429, headers: { "retry-after": "2" } });
  }) as typeof fetch, async (ms) => { waits.push(ms); });
  await assert.rejects(limited.call("eth_blockNumber"), /HTTP 429/);
  assert.equal(requests, 4);
  assert.ok(waits.filter((ms) => ms === 2000).length >= 2);
});

test("RPC batch retries only failed items and restores requested order", async () => {
  const batches: number[][] = [];
  const rpc = new JsonRpcClient("https://private.test/secret", "Ethereum", (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Array<{ id: number }>;
    batches.push(body.map((item) => item.id));
    return Response.json(batches.length === 1
      ? [{ jsonrpc: "2.0", id: body[1]!.id, error: { code: 429, message: "rate limit" } }, { jsonrpc: "2.0", id: body[0]!.id, result: "first" }]
      : [{ jsonrpc: "2.0", id: body[0]!.id, result: "second" }]);
  }) as typeof fetch, async () => undefined);
  assert.deepEqual(await rpc.batch([{ method: "eth_getTransactionReceipt", params: ["first"] }, { method: "eth_getTransactionReceipt", params: ["second"] }]), ["first", "second"]);
  assert.deepEqual(batches, [[1, 2], [2]]);
});

test("RPC chunks batches to 20 and rejects malformed or mismatched responses without retries", async () => {
  const sizes: number[] = [];
  const rpc = new JsonRpcClient("https://private.test/secret", "Ethereum", (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Array<{ id: number }>;
    sizes.push(body.length);
    return Response.json(body.map((item) => ({ jsonrpc: "2.0", id: item.id, result: item.id })));
  }) as typeof fetch, async () => undefined);
  assert.equal((await rpc.batch(Array.from({ length: 45 }, () => ({ method: "eth_getTransactionReceipt", params: [] })))).length, 45);
  assert.deepEqual(sizes, [20, 20, 5]);
  let calls = 0;
  const invalid = new JsonRpcClient("https://private.test/secret", "Ethereum", (async () => {
    calls += 1;
    return Response.json({ jsonrpc: "2.0", id: 999, result: "0x1" });
  }) as typeof fetch, async () => undefined);
  await assert.rejects(invalid.call("eth_chainId"), /invalid response/);
  assert.equal(calls, 1);
});

test("RPC batch HTTP 500 falls back to paced individual calls within the original attempt budget", async () => {
  const calls: Array<string | string[]> = [];
  const rpc = new JsonRpcClient("https://private.test/secret", "Ethereum", (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: string[] } | Array<{ params: string[] }>;
    if (Array.isArray(body)) { calls.push(body.map((item) => item.params[0]!)); return new Response("", { status: 500 }); }
    calls.push(body.params[0]!);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.params[0] });
  }) as typeof fetch, async () => undefined);
  assert.deepEqual(await rpc.batch(["first", "second"].map((hash) => ({ method: "eth_getTransactionReceipt", params: [hash] }))), ["first", "second"]);
  assert.deepEqual(calls, [["first", "second"], "first", "second"]);
  let attempts = 0;
  const unavailable = new JsonRpcClient("https://private.test/secret", "Ethereum", (async () => { attempts += 1; return new Response("", { status: 500 }); }) as typeof fetch, async () => undefined);
  await assert.rejects(unavailable.batch([{ method: "eth_getTransactionReceipt", params: ["missing"] }]), /HTTP 500/);
  assert.equal(attempts, 3);
});

test("historical numeric state errors use exact canonical blockHash log filters without skipping history", async () => {
  const methods: string[] = [];
  const blockHash = `0x${"a".repeat(64)}`;
  const rpc = new JsonRpcClient("https://private.test/secret", "Ethereum", (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<Record<string, unknown> | string | boolean> };
    methods.push(body.method);
    if (methods.length === 1) return Response.json({ error: { code: 27, message: "Unknown state. First available state is 1" } }, { status: 400 });
    if (body.method === "eth_getBlockByNumber") return Response.json({ jsonrpc: "2.0", id: body.id, result: { number: "0xa", hash: blockHash, timestamp: "0x1", transactions: [] } });
    const filter = body.params[0] as Record<string, unknown>;
    assert.equal(filter.blockHash, blockHash);
    assert.equal(filter.fromBlock, undefined);
    assert.deepEqual(filter.address, Object.values(EVM_MARKET_POOLS));
    return Response.json({ jsonrpc: "2.0", id: body.id, result: [{ address: Object.values(EVM_MARKET_POOLS)[0], blockNumber: "0xa", blockHash, transactionHash: `0x${"b".repeat(64)}`, transactionIndex: "0x0", logIndex: "0x0", data: "0x", topics: [Object.keys(EVM_MARKET_TOPICS)[0]] }] });
  }) as typeof fetch, async () => undefined);
  assert.equal((await evmLogs(rpc, 10, 10)).length, 1);
  assert.deepEqual(methods, ["eth_getLogs", "eth_getBlockByNumber", "eth_getLogs"]);
});

test("historical blockHash recovery rejects contradictory headers before advancing", async () => {
  let calls = 0;
  const rpc = new JsonRpcClient("https://private.test/secret", "Ethereum", (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number };
    calls += 1;
    if (calls === 1) return Response.json({ error: { message: "Unknown state" } }, { status: 400 });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { number: "0xb", hash: `0x${"a".repeat(64)}`, timestamp: "0x1", transactions: [] } });
  }) as typeof fetch, async () => undefined);
  await assert.rejects(evmLogs(rpc, 10, 10), /Invalid Ethereum (header|block)/);
  assert.equal(calls, 2);
});

test("Ethereum hydration fails closed on reorgs, missing transactions, and inconsistent receipts", async () => {
  const hash = `0x${"b".repeat(64)}`;
  const blockHash = `0x${"a".repeat(64)}`;
  const log = { address: Object.values(EVM_MARKET_POOLS)[0], blockNumber: "0xa", blockHash, transactionHash: hash, transactionIndex: "0x0", logIndex: "0x0", data: "0x", topics: [Object.keys(EVM_MARKET_TOPICS)[0]] };
  const transaction = { hash, transactionIndex: "0x0", value: "0x0", gas: "0x1" };
  const receipt = { blockNumber: "0xa", blockHash, transactionHash: hash, gasUsed: "0x1", effectiveGasPrice: "0x1" };
  for (const scenario of ["reorg", "missing-transaction", "missing-receipt", "wrong-receipt", "valid"]) {
    let writes = 0;
    const rpc = new JsonRpcClient("https://private.test/secret", "Ethereum", (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string } | Array<{ id: number }>;
      if (Array.isArray(body)) return Response.json(body.map((item) => ({ jsonrpc: "2.0", id: item.id, result: scenario === "missing-receipt" ? null : { ...receipt, ...(scenario === "wrong-receipt" ? { blockHash: `0x${"c".repeat(64)}` } : {}) } })));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_getLogs" ? [log] : {
        number: "0xa", hash: scenario === "reorg" ? `0x${"c".repeat(64)}` : blockHash, timestamp: "0x1", transactions: scenario === "missing-transaction" ? [] : [transaction]
      } });
    }) as typeof fetch, async () => undefined);
    const collection = { bulkWrite: async () => { writes += 1; return { upsertedCount: 1 }; } } as unknown as Parameters<typeof storeEvmRange>[1];
    if (scenario === "valid") assert.equal(await storeEvmRange(rpc, collection, 10, 10, "backfill"), 1);
    else await assert.rejects(storeEvmRange(rpc, collection, 10, 10, "backfill"), /changed while hydrating|Missing Ethereum|Inconsistent Ethereum/);
    assert.equal(writes, scenario === "valid" ? 1 : 0);
  }
});

test("market filters cover common swap shapes and liquid ETH/SOL stablecoin pools", () => {
  assert.equal(Object.keys(EVM_MARKET_TOPICS).length, 6);
  assert.equal(Object.keys(EVM_MARKET_POOLS).length, 5);
  assert.equal(Object.keys(configuredSolanaMarkets({})).length, Object.keys(DEFAULT_SOLANA_MARKETS).length);
  assert.deepEqual(configuredSolanaMarkets({ MARKET_SOLANA_MARKETS: "pool:11111111111111111111111111111111" }), {
    pool: "11111111111111111111111111111111"
  });
  assert.throws(() => configuredSolanaMarkets({ MARKET_SOLANA_MARKETS: "broken" }), /name:address/);
});
