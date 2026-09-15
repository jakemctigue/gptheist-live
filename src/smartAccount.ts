import { createHash, randomBytes } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PONS_FACTORY, ROBINHOOD_CHAIN_ID, type RpcCaller } from "./live.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const PLAN_TTL_MS = 10 * 60_000;
const PRICE_MAX_AGE_MS = 10 * 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 20;
const MAX_EPHEMERAL_RECORDS = 10_000;

const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)"
]);
const CURVE_ABI = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function sellableTokens() view returns (uint256)"
]);

export const PONS_BUY_SELECTOR = toFunctionSelector("buy(uint256,uint256,address)");
export const PONS_SELL_SELECTOR = toFunctionSelector("sell(uint256,uint256,address)");
export const ERC20_APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");

export type SmartAccountPermission =
  | { type: "native-token-transfer"; data: { allowance: Hex } }
  | { type: "erc20-token-transfer"; data: { address: Address; allowance: Hex } }
  | { type: "gas-limit"; data: { limit: Hex } }
  | { type: "functions-on-contract"; data: { address: Address; functions: Hex[] } };

export interface SmartAccountPlan {
  planId: string;
  accountId: string;
  accountType: "sma-b";
  chainId: typeof ROBINHOOD_CHAIN_ID;
  owner: Address;
  sessionKey: Address;
  token: Address;
  curve: Address;
  expirySec: number;
  spendCapUsd: string;
  spendCapWei: string;
  gasReserveWei: string;
  totalFundingWei: string;
  maxGasUnits: number;
  maxFeePerGasWei: string;
  maxSlippageBps: number;
  price: { symbol: "ETH"; currency: "usd"; value: string; lastUpdatedAt: string };
  permissions: SmartAccountPermission[];
  unsupportedContractActions: ["cancel", "reprice"];
  expiresAt: string;
  planExpiresAt: string;
}

interface PendingPlan extends SmartAccountPlan {
  smartAccount?: Address;
}

export interface SmartAccountGrant {
  _id: string;
  owner: Address;
  account: Address;
  sessionKey: Address;
  token: Address;
  curve: Address;
  context: Hex;
  fundingTransactionHash: Hex;
  spendCapWei: string;
  gasReserveWei: string;
  totalFundingWei: string;
  maxGasUnits: number;
  maxFeePerGasWei: string;
  maxSlippageBps: number;
  permissions: SmartAccountPermission[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SmartAccountGrantStore {
  find(owner: Address): Promise<SmartAccountGrant | null>;
  save(grant: SmartAccountGrant): Promise<void>;
  revoke(owner: Address, revokedAt: Date): Promise<boolean>;
}

export class MemorySmartAccountGrantStore implements SmartAccountGrantStore {
  readonly #grants = new Map<string, SmartAccountGrant>();

  async find(owner: Address): Promise<SmartAccountGrant | null> {
    return this.#grants.get(owner.toLowerCase()) ?? null;
  }

  async save(grant: SmartAccountGrant): Promise<void> {
    this.#grants.set(grant.owner.toLowerCase(), grant);
  }

  async revoke(owner: Address, revokedAt: Date): Promise<boolean> {
    const grant = this.#grants.get(owner.toLowerCase());
    if (!grant || grant.revokedAt) return false;
    this.#grants.set(owner.toLowerCase(), { ...grant, context: "0x00", revokedAt });
    return true;
  }
}

export class MongoSmartAccountGrantStore implements SmartAccountGrantStore {
  readonly #uri: string;
  readonly #database: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#uri = env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";
    this.#database = env.GPTHEIST_MONGODB_DB?.trim() || "gptheist";
  }

  async #withCollection<T>(work: (collection: Collection<SmartAccountGrant>) => Promise<T>): Promise<T> {
    const client = new MongoClient(this.#uri, { serverSelectionTimeoutMS: 8_000 });
    try {
      await client.connect();
      const collection = client.db(this.#database).collection<SmartAccountGrant>("smart_account_grants");
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "session_expiry_ttl" });
      return await work(collection);
    } finally {
      await client.close();
    }
  }

