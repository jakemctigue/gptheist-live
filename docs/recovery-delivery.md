# Hosted recovery delivery — 2026-10-06

The hosted importers and original $20 month-long paper worker are recovered. This is an operational recovery, not a profitable strategy or a completed month-long result. Real trading remains disabled. MongoDB data and secrets remain hosted; no local transaction database or new local credential file was created.

## Verified hosted releases

| Service | Successful Railway deployment | Scope |
| --- | --- | --- |
| Paper worker | `eb8244f7-4875-4349-8707-4cbdfa681df9` | Chain-validated read RPC fallback, Coinbase price observation, honest initial marks/freshness, transactional lease fencing |
| Main importer | `be02574c-35df-4bb7-b108-d8181a4cf6ff` | dRPC Ethereum, checkpoint reuse, bounded requests/restarts, canonical historical-log and receipt-batch compatibility |

Both deployments were checked through Railway and live service interfaces. Paper build logs selected Node **18.20.8**; its deployed worker completed real Atlas-fenced accounting writes successfully. Full local suites used Node 24.21.0. Remote test execution was unavailable because Railway SSH has no registered key; no key was registered to bypass that limitation.

Paper source was uploaded from the clean `C:/Users/Jake/gptheist-live/gptheist-paper-recovery` worktree (`codex/paper-service-recovery`, deployment base `126911f`). Its seven authored files were synchronized back to the original checkout. Publication uses `codex/paper-recovery-publish` on the runtime-identical code base `c4459de`, excluding the unpublished `126911f` checkpoint's generated graphs/browser logs while preserving it locally. Main importer source was uploaded from the separate `C:/Users/Jake/gptheist-live/gptheist-drpc-recovery` worktree (`codex/drpc-market-recovery`), based on recovered importer commit `7566b6d`. Commit/push scope is the eight paper recovery/report files and four importer recovery files on those separate published branches. No main-branch merge is included. User research scripts and unrelated dirty artifacts were preserved and excluded from uploads and commits. Local MCP client settings, authentication state, EH host files and generated context graphs are not part of the repository commits.

## Live evidence

- Original run: `paper-month-v1`, strategy `pons-forward-v1`, 2026-09-29T11:57:52.439Z through 2026-10-29T11:57:52.439Z. The policy snapshot, dates, five existing position IDs and historical accounting remained unchanged after deployment.
- Post-deploy paper observation: `lastSuccessfulTickAt` and `lastMarketDataAt` advanced to **2026-10-06T10:02:34.182Z**, disposition `OBSERVED`, error null. Coinbase price provenance reports observation 10:02:34.978Z and HTTP source date 10:02:34Z. Later ticks continue independently on Railway.
- Hosted MongoDB `hello` confirmed a replica set with sessions. A read-only transaction on the actual run committed successfully before release; the deployed fenced tick subsequently wrote successful accounting/status updates.
- Main `/health`: status `ok`, chain 4663, `trading: false`. Its legacy paper ledger is separate from the fixed-month paper worker; its trade count must not be reported as that run's count.
- Ethereum historical checkpoint advanced **26108111 → 26108311**, stored transactions **55637 → 55833**, timestamp **10:05:38Z**. Robinhood advanced **78648482 → 79348482**, stored transactions **661446 → 664597**, timestamp **10:06:13Z**. Existing job IDs, historical starting boundaries and Mongo collections were preserved. These are evidence snapshots, not current-head completeness claims.

## Provider cost controls and limitations

The paper worker explicitly uses `https://rpc.mainnet.chain.robinhood.com` with `https://robinhood-rpc.publicnode.com` as a chain-validated fallback, and Coinbase ETH/USD observations. Every endpoint is checked for chain 4663; requests are read-only, bounded and rate-limit-aware. A flat run at its daily limit does not needlessly poll feeds. Observation timestamps do not independently establish the endpoint's block-time freshness.

Ethereum import uses the existing Railway dRPC secret, with a 60-second poll and at most 100 blocks per tick. Historical start discovery is reused from the checkpoint instead of doing a binary search on every poll. Failed receipt batches fall back to individual calls within the same three-attempt budget. Historical logs use exact canonical block hashes when dRPC rejects numeric historical ranges; mismatched or missing hydration data stops advancement instead of silently omitting transactions. Robinhood import polls at 10 seconds and resumes its existing checkpoint.

The supplied dRPC Solana endpoint rejects this account's free-plan entitlement. Solana market importing is explicitly disabled, not silently replaced or upgraded. Existing Solana history was not deleted. Alchemy remains configured for owner-authorized smart-account ETH/USD Prices API and Wallet API (`wallet_requestAccount`, `wallet_createSession`) paths; recurring recovered trading-data RPC loops do not use it. No monthly savings figure is claimed without actual provider bills. Public Robinhood endpoints remain rate-limited; no production SLA is implied.

## Measured economics, not a profit promise

The fixed paper account remains **$18.256172**, down **$1.743828 (8.71914%)** from $20: five closed trades, five losses, no open positions at verification. Hosting/API expenses are additional and are not included in that paper equity. The run is not finished until October 29. No future earnings estimate is supported by this record.

The baseline retains its original gas, tax, position-size, stop and slippage assumptions. Its two 3% modeled slippage haircuts alone impose about 5.91% round-trip friction before tax, gas and reserve impact. A separate pure cost/momentum research gate was added, but it is not connected to execution or substituted for the fixed baseline. No positive chronological PONS holdout result has been demonstrated. See [profitability audit](profitability-audit.md) for complete five-trade reconciliation and synthetic cost sensitivities clearly separated from measured results.

## EH orchestration and verification

Event Horizon runs through the dedicated local VS Code host and authenticated stdio bridge. **20 saved launch definitions / 23 checks passed**, including initialization, discovery of 52 tools and an actual `eh_list_plans` call. Claude Code and Factory independently reported connected. Existing sessions need reload; saved-command verification does not establish native GUI consent in every dormant client. Raw remote model APIs cannot auto-discover a loopback server. No public tunnel or firewall opening was created.

EH has no registered Codex spawning backend (`No backend registered for type: codex`). Actual native Codex workers were used and honestly registered as native adapter sessions under the EH plan, rather than represented as EH-spawned agents. Two pre-existing access-denied shell lock hooks and some GUI client loading remain unverified. Setup details: `C:/Users/Jake/.event-horizon/README.md`.

- Clean paper suite/build: **87 passed, 1 expected skip, 0 failed** (88 total).
- Clean main suite/build: **79 passed, 1 expected skip, 0 failed** (80 total).
- Synchronized root's exact three impacted recovery test files: **30/30 passed**.
- EH client checks: **23/23 passed**; diff checks passed.
- vexp reported no parse errors or broken imports; its generic `get` dependency warnings were reviewed, not treated as evidence of an API break. Repository has no lint script, so no lint pass is claimed.

Remaining work is economic validation and reliable ongoing data coverage, not authorization to trade real funds. The hosted fixed baseline will continue on its existing schedule. Any new strategy needs an explicitly separate version, chronological data with gaps labeled, and net-of-cost holdout plus forward evidence before promotion.
