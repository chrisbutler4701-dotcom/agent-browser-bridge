# Extension architecture

The Chrome MV3 extension is a control surface and outbound browser transport for one configured Field Browser Bridge server.

## Configuration and pairing

The side panel stores a validated server address. HTTPS servers are allowed; plain HTTP is restricted to explicit-port `127.0.0.1` or `localhost` in the normal build. A non-hosted HTTPS origin requires a Chrome runtime host-permission grant before it is saved. Changing origin clears the old pairing token, disables control, and closes the old transport so credentials never cross server boundaries.

Pairing exchanges a short-lived single-use code for a browser token. The token remains in extension-local storage and authenticates only browser transport routes. It cannot authenticate MCP.

## Read and control paths

Page reads require Chrome-granted normal-page access. Captures are sanitized before delivery and omit cookies, browser storage, hidden fields, passwords, MFA values, and existing form values. Sensitive-origin restrictions are an optional additional approval layer.

Control is a separate reversible toggle. An offscreen document owns the durable command transport so MV3 service-worker suspension does not create competing sockets. WebSocket is primary; authenticated polling is recovery. Both routes deliver through the same queue and executor safety checks.

## Cloud variant

The cloud package contains the same runtime files. Its manifest differs only in `host_permissions`, which becomes `["<all_urls>"]`, and its packaged build-time constant allows the container-only HTTP broker hostname. A persistent `/profile` volume preserves pairing across restarts. The pairing helper uses the normal `pair-browser` and `toggle-browser-control` messages and receives no bypass token.

## Updating an unpacked extension

Replace files in the same directory originally loaded through `chrome://extensions`, then choose **Reload**. Keeping the same directory preserves the extension ID and `chrome.storage`; reinstalling from a new path creates a new identity and requires pairing again.
