import { alchemyWalletTransport, createSmartWalletClient } from "@alchemy/wallet-apis";
import { createWalletClient, custom, defineChain, toHex, type Address, type EIP1193Provider, type Hex } from "viem";

interface SmartAccountPermission {
  type: string;
  data: Record<string, unknown>;
}

interface SmartAccountPlan {
  planId: string;
  accountId: string;
  accountType: "sma-b";
  chainId: 4663;
  owner: Address;
  expirySec: number;
  sessionKey: Address;
  totalFundingWei: string;
  permissions: SmartAccountPermission[];
}

interface SetupInput {
  provider: EIP1193Provider;
  owner: Address;
  plan: SmartAccountPlan;
}

interface SetupResult {
  account: Address;
  fundingTransactionHash: Hex;
  grant: unknown;
}

const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] }
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" }
  }
});

function assertAddress(value: string, label: string): asserts value is Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} is not a valid address`);
}

async function setup(input: SetupInput): Promise<SetupResult> {
  const owner = input.owner.toLowerCase();
  if (owner !== input.plan.owner.toLowerCase() || input.plan.chainId !== robinhoodChain.id || input.plan.accountType !== "sma-b") {
    throw new Error("Smart-account plan does not match the connected MetaMask owner or Robinhood Chain");
  }
  assertAddress(owner, "MetaMask owner");
  const walletClient = createWalletClient({
    account: owner,
    chain: robinhoodChain,
    transport: custom(input.provider)
  });
  const apiClient = createSmartWalletClient({
    signer: walletClient,
    chain: robinhoodChain,
    transport: alchemyWalletTransport({
      url: new URL("/api/smart-account/rpc", window.location.origin).href,
      retryCount: 0,
      timeout: 20_000
    })
  });
  const account = await apiClient.requestAccount({
    id: input.plan.accountId,
    creationHint: { accountType: "sma-b", createAdditional: true }
  });
  const permissions = await apiClient.grantPermissions({
    account: account.address,
    chainId: input.plan.chainId,
    expirySec: input.plan.expirySec,
    key: { publicKey: input.plan.sessionKey, type: "secp256k1" },
    permissions: input.plan.permissions
  });
  const balance = BigInt(await input.provider.request({ method: "eth_getBalance", params: [owner, "latest"] }) as Hex);
  const fundingValue = BigInt(input.plan.totalFundingWei);
  if (balance <= fundingValue) throw new Error("Treasury balance does not cover the capped funding amount plus its own transfer gas");
  const fundingTransactionHash = await input.provider.request({
    method: "eth_sendTransaction",
    params: [{ from: owner, to: account.address, value: toHex(fundingValue) }]
  }) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(fundingTransactionHash)) throw new Error("MetaMask returned an invalid funding transaction hash");
  const activationBody = JSON.stringify({
    planId: input.plan.planId,
    account: account.address,
    context: permissions.context,
    fundingTransactionHash
  });
  let activationResponse: Response | null = null;
  let activation: { error?: string; code?: string } = {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    activationResponse = await fetch("/api/smart-account/activate", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: activationBody
    });
    activation = await activationResponse.json() as { error?: string; code?: string };
    if (activationResponse.ok || activation.code !== "FUNDING_NOT_FOUND") break;
    await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  if (!activationResponse?.ok) throw new Error(`${activation.code ?? "ACTIVATION_FAILED"}: ${activation.error ?? `HTTP ${activationResponse?.status ?? 0}`}`);
  return { account: account.address, fundingTransactionHash, grant: activation };
}

declare global {
  interface Window {
    GptheistSmartAccount: { setup: typeof setup };
  }
}

window.GptheistSmartAccount = { setup };
