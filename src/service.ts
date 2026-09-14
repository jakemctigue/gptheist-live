import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const children = new Set<ChildProcess>();
let shuttingDown = false;
let syncRestart: NodeJS.Timeout | null = null;

export function transactionSyncArgsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const pollMs = env.ROBINHOOD_POLL_MS?.trim() || "1000";
  const scope = env.TRANSACTION_SYNC_SCOPE?.trim() || "pons-launches";
  const confirmations = env.TRANSACTION_SYNC_CONFIRMATIONS?.trim() || "1";
  const batchSize = env.TRANSACTION_SYNC_BATCH_SIZE?.trim() || "100";
  const jobId = env.TRANSACTION_SYNC_JOB_ID?.trim() || "robinhood-three-months";
  return [
    resolve(runtimeDirectory, "transactionImport.js"),
    "--scope", scope,
    "--months", "3",
    "--follow",
    "--poll-ms", pollMs,
    "--confirmations", confirmations,
    "--batch-size", batchSize,
    "--job-id", jobId
  ];
}

function syncEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env.TRANSACTION_SYNC_ENABLED ?? "true").trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error("TRANSACTION_SYNC_ENABLED must be true or false");
  return value === "true" && Boolean(env.ALCHEMY_API_KEY?.trim() || env.ROBINHOOD_RPC_URL?.trim());
}

function launchDesk(): void {
  const child = spawn(process.execPath, [resolve(runtimeDirectory, "cli.js"), "desk", "--host", "0.0.0.0"], {
    env: process.env,
    stdio: "inherit"
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (shuttingDown) return;
    process.stderr.write(`Desk process exited with code ${String(code ?? 1)}; stopping service for a clean platform restart.\n`);
    process.exitCode = code ?? 1;
    shutdown();
  });
}

function launchSync(): void {
  const child = spawn(process.execPath, transactionSyncArgsFromEnv(), { env: process.env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (shuttingDown) return;
    process.stderr.write(`Checkpointed transaction sync exited with code ${String(code ?? 1)}; restarting from MongoDB in 5 seconds.\n`);
    syncRestart = setTimeout(launchSync, 5_000);
  });
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (syncRestart) clearTimeout(syncRestart);
  for (const child of children) child.kill("SIGTERM");
  const forceExit = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 8_000);
  forceExit.unref();
}

export function startService(): void {
  launchDesk();
  if (syncEnabled(process.env)) {
    process.stdout.write("TRANSACTION SYNC — enabled; MongoDB checkpoint robinhood-three-months will resume automatically.\n");
    launchSync();
  } else {
    process.stdout.write("TRANSACTION SYNC — skipped; configure ALCHEMY_API_KEY or ROBINHOOD_RPC_URL to enable durable ingestion.\n");
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    startService();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "service startup failed";
    process.stderr.write(`GPTHEIST service failed: ${message}\n`);
    process.exitCode = 1;
  }
}
