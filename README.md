# Field Browser Bridge

Field Browser Bridge lets your own AI agent work in your real Chrome browser through a self-hosted MCP broker. You choose read and control permissions, and final actions require your approval. Page reads filter sensitive browser data before it leaves the browser; cookies, storage, passwords, hidden fields, and existing form values are excluded. Screenshots are different: they can include anything visible, so enable them deliberately.

## 10-minute local quickstart

You need Node.js 22.12+ and Chrome 116+. Docker Compose is optional. Local setup uses `127.0.0.1` and needs no domain or HTTPS.

```sh
npm ci
cd deploy/selfhost
docker compose up -d --build
docker compose exec broker npm run pair-code
```

**No Docker?** Run the broker directly with Node. Keep this terminal open; run the other commands in a second terminal with the same three variables exported:

```sh
npm ci
export FBB_DATA_DIR="$PWD/.fbb-data" PUBLIC_BASE_URL=http://127.0.0.1:8767 FBB_LISTEN_HOST=127.0.0.1
npm start
# second terminal, same exports:
npm run pair-code
npm run agent-token -- create --id claude-code --cap browser.read,browser.control
```

Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this repository's `extension/` folder. Open the extension side panel, choose **Bridge**, and enter `http://127.0.0.1:8767/work-edge/ingest` as the server address. Paste the single-use pairing code from the last command and click **Pair browser**. The standard extension build accepts this loopback HTTP URL; no special build flag is needed. Grant site read permission when Chrome asks, and turn on **Browser control** only if you want the agent to act.

Create a separate scoped key for Claude Code. The command prints the key once; copy it privately:

```sh
docker compose exec broker npm run agent-token -- create --id claude-code --cap browser.read,browser.control
```

In a terminal with Claude Code installed, substitute the printed key for `<agent-token>`:

```sh
claude mcp add --transport http field-browser-bridge http://127.0.0.1:8767/mcp --header 'Authorization: Bearer <agent-token>'
claude mcp list
```

Ask Claude Code to list available Field Browser Bridge tools or read the current tab. Codex and other HTTP MCP clients can use the same `/mcp` endpoint with a bearer authorization header; mint a separate key for each agent. Keep agent keys out of shell history and shared configuration when possible. To stop the local service, run `docker compose down` from `deploy/selfhost/` (the state volume remains).

## Remote HTTPS for web apps

Claude.ai and ChatGPT require a publicly reachable HTTPS broker URL. Run the same Compose service behind your own HTTPS reverse proxy, set `PUBLIC_BASE_URL=https://bridge.example.com` in `deploy/selfhost/.env`, and restart with `docker compose up -d`. Enter `https://bridge.example.com/work-edge/ingest` in the extension. The MCP URL is `https://bridge.example.com/mcp`. Web clients use the broker's OAuth sign-in flow and start with read access; the owner can grant more capabilities. See [self-hosting](deploy/selfhost/README.md) for a Caddy example. Keep the local port private to the host when exposing the proxy.

## Safety model

Browser pairing and agent authentication use separate credentials. Each agent key has explicit capabilities and can be revoked. Read access requires Chrome site permission; control requires the browser toggle. The broker blocks ordinary final send, submit, save, delete, purchase, and signing actions. Verified actions bind proposed values and page state to an approval and record a receipt. Page text is filtered before transfer; screenshots may expose visible sensitive content and require the broker policy to allow them. Unauthenticated MCP requests are rejected.

## Architecture

```text
Your AI agent --HTTP MCP + scoped token--> Broker on your machine
                                           ^
                                           | authenticated WebSocket
                                           |
Your Chrome <--site permissions + approval-- Extension side panel
```

The extension connects outward to the broker. The broker routes authorized commands to a paired browser and returns filtered results to the agent. No vendor-hosted broker is configured in this repository.

## Testing

```sh
npm ci
npm test
```

The test command validates the extension package and runs the Node test suite. GitHub Actions runs the same commands on Node 22. The source is Apache-2.0 licensed; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
