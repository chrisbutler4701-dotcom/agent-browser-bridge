# Field Browser Bridge product specification

Field Browser Bridge is a self-hosted Node.js broker and Chrome MV3 extension. A paired browser makes an outbound authenticated connection to the broker, and separately authenticated MCP clients request capability-scoped browser reads or safe control actions.

## Product boundaries

- The broker and extension have no runtime dependency on a vendor-operated service. Users enter their own broker address; no hosted server is configured by default.
- Browser pairing credentials and MCP client credentials are separate and cannot substitute for each other.
- The extension never exports cookies, browser storage, passwords, MFA values, hidden controls, or existing form values through page reads.
- Browser control is off until the user enables it. Final send, submit, save, delete, purchase, and signing actions stay behind the verified-action boundary.
- The broker has no runtime npm dependencies. The optional cloud-browser image alone installs `playwright-core`.

## Supported surfaces

- Chrome 116+ extension with a side panel for server address, pairing, read permissions, control state, browser identity, and verified-action approvals.
- MCP Streamable HTTP at `/mcp`, with `/work-edge/mcp` as a compatibility alias.
- OAuth 2.1 with PKCE and dynamic client registration for web clients.
- Scoped bearer tokens for local coding agents.
- Pairing, ingest, screenshots, durable command delivery, browser registry, and verified actions under `/work-edge/` routes.

## Deployment contract

Production startup requires `PUBLIC_BASE_URL`. Writable state defaults under `FBB_DATA_DIR` (`/data` in containers), including browser and agent token verifiers, browser registry, command state, OAuth state, receipts, and encrypted transactions. First boot creates private secrets once in `/data/secrets.json` with mode `0600`, including distinct OAuth web-app and owner-administration passphrases, and never prints them during normal startup.

The standard self-host entry point is `deploy/selfhost/docker-compose.yml`. Remote installs must place the broker behind HTTPS. The optional cloud-browser profile runs the same extension with a persistent Chrome profile and the same pairing flow as any other browser.

## Compatibility constraints

- Keep the extension-to-broker pairing, ingest, WebSocket, polling, result, and screenshot wire contracts stable.
- Keep browser resolution explicit: an offline default browser never falls back to another online browser.
- Keep capability checks identical between `tools/list` and `tools/call`.
- Keep verified proposals bound to the authenticated principal, browser, target, values, pre-state, approval hash, and receipt chain.
- Keep Node.js at 22.12 or newer and Chrome at 116 or newer.

## Release gate

`npm test` must pass with no failures. The release reviewer also builds both Docker images, verifies the normal and cloud extension package differences, and performs a local pairing and MCP smoke test.
