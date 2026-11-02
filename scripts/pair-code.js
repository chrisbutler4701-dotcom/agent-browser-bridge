import { loadFirstBootSecrets } from '../broker/src/first-boot.js';

// Talk to the broker directly. Inside the container the public address (often an
// HTTPS proxy in front) may not be reachable, so use the local listen port.
export function adminBaseUrl(env = process.env) {
  if (env.FBB_ADMIN_URL) return String(env.FBB_ADMIN_URL).replace(/\/$/, '');
  if (env.FBB_IN_CONTAINER === '1') return `http://127.0.0.1:${env.FBB_LISTEN_PORT || 8767}`;
  return String(env.PUBLIC_BASE_URL || 'http://127.0.0.1:8767').replace(/\/$/, '');
}
const baseUrl = adminBaseUrl();
let token = process.env.WORK_EDGE_DEV_TOKEN;
if (!token) {
  try { token = loadFirstBootSecrets(process.env).pairingAdminToken; } catch { /* Keep the existing explicit error below. */ }
}

if (!token) {
  process.stderr.write('WORK_EDGE_DEV_TOKEN is required to create a pairing code.\n');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`${baseUrl}/pair/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Pair-code request failed with HTTP ${response.status}.`);
    process.stdout.write(`${result.code}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
