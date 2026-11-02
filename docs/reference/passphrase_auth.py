"""Passphrase sign-in for web connectors (claude.ai, ChatGPT).

Those apps can't send a fixed bearer header, so they connect with OAuth: they
register themselves, send the user here to sign in, then trade the code for
tokens. Signing in means typing MCP_LOGIN_PASSPHRASE on /login. No GitHub or
Google app is involved.

Clients and tokens are kept in a JSON file under the state directory so a
restart doesn't log the apps out. Refresh tokens never expire, so each app only
asks for the passphrase once.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import json
import os
import secrets
import time
from urllib.parse import urlparse

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse

from fastmcp.server.auth.auth import ClientRegistrationOptions, RevocationOptions
from fastmcp.server.auth.providers.in_memory import InMemoryOAuthProvider

PENDING_TTL = 10 * 60
MAX_FAILURES = 5          # wrong passphrases allowed per window
FAILURE_WINDOW = 15 * 60  # before /login locks for the rest of the window


class PassphraseOAuthProvider(InMemoryOAuthProvider):
    def __init__(self, *, base_url: str, passphrase: str, state_file: str):
        super().__init__(
            base_url=base_url,
            client_registration_options=ClientRegistrationOptions(enabled=True),
            revocation_options=RevocationOptions(enabled=True),
        )
        self._passphrase = passphrase
        self._state_file = state_file
        self._pending: dict[str, tuple[float, str, AuthorizationParams]] = {}
        self._failures: list[float] = []
        self._load()

    # ------------------------------------------------------------ persistence

    def _load(self) -> None:
        if not os.path.exists(self._state_file):
            return
        with open(self._state_file) as f:
            s = json.load(f)
        self.clients = {k: OAuthClientInformationFull.model_validate(v) for k, v in s["clients"].items()}
        self.access_tokens = {k: AccessToken.model_validate(v) for k, v in s["access_tokens"].items()}
        self.refresh_tokens = {k: RefreshToken.model_validate(v) for k, v in s["refresh_tokens"].items()}
        self._access_to_refresh_map = s["access_to_refresh"]
        self._refresh_to_access_map = s["refresh_to_access"]

    def _save(self) -> None:
        now = time.time()
        live_access = {k: v for k, v in self.access_tokens.items() if not v.expires_at or v.expires_at > now}
        s = {
            "clients": {k: v.model_dump(mode="json") for k, v in self.clients.items()},
            "access_tokens": {k: v.model_dump(mode="json") for k, v in live_access.items()},
            "refresh_tokens": {k: v.model_dump(mode="json") for k, v in self.refresh_tokens.items()},
            "access_to_refresh": self._access_to_refresh_map,
            "refresh_to_access": self._refresh_to_access_map,
        }
        tmp = self._state_file + ".tmp"
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            json.dump(s, f)
        os.replace(tmp, self._state_file)

    async def register_client(self, client_info):
        await super().register_client(client_info)
        self._save()

    async def exchange_authorization_code(self, client, authorization_code):
        token = await super().exchange_authorization_code(client, authorization_code)
        self._save()
        return token

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        token = await super().exchange_refresh_token(client, refresh_token, scopes)
        self._save()
        return token

    async def revoke_token(self, token):
        await super().revoke_token(token)
        self._save()

    # ------------------------------------------------------------ sign-in

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        """Park the request and send the user to /login instead of approving it."""
        if client.client_id not in self.clients:
            raise AuthorizeError(error="unauthorized_client", error_description="Client not registered.")
        now = time.time()
        self._pending = {k: v for k, v in self._pending.items() if v[0] > now}
        req = secrets.token_urlsafe(24)
        self._pending[req] = (now + PENDING_TTL, client.client_id, params)
        return f"{str(self.base_url).rstrip('/')}/login?req={req}"

    def _locked(self) -> bool:
        now = time.time()
        self._failures = [t for t in self._failures if t > now - FAILURE_WINDOW]
        return len(self._failures) >= MAX_FAILURES

    async def login(self, request: Request):
        if request.method == "GET":
            req = request.query_params.get("req", "")
            return self._page(req, error=None)

        form = await request.form()
        req = str(form.get("req", ""))
        pending = self._pending.get(req)
        if not pending or pending[0] < time.time():
            return self._page("", error="This sign-in link expired. Start the connection again from the app.")
        if self._locked():
            return self._page(req, error="Too many wrong tries. Wait 15 minutes, then try again.")

        typed = str(form.get("passphrase", "")).strip()
        digest = lambda s: hashlib.sha256(s.encode()).digest()  # noqa: E731 (equal-length compare)
        if not hmac.compare_digest(digest(typed), digest(self._passphrase)):
            self._failures.append(time.time())
            await asyncio.sleep(1)
            return self._page(req, error="That passphrase didn't match. Try again.")

        del self._pending[req]
        _, client_id, params = pending
        client = self.clients[client_id]
        # The parent issues and stores the authorization code.
        redirect = await InMemoryOAuthProvider.authorize(self, client, params)
        return RedirectResponse(redirect, status_code=302)

    def _page(self, req: str, error: str | None) -> HTMLResponse:
        pending = self._pending.get(req)
        app = ""
        if pending:
            client = self.clients.get(pending[1])
            host = urlparse(str(pending[2].redirect_uri)).hostname or "an app"
            name = (client.client_name if client and client.client_name else host)
            app = f"<p class=app><strong>{html.escape(name)}</strong> ({html.escape(host)}) wants to use your Builder Brain.</p>"
        err = f"<p class=err role=alert>{html.escape(error)}</p>" if error else ""
        form = (
            f"""<form method=post action=/login>
<input type=hidden name=req value="{html.escape(req)}">
<label for=p>Passphrase</label>
<input id=p name=passphrase type=password autocomplete=current-password autofocus required>
<button type=submit>Sign in</button>
</form>""" if pending else ""
        )
        return HTMLResponse(f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Sign in to Builder Brain</title>
<style>
body{{font:20px/1.5 system-ui,sans-serif;background:#111;color:#fff;margin:0;padding:24px;}}
main{{max-width:32rem;margin:8vh auto;}}
h1{{font-size:1.6em;margin:0 0 .5em}}
label{{display:block;font-weight:700;margin:1em 0 .3em}}
input{{width:100%;box-sizing:border-box;font-size:1.2em;padding:.6em;border:3px solid #fff;border-radius:8px;background:#000;color:#fff}}
button{{margin-top:1em;width:100%;font-size:1.2em;font-weight:700;padding:.7em;border:0;border-radius:8px;background:#ffd400;color:#000}}
.err{{background:#5a0000;border:3px solid #ff6b6b;padding:.6em;border-radius:8px}}
.app{{color:#ddd}}
</style></head><body><main>
<h1>Sign in to Builder Brain</h1>{app}{err}{form}
</main></body></html>""")
