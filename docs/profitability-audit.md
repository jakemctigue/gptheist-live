# Profitability audit: $20 forward paper account

Evidence captured from the hosted paper API on 2026-10-06. This audit concerns the fixed `pons-forward-v1` baseline, started 2026-09-29T11:57:52.439Z and scheduled to finish 2026-10-29T11:57:52.439Z. Execution is disabled. The reported results are paper results, not real fills or an estimate of future income.

## Measured result

The complete returned five-position ledger reconciles to the reported cash/equity of **$18.256172**, a realized loss of **$1.743828 (8.71914% of starting capital)**. No position remains open. All five trades lost money.

| Entry date UTC | Score | Debit including entry gas | Net exit proceeds | Realized P&L | Close reason |
| --- | ---: | ---: | ---: | ---: | --- |
| September 29 | 75 | $2.019242 | $1.609122 | -$0.410120 | STOP_LOSS |
| September 30 | 70 | $1.982123 | $1.645058 | -$0.337065 | TIME_STOP |
| October 1 | 75 | $1.945507 | $1.720062 | -$0.225445 | TIME_STOP |
| October 2 | 75 | $1.936384 | $1.733760 | -$0.202624 | TIME_STOP |
| October 3 | 85 | $1.911815 | $1.343241 | -$0.568574 | STOP_LOSS |

Total entry debit was $9.795071 and net proceeds were $8.051243. The ledger records **$0.125591 of entry gas**, approximately 7.2% of the loss. This does **not** mean the other 92.8% was price movement: exit gas, tax, slippage, reserve changes and ETH/USD movement are mixed into net proceeds. The public API does not supply enough observations to attribute these components separately. Do not call net paper returns gross token returns.

The October 3 position lost 29.74% against its debit by the first mark about a minute after entry, despite an 85 assessment score. A 20% stop is a trigger, not a guaranteed loss cap; gaps, costs and polling delay can overshoot it. Higher assessment scores have not demonstrated a predictive edge in this sample. Five outcomes are insufficient to establish a stable win rate or optimize parameters.

## Cost hurdle

The baseline models:

1. Entry tax deducted from the quote input.
2. Constant-product reserve impact on token output.
3. A 3% entry slippage haircut on acquired tokens.
4. Constant-product reverse-sale impact, exit tax and another 3% slippage haircut.
5. Gas added to entry debit and deducted from exit proceeds.

For quote reserve Q, token reserve T, gross quote input G, fee fraction f and slippage fraction s, the integer implementation is:

```text
entry fee      = floor(G * feeBps / 10000)
effective      = G - entry fee
expected token = floor(T * effective / (Q + effective))
acquired token = floor(expected token * (10000 - slipBps) / 10000)
expected exit  = floor(Q * acquired token / (T + acquired token))
exit fee       = floor(expected exit * feeBps / 10000)
modeled exit   = floor((expected exit - exit fee) * (10000 - slipBps) / 10000)
debit USD      = entry notional USD + entry gas USD
proceeds USD   = max(0, floor(modeled exit * ETH/USD / 10^18) - exit gas USD)
P&L USD        = proceeds USD - debit USD
```

With negligible reserve impact, 5% tax and 3% slippage on each leg, only `(0.95 * 0.97)^2 = 84.916225%` of gross input survives before gas. Tax and slippage alone therefore cost about 15.08%, and recovering that friction requires about 17.76% gross appreciation under this simplified proportional model. Even **zero tax** leaves approximately 5.91% loss from two 3% slippage haircuts before gas and reserve impact.

The new exact evaluator mirrors baseline reserve treatment: both quotes use the same observed reserves, since the paper buy does not actually change on-chain reserves. It uses integer arithmetic and binary search for the smallest quote reserve producing a break-even sale while token reserve, ETH/USD, tax and gas stay fixed. This is a hypothetical cost sensitivity, not an attainable reserve forecast. If actual token reserve changes, use new executable quotes rather than extrapolating this hurdle.

A reproducible scenario uses Q = 1 ETH, T = 10^24 token units, ETH/USD = $2,000, entry notional = $2, gas = $0.02 per leg, fee = 5%, slippage = 3%. Entry debit is **$2.02**, unchanged-reserve exit proceeds are **$1.675152**, immediate loss is **$0.344848 (17.08% rounded up)**, and the quote-reserve growth hurdle is **20.35% rounded up** with all other inputs fixed. These are synthetic sensitivity inputs, not the five trades' missing entry market states.

