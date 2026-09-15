import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, encodeFunctionResult, parseAbi, toHex } from "viem";
import { PONS_FACTORY, type RpcCaller } from "../src/live.js";
import {
  ERC20_APPROVE_SELECTOR,
  MemorySmartAccountGrantStore,
  PONS_BUY_SELECTOR,
  PONS_SELL_SELECTOR,
  SmartAccountCoordinator,
  SmartAccountError
} from "../src/smartAccount.js";

const owner = "0x3333333333333333333333333333333333333333" as const;
const token = "0x1111111111111111111111111111111111111111" as const;
const curve = "0x2222222222222222222222222222222222222222" as const;
const smartAccount = "0x4444444444444444444444444444444444444444" as const;
const zero = "0x0000000000000000000000000000000000000000" as const;
const now = Date.parse("2026-09-14T12:00:00.000Z");

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)"
]);
const curveAbi = parseAbi(["function sellableTokens() view returns (uint256)"]);
const factorySelector = encodeFunctionData({ abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).slice(0, 10);
const sellableSelector = encodeFunctionData({ abi: curveAbi, functionName: "sellableTokens" }).slice(0, 10);

function createHarness(): { coordinator: SmartAccountCoordinator; store: MemorySmartAccountGrantStore; walletBodies: unknown[] } {
  const store = new MemorySmartAccountGrantStore();
  const walletBodies: unknown[] = [];
  let fundingValue = "0x0";
  const rpc: RpcCaller = async (method, params = []) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return "0x6001600055";
    if (method === "eth_call") {
      const request = params[0] as { to: string; data: string };
      if (request.to.toLowerCase() === PONS_FACTORY && request.data.slice(0, 10) === factorySelector) {
        return encodeFunctionResult({
          abi: factoryAbi,
          functionName: "getLaunchedToken",
          result: {
            token,
            curve,
            deployer: owner,
            creatorFeeRecipient: owner,
            pairToken: zero,
            graduationThreshold: 1n,
            poolFee: 0,
            tickSpacing: 60,
            creatorTaxBps: 100,
            buybackEnabled: false,
            phase: 0,
            sweptQuote: 0n,
            sweptTokens: 0n,
            sweptAt: 0n,
            exists: true
          }
        });
      }
      if (request.to.toLowerCase() === curve && request.data.slice(0, 10) === sellableSelector) {
        return encodeFunctionResult({ abi: curveAbi, functionName: "sellableTokens", result: 1_000_000_000_000_000_000_000n });
      }
    }
    if (method === "eth_getTransactionByHash") {
      return { from: owner, to: smartAccount, value: fundingValue };
    }
    if (method === "eth_getTransactionReceipt") {
      return { blockNumber: "0x123", status: "0x1" };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/prices/v1/")) {
      return new Response(JSON.stringify({ data: [{ symbol: "ETH", prices: [{ currency: "usd", value: "3000.00", lastUpdatedAt: new Date(now).toISOString() }] }] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { method?: string };
    walletBodies.push(body);
    if (body.method === "wallet_requestAccount") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { accountAddress: smartAccount, id: "00000000-0000-5000-8000-000000000000" } }), { status: 200 });
    }
    if (body.method === "wallet_createSession") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: `0x${"ab".repeat(32)}`, chainId: "0x1237", signatureRequest: { type: "eth_signTypedData_v4", data: {} } } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const coordinator = new SmartAccountCoordinator({
    rpc,
    store,
    fetch: fetcher,
    now: () => now,
    env: {
      ALCHEMY_API_KEY: "test-key",
      ORCHESTRATOR_SESSION_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      SMART_ACCOUNT_MAX_GAS_UNITS: "700000",
      SMART_ACCOUNT_MAX_FEE_PER_GAS_WEI: "1000000000",
      SMART_ACCOUNT_SPEND_CAP_USD_CENTS: "3000",
      TRADE_MAX_SLIPPAGE_BPS: "300"
    }
  });
  const originalCreatePlan = coordinator.createPlan.bind(coordinator);
  coordinator.createPlan = async (...args) => {
    const plan = await originalCreatePlan(...args);
    fundingValue = toHex(BigInt(plan.totalFundingWei));
    return plan;
  };
  return { coordinator, store, walletBodies };
}

