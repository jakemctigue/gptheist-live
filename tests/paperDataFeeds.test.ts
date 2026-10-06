import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { createPaperEthUsdPriceReader, createPaperRpcCaller, paperRpcUrlsFromEnv } from "../src/paperDataFeeds.js";
import { initialPaperMarkUsdMicros, paperTick, paperTradingConfigFromEnv, quotePaperBuy, quotePaperSell, safePaperError } from "../src/paperTrading.js";

function rpcResponse(init: RequestInit | undefined, result: unknown): Response {
  const body = JSON.parse(String(init?.body)) as { id: number };
  return Response.json({ jsonrpc: "2.0", id: body.id, result });
}

test("paper RPC configuration respects explicit endpoints without silently adding another provider", () => {
  assert.deepEqual(paperRpcUrlsFromEnv({ ROBINHOOD_RPC_URL: "https://first.test/token#nologs, https://second.test/token", ALCHEMY_API_KEY: "not_used_key" }), ["https://first.test/token", "https://second.test/token"]);
  assert.throws(() => paperRpcUrlsFromEnv({ ROBINHOOD_RPC_URL: "http://first.test" }), /HTTPS/);
  assert.throws(() => paperRpcUrlsFromEnv({ ROBINHOOD_RPC_URL: "https://user:pass@first.test" }), /credentials/);
});

test("paper RPC rejects the Ethereum chain before sending market reads and falls back to verified Robinhood", async () => {
  const calls: string[] = [];
  const rpc = createPaperRpcCaller(["https://ethereum.test", "https://robinhood.test"], {
    fetcher: async (input, init) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      calls.push(`${String(input)}:${method}`);
      return rpcResponse(init, method === "eth_chainId" ? (String(input).includes("ethereum") ? "0x1" : "0x1237") : "0x42");
    }
  });
  assert.equal(await rpc("eth_blockNumber"), "0x42");
  assert.equal(await rpc("eth_gasPrice"), "0x42");
  assert.deepEqual(calls, ["https://ethereum.test:eth_chainId", "https://robinhood.test:eth_chainId", "https://robinhood.test:eth_blockNumber", "https://robinhood.test:eth_gasPrice"]);
});

test("429 Retry-After opens the RPC circuit across ticks without repeated retries", async () => {
  let time = 0;
  let firstCalls = 0;
  const rpc = createPaperRpcCaller(["https://limited.test", "https://healthy.test"], {
    now: () => time,
    fetcher: async (input, init) => {
      if (String(input).includes("limited")) { firstCalls += 1; return new Response("limited", { status: 429, headers: { "retry-after": "120" } }); }
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      return rpcResponse(init, method === "eth_chainId" ? "0x1237" : "0x42");
    }
  });
  assert.equal(await rpc("eth_blockNumber"), "0x42");
  time = 60_000;
  assert.equal(await rpc("eth_blockNumber"), "0x42");
  assert.equal(firstCalls, 1);
  time = 120_000;
  assert.equal(await rpc("eth_blockNumber"), "0x42");
  assert.equal(firstCalls, 2);
});

test("RPC circuit handles HTTP-date Retry-After and does not echo secrets", async () => {
  let calls = 0;
  const secretUrl = "https://provider.test/private_secret_token";
  const time = Date.parse("2026-10-06T12:00:00Z");
  const rpc = createPaperRpcCaller([secretUrl], {
    now: () => time,
    fetcher: async () => { calls += 1; return new Response("", { status: 429, headers: { "retry-after": new Date(time + 180_000).toUTCString() } }); }
  });
  await assert.rejects(rpc("eth_chainId"), (error: unknown) => error instanceof Error && /429/.test(error.message) && !error.message.includes("private_secret_token"));
  await assert.rejects(rpc("eth_chainId"), /cooling down/);
  assert.equal(calls, 1);
});

test("paper RPC never sends a transaction, signature, or unsupported method", async () => {
  let calls = 0;
  const rpc = createPaperRpcCaller(["https://provider.test"], { fetcher: async () => { calls += 1; throw new Error("should never call"); } });
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_getLogs"]) {
    await assert.rejects(rpc(method), /not permitted/);
  }
  assert.equal(calls, 0);
});

test("optional contract reverts do not disable a healthy RPC or echo provider error text", async () => {
  const rpc = createPaperRpcCaller(["https://healthy.test"], { fetcher: async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method === "eth_call") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "execution reverted secret_provider_key" } });
    return rpcResponse(init, body.method === "eth_chainId" ? "0x1237" : "0x42");
  } });
  await assert.rejects(rpc("eth_call", [{}]), (error: unknown) => error instanceof Error && error.message === "RPC application error (-32000)");
  assert.equal(await rpc("eth_gasPrice"), "0x42");
});

