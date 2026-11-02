# Broker

`broker/src/server.js` is a dependency-free Node.js HTTP server. It serves MCP at `POST /mcp` and `/work-edge/mcp`, OAuth discovery and authorization routes, authenticated browser ingest, pairing, screenshot ingest, command polling/results, and WebSocket command transport.

## Configuration

Production startup requires `PUBLIC_BASE_URL`. `FBB_LISTEN_HOST` and `FBB_LISTEN_PORT` override the policy listen address; container startup defaults the host to `0.0.0.0`. The server reads `WORK_EDGE_POLICY`, then `config/policy.local.json`, then `config/policy.example.json`.

Persistent state defaults beneath `FBB_DATA_DIR=/data`:

- `/data/browser-tokens.json`
- `/data/agent-tokens.json`
- `/data/browser-registry.json`
- `/data/command-state.json`
- `/data/oauth.json`
- `/data/verified-action-receipts.json`
- `/data/verified-action-transactions.json`
- `/data/verified-action-transactions.key`

First boot stores generated credentials in `/data/secrets.json` with mode `0600`, including separate OAuth web-app and owner-administration passphrases. Use `npm run owner-token` only when the owner recovery token must be copied to a client, and `npm run owner-passphrase` only when signing in to owner administration.

## URL and audit policy

`allowOrigins` accepts exact URL origins or the standalone wildcard `"*"`. Deny prefixes always take precedence. URL paths and queries remain excluded from returned URL context unless `audit.includeUrlPath` is true.

Audit events exclude content bodies and write structured metadata to standard output. Production log retention and access controls belong to the deployment environment.
