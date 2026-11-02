# Self-host Field Browser Bridge

From this directory:

```sh
docker compose up -d
docker compose exec broker npm run pair-code
docker compose exec broker npm run agent-token -- create --id my-agent --cap browser.read,browser.control
```

Paste the pairing code from the second command into the extension and set its server address to `http://127.0.0.1:8767/work-edge/ingest`. The third command prints a new agent key once; copy it into your agent.

The broker generates its private first-boot secrets once in the `fbb-data` volume. It does not print the owner MCP token during startup. Retrieve that token only when needed with:

```sh
docker compose exec broker npm run owner-token
```

Owner administration uses a separate generated passphrase from OAuth web-app sign-in. Retrieve it only when needed with:

```sh
docker compose exec broker npm run owner-passphrase
```

## Remote HTTPS access

Do not expose the broker as plain HTTP. Put it behind HTTPS and set `PUBLIC_BASE_URL` in a local `.env` file to the public origin. For example, a Caddy configuration can be:

```caddyfile
bridge.example.com {
  reverse_proxy 127.0.0.1:8767
}
```

Then set `PUBLIC_BASE_URL=https://bridge.example.com`, restart the compose project, and use `https://bridge.example.com/work-edge/ingest` as the extension's server address.

## Cloud browser sandbox

The cloud browser keeps Chromium's sandbox on. It uses the shipped seccomp profile, `no-new-privileges`, and every Linux capability dropped except `SYS_CHROOT`, which the sandbox needs to confine its renderers. This was verified on Ubuntu 24.04 (kernel 6.8), where `chrome://sandbox` reports "You are adequately sandboxed."

The cloud browser keeps Chromium's sandbox enabled by default. The compose file ships with the Playwright seccomp profile needed for Chromium user namespaces, drops all Linux capabilities, and enables `no-new-privileges`.

At startup, the pairing helper checks `chrome://sandbox` and refuses to pair or serve unless Chromium reports that it is adequately sandboxed. There is no automatic fallback to `--no-sandbox`.

For local development only, set both `FBB_ENV=development` and `FBB_CLOUD_NO_SANDBOX=1`. Production startup refuses `FBB_CLOUD_NO_SANDBOX=1`.

## Production network egress

The broker policy denies navigation to cloud metadata, loopback, link-local, and RFC1918 destinations. The cloud image also installs a Chromium managed `URLBlocklist` for metadata and loopback hosts. On a production Docker host, add an egress firewall as the third layer, preserving the compose network so `http://broker:8767` still works:

```sh
COMPOSE_NETWORK=field-browser-bridge_default
CLOUD_CONTAINER=field-browser-bridge-cloud-browser-1
COMPOSE_SUBNET=$(docker network inspect "$COMPOSE_NETWORK" --format '{{(index .IPAM.Config 0).Subnet}}')
CLOUD_IP=$(docker inspect "$CLOUD_CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
iptables -I DOCKER-USER -s "$CLOUD_IP" -d 169.254.0.0/16 -j DROP
iptables -I DOCKER-USER -s "$CLOUD_IP" -d 10.0.0.0/8 -j DROP
iptables -I DOCKER-USER -s "$CLOUD_IP" -d 172.16.0.0/12 -j DROP
iptables -I DOCKER-USER -s "$CLOUD_IP" -d 192.168.0.0/16 -j DROP
iptables -I DOCKER-USER -s "$CLOUD_IP" -d "$COMPOSE_SUBNET" -j RETURN
```

Adapt the compose network and container names to the deployment. Persist equivalent rules with the host's firewall tooling.
