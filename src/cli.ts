#!/usr/bin/env node
import "dotenv/config";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, EXECUTION_MODE, ensureSafeAuditDirectory, runSimulation, sanitizeTerminal, validateFixture, writeJsonlLog, type ReplayFixture, type SimulationResult } from "./simulation.js";
import { createHttpRpcCaller, startDeskServer } from "./server.js";
import { DEFAULT_RPC_URL } from "./live.js";
import { paperLedgerStoreFromEnv, paperPolicyFromEnv, paperReport, stepPaperLedger, type PaperReport } from "./paperLedger.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function rpcUrlFromEnv(): string | undefined {
  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
  const alchemyRpc = alchemyKey && /^[A-Za-z0-9_-]{10,200}$/.test(alchemyKey)
    ? `https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}#nologs,${DEFAULT_RPC_URL}`
    : undefined;
  return process.env.ROBINHOOD_RPC_URL ?? process.env.RPC_URL ?? alchemyRpc;
}

function formatEth(wei: string): string {
  const value = BigInt(wei);
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / 10n ** 18n;
  const fraction = (magnitude % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${sign}${whole}.${fraction} ETH`;
}

function formatUsd(wei: string, ethUsd: number | null): string {
  if (ethUsd === null) return "";
  return ` ($${((Number(BigInt(wei)) / 1e18) * ethUsd).toFixed(2)})`;
}

async function spotEthUsd(): Promise<number | null> {
  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(5_000) });
    const body = await response.json() as { data?: { amount?: string } };
    const value = Number(body.data?.amount);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function formatPaperReport(report: PaperReport, ethUsd: number | null): string {
  const pct = (bps: number | null): string => bps === null ? "n/a" : `${(bps / 100).toFixed(2)}%`;
  const lines = [
    "GPTHEIST — FORWARD PAPER LEDGER (paper-only; no orders are sent)",
    `Started ${report.startedAt}; ${report.cycles} cycles; last ${report.lastCycleAt ?? "never"} at block ${report.lastBlock ?? "n/a"}`,
    `Stake per paper trade: ${formatEth(report.stakeWei)}${formatUsd(report.stakeWei, ethUsd)}`,
    `Positions: ${report.opened} opened, ${report.open} open, ${report.closed} closed (${report.wins} wins / ${report.losses} losses, win rate ${pct(report.winRateBps)})`,
    `Skipped at capacity: ${report.skippedAtCapacity}`,
    `Exits: take-profit ${report.exitReasons.TAKE_PROFIT}, stop-loss ${report.exitReasons.STOP_LOSS}, max-hold ${report.exitReasons.MAX_HOLD}, left-curve ${report.exitReasons.LEFT_CURVE}`,
    `Realized P&L: ${formatEth(report.realizedPnlWei)}${formatUsd(report.realizedPnlWei, ethUsd)}`,
    `Unrealized P&L: ${formatEth(report.unrealizedPnlWei)}${formatUsd(report.unrealizedPnlWei, ethUsd)}`,
    `Total P&L: ${formatEth(report.totalPnlWei)}${formatUsd(report.totalPnlWei, ethUsd)} on ${formatEth(report.capitalDeployedWei)} deployed (${pct(report.returnOnDeployedBps)})`
  ];
  if (report.lastError) lines.push(`Last cycle error: ${report.lastError}`);
  for (const position of report.positions.slice(0, 10)) {
    const outcome = position.status === "OPEN"
      ? `OPEN mark ${formatEth(position.markWei)}${position.markStale ? " (stale)" : ""}`
      : `${position.exitReason ?? "CLOSED"} P&L ${formatEth(position.pnlWei ?? "0")}`;
    lines.push(`  ${sanitizeTerminal(position.symbol).padEnd(12)} ${position.openedAt} ${outcome}`);
  }
  return `${lines.map((line) => sanitizeTerminal(line)).join("\n")}\n`;
}

async function loadFixture(path: string): Promise<ReplayFixture> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("Unable to read fixture file");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Fixture is not valid JSON");
  }
  validateFixture(raw);
  return raw;
}

function formatResult(result: SimulationResult, logPath: string): string {
  const lines = [
    "GPTHEIST — PAPER-TRADING REPLAY",
    "Safety: simulation only; no wallet, signing, private keys, or live execution.",
    ""
  ];
  for (const handoff of result.agents) {
    lines.push(`[${handoff.timestamp}] ${handoff.agent.padEnd(10)} ${handoff.outcome.padEnd(4)} :: ${handoff.role} — ${handoff.message}`);
  }
  lines.push("", `FINAL: ${result.decision} — ${result.status} (${result.mode}; executed=${String(result.paperTrade.executed)})`);
  lines.push(`Paper trade: ${result.paperTrade.side} ${result.paperTrade.positionPct.toFixed(2)}% ${result.paperTrade.market} @ ${result.paperTrade.referencePrice.toFixed(2)}`);
  lines.push(`Audit: ${sanitizeTerminal(logPath)}`);
  return `${lines.join("\n")}\n`;
}

async function runFixture(path: string): Promise<void> {
  const result = runSimulation(await loadFixture(path));
  const logPath = await writeJsonlLog(result, resolve(process.cwd(), "runs"));
  process.stdout.write(formatResult(result, logPath));
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "demo") {
    await runFixture(resolve(projectRoot, "fixtures/success.json"));
    return;
  }
  if (command === "replay") {
    const fixturePath = args[1];
    if (fixturePath === undefined) throw new Error("Usage: gptheist replay <fixture.json>");
    await runFixture(resolve(process.cwd(), fixturePath));
    return;
  }
  if (command === "agents") {
    process.stdout.write("GPTHEIST — TEN AGENTS, ONE DECISION\n\n");
    AGENTS.forEach((agent, index) => {
      process.stdout.write(`${index + 1}. ${agent.name} — ${agent.role}\n   ${agent.responsibility}\n`);
    });
    return;
  }
  if (command === "desk") {
    const option = (name: string): string | undefined => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const host = option("--host") ?? "127.0.0.1";
    const portText = option("--port") ?? process.env.PORT ?? "4173";
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535");
    const pollMsText = process.env.ROBINHOOD_POLL_MS ?? "1000";
    const pollMs = Number(pollMsText);
    if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
      throw new Error("ROBINHOOD_POLL_MS must be an integer from 250 to 60000");
    }
    const rpcUrl = rpcUrlFromEnv();
    const cacheMs = Math.max(0, pollMs - 100);
    const server = await startDeskServer(rpcUrl ? { host, port, rpcUrl, cacheMs, failureCacheMs: pollMs } : { host, port, cacheMs, failureCacheMs: pollMs });
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    process.stdout.write(`GPTHEIST DESK — Robinhood Chain watch with browser-wallet execution gates\nhttp://${sanitizeTerminal(host)}:${boundPort}\nPolling every ${pollMs} ms. The server never receives the treasury key; an optional isolated session key can be configured.\n`);
    await new Promise<void>(() => undefined);
    return;
  }
  if (command === "paper") {
    const store = paperLedgerStoreFromEnv();
    if (args[1] === "report") {
      const ledger = await store.load();
      if (!ledger) {
        process.stdout.write("No paper ledger yet. Start one with: gptheist paper\n");
        return;
      }
      process.stdout.write(formatPaperReport(paperReport(ledger), await spotEthUsd()));
      return;
    }
    const policy = paperPolicyFromEnv();
    const rpc = createHttpRpcCaller(rpcUrlFromEnv());
    const pollText = process.env.PAPER_POLL_MS ?? "60000";
    const pollMs = Number(pollText);
    if (!Number.isSafeInteger(pollMs) || pollMs < 5_000 || pollMs > 3_600_000) throw new Error("PAPER_POLL_MS must be an integer from 5000 to 3600000");
    const once = args.includes("--once");
    for (;;) {
      const ledger = await stepPaperLedger(rpc, store, policy);
      const report = paperReport(ledger);
      process.stdout.write(`[${new Date().toISOString()}] PAPER block ${report.lastBlock ?? "n/a"}: ${report.open} open, ${report.closed} closed, total P&L ${formatEth(report.totalPnlWei)}${report.lastError ? `; error: ${sanitizeTerminal(report.lastError)}` : ""}\n`);
      if (once) {
        process.stdout.write(formatPaperReport(report, await spotEthUsd()));
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
  }
  if (command === "doctor") {
    const checks: Array<[string, () => Promise<boolean>]> = [
      ["Node.js >= 18", async () => Number(process.versions.node.split(".")[0]) >= 18],
      ["bundled demo fixture", async () => {
        await access(resolve(projectRoot, "fixtures/success.json"), constants.R_OK);
        return true;
      }],
      ["runs directory writable and safe", async () => {
        const runs = resolve(process.cwd(), "runs");
        await ensureSafeAuditDirectory(runs);
        await access(runs, constants.W_OK);
        return true;
      }],
      ["runtime dependencies allowlisted", async () => {
        const pkg = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        const dependencies = Object.keys(pkg.dependencies ?? {}).sort();
        return dependencies.length === 4
          && dependencies[0] === "@alchemy/wallet-apis"
          && dependencies[1] === "dotenv"
          && dependencies[2] === "mongodb"
          && dependencies[3] === "viem";
      }],
      ["replay execution boundary: paper-only", async () => EXECUTION_MODE === "paper-only"]
    ];
    let passed = 0;
    for (const [label, check] of checks) {
      try {
        if (await check()) {
          passed += 1;
          process.stdout.write(`PASS ${label}\n`);
        } else {
          process.stdout.write(`FAIL ${label}\n`);
        }
      } catch {
        process.stdout.write(`FAIL ${label}\n`);
      }
    }
    process.stdout.write(`Doctor: ${passed}/${checks.length} checks passed\n`);
    if (passed !== checks.length) process.exitCode = 1;
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write([
      "GPTHEIST — deterministic ten-agent market replay",
      "",
      "Usage:",
      "  gptheist demo",
      "  gptheist replay <fixture.json>",
      "  gptheist agents",
      "  gptheist desk [--host 127.0.0.1] [--port 4173]",
      "  gptheist paper [--once]",
      "  gptheist paper report",
      "  gptheist doctor",
      "",
      "Paper: forward paper ledger that enters Desk WATCH launches at live curve prices; never signs or sends.",
      "Desk: Robinhood Chain launch feed with optional browser-wallet trade gates.",
      "Replay: deterministic paper-only simulation.",
      ""
    ].join("\n"));
    return;
  }
  process.stderr.write(`Unknown command: ${sanitizeTerminal(command)}\n`);
  process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  const safeMessage = sanitizeTerminal(message).trim();
  process.stderr.write(`Error: ${safeMessage || "Unknown error"}\n`);
  process.exitCode = 1;
}
