# Verified Action Runtime

Verified Action Runtime is the transaction boundary for consequential computer-use actions. It is model-independent: any authenticated MCP principal may propose an action when granted, but only this runtime may bind approval to the exact proposal and produce evidence of the persisted result.

## Invariant and lifecycle

An approval authorizes one immutable proposal—not a tool name, browser session, or general permission. Changing the authenticated agent, target, origin, record identifier, field, value, or proposal metadata changes the proposal hash and invalidates approval.

1. `proposed` — capture intent, actor, target, pre-action state hash, and exact changes.
2. `approved` — bind approver, proposal hash, approval time, and expiration.
3. `executing` — re-hash the proposal and freshly observed pre-action state; refuse proposal changes, state drift, or expired approval.
4. `indeterminate` — execution began, but the broker lost an authoritative result or post-commit verification. The action must not be replayed.
5. `verified` — structured persisted state exactly matches the approved changes.
6. `failed` — an authoritative execution failure or structured persistence mismatch is recorded.

## Recovery and receipt integrity

Pending snapshots are sealed with AES-256-GCM under a 256-bit key. Transaction files, keys, and receipts use mode `0600` and atomic writes. Altered ciphertext, metadata, receipts, or chain links fail closed.

`proposed` and `approved` transactions may resume after restart with the original hash and expiration. A transaction found in `executing` becomes `indeterminate`; it is never automatically replayed. `edge_verified_action_reconcile` performs a structured read-only verification against the originally bound browser target. Exact match creates a verified receipt; mismatch creates a failed receipt; unavailable or wrong-target readback leaves it indeterminate.

Receipts use deterministic JSON ordering and SHA-256. Each receipt links to the previous durable head and retains field names plus hashes of approved values, intent, target, and authenticated ownership identity. Receipt creation and ownership checks use the same canonical `{ agentId }` projection.

## Deliberate limits

- Ordinary final-action tools remain blocked. Final actions require preflight, exact approval, state recheck, commit, verification, and receipt creation.
- The proposing principal owns the transaction. Peer principals cannot inspect, execute, or reconcile it; audit-read permission grants observation only.
- Hashes are integrity evidence, not signatures or non-repudiation.
- Page text and field contents do not appear in receipts.
- Losing the transaction key makes pending transactions unrecoverable by design.
- Screenshot-only model judgment is insufficient for a `persisted_match` result; the verifier requires structured state.

## Browser integration

The paired Chrome extension hashes current field values without exporting them, surfaces exact proposed values in a local approval card, and binds the decision to the proposal hash. Execution performs a second preflight, refuses state drift, applies only approved values, reaches the explicitly named final control, and returns structured post-state for deterministic verification and receipt creation.
