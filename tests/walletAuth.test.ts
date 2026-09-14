import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { WalletAuth, WalletAuthError } from "../src/walletAuth.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const origin = "https://desk.example";

test("wallet authentication verifies a one-time SIWE challenge and creates an expiring session", async () => {
  let now = Date.parse("2026-09-14T12:00:00.000Z");
  const auth = new WalletAuth({ now: () => now, challengeTtlMs: 60_000, sessionTtlMs: 120_000 });
  const challenge = auth.createChallenge(account.address, origin, "client-one");
  assert.match(challenge.message, /^desk\.example wants you to sign in with your Ethereum account:/);
  assert.match(challenge.message, /Chain ID: 4663/);
  assert.match(challenge.message, /This does not authorize a transaction/);
  const signature = await account.signMessage({ message: challenge.message });
  const verified = await auth.verifyChallenge({
    challengeId: challenge.challengeId,
    message: challenge.message,
    signature
  }, origin, "client-one");
  assert.equal(verified.session.wallet, account.address);
  assert.deepEqual(auth.readSession(verified.token), verified.session);

  await assert.rejects(
    auth.verifyChallenge({ challengeId: challenge.challengeId, message: challenge.message, signature }, origin, "client-one"),
    (error: unknown) => error instanceof WalletAuthError && error.code === "CHALLENGE_EXPIRED"
  );
  now += 120_001;
  assert.equal(auth.readSession(verified.token), null);
});

test("wallet authentication rejects the wrong signer and consumes the challenge", async () => {
  const auth = new WalletAuth();
  const challenge = auth.createChallenge(account.address, origin, "client-two");
  const signature = await otherAccount.signMessage({ message: challenge.message });
  await assert.rejects(
    auth.verifyChallenge({ challengeId: challenge.challengeId, message: challenge.message, signature }, origin, "client-two"),
    (error: unknown) => error instanceof WalletAuthError && error.code === "INVALID_SIGNATURE"
  );
  await assert.rejects(
    auth.verifyChallenge({ challengeId: challenge.challengeId, message: challenge.message, signature }, origin, "client-two"),
    (error: unknown) => error instanceof WalletAuthError && error.code === "CHALLENGE_EXPIRED"
  );
});

test("wallet authentication binds challenges to their requesting origin", async () => {
  const auth = new WalletAuth();
  const challenge = auth.createChallenge(account.address, origin, "client-three");
  const signature = await account.signMessage({ message: challenge.message });
  await assert.rejects(
    auth.verifyChallenge({ challengeId: challenge.challengeId, message: challenge.message, signature }, "https://evil.example", "client-three"),
    (error: unknown) => error instanceof WalletAuthError && error.code === "CHALLENGE_MISMATCH"
  );
});