  find(owner: Address): Promise<SmartAccountGrant | null> {
    return this.#withCollection((collection) => collection.findOne({ _id: owner.toLowerCase() }));
  }

  async save(grant: SmartAccountGrant): Promise<void> {
    await this.#withCollection(async (collection) => {
      await collection.replaceOne({ _id: grant._id }, grant, { upsert: true });
    });
  }

  revoke(owner: Address, revokedAt: Date): Promise<boolean> {
    return this.#withCollection(async (collection) => {
      const result = await collection.updateOne(
        { _id: owner.toLowerCase(), revokedAt: null },
        { $set: { context: "0x00", revokedAt } }
      );
      return result.modifiedCount === 1;
    });
  }
}

export class SmartAccountError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message);
    this.name = "SmartAccountError";
  }
}

export interface SmartAccountCoordinatorOptions {
  rpc: RpcCaller;
  store?: SmartAccountGrantStore;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

function positiveInteger(name: string, value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return parsed;
}

function positiveBigInt(name: string, value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]{0,77}$/.test(value)) throw new Error(`${name} must be a positive base-unit integer`);
  return BigInt(value);
}

function normalizeAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new SmartAccountError("INVALID_ADDRESS", `${label} must be a 20-byte address`, 400);
  return getAddress(value.toLowerCase());
}

function normalizeHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX.test(value)) throw new SmartAccountError("INVALID_HEX", `${label} must be non-empty even-length hex`, 400);
  return value.toLowerCase() as Hex;
}

function rpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new SmartAccountError("INVALID_RPC", `RPC returned an invalid ${label}`, 502);
  return BigInt(value);
}

function stableAccountId(owner: Address): string {
  const bytes = createHash("sha256").update(`gptheist:mav2:${owner.toLowerCase()}`).digest();
  // Wallet APIs validates this caller-supplied id as UUID v4. Keeping the
  // payload deterministic prevents duplicate additional accounts per owner.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseUsdMicros(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}(?:\.[0-9]{1,6})?$/.test(value)) {
    throw new SmartAccountError("PRICE_UNAVAILABLE", "Alchemy returned an invalid ETH/USD price", 502);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction || "0").padEnd(6, "0"));
}

function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function formatUsdCents(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function publicGrant(grant: SmartAccountGrant, now = Date.now()): Omit<SmartAccountGrant, "context"> & { status: "ACTIVE" | "REVOKED" | "EXPIRED" } {
  const status = grant.revokedAt ? "REVOKED" : grant.expiresAt.getTime() <= now ? "EXPIRED" : "ACTIVE";
  const { context: _, ...rest } = grant;
  return { ...rest, status };
}

function hasDeployedCode(value: unknown, label: string): boolean {
  if (value === "0x") return false;
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new SmartAccountError("INVALID_RPC", `RPC returned invalid ${label} code`, 502);
  }
  return true;
}