test("Coinbase ETH/USD reader caches valid observations with honest response-date provenance", async () => {
  let time = Date.parse("2026-10-06T12:00:00Z");
  let calls = 0;
  const read = createPaperEthUsdPriceReader({ PAPER_ETH_USD_PROVIDERS: "coinbase" }, {
    now: () => time,
    fetcher: async (input) => {
      assert.equal(String(input), "https://api.coinbase.com/v2/prices/ETH-USD/spot");
      calls += 1;
      return Response.json({ data: { base: "ETH", currency: "USD", amount: "2200.125" } }, { headers: { date: new Date(time).toUTCString() } });
    }
  });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(first.usdMicros, 2_200_125_000);
  assert.equal(second.observedAt.getTime(), time);
  assert.equal(first.provider, "coinbase");
  assert.equal(first.freshnessBasis, "http-response-date");
  assert.equal(calls, 1);
  time += 59_000;
  assert.equal((await read()).observedAt.getTime(), time - 59_000);
  assert.equal(calls, 1);
  time += 2_000;
  assert.equal((await read()).observedAt.getTime(), time);
  assert.equal(calls, 2);
});

test("Coinbase marks reject wrong currency, wrong asset, malformed amount, missing or stale date", async () => {
  const time = Date.parse("2026-10-06T12:00:00Z");
  const valid = { base: "ETH", currency: "USD", amount: "2200" };
  for (const [data, headers] of [
    [{ ...valid, currency: "EUR" }, { date: new Date(time).toUTCString() }],
    [{ ...valid, base: "BTC" }, { date: new Date(time).toUTCString() }],
    [{ ...valid, amount: "NaN" }, { date: new Date(time).toUTCString() }],
    [valid, {}],
    [valid, { date: new Date(time - 121_000).toUTCString() }],
    [valid, { date: new Date(time + 31_000).toUTCString() }],
    [valid, { date: new Date(time).toUTCString(), age: "180" }]
  ] as const) {
    const read = createPaperEthUsdPriceReader({ PAPER_ETH_USD_PROVIDERS: "coinbase" }, {
      now: () => time, fetcher: async () => Response.json({ data }, { headers })
    });
    await assert.rejects(read(), /schema or freshness check failed/);
  }
});

test("price cache is not reused after the clock moves behind its observation", async () => {
  let time = Date.parse("2026-10-06T12:00:00Z");
  let calls = 0;
  const read = createPaperEthUsdPriceReader({ PAPER_ETH_USD_PROVIDERS: "coinbase" }, {
    now: () => time,
    fetcher: async () => {
      calls += 1;
      return Response.json({ data: { base: "ETH", currency: "USD", amount: String(2_000 + calls) } }, { headers: { date: new Date(time).toUTCString() } });
    }
  });
  assert.equal((await read()).usdMicros, 2_001_000_000);
  time -= 60_000;
  assert.equal((await read()).usdMicros, 2_002_000_000);
  assert.equal(calls, 2);
});

test("paper entries exclude future-dated imported launches before any market research", async () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const run = {
    startingUsdMicros: 20_000_000, cashUsdMicros: 20_000_000,
    startedAt: new Date(now.getTime() - 3_600_000), endsAt: new Date(now.getTime() + 3_600_000), status: "RUNNING"
  } as Parameters<typeof paperTick>[2];
  let timestampFilter: unknown;
  const runUpdates: Record<string, unknown>[] = [];
  const emptyCursor = { sort: () => emptyCursor, limit: () => emptyCursor, next: async () => null, toArray: async () => [] };
  const futureCursor = { sort: () => futureCursor, limit: () => futureCursor, toArray: async () => [{
    timestamp: new Date(now.getTime() + 60_000), blockNumber: 10,
    ponsLaunches: [{ transactionHash: "0xfuture", logIndex: 0, blockNumber: 10, pairToken: "0x0000000000000000000000000000000000000000" }]
  }] };
  const database = { collection: (name: string) => {
    if (name === "paper_trade_runs") return { findOne: async () => run, updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => { runUpdates.push(update.$set); } };
    if (name === "robinhood_transactions") return { find: (filter: { timestamp: unknown }) => { timestampFilter = filter.timestamp; return futureCursor; } };
    return { findOne: async () => null, find: () => emptyCursor };
  } } as unknown as Db;
  const rpcMethods: string[] = [];
  const rpc = async (method: string): Promise<unknown> => {
    rpcMethods.push(method);
    if (method === "eth_call") throw new Error("future launch reached market research");
    return method === "eth_chainId" ? "0x1237" : "0x42";
  };
  const status = await paperTick(database, rpc, run, paperTradingConfigFromEnv({}), async () => ({
    usdMicros: 2_000_000_000, provider: "coinbase", observedAt: now, sourceTimestamp: now, freshnessBasis: "http-response-date"
  }), now);
  assert.equal(status, "RUNNING");
  assert.deepEqual(timestampFilter, { $gte: new Date(now.getTime() - 900_000), $lte: now });
  assert.deepEqual(rpcMethods, ["eth_chainId", "eth_blockNumber", "eth_gasPrice"]);
  const totals = runUpdates.filter((update) => "entryCount" in update);
  assert.equal(totals[0]?.lastSuccessfulTickAt, undefined, "partial accounting must not stamp successful observation freshness");
  assert.equal(totals[1]?.lastSuccessfulTickAt, now);
});