test("builds a 24-hour MAv2 policy with no root or global-contract authority", async () => {
  const { coordinator } = createHarness();
  const plan = await coordinator.createPlan(owner, token, curve);
  assert.equal(plan.accountType, "sma-b");
  assert.equal(plan.chainId, 4663);
  assert.match(plan.accountId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(plan.spendCapUsd, "30.00");
  assert.equal(plan.spendCapWei, "10000000000000000");
  assert.equal(plan.expirySec, Math.floor(now / 1_000) + 86_400);
  assert.equal(plan.permissions.map((permission) => String(permission.type)).some((type) => type === "root" || type === "functions-on-all-contracts"), false);
  assert.deepEqual(plan.permissions.at(-2), { type: "functions-on-contract", data: { address: curve, functions: [PONS_BUY_SELECTOR, PONS_SELL_SELECTOR] } });
  assert.deepEqual(plan.permissions.at(-1), { type: "functions-on-contract", data: { address: token, functions: [ERC20_APPROVE_SELECTOR] } });
  assert.deepEqual(plan.unsupportedContractActions, ["cancel", "reprice"]);
  assert.equal((await coordinator.createPlan(owner, token, curve)).planId, plan.planId);
  await assert.rejects(
    coordinator.createPlan(owner, token, "0x5555555555555555555555555555555555555555"),
    (error: unknown) => error instanceof SmartAccountError && error.code === "SESSION_PLAN_ACTIVE"
  );
});

test("proxies only the exact planned account and session requests, then persists and revokes the grant", async () => {
  const { coordinator, walletBodies } = createHarness();
  const plan = await coordinator.createPlan(owner, token, curve);
  await assert.rejects(
    coordinator.proxyWalletRpc(owner, { jsonrpc: "2.0", id: 1, method: "wallet_sendPreparedCalls", params: [{}] }),
    (error: unknown) => error instanceof SmartAccountError && error.code === "WALLET_RPC_METHOD_DENIED"
  );
  await coordinator.proxyWalletRpc(owner, {
    jsonrpc: "2.0",
    id: 1,
    method: "wallet_requestAccount",
    params: [{ signerAddress: owner, id: plan.accountId, creationHint: { createAdditional: true, accountType: "sma-b" }, includeCounterfactualInfo: true }]
  });
  await assert.rejects(
    coordinator.proxyWalletRpc(owner, {
      jsonrpc: "2.0",
      id: 2,
      method: "wallet_createSession",
      params: [{ account: smartAccount, chainId: "0x1237", expirySec: plan.expirySec, key: { publicKey: plan.sessionKey, type: "secp256k1" }, permissions: [...plan.permissions, { type: "root" }] }]
    }),
    (error: unknown) => error instanceof SmartAccountError && error.code === "SESSION_POLICY_MISMATCH"
  );
  await coordinator.proxyWalletRpc(owner, {
    jsonrpc: "2.0",
    id: 3,
    method: "wallet_createSession",
    params: [{ account: smartAccount, chainId: "0x1237", expirySec: plan.expirySec, key: { publicKey: plan.sessionKey, type: "secp256k1" }, permissions: plan.permissions }]
  });
  assert.equal(walletBodies.length, 2);
  const active = await coordinator.activate(owner, {
    planId: plan.planId,
    account: smartAccount,
    context: `0x00${"aa".repeat(65)}`,
    fundingTransactionHash: `0x${"bb".repeat(32)}`
  });
  assert.equal(active.status, "ACTIVE");
  assert.equal("context" in active, false);
  assert.equal((await coordinator.status(owner))?.status, "ACTIVE");
  assert.equal((await coordinator.revoke(owner)).revoked, true);
  assert.equal((await coordinator.status(owner))?.status, "REVOKED");
  await assert.rejects(
    coordinator.createPlan(owner, token, curve),
    (error: unknown) => error instanceof SmartAccountError && error.code === "SESSION_ALREADY_ACTIVE"
  );
});

test("rate-limits owner-scoped smart-account mutation requests", async () => {
  const { coordinator } = createHarness();
  const denied = { jsonrpc: "2.0", id: 1, method: "wallet_sendPreparedCalls", params: [{}] };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await assert.rejects(
      coordinator.proxyWalletRpc(owner, denied),
      (error: unknown) => error instanceof SmartAccountError && error.code === "WALLET_RPC_METHOD_DENIED"
    );
  }
  await assert.rejects(
    coordinator.proxyWalletRpc(owner, denied),
    (error: unknown) => error instanceof SmartAccountError && error.code === "RATE_LIMITED" && error.status === 429
  );
});
