# Independent SOL quote-paper research

This opt-in worker shares the existing Node service and hosted MongoDB. It does not sign, send transactions, change the baseline paper account, use per-tick AI, or promote strategies. Quotes are executable-route indications, not evidence of fills: transaction construction and realized execution remain unverified.

## Start calibration

Set `JUPITER_API_KEY` in the existing worker's secret store using a free Jupiter key. Keep `MONGODB_URI` and `GPTHEIST_MONGODB_DB` consistent with that worker. Set `RESEARCH_ENABLED=true` and a unique `RESEARCH_EXPERIMENT_ID`. The service starts the collector child on its next restart. Without a key, the collector records outages and candles but cannot create quote-backed fills.

For a bounded check with the same environment, run `npm run research:collect -- --once`. Run `npm run research:report` to print the current report. These commands build first. No scheduler or additional hosting service is required.

The immutable experiment records its policy, compiled-code hash and source identities before observations. Changing code or policy requires a new experiment ID; the worker refuses to silently continue an incompatible experiment. Mongo transactions atomically append evidence and update the independent state projection. A lease and hourly bucket prevent duplicate accounting after restart. This requires a Mongo deployment supporting transactions.

## Fixed candidate and collection design

The initial candidate uses completed Coinbase Exchange SOL/USD daily candles, a rising 100-day EMA, a 20-day breakout, 14-day ATR, a 3-ATR trailing stop, a 10-day low exit and a 20-day maximum holding time. Stops are evaluated on daily closes; they are not intraday stop orders. Age-triggered exits are checked hourly. Initial paper capital defaults to $20. Position sizing caps allocation at 25% of cash and modeled stop risk at 0.5% of cash. There is no daily trade quota, although this daily signal naturally limits entries.

After a five-minute publication lag, the worker samples one SOL/USDC entry and exact-net-output reverse quote each hour. Signal entries and held positions request additional quotes. Scheduled sampling alone is roughly 48 quote requests/day, before candidates, held-position marks, retries and public price/candle requests. Requests are paced and capped at 24 per tick. Candles are refreshed daily with a requested 250-day warmup; missing, revised, incomplete and stale observations cause abstention. Each quote retains request/observation timestamps, route and cost evidence. No historical fill is reconstructed from a later quote.

Entry requires a fresh valid reverse quote, known external fee estimates and immediate round-trip loss no larger than one third of modeled stop risk. Route fees are embedded in quoted amounts, not subtracted twice. External cost per leg is the greater of the provider estimate and a declared $0.02 default assumption. The report separately stresses an additional 1% per traded leg. Gas, failures, rent recovery and realized slippage still require execution evidence. USD valuation uses observed Coinbase USDC/USD and SOL/USD prices.

Pons records a separate static rejection: two modeled 3% slippage haircuts imply a 591-bps round-trip loss floor, above the 500-bps gate. Reserves are explicitly unobserved because this modeled floor already rejects the candidate. No extra Pons RPC polling is performed.

Evidence is append-only in `research_events_v1`; experiment manifests use `research_experiments_v1` and mutable projections use `research_states_v1`. There is no TTL deletion. Collection pauses after a 100 MB logical JSON evidence budget per experiment; BSON, indexes and state storage add overhead. The budget is not a hosting-bill guarantee. A paused tick is discarded atomically and no further quotes are requested on subsequent ticks.

## Freeze and evaluate

After calibration has valid complete candles and quote observations, run `npm run research:freeze -- sol-confirmation-v1` with the calibration ID still configured. This creates a new immutable confirmation manifest. Then set `RESEARCH_EXPERIMENT_ID=sol-confirmation-v1` and restart the existing worker. Confirmation begins with independent cash and excludes bars that closed before its freeze timestamp. Calibration outcomes are not confirmation evidence.

Reports include quote-paper equity, cash, a clearly labeled Coinbase price-proxy passive benchmark, mark age, outages, extra-slippage and total-open-position-loss stresses, and overhead. Leave `RESEARCH_DAILY_OVERHEAD_MICROS` unset until measured: net-after-overhead remains unknown. The passive benchmark is not an executable Jupiter benchmark. A minimum of 90 days and 30 closed trades only marks eligibility for independent review, not success. Venue-specific unseen and prospective evidence, statistical review, executable passive comparison and actual execution-cost evidence remain required before any promotion. Proxy gains never authorize promotion.

No new subscription or service is needed by this design. Existing hosting/database capacity and provider quotas must still be measured; incremental cost is not guaranteed to be zero.