## Operational and accounting limits

At capture the worker reports `eth_chainId failed after bounded retries: RPC HTTP 429`. This explains missing opportunities; restored connectivity does not by itself create an economic edge. The most recent trade closed October 3. A process status of RUNNING is not evidence of successful observation.

The older worker observed at capture also updated `lastTickAt` on errors. The recovered worker records failed attempts in `lastAttemptAt`, and sets `lastSuccessfulTickAt` and `lastTickAt` only after successful tick completion. A successful tick may intentionally skip feeds when the daily entry limit is exhausted or the month ends flat; `lastMarketDataAt` is an observation timestamp, not independently verified block-time freshness. Consequently the audit treats `lastTickAt` in a version-neutral way: a null error and recent tick means only `NO_REPORTED_ERROR`, never independently verified healthy market data. Stale or unavailable ticks are flagged.

The older worker initialized an open position's mark to zero with PENDING status, temporarily undervaluing equity by the whole position. The recovered worker initializes new positions with the cost-adjusted reverse-sale quote at the same observed reserves used by later marks, including unchanged fees, slippage and modeled exit gas. This repairs initial valuation without introducing a reserve-treatment discontinuity or rewriting the five historic closed rows. Legacy PENDING and any UNAVAILABLE marks must still be labeled in reports.

The recovered worker renews its existing lease before bounded provider calls and checks owner plus expiry in the same MongoDB transaction as each ledger mutation. Expired or replaced owners cannot write positions or run totals. This requires a transaction-capable replica set or sharded topology; the hosted target's read-only `hello` check confirmed a replica set and session support. Provider calls remain outside transaction callbacks so a database retry does not repeat external market requests.

The API returns only the newest 25 positions. The audit compares returned rows with entry and closed counts before reconciling row P&L to run totals. Once rows are truncated, row totals are partial, and the module refuses to present them as a complete ledger. Platform/provider overhead is outside this paper portfolio. Actual net profitability needs measured hosting and API bills deducted as a separate expense.

## Separate candidate study, not a rewrite of the baseline

`src/profitability.ts` provides three pure functions:

- `auditPaperProfitability`: validates and reconciles integer ledger amounts, flags incomplete history and valuation limits, and reports provider errors.
- `analyzePaperEntryEconomics`: calculates unchanged-reserve immediate liquidation loss and an exact fixed-token-reserve break-even sensitivity.
- `evaluatePaperCandidate`: gates a **separately versioned** `pons-cost-momentum-research-v1` candidate using a permitted immediate-loss budget and at least three distinct pre-decision reserve observations spanning a specified period. Future observations are excluded. Stale observations and insufficient evidence reject the candidate.

The candidate is not connected to the fixed worker and cannot submit transactions. A 5% immediate-loss budget would reject every baseline trade with the current 3% per-leg slippage assumption before even adding gas. Rejecting costly opportunities and holding cash is a valid result; passing a gate does not forecast profitability. Do not reduce cost assumptions solely to make a backtest look profitable.

The existing public ledger contains no chronological reserve time series, so **no candidate backtest or positive holdout result is claimed**. First obtain block/time-stamped market observations with explicit collection start/end and gaps, and quote costs available at each decision time. Freeze selection parameters on an earlier training segment, then evaluate a later untouched chronological segment and a cash benchmark. Reserve interpolation across outages, post-hoc selection of winners, and score optimization on these five trades would contaminate the result.

The useful next result is a forward record of eligible/rejected candidate decisions, including observed cost hurdle, data freshness, reason and later executable paper exits. Entry frequency should be earned by evidence, not a daily quota. Continue the original baseline independently for comparison. Only promote a candidate after a complete cost-adjusted holdout and forward sample supports it.

## Verification

`tests/profitability.test.ts` exercises exact five-trade reconciliation, incomplete ledger coverage, invalid or duplicate rows, stale attempts/PENDING marks, minimum break-even reserve boundary, economic gate rejection, exclusion of future data and rejection of stale/duplicate observations. There is no live order, secret output, database write or strategy mutation in this module.

Recovery verification uses Node v24.21.0 locally; `package.json` declares Node >=18 and Railway uses Railpack rather than a pinned repository Dockerfile. The new feed fixtures use the static `Response.json` helper: compatibility on an older Node 18 runtime is not established by these local tests. Confirm the actual deployed Node version during Railway build/runtime verification before claiming hosted compatibility.
