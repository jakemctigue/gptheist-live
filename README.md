<p align="center">
  <img src="./assets/avatar.jpg" alt="GPTHEIST" width="128">
</p>
<p align="center">
  <img src="./assets/banner.jpg" alt="GPTHEIST — Ten agents. One decision." width="100%">
</p>

<p align="center">
  <strong>Ten agents pass one market decision forward. Any one of them can kill it.</strong>
</p>

<p align="center">
  <a href="https://github.com/jakemctigue/gptheist-live/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jakemctigue/gptheist-live/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="mode" src="https://img.shields.io/badge/mode-paper--only-e5484d">
  <img alt="runtime dependencies" src="https://img.shields.io/badge/runtime%20dependencies-viem-f4efe6">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-f4efe6">
</p>

GPTHEIST is a Robinhood Chain launch desk plus a deterministic market-replay CLI inspired by the ten-agent operating system described by [@immortalhowwl](https://x.com/immortalhowwl). Every Pons factory launch crosses ten visible evidence stages. Palermo can veto a trade before the Desk prepares an unsigned Pons v2 curve transaction for the user's browser wallet.

The server never receives a private key and never signs. It verifies the chain, factory record, curve phase, quote asset, fees, score, size, price impact, wallet balances and a pinned-block simulation. A passing transaction still requires a separate click and approval in the connected EIP-1193 browser wallet.

<p align="center">
  <img src="./assets/desk.png" alt="GPTHEIST Desk showing live Robinhood Chain launches and a Palermo veto" width="100%">
</p>

## Sixty seconds

Requires Node.js 18 or newer.

```bash
git clone https://github.com/jakemctigue/gptheist-live.git
cd gptheist-live
npm install
npm run desk
```

Open `http://127.0.0.1:4173`. The Desk reads recent `TokenLaunched` events from the verified Pons v2 factory on Robinhood Chain (chain ID `4663`). Selecting a launch also loads that deployer's on-chain launch and graduation history for the preceding 30 days. The execution panel can prepare native-ETH curve buys and sells when live trading is enabled.

For the fully offline deterministic replay instead:

```bash
npm run demo
```

The replay uses the bundled `fixtures/success.json`:

```text
GPTHEIST — PAPER-TRADING REPLAY
Safety: simulation only; no wallet, signing, private keys, or live execution.

[2026-01-15T12:00:00.000Z] TOKYO      INFO :: Scout — Observed GPTHEIST-USDC at 0.42 from bundled replay data.
[2026-01-15T12:00:01.000Z] BERLIN     INFO :: Planner / criteria — Criteria locked: momentum >= 0.55, social quality >= 0.50/100 samples, liquidity >= $1m, slippage <= 25 bps.
[2026-01-15T12:00:02.000Z] RIO        PASS :: Technical / chart analysis — Momentum score 0.72.
[2026-01-15T12:00:03.000Z] DENVER     PASS :: Social-signal quality — Social score 0.66 across 250 fixture samples.
[2026-01-15T12:00:04.000Z] LISBON     PASS :: Data / handoff validation — Fixture schema validated; ordered handoff continuity is structurally enforced.
[2026-01-15T12:00:05.000Z] STOCKHOLM  PASS :: Liquidity / slippage / position sizing — Liquidity $5000000; slippage 8 bps; simulated size 1.50%.
[2026-01-15T12:00:06.000Z] NAIROBI    INFO :: Signal brief — Brief: technical, social, data, and sizing checks cleared.
[2026-01-15T12:00:07.000Z] HELSINKI   INFO :: Append-only audit / logistics — Audit trace 9d64be648f8a52d3 prepared; execution remains disabled.
[2026-01-15T12:00:08.000Z] PALERMO    PASS :: Red-team veto gate — Red-team gate found no policy violation.
[2026-01-15T12:00:09.000Z] PROFESSOR  PASS :: Final coordinator / decision — Approved for paper simulation only; no order was sent.

FINAL: PASS — approved (paper-only; executed=false)
Paper trade: BUY 1.50% GPTHEIST-USDC @ 0.42
Audit: runs/b8d3603a21d62139.jsonl
```

## Commands

| Command | What it does |
|---|---|
| `npm run desk` | Builds and opens the read-only live launch desk on port `4173` |
| `npm run demo` | Builds and runs the bundled safe replay |
| `node dist/src/cli.js replay fixtures/veto.json` | Replays any local fixture and writes an audit log |
| `node dist/src/cli.js agents` | Lists all ten roles and boundaries |
| `node dist/src/cli.js doctor` | Checks Node, fixture access, logs, dependencies, and execution mode |
| `npm test` | Builds and runs the complete test suite |

## Production deployment

The included `railway.json` builds the TypeScript project, starts the Desk on Railway's assigned `PORT`, and checks `/health`. Deploy the repository from the Railway dashboard or CLI after setting a production RPC endpoint. This example keeps Alchemy as the primary provider and routes event-log history to Robinhood's archive RPC:

```bash
railway variables set ROBINHOOD_RPC_URL="https://robinhood-mainnet.g.alchemy.com/v2/your-key#nologs,https://rpc.mainnet.chain.robinhood.com"
railway up
```

`ROBINHOOD_RPC_URL` may contain a comma-separated fallback list. Append `#nologs` to an endpoint that supports ordinary reads but does not support `eth_getLogs`:

```text
https://read-rpc.example#nologs,https://archive-rpc.example
```

The live feed scans 25,000 recent blocks. A selected deployer's research dossier performs a cached, time-based 30-day scan and discovers the correct starting block from on-chain timestamps. `RPC_URL` remains supported as a compatibility alias. If only `ALCHEMY_API_KEY` is present, the app automatically builds the same Alchemy-plus-archive endpoint list. With none of these variables set, the app uses public Robinhood Chain endpoints suitable for local evaluation and light traffic.

Live trade preparation is disabled by default. Enable it only with explicit limits:

```bash
railway variables set LIVE_TRADING_ENABLED=true
railway variables set TRADE_MAX_BUY_WEI=50000000000000000
railway variables set TRADE_MAX_BUY_WALLET_BPS=1000
railway variables set TRADE_MAX_SLIPPAGE_BPS=300
railway variables set TRADE_MAX_PRICE_IMPACT_BPS=500
railway variables set TRADE_MAX_TOTAL_FEE_BPS=500
railway variables set TRADE_MIN_BUY_SCORE=70
railway variables set TRADE_MAX_QUOTE_AGE_BLOCKS=300
```

`TRADE_MAX_BUY_WEI` defaults to 0.05 ETH. The wallet-relative cap defaults to 10%, slippage to 3%, estimated price impact to 5%, total curve fee plus tax to 5%, the buy score to 70/100, and quote validity to 300 blocks. Sells must fit the connected wallet's token balance. The server returns calldata only after `eth_call` and gas estimation pass; `eth_sendTransaction` exists only in the browser and always opens the wallet's approval screen.

After `npm link`, use the shorter binary form:

```bash
gptheist desk
gptheist demo
gptheist replay fixtures/veto.json
gptheist agents
gptheist doctor
```

## The handoff

```text
TOKYO → BERLIN → RIO → DENVER → LISBON
  → STOCKHOLM → NAIROBI → HELSINKI
  → PALERMO (PASS / VETO) → PROFESSOR
```

1. **Tokyo** frames the observation.
2. **Berlin** locks the criteria before analysis.
3. **Rio** checks technical context.
4. **Denver** grades the supplied social signal.
5. **Lisbon** validates data and handoffs.
6. **Stockholm** checks liquidity, slippage, and simulated size.
7. **Nairobi** compresses the cleared signals.
8. **Helsinki** prepares an append-only trace.
9. **Palermo** attempts to stop unsafe work.
10. **Professor** returns the final paper-only decision.

See [`docs/AGENTS.md`](docs/AGENTS.md) for responsibilities and approval boundaries.

## Replay your own fixture

Copy a bundled fixture and edit its observation fields:

```bash
cp fixtures/success.json my-replay.json
npm run build
node dist/src/cli.js replay my-replay.json
```

Every replay input is local JSON; replay mode does not fetch market data. Fixtures are schema-validated before the first handoff, and terminal control characters are escaped. Identical input under the same policy version produces the same run ID, handoffs, timestamps, and final decision. Audit records are written to `runs/<run-id>.jsonl`. Existing records are immutable: the CLI refuses to overwrite a run ID with different content.

A run is vetoed when any configured boundary fails, including:

- incomplete or invalid replay data;
- momentum below `0.55`;
- social quality below `0.50` or fewer than `100` fixture samples;
- liquidity below `$1,000,000`;
- estimated slippage above `25 bps`;
- requested size outside its explicit cap;
- any supplied risk flag.

These thresholds are demonstration rules, not trading advice or validated predictors.

## What this is not

- not ten live LLM instances;
- not evidence that a historical trade happened;
- not a backtesting engine or profit calculator;
- not a custodial wallet, exchange, broker, or autonomous trading agent;
- not able to hold a private key, bypass the configured gates, or approve a wallet prompt.

The Desk verifies factory provenance and reads each launch's current Pons state at the same snapshot block. A deterministic score can place supported ETH launches on the **WATCH** list; unsupported pairs, unsafe taxes, completed/rescued curves, malformed evidence, and unavailable reads receive an explicit **VETO**. A WATCH result is only one input to the stricter execution policy and is never a promise of market quality.

It is an open, deterministic reference implementation of the **ownership → handoff → veto → final decision** pattern. Use it to inspect and extend the coordination logic before connecting any external system.

## Development

```bash
npm install
npm test
npm run build
npm pack --dry-run
```

The only direct runtime dependency is `viem`, used to ABI-encode and decode pinned read-only Multicall3 requests. CI tests Node 18 and Node 20, and dependency audits run before release.

## Safety

Never put secrets or private keys into fixtures or server variables. Live transactions are handed to the browser wallet only after all server gates pass, and the user must approve them there. Pons v2 currently reports that its independent audits are still in progress; treat the contracts and launch tokens as experimental and verify the token address and wallet transaction before signing.

## License

MIT © [@immortalhowwl](https://x.com/immortalhowwl)