test("expired cached marks fail closed when provider fails instead of repricing with stale USD", async () => {
  let time = Date.parse("2026-10-06T12:00:00Z");
  let calls = 0;
  const read = createPaperEthUsdPriceReader({ PAPER_ETH_USD_PROVIDERS: "coinbase" }, {
    now: () => time,
    fetcher: async () => {
      calls += 1;
      return calls === 1 ? Response.json({ data: { currency: "USD", amount: "2000" } }, { headers: { date: new Date(time).toUTCString() } }) : new Response("", { status: 429, headers: { "retry-after": "120" } });
    }
  });
  await read();
  time += 61_000;
  await assert.rejects(read(), /429/);
  await assert.rejects(read(), /cooling down/);
  assert.equal(calls, 2);
});

test("explicit price fallback uses Coinbase after Alchemy failure and validates Alchemy timestamps", async () => {
  const time = Date.parse("2026-10-06T12:00:00Z");
  const key = "secret_for_test";
  const read = createPaperEthUsdPriceReader({ PAPER_ETH_USD_PROVIDERS: "alchemy,coinbase", ALCHEMY_API_KEY: key }, {
    now: () => time,
    fetcher: async (input) => String(input).includes("alchemy") ? new Response("", { status: 403 }) : Response.json({ data: { base: "ETH", currency: "USD", amount: "2000" } }, { headers: { date: new Date(time).toUTCString() } })
  });
  assert.equal((await read()).provider, "coinbase");
  const stale = createPaperEthUsdPriceReader({ ALCHEMY_API_KEY: key }, {
    now: () => time, fetcher: async () => Response.json({ data: [{ symbol: "ETH", prices: [{ currency: "usd", value: "2000", lastUpdatedAt: new Date(time - 121_000).toISOString() }] }] })
  });
  await assert.rejects(stale(), /freshness check failed/);
});

test("initial position equity uses the same cost-deducted reverse quote as later marks", () => {
  const quoteReserve = "100000000000000000000";
  const tokenReserve = "5000000000000000000000";
  const buy = quotePaperBuy(quoteReserve, tokenReserve, "1000000000000000", 200, 300);
  const sell = quotePaperSell(quoteReserve, tokenReserve, buy.modeledTokenOut, 200, 300);
  const gas = 100000000000n;
  const mark = initialPaperMarkUsdMicros(quoteReserve, tokenReserve, buy.modeledTokenOut, 200, 300, gas, 2_000_000_000);
  const expected = Number((BigInt(sell.modeledQuoteOutWei) - gas) * 2_000_000_000n / 1_000_000_000_000_000_000n);
  assert.equal(mark, expected);
  assert.ok(mark > 0 && mark < 2_000_000);
  assert.equal(initialPaperMarkUsdMicros(quoteReserve, tokenReserve, buy.modeledTokenOut, 200, 300, 100000000000000000000n, 2_000_000_000), 0);
});

test("flat month completion and daily entry exhaustion skip all external data feeds", async () => {
  const now = new Date("2026-10-06T12:00:00Z");
  for (const complete of [true, false]) {
    const lastEntry = { openedAt: now };
    const updates: Record<string, unknown>[] = [];
    const run = { startingUsdMicros: 20_000_000, endsAt: new Date(now.getTime() + (complete ? -1 : 1)), status: "RUNNING" } as Parameters<typeof paperTick>[2];
    const cursor = { sort: () => cursor, limit: () => cursor, next: async () => lastEntry, toArray: async () => [] };
    const database = { collection: (name: string) => name === "paper_trade_runs" ? {
      updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => { updates.push(update.$set); }
    } : { findOne: async () => null, find: () => cursor } } as unknown as Db;
    let externalCalls = 0;
    const fail = async (): Promise<never> => { externalCalls += 1; throw new Error("no feed request expected"); };
    const status = await paperTick(database, fail, run, paperTradingConfigFromEnv({}), fail, now);
    assert.equal(status, complete ? "COMPLETE" : "RUNNING");
    assert.equal(externalCalls, 0);
    assert.equal(updates[0]?.tickDisposition, complete ? "MONTH_END_FLAT" : "DAILY_ENTRY_LIMIT");
    assert.equal(updates[1]?.lastSuccessfulTickAt, now);
  }
});

test("paper errors redact individual URLs in a fallback list and new dRPC secrets", () => {
  const first = "https://first.test/secretA";
  const second = "https://second.test/secretB";
  const result = safePaperError(new Error(`${first} ${second} secret_drpc_key`), { ROBINHOOD_RPC_URL: `${first},${second}`, DRPC_API_KEY: "secret_drpc_key" });
  assert.equal(result, "<redacted> <redacted> <redacted>");
});