export class SmartAccountCoordinator {
  readonly #rpc: RpcCaller;
  readonly #store: SmartAccountGrantStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #apiKey: string | null;
  readonly #sessionKey: Address | null;
  readonly #maxGasUnits: number;
  readonly #maxFeePerGasWei: bigint;
  readonly #maxSlippageBps: number;
  readonly #spendCapUsdCents: number;
  readonly #plans = new Map<string, PendingPlan>();
  readonly #rateLimits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: SmartAccountCoordinatorOptions) {
    const env = options.env ?? process.env;
    this.#rpc = options.rpc;
    this.#store = options.store ?? new MongoSmartAccountGrantStore(env);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#apiKey = env.ALCHEMY_API_KEY?.trim() || null;
    const sessionPrivateKey = env.ORCHESTRATOR_SESSION_PRIVATE_KEY?.trim();
    if (sessionPrivateKey && !PRIVATE_KEY.test(sessionPrivateKey)) throw new Error("ORCHESTRATOR_SESSION_PRIVATE_KEY must be a 32-byte 0x-prefixed key");
    this.#sessionKey = sessionPrivateKey ? privateKeyToAccount(sessionPrivateKey as Hex).address : null;
    this.#maxGasUnits = positiveInteger("SMART_ACCOUNT_MAX_GAS_UNITS", env.SMART_ACCOUNT_MAX_GAS_UNITS, 700_000, 10_000_000);
    this.#maxFeePerGasWei = positiveBigInt("SMART_ACCOUNT_MAX_FEE_PER_GAS_WEI", env.SMART_ACCOUNT_MAX_FEE_PER_GAS_WEI, 1_000_000_000n);
    this.#maxSlippageBps = positiveInteger("TRADE_MAX_SLIPPAGE_BPS", env.TRADE_MAX_SLIPPAGE_BPS, 300, 2_000);
    this.#spendCapUsdCents = positiveInteger("SMART_ACCOUNT_SPEND_CAP_USD_CENTS", env.SMART_ACCOUNT_SPEND_CAP_USD_CENTS, 3_000, 3_000);
  }

  get configured(): boolean {
    return Boolean(this.#apiKey && this.#sessionKey);
  }

  publicConfiguration(): { enabled: boolean; chainId: number; accountType: "sma-b"; spendCapUsd: string; sessionTtlSeconds: number; reason?: string } {
    const result = {
      enabled: this.configured,
      chainId: ROBINHOOD_CHAIN_ID,
      accountType: "sma-b" as const,
      spendCapUsd: formatUsdCents(this.#spendCapUsdCents),
      sessionTtlSeconds: SESSION_TTL_SECONDS
    };
    return this.configured ? result : { ...result, reason: "Alchemy API key or orchestrator session key is not configured" };
  }

  async status(ownerInput: unknown): Promise<ReturnType<typeof publicGrant> | null> {
    const owner = normalizeAddress(ownerInput, "owner");
    const grant = await this.#store.find(owner);
    return grant ? publicGrant(grant, this.#now()) : null;
  }

  async createPlan(ownerInput: unknown, tokenInput: unknown, curveInput: unknown): Promise<SmartAccountPlan> {
    if (!this.#apiKey || !this.#sessionKey) throw new SmartAccountError("SMART_ACCOUNT_DISABLED", "Smart-account setup is not configured", 503);
    const owner = normalizeAddress(ownerInput, "owner");
    this.#assertRateLimit(owner);
    const token = normalizeAddress(tokenInput, "token");
    const curve = normalizeAddress(curveInput, "curve");
    const current = await this.#store.find(owner);
    if (current && current.expiresAt.getTime() > this.#now()) {
      const detail = current.revokedAt
        ? "The application context is disabled; wait for its on-chain expiry before authorizing another target"
        : "Disable the current session or wait for its expiry before authorizing another target";
      throw new SmartAccountError("SESSION_ALREADY_ACTIVE", detail, 409);
    }
    const chain = rpcQuantity(await this.#rpc("eth_chainId"), "chain id");
    if (chain !== BigInt(ROBINHOOD_CHAIN_ID)) throw new SmartAccountError("CHAIN_MISMATCH", `RPC must report Robinhood Chain ${ROBINHOOD_CHAIN_ID}`, 502);
    const launchRaw = await this.#rpc("eth_call", [{
      to: PONS_FACTORY,
      data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] })
    }, "latest"]);
    const launch = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getLaunchedToken", data: normalizeHex(launchRaw, "factory response") });
    if (!launch.exists || getAddress(launch.token) !== token || getAddress(launch.curve) !== curve) {
      throw new SmartAccountError("FACTORY_PROVENANCE", "token and curve do not match a Pons v2 factory record");
    }
    if (getAddress(launch.pairToken) !== ZERO_ADDRESS || launch.phase !== 0) {
      throw new SmartAccountError("VENUE_NOT_ALLOWED", "only active native-ETH Pons curves can be authorized");
    }
    const [tokenCode, curveCode] = await Promise.all([
      this.#rpc("eth_getCode", [token, "latest"]),
      this.#rpc("eth_getCode", [curve, "latest"])
    ]);
    if (!hasDeployedCode(tokenCode, "token") || !hasDeployedCode(curveCode, "curve")) {
      throw new SmartAccountError("CONTRACT_CODE_REQUIRED", "verified token and curve must both have deployed code");
    }
    const sellableRaw = await this.#rpc("eth_call", [{
      to: curve,
      data: encodeFunctionData({ abi: CURVE_ABI, functionName: "sellableTokens" })
    }, "latest"]);
    const sellableTokens = decodeFunctionResult({ abi: CURVE_ABI, functionName: "sellableTokens", data: normalizeHex(sellableRaw, "sellable token response") });
    if (sellableTokens <= 0n) throw new SmartAccountError("CURVE_CLOSED", "the Pons curve has no sellable tokens");

    const priceResponse = await this.#fetch(`https://api.g.alchemy.com/prices/v1/${encodeURIComponent(this.#apiKey)}/tokens/by-symbol?symbols=ETH`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000)
    });
    if (!priceResponse.ok) throw new SmartAccountError("PRICE_UNAVAILABLE", `Alchemy price request failed with HTTP ${priceResponse.status}`, 502);
    const pricePayload = await priceResponse.json() as { data?: Array<{ symbol?: unknown; prices?: Array<{ currency?: unknown; value?: unknown; lastUpdatedAt?: unknown }> }> };
    const eth = pricePayload.data?.find((entry) => entry.symbol === "ETH")?.prices?.find((entry) => entry.currency === "usd");
    const priceMicros = parseUsdMicros(eth?.value);
    if (typeof eth?.lastUpdatedAt !== "string" || !Number.isFinite(Date.parse(eth.lastUpdatedAt)) || Math.abs(this.#now() - Date.parse(eth.lastUpdatedAt)) > PRICE_MAX_AGE_MS) {
      throw new SmartAccountError("STALE_PRICE", "Alchemy ETH/USD price is older than ten minutes", 502);
    }
    const spendCapWei = (BigInt(this.#spendCapUsdCents) * 10_000n * 10n ** 18n) / priceMicros;
    if (spendCapWei <= 0n) throw new SmartAccountError("PRICE_UNAVAILABLE", "ETH/USD price produced a zero spending allowance", 502);
    const gasReserveWei = BigInt(this.#maxGasUnits) * this.#maxFeePerGasWei;
    const expirySec = Math.floor(this.#now() / 1_000) + SESSION_TTL_SECONDS;
    const permissions: SmartAccountPermission[] = [
      { type: "native-token-transfer", data: { allowance: toHex(spendCapWei) } },
      { type: "erc20-token-transfer", data: { address: token, allowance: toHex(sellableTokens) } },
      { type: "gas-limit", data: { limit: toHex(BigInt(this.#maxGasUnits)) } },
      { type: "functions-on-contract", data: { address: curve, functions: [PONS_BUY_SELECTOR, PONS_SELL_SELECTOR] } },
      { type: "functions-on-contract", data: { address: token, functions: [ERC20_APPROVE_SELECTOR] } }
    ];
    const planId = randomBytes(24).toString("base64url");
    const plan: PendingPlan = {
      planId,
      accountId: stableAccountId(owner),
      accountType: "sma-b",
      chainId: ROBINHOOD_CHAIN_ID,
      owner,
      sessionKey: this.#sessionKey,
      token,
      curve,
      expirySec,
      spendCapUsd: formatUsdCents(this.#spendCapUsdCents),
      spendCapWei: spendCapWei.toString(),
      gasReserveWei: gasReserveWei.toString(),
      totalFundingWei: (spendCapWei + gasReserveWei).toString(),
      maxGasUnits: this.#maxGasUnits,
      maxFeePerGasWei: this.#maxFeePerGasWei.toString(),
      maxSlippageBps: this.#maxSlippageBps,
      price: { symbol: "ETH", currency: "usd", value: String(eth.value), lastUpdatedAt: eth.lastUpdatedAt },
      permissions,
      unsupportedContractActions: ["cancel", "reprice"],
      expiresAt: new Date(expirySec * 1_000).toISOString(),
      planExpiresAt: new Date(this.#now() + PLAN_TTL_MS).toISOString()
    };
    this.#prunePlans();
    while (this.#plans.size >= MAX_EPHEMERAL_RECORDS) this.#plans.delete(this.#plans.keys().next().value as string);
    this.#plans.set(planId, plan);
    return plan;
  }

  async proxyWalletRpc(ownerInput: unknown, body: unknown): Promise<unknown> {
    if (!this.#apiKey || !this.#sessionKey) throw new SmartAccountError("SMART_ACCOUNT_DISABLED", "Smart-account setup is not configured", 503);
    const owner = normalizeAddress(ownerInput, "owner");
    this.#assertRateLimit(owner);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SmartAccountError("INVALID_WALLET_RPC", "Wallet RPC body must be an object", 400);
    const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (request.jsonrpc !== "2.0" || (typeof request.id !== "number" && typeof request.id !== "string") || !Array.isArray(request.params) || request.params.length !== 1) {
      throw new SmartAccountError("INVALID_WALLET_RPC", "Wallet RPC envelope is invalid", 400);
    }
    this.#prunePlans();
    let plan: PendingPlan | undefined;
    if (request.method === "wallet_requestAccount") {
      const params = request.params[0];
      if (typeof params !== "object" || params === null || Array.isArray(params)) throw new SmartAccountError("INVALID_ACCOUNT_REQUEST", "account request parameters are invalid", 400);
      const value = params as Record<string, unknown>;
      plan = [...this.#plans.values()].find((candidate) => candidate.owner === owner && candidate.accountId === value.id);
      const signerAddress = normalizeAddress(value.signerAddress, "signer address");
      if (!plan || signerAddress !== owner || value.includeCounterfactualInfo !== true || !sameJson(value.creationHint, { accountType: "sma-b", createAdditional: true })) {
        throw new SmartAccountError("ACCOUNT_POLICY_MISMATCH", "only the current MetaMask owner may request the planned Modular Account V2", 403);
      }
    } else if (request.method === "wallet_createSession") {
      const params = request.params[0];
      if (typeof params !== "object" || params === null || Array.isArray(params)) throw new SmartAccountError("INVALID_SESSION_REQUEST", "session request parameters are invalid", 400);
      const value = params as Record<string, unknown>;
      const account = normalizeAddress(value.account, "account");
      plan = [...this.#plans.values()].find((candidate) => candidate.owner === owner && candidate.smartAccount === account);
      if (!plan || value.chainId !== toHex(ROBINHOOD_CHAIN_ID) || value.expirySec !== plan.expirySec || !sameJson(value.key, { publicKey: plan.sessionKey, type: "secp256k1" }) || !sameJson(value.permissions, plan.permissions)) {
        throw new SmartAccountError("SESSION_POLICY_MISMATCH", "session request does not exactly match the server-issued restricted policy", 403);
      }
    } else {
      throw new SmartAccountError("WALLET_RPC_METHOD_DENIED", "only account creation and scoped session authorization are allowed", 403);
    }

    const response = await this.#fetch(`https://api.g.alchemy.com/v2/${encodeURIComponent(this.#apiKey)}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new SmartAccountError("ALCHEMY_WALLET_API", `Alchemy Wallet API failed with HTTP ${response.status}`, 502);
    const payload = await response.json() as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (payload.error) {
      const message = typeof payload.error.message === "string" ? payload.error.message.slice(0, 180) : "Alchemy Wallet API request failed";
      throw new SmartAccountError("ALCHEMY_WALLET_API", message, 502);
    }
    if (request.method === "wallet_requestAccount") {
      const result = payload.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) throw new SmartAccountError("INVALID_ALCHEMY_RESPONSE", "Alchemy returned an invalid account response", 502);
      plan.smartAccount = normalizeAddress((result as Record<string, unknown>).accountAddress, "smart account");
    }
    return payload;
  }

  async activate(ownerInput: unknown, input: unknown): Promise<ReturnType<typeof publicGrant>> {
    const owner = normalizeAddress(ownerInput, "owner");
    this.#assertRateLimit(owner);
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new SmartAccountError("INVALID_ACTIVATION", "activation body must be an object", 400);
    const value = input as Record<string, unknown>;
    if (typeof value.planId !== "string") throw new SmartAccountError("INVALID_ACTIVATION", "planId is required", 400);
    this.#prunePlans();
    const plan = this.#plans.get(value.planId);
    if (!plan || plan.owner !== owner || !plan.smartAccount) throw new SmartAccountError("PLAN_EXPIRED", "smart-account plan is missing or expired", 409);
    const account = normalizeAddress(value.account, "account");
    if (account !== plan.smartAccount) throw new SmartAccountError("ACCOUNT_POLICY_MISMATCH", "activated account does not match the planned account", 403);
    const context = normalizeHex(value.context, "permission context");
    if (context.length < 132 || !context.startsWith("0x00")) throw new SmartAccountError("INVALID_PERMISSION_CONTEXT", "permission context is not an Alchemy remote-session context", 400);
    if (typeof value.fundingTransactionHash !== "string" || !TRANSACTION_HASH.test(value.fundingTransactionHash)) throw new SmartAccountError("INVALID_FUNDING_TRANSACTION", "fundingTransactionHash must be a transaction hash", 400);
    const fundingTransactionHash = value.fundingTransactionHash.toLowerCase() as Hex;
    let transaction: unknown = null;
    for (let attempt = 0; attempt < 5 && transaction === null; attempt += 1) {
      transaction = await this.#rpc("eth_getTransactionByHash", [fundingTransactionHash]);
      if (transaction === null && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (typeof transaction !== "object" || transaction === null || Array.isArray(transaction)) throw new SmartAccountError("FUNDING_NOT_FOUND", "funding transaction is not visible on Robinhood Chain yet; retry activation", 409);
    const funded = transaction as Record<string, unknown>;
    if (normalizeAddress(funded.from, "funding sender") !== owner || normalizeAddress(funded.to, "funding recipient") !== account || rpcQuantity(funded.value, "funding value") !== BigInt(plan.totalFundingWei)) {
      throw new SmartAccountError("FUNDING_POLICY_MISMATCH", "funding transaction does not exactly match the treasury, smart account, and capped amount", 403);
    }
    const grant: SmartAccountGrant = {
      _id: owner.toLowerCase(),
      owner,
      account,
      sessionKey: plan.sessionKey,
      token: plan.token,
      curve: plan.curve,
      context,
      fundingTransactionHash,
      spendCapWei: plan.spendCapWei,
      gasReserveWei: plan.gasReserveWei,
      totalFundingWei: plan.totalFundingWei,
      maxGasUnits: plan.maxGasUnits,
      maxFeePerGasWei: plan.maxFeePerGasWei,
      maxSlippageBps: plan.maxSlippageBps,
      permissions: plan.permissions,
      createdAt: new Date(this.#now()),
      expiresAt: new Date(plan.expiresAt),
      revokedAt: null
    };
    await this.#store.save(grant);
    this.#plans.delete(plan.planId);
    return publicGrant(grant, this.#now());
  }

  async revoke(ownerInput: unknown): Promise<{ revoked: boolean; revokedAt: string }> {
    const owner = normalizeAddress(ownerInput, "owner");
    this.#assertRateLimit(owner);
    const revokedAt = new Date(this.#now());
    const revoked = await this.#store.revoke(owner, revokedAt);
    return { revoked, revokedAt: revokedAt.toISOString() };
  }

  #prunePlans(): void {
    const now = this.#now();
    for (const [id, plan] of this.#plans) {
      if (Date.parse(plan.planExpiresAt) <= now) this.#plans.delete(id);
    }
  }

  #assertRateLimit(owner: Address): void {
    const key = owner.toLowerCase();
    const now = this.#now();
    const current = this.#rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      while (this.#rateLimits.size >= MAX_EPHEMERAL_RECORDS) this.#rateLimits.delete(this.#rateLimits.keys().next().value as string);
      this.#rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    if (current.count >= RATE_LIMIT_REQUESTS) {
      throw new SmartAccountError("RATE_LIMITED", "too many smart-account setup requests; retry in one minute", 429);
    }
    current.count += 1;
  }
}
