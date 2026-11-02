# Packaging a hosted extension

Set `FBB_HOSTED_INGEST_URL` in the packaging environment, then run `npm run package:extension`. For example, the ingest URL has the form `https://bridge.example.com/work-edge/ingest`.

The package step writes this value into `hosted-default.js`, the server address field, and the extension's host permissions. The address is optional. Without it, the package contains empty defaults and users enter their own server addresses. Do not commit a generated package containing private deployment values.
