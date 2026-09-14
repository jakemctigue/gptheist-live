import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID } from "./live.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const MAX_CHALLENGES_PER_WINDOW = 60;
const MAX_VERIFICATIONS_PER_WINDOW = 30;
const MAX_RECORDS = 10_000;

interface ChallengeRecord {
  wallet: Address;
  message: string;
  origin: string;
  expiresAt: number;
}

interface SessionRecord {
  wallet: Address;
  expiresAt: number;
}

interface RateRecord {
  count: number;
  resetsAt: number;
}

export interface WalletChallenge {
  challengeId: string;
  wallet: Address;
  message: string;
  expiresAt: string;
}

export interface WalletSession {
  wallet: Address;
  expiresAt: string;
}

export interface WalletAuthOptions {
  now?: () => number;
  challengeTtlMs?: number;
  sessionTtlMs?: number;
}

export class WalletAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "WalletAuthError";
  }
}

function normalizeWallet(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new WalletAuthError("INVALID_WALLET", "wallet must be a 20-byte Ethereum address", 400);
  }
  try {
    return getAddress(value.toLowerCase());
  } catch {
    throw new WalletAuthError("INVALID_WALLET", "wallet must be a valid Ethereum address", 400);
  }
}

function boundedRandomId(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export class WalletAuth {
  readonly #now: () => number;
  readonly #challengeTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #challenges = new Map<string, ChallengeRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #challengeRates = new Map<string, RateRecord>();
  readonly #verificationRates = new Map<string, RateRecord>();

  constructor(options: WalletAuthOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#challengeTtlMs = options.challengeTtlMs ?? CHALLENGE_TTL_MS;
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  }

  #prune(now: number): void {
    for (const [id, record] of this.#challenges) if (record.expiresAt <= now) this.#challenges.delete(id);
    for (const [id, record] of this.#sessions) if (record.expiresAt <= now) this.#sessions.delete(id);
    for (const rates of [this.#challengeRates, this.#verificationRates]) {
      for (const [key, record] of rates) if (record.resetsAt <= now) rates.delete(key);
      while (rates.size > MAX_RECORDS) rates.delete(rates.keys().next().value as string);
    }
    while (this.#challenges.size > MAX_RECORDS) this.#challenges.delete(this.#challenges.keys().next().value as string);
    while (this.#sessions.size > MAX_RECORDS) this.#sessions.delete(this.#sessions.keys().next().value as string);
  }

  #consumeRate(records: Map<string, RateRecord>, key: string, maximum: number, now: number): void {
    const current = records.get(key);
    if (!current || current.resetsAt <= now) {
      records.set(key, { count: 1, resetsAt: now + RATE_WINDOW_MS });
      return;
    }
    if (current.count >= maximum) throw new WalletAuthError("RATE_LIMITED", "too many authentication attempts", 429);
    current.count += 1;
  }

  createChallenge(walletInput: unknown, origin: string, clientId: string): WalletChallenge {
    const now = this.#now();
    this.#prune(now);
    this.#consumeRate(this.#challengeRates, clientId, MAX_CHALLENGES_PER_WINDOW, now);
    const wallet = normalizeWallet(walletInput);
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin || !["http:", "https:"].includes(parsedOrigin.protocol)) {
      throw new WalletAuthError("INVALID_ORIGIN", "authentication origin is invalid", 400);
    }
    const nonce = randomBytes(12).toString("hex");
    const issuedAt = new Date(now).toISOString();
    const expiresAt = now + this.#challengeTtlMs;
    const message = [
      `${parsedOrigin.host} wants you to sign in with your Ethereum account:`,
      wallet,
      "",
      "Authenticate to GPTHEIST. This does not authorize a transaction.",
      "",
      `URI: ${parsedOrigin.origin}`,
      "Version: 1",
      `Chain ID: ${ROBINHOOD_CHAIN_ID}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`
    ].join("\n");
    const challengeId = boundedRandomId(24);
    this.#challenges.set(challengeId, { wallet, message, origin, expiresAt });
    return { challengeId, wallet, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  async verifyChallenge(input: unknown, origin: string, clientId: string): Promise<{ token: string; session: WalletSession }> {
    const now = this.#now();
    this.#prune(now);
    this.#consumeRate(this.#verificationRates, clientId, MAX_VERIFICATIONS_PER_WINDOW, now);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new WalletAuthError("INVALID_AUTH_REQUEST", "authentication request must be a JSON object", 400);
    }
    const body = input as Record<string, unknown>;
    const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const message = typeof body.message === "string" ? body.message : "";
    if (!/^[A-Za-z0-9_-]{32}$/.test(challengeId) || !SIGNATURE.test(signature)) {
      throw new WalletAuthError("INVALID_AUTH_REQUEST", "challengeId or signature is malformed", 400);
    }
    const challenge = this.#challenges.get(challengeId);
    this.#challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= now) {
      throw new WalletAuthError("CHALLENGE_EXPIRED", "authentication challenge is missing, expired, or already used", 401);
    }
    if (challenge.origin !== origin || challenge.message !== message) {
      throw new WalletAuthError("CHALLENGE_MISMATCH", "authentication challenge does not match this origin", 401);
    }
    const valid = await verifyMessage({
      address: challenge.wallet,
      message: challenge.message,
      signature: signature as Hex
    });
    if (!valid) throw new WalletAuthError("INVALID_SIGNATURE", "wallet signature could not be verified", 401);
    const token = boundedRandomId(32);
    const expiresAt = now + this.#sessionTtlMs;
    this.#sessions.set(token, { wallet: challenge.wallet, expiresAt });
    return { token, session: { wallet: challenge.wallet, expiresAt: new Date(expiresAt).toISOString() } };
  }

  readSession(token: string | null): WalletSession | null {
    if (!token) return null;
    const now = this.#now();
    this.#prune(now);
    const record = this.#sessions.get(token);
    if (!record || record.expiresAt <= now) return null;
    return { wallet: record.wallet, expiresAt: new Date(record.expiresAt).toISOString() };
  }

  destroySession(token: string | null): void {
    if (token) this.#sessions.delete(token);
  }
}

export function normalizedWallet(value: unknown): Address {
  return normalizeWallet(value);
}
