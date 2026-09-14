import dotenv from "dotenv";

dotenv.config({ quiet: true });

const apiKey = process.env.ALCHEMY_API_KEY?.trim();

if (!apiKey) {
  console.error(
    "Missing ALCHEMY_API_KEY. Create a .env file with ALCHEMY_API_KEY=<my-key>.",
  );
  process.exit(1);
}

const rpcUrl = `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`;
let requestId = 1;

async function callRpc(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
  };

  if (params !== undefined) {
    body.params = params;
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Alchemy returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? response.statusText;
    throw new Error(`Alchemy HTTP ${response.status}: ${message}`);
  }

  if (payload.error) {
    throw new Error(
      `Alchemy JSON-RPC ${payload.error.code}: ${payload.error.message}`,
    );
  }

  return payload;
}

async function main() {
  const health = await callRpc("getHealth");
  const slot = await callRpc("getSlot", [{ commitment: "finalized" }]);
  const latestBlockhash = await callRpc("getLatestBlockhash", [
    { commitment: "finalized" },
  ]);

  console.log(
    JSON.stringify(
      {
        health,
        slot,
        latestBlockhash,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
