#!/usr/bin/env node
import "dotenv/config";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, EXECUTION_MODE, ensureSafeAuditDirectory, runSimulation, sanitizeTerminal, validateFixture, writeJsonlLog, type ReplayFixture, type SimulationResult } from "./simulation.js";
import { startDeskServer } from "./server.js";
import { DEFAULT_RPC_URL } from "./live.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
    const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
    const alchemyRpc = alchemyKey && /^[A-Za-z0-9_-]{10,200}$/.test(alchemyKey)
      ? `https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}#nologs,${DEFAULT_RPC_URL}`
      : undefined;
    const rpcUrl = process.env.ROBINHOOD_RPC_URL ?? process.env.RPC_URL ?? alchemyRpc;
    const cacheMs = Math.max(0, pollMs - 100);
    const server = await startDeskServer(rpcUrl ? { host, port, rpcUrl, cacheMs, failureCacheMs: pollMs } : { host, port, cacheMs, failureCacheMs: pollMs });
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    process.stdout.write(`GPTHEIST DESK — Robinhood Chain watch with browser-wallet execution gates\nhttp://${sanitizeTerminal(host)}:${boundPort}\nPolling every ${pollMs} ms. The server never stores a private key or signs a transaction.\n`);
    await new Promise<void>(() => undefined);
    return;
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
        return dependencies.length === 3 && dependencies[0] === "dotenv" && dependencies[1] === "mongodb" && dependencies[2] === "viem";
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
      "  gptheist doctor",
      "",
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
