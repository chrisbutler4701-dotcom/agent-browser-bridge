# Agent identities and capabilities

The MCP facade authenticates agent clients separately from paired browsers. A browser token proves which Chrome instance may transport commands and local approvals. An agent token proves which model or harness may request specific tools. Neither credential substitutes for the other.

`WORK_EDGE_MCP_TOKEN` is the owner recovery credential. The browser pairing administrator credential in `WORK_EDGE_DEV_TOKEN` never authenticates MCP requests.

## Grants

| Capability | Allows | Does not allow |
| --- | --- | --- |
| `browser.read` | Captured status, tabs, snapshots, screenshots, extracted text, and capture-scoped element discovery | Live DOM discovery or browser mutation |
| `browser.control` | Live safe-element discovery and ordinary constrained click, press, type, scroll, select, navigate, and wait tools | Verified final actions |
| `browser.verified.propose` | Field inspection, immutable proposal creation, and status/receipt access for the principal's own transactions | Execution or reconciliation |
| `browser.verified.execute` | Execution, reconciliation, and status/receipt access for the principal's own transactions | Reading or executing a peer principal's transaction |
| `browser.audit.read` | Read any verified transaction status or receipt | Proposal, ordinary control, execution, or reconciliation |
| `delegate_runs` | Issue and revoke short-lived, one-browser run credentials through `/agent-grants` | Direct MCP browser tools by itself |
| `manage_browser_privacy` | Set per-browser privacy through `POST /agent-grants/privacy` | Browser read or control authority by itself |
| `private_browser_local` | Use a private browser with this key | Browser read or control authority by itself |

`tools/list` returns only tools reachable through at least one grant. Every `tools/call` repeats authorization independently, including the `scope: "live"` distinction for `edge_find_elements`.

`edge_screenshot` remains under `browser.read` because it does not mutate the page, but it is a fresh live capture rather than stored DOM readback. Runtime execution also requires the human-controlled browser toggle, normal-page host permission, screenshot-enabled broker policy, and a supported extension version. Its PNG is scoped to the exact paired browser and command; `browser.control` alone does not grant screenshot access.

## Provisioning

Self-hosted state defaults to `/data`, so the standard commands are:

```bash
export FBB_DATA_DIR=/data
npm run agent-token -- create --id my-agent --cap browser.read,browser.control
npm run agent-token -- list
npm run agent-token -- revoke --id my-agent
```

The create command prints the token once. The store retains only its SHA-256 verifier, agent ID, grants, credential version, creation time, and optional revocation time in a mode-`0600` atomically replaced file. A revoked ID may be provisioned again with `create`; this issues new bearer material, increments its credential version, and never reactivates the old token. A malformed or unreadable store fails closed.

The broker can issue short-lived delegated run credentials with `delegate_runs`. A run grant lasts at most 30 minutes, is pinned to one browser and one lane, and is revoked by `DELETE /agent-grants/:run_id`. Its capabilities are limited by the issuing key. Verified final actions still require normal approval.

Users can mark browsers private. Private browsers reject cloud agent keys unless the principal has `private_browser_local`; `manage_browser_privacy` controls the privacy setting. The `POST /agent-grants/privacy` route accepts a browser ID and boolean `private` value. These grants never expand read or control permissions by themselves.

## Safe recovery and transaction ownership

Keep the owner recovery token private and use scoped identities for routine clients. A configured owner token remains accepted even when scoped identities exist, preventing a lost or revoked agent token from becoming an administrative lockout. Without an owner token, scoped agent identity, or OAuth access token, MCP access remains closed.

New verified proposals bind `actor.agentId` to the authenticated principal. Only that principal may execute or reconcile the proposal. Audit readers may inspect status and receipts but cannot act on the transaction. Missing or invalid `actor.agentId` fails closed.

## Tab targeting (1.1.0, approved in 2026-10-22)

Agents can read, control, and switch between any open tab, not only the front tab.

- `edge_list_open_tabs` (browser.read): every open tab with its `tabId`, window, title, address (query string removed), and which tab is in front.
- `edge_read_tab` (browser.read): read any tab's text by `tabId` without switching to it.
- `tabId` is accepted by `edge_click`, `edge_press`, `edge_type`, `edge_scroll`, `edge_select`, `edge_navigate`, `edge_wait`, `edge_screenshot`, and live `edge_find_elements`. Omit it to act on the front tab exactly as before.
- `edge_open_tab` (browser.control): opens a tab in the background by default; `active: true` brings it forward.
- `edge_activate_tab` (browser.control): brings a tab to the front. Use only when the user wants to see it.
- `edge_close_tab` (browser.control): closes a tab.

Background tabs are worked without stealing focus, so the user can keep working and chatting in the front tab. A named tab is never substituted: if it closed or moved to another site, the command is refused with `tab_not_found` or `tab_changed`. Background screenshots use the `debugger` permission; Chrome shows its debugging bar while a capture runs, and the extension detaches right after. Final-action URLs and controls stay blocked, URL policy still applies to new tabs, and the one-agent-at-a-time control lock is unchanged.

## Look before acting and per-tab snapshots (1.2.0, approved in 2026-10-22)

- The broker keeps the latest snapshot per tab. `edge_snapshot`, `edge_extract_text`, and capture-scope `edge_find_elements` accept `tabId`; `edge_list_tabs` lists every captured tab instead of only the last one.
- The broker remembers, per agent, the page address it last saw in each tab (from snapshot reads, `edge_read_tab`, navigation, and the read returned after every action). Memory only; cleared when an agent is disconnected.
- `edge_click`, `edge_press`, `edge_type`, and `edge_select` are refused with `look_first` if the agent has not seen the page now in that tab (or it moved to another address). The refusal carries a fresh snapshot, so the agent can decide again and retry. Scroll, wait, and navigate do not require a prior look.
- Every agent action returns a fresh read of the same tab afterwards, even when background read monitoring is off. Sensitive-page rules still apply.
- Browser-reported result codes are limited to `look_first`, `tab_changed`, `tab_not_found`, `tab_invalid`, and `screenshot_unavailable`; any other code from a browser is reported as `browser_denied`.

