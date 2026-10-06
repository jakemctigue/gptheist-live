import test from "node:test";
import assert from "node:assert/strict";
import { createResearchFeeds, parseOrder, SOL_MINT, USDC_MINT } from "../src/researchFeeds.js";
const now = "2026-10-06T00:05:00.000Z";
function order(inputMint = USDC_MINT, outputMint = SOL_MINT, amount = "1000000", output = "8000000") {
  return { inputMint, outputMint, inAmount: amount, outAmount: output, router: "metis", feeBps: 5, routePlan: [{ swapInfo: { label: "test" } }], signatureFeeLamports: 5000, prioritizationFeeLamports: 1000, rentFeeLamports: 0, transaction: null };
}
test("quote amounts remain fee-inclusive; missing fees stay unknown and transactions are not stored", () => {
  const raw = { ...order(), signatureFeeLamports: undefined, transaction: "do-not-store" };
  const quote = parseOrder(raw, USDC_MINT, SOL_MINT, "1000000", now, now);
  assert.equal(quote.outputAmount, "8000000"); assert.equal(quote.externalFeeLamports, null);
  assert.equal(quote.raw.transaction, undefined);
});
test("quote validation rejects wrong assets, amounts and expired prices", () => {
  assert.throws(() => parseOrder(order(SOL_MINT), USDC_MINT, SOL_MINT, "1000000", now, now));
  assert.throws(() => parseOrder({ ...order(), expireAt: now }, USDC_MINT, SOL_MINT, "1000000", now, now));
});
test("reverse request uses exact net output and requests are paced without signing", async () => {
  let ms = Date.parse(now); const urls: string[] = [];
  const feeds = createResearchFeeds("test-secret", { clock: () => ms, sleep: async n => { ms += n; }, fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url)); assert.equal(init?.method, undefined);
    const q = new URL(String(url)).searchParams;
    return new Response(JSON.stringify(order(q.get("inputMint")!, q.get("outputMint")!, q.get("amount")!, urls.length === 1 ? "8000000" : "990000")), { status: 200 });
  }) as typeof fetch });
  const result = await feeds.quotePair("1000000");
  assert.equal(new URL(urls[1]!).searchParams.get("amount"), "8000000");
  assert.equal(result.reverse.outputAmount, "990000"); assert.ok(ms >= Date.parse(now) + 1100);
  assert.ok(urls.every(u => !u.includes("test-secret") && !u.includes("execute")));
});
test("missing key and retries are bounded and secret-safe", async () => {
  const missing = createResearchFeeds(undefined);
  await assert.rejects(missing.quotePair("1000000"), /JUPITER_KEY_MISSING/);
  let attempts = 0;
  const feeds = createResearchFeeds("secret", { sleep: async () => {}, fetcher: (async () => { attempts++; return new Response("sensitive-body", { status: 429 }); }) as typeof fetch });
  await assert.rejects(feeds.quotePair("1000000"), /HTTP_429/); assert.equal(attempts, 2);
});
