# Wallet and orchestration boundary

GPTHEIST targets Robinhood Chain mainnet (chain ID 4663). The application may prepare a transaction, but only the selected MetaMask account can sign and submit it.

## MetaMask and hardware wallets

The desk discovers MetaMask through EIP-6963, explicitly requests access to `eth_accounts`, switches to Robinhood Chain, and asks the selected account to sign a short-lived login challenge. A transaction still creates a separate MetaMask confirmation.

Ledger and Trezor EVM accounts connected through MetaMask use the same application path. Message and transaction signatures remain inside MetaMask and require the hardware device when the account is hardware-backed. GPTHEIST never receives a recovery phrase, private key, hardware-wallet transport, or unrestricted signing token.

This is deliberately non-custodial. A truly custodial or unattended signer would be a separate security product: it needs an HSM or MPC quorum, withdrawal and contract allowlists, independent 33% enforcement, audit logs, emergency revocation, and a reviewed recovery ceremony. Do not implement that by placing a private key or seed phrase in Railway.

## AI provider configuration

Railway injects these server-only variables:

- `OPENAI_API_KEY` with `OPENAI_MODEL=gpt-6-astra`
- `ANTHROPIC_API_KEY` with `ANTHROPIC_MODEL=claude-opus-5`
- `TOGETHER_API_KEY`, with an optional explicit `TOGETHER_MODEL`

`GET /api/providers` reports only configuration readiness and model names. It never returns or logs a key. No model is currently authorized to prepare, sign, or submit a transaction. Any future model response must be parsed as untrusted advisory data and passed through deterministic policy gates.

## n8n

n8n is appropriate around the application, not inside the signing boundary. Recommended responsibilities are deployment checks, `/health` monitoring, alerts, daily summaries, MongoDB checkpoint monitoring, and human approval routing. Run it as a separate service with its own database, encryption key, authenticated webhooks, and least-privilege credentials.

Do not give n8n a wallet seed, MetaMask session cookie, or an endpoint that bypasses the browser-wallet approval. It should never be the signer.

## Gainium

Gainium is designed around its supported exchange bots and webhook actions. GPTHEIST trades Pons curves directly on Robinhood Chain, so Gainium is not the execution engine for this path. If it is added later, start in Gainium paper mode with a read-only or bot-restricted API key and use it only for independent strategy comparison. Never forward its webhook output directly to transaction signing.

## End-to-end control flow

1. The checkpointed collector stores Robinhood Chain data in MongoDB.
2. GPTHEIST derives a deterministic WATCH or VETO assessment.
3. Optional AI providers may explain the evidence but cannot change the deterministic result.
4. The user explicitly authorizes the MetaMask account with a one-time signed challenge.
5. The server enforces chain, venue, fee, score, 33% sizing, slippage, impact, simulation, gas, and authenticated-wallet gates.
6. MetaMask displays the final transaction. A hardware-backed account also requires physical device confirmation.
7. Optional n8n workflows observe health and results after the fact.
