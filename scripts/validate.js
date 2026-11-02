import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTED_INGEST_URL } from '../extension/hosted-default.js';
import { HOSTED_COCKPIT_URL } from '../extension/hosted-default.js';
import { listZipEntries, listZipEntryMetadata, packageExtension } from './package-extension.js';

const root = new URL('..', import.meta.url).pathname;
const extension = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const requiredTools = ['edge_status', 'edge_bridge_status', 'edge_list_browsers', 'edge_list_tabs', 'edge_active_tab', 'edge_snapshot', 'edge_screenshot', 'edge_extract_text', 'edge_find_elements', 'edge_verified_action_status', 'edge_verified_receipt'];
const sourceFiles = [join(root, 'broker/src/server.js'), join(root, 'broker/src/tools.js'), join(root, 'broker/src/command-queue.js'), join(root, 'broker/src/oauth.js'), join(root, 'broker/src/mcp-http.js'), ...readdirSync(extension).filter((file) => file.endsWith('.js')).map((file) => join(extension, file))];

for (const file of sourceFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
if (manifest.manifest_version !== 3) throw new Error('Extension must use Manifest V3.');
for (const permission of ['activeTab', 'offscreen', 'scripting', 'storage']) if (!manifest.permissions?.includes(permission)) throw new Error(`Missing required permission: ${permission}`);
if (!manifest.permissions?.includes('sidePanel') || manifest.side_panel?.default_path !== 'sidepanel.html') throw new Error('Extension must declare the supported Field Browser Bridge side panel.');
const localBrokerPermission = 'http://127.0.0.1/*';
const localhostBrokerPermission = 'http://localhost/*';
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify([localBrokerPermission, localhostBrokerPermission])) throw new Error('Source extension host permissions must be loopback only.');
if (manifest.minimum_chrome_version !== '116') throw new Error('Extension WebSocket service worker support requires Chrome 116+.');
const expectedCsp = "script-src 'self'; object-src 'self'; connect-src 'self' https: wss: http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*";
if (manifest.content_security_policy?.extension_pages !== expectedCsp) throw new Error('Extension CSP must allow HTTPS/WSS servers and loopback HTTP/WS only.');
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(['<all_urls>', 'https://*/*'])) throw new Error('Normal-page reading and user-selected HTTPS servers must be separately granted optional permissions.');
if (manifest.background?.service_worker !== 'service-worker.js' || manifest.background?.type !== 'module') throw new Error('Extension background must be the module service worker.');
if (!manifest.action || manifest.action.default_popup !== undefined) throw new Error('Extension must declare an action that opens the supported side panel, not a popup.');
const popupHtml = readFileSync(join(extension, 'popup.html'), 'utf8');
if (!popupHtml.includes('id="brokerUrl" type="url" value="" placeholder="https://your-server.example/work-edge/ingest"')) throw new Error('The popup must offer a neutral server address placeholder.');
for (const forbiddenPopupControl of ['side_panel', 'sidePanel', 'id="chatTranscript"', 'id="miniChat"', 'mini-agent', 'id="persona"']) if (popupHtml.includes(forbiddenPopupControl)) throw new Error(`The popup must not contain ${forbiddenPopupControl}.`);
const expectedIcons = { 16: 'icons/work-edge-tools-16.svg', 32: 'icons/work-edge-tools-32.svg', 48: 'icons/work-edge-tools-48.svg', 128: 'icons/work-edge-tools-128.svg' };
if (JSON.stringify(manifest.icons) !== JSON.stringify(expectedIcons)) throw new Error('Extension must declare the standard icon sizes.');
if (JSON.stringify(manifest.action?.default_icon) !== JSON.stringify({ 16: expectedIcons[16], 32: expectedIcons[32] })) throw new Error('Extension action must declare its toolbar icons.');
for (const icon of Object.values(expectedIcons)) if (!existsSync(join(extension, icon))) throw new Error(`Missing extension icon: ${icon}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) throw new Error('Extension version must be a dotted numeric version.');
const toolsModule = await import(join(root, 'broker/src/tools.js'));
const serverModule = await import(join(root, 'broker/src/server.js'));
const brokerUrlModule = await import(join(root, 'extension/broker-url.js'));
const serviceWorkerModule = await import(join(root, 'extension/service-worker.js'));
if (serviceWorkerModule.validateBrokerUrl !== brokerUrlModule.validateBrokerUrl) throw new Error('The service worker must reuse the shared broker URL predicate.');
serverModule.validatePolicy({ listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: [], denyUrlPrefixes: [], capture: {} });
for (const invalidListen of [{ host: '', port: 8765 }, { host: '127.0.0.1', port: -1 }, { host: '127.0.0.1', port: 65536 }]) {
  let failed = false;
  try { serverModule.validatePolicy({ listen: invalidListen, allowOrigins: [], denyUrlPrefixes: [], capture: {} }); } catch { failed = true; }
  if (!failed) throw new Error('Policy listen host and port must be validated.');
}
for (const url of ['http://127.0.0.1:8765/ingest', 'http://localhost:8765/work-edge/ingest', 'https://example.com/ingest', 'https://example.com:8443/work-edge/ingest']) if (!brokerUrlModule.validateBrokerUrl(url)) throw new Error(`Approved broker URL rejected: ${url}`);
for (const url of ['http://example.com:8765/ingest', 'http://127.0.0.1/ingest', 'http://localhost/ingest', 'http://127.0.0.1:0/ingest', 'http://127.0.0.1:65536/ingest', 'http://127.0.0.1:8765/ingest?x=1', 'http://127.0.0.1:8765/ingest#f', 'http://user:pass@127.0.0.1:8765/ingest', 'https://example.com/ingest?x=1', 'https://user@example.com/ingest']) if (brokerUrlModule.validateBrokerUrl(url)) throw new Error(`Unapproved broker URL accepted: ${url}`);
const names = new Set(toolsModule.READ_ONLY_TOOLS.map((tool) => tool.name));
for (const tool of requiredTools) if (!names.has(tool)) throw new Error(`Missing required read-only MCP tool: ${tool}`);
packageExtension();
const packageFile = join(root, `dist/field-browser-bridge-${manifest.version}.zip`);
const packageEntries = listZipEntries(packageFile);
const packageEntryMetadata = listZipEntryMetadata(packageFile);
const requiredPackageEntries = ['manifest.json', 'popup.html', 'popup.css', 'popup.js', 'sidepanel.html', 'agents-panel.js', 'cockpit-panel.js', 'install-setup.js', 'service-worker.js', 'broker-url.js', 'hosted-default.js', 'agent-control-status.js', 'command-executor.js', 'command-runner-worker.js', 'offscreen.html', 'offscreen.js', 'content/capture.js', 'vendor/MAMMOTH-LICENSE', ...Object.values(expectedIcons)];
for (const entry of requiredPackageEntries) if (!packageEntries.includes(entry)) throw new Error(`Packaged extension is missing runtime file: ${entry}`);
for (const legacyEntry of ['mini-agent.js', 'page-intelligence.js', 'action-router.js']) if (packageEntries.includes(legacyEntry)) throw new Error(`Packaged extension must not contain local chat module: ${legacyEntry}`);
for (const entry of packageEntries) if (/(^|\/)(?:\.git|node_modules|test|tests|tokens)(?:\/|$)|(^|\/)[^/]*token[^/]*(?:\/|$)/i.test(entry)) throw new Error(`Packaged extension contains forbidden file: ${entry}`);
for (const entry of packageEntryMetadata) {
  const expectedMode = entry.isDirectory ? 0o755 : 0o644;
  if (entry.unixMode !== expectedMode) throw new Error(`Packaged extension entry ${entry.name} must use mode ${expectedMode.toString(8)}.`);
}
for (const file of packageEntries.filter((entry) => !entry.endsWith('/'))) {
  const segments = file.split('/');
  segments.pop();
  while (segments.length) {
    const directory = `${segments.join('/')}/`;
    if (!packageEntries.includes(directory)) throw new Error(`Packaged extension is missing directory entry: ${directory}`);
    segments.pop();
  }
}
console.log(`Validated Manifest V3, ${sourceFiles.length} JavaScript files, ${requiredTools.length} required read-only MCP tools, and ${packageEntries.length} packaged runtime files with readable ZIP permissions.`);
