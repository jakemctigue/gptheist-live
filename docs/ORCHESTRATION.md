# Wallet and orchestration boundary

GPTHEIST targets Robinhood Chain mainnet (chain ID 4663). The Desk prepares an unsigned quote for the configured Alchemy session address. It does not ask a browser wallet to sign or submit that quote.

## Alchemy session

`ORCHESTRATOR_SESSION_PRIVATE_KEY` identifies the Alchemy session. The Desk reads the derived address and uses it as the wallet for paper positions and quote preparation. The private key is not sent to the browser, and this application does not broadcast transactions with it.

A browser extension is not part of the live path. There is no EIP-6963 discovery, `personal_sign` login, or `eth_sendTransaction` handoff.

Do not implement an unattended broadcaster by placing an additional treasury key in the browser or in a route that signs arbitrary calldata. Keep the session key in the secret manager.

## AI provider configuration

Railway injects these server-only variables:

- `OPENAI_API_KEY` with `OPENAI_MODEL=gpt-6-astra`
- `ANTHROPIC_API_KEY` with `ANTHROPIC_MODEL=claude-opus-5`
- `TOGETHER_API_KEY`, with an optional explicit `TOGETHER_MODEL`

`GET /api/providers` reports only configuration readiness and model names. It never returns or logs a key. No model is currently authorized to prepare, sign, or submit a transaction. Any future model response must be parsed as untrusted advisory data and passed through deterministic policy gates.

## n8n

n8n is appropriate around the application, not inside the signing boundary. Recommended responsibilities are deployment checks, `/health` monitoring, alerts, daily summaries, MongoDB checkpoint monitoring, and human approval routing. Run it as a separate service with its own database, encryption key, authenticated webhooks, and least-privilege credentials.

Do not give n8n a wallet seed or an endpoint that signs quotes. It should never be the signer.

## Gainium

Gainium is designed around its supported exchange bots and webhook actions. GPTHEIST trades Pons curves directly on Robinhood Chain, so Gainium is not the execution engine for this path. If it is added later, start in Gainium paper mode with a read-only or bot-restricted API key and use it only for independent strategy comparison. Never forward its webhook output directly to transaction signing.

## End-to-end control flow

1. The checkpointed collector stores Robinhood Chain data in MongoDB.
2. GPTHEIST derives a deterministic WATCH or VETO assessment.
3. Optional AI providers may explain the evidence but cannot change the deterministic result.
4. The Desk binds the configured Alchemy session address. No browser signature is required.
5. The server enforces chain, venue, fee, score, slippage, impact, simulation, gas, and session-address gates. The quote stays unsigned.
6. Optional n8n workflows observe health and results after the fact.
