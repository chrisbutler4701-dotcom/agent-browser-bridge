import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const scriptFile = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptFile));
const extensionDirectory = join(root, 'extension');
const outputDirectory = join(root, 'dist');

function packageNameForManifest() {
  const manifest = JSON.parse(readFileSync(join(extensionDirectory, 'manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) throw new Error('Extension version must be a dotted numeric version.');
  return `field-browser-bridge-${manifest.version}.zip`;
}
const forbiddenSegment = new Set(['.git', 'node_modules', 'test', 'tests', 'tokens']);
const requiredRuntimeEntries = new Set([
  'manifest.json', 'popup.html', 'popup.css', 'popup.js', 'sidepanel.html', 'privacy.html', 'privacy.js', 'swap.js', 'swap-store.js', 'content/restore-display.js', 'content/private-files.js', 'vendor/pdf.mjs', 'vendor/pdf.worker.mjs', 'vendor/mammoth.browser.min.js', 'vendor/MAMMOTH-LICENSE', 'agents-panel.js', 'cockpit-panel.js', 'install-setup.js', 'service-worker.js', 'frame-scope.js', 'broker-url.js', 'hosted-default.js',
  'agent-control-status.js', 'command-executor.js', 'command-runner-worker.js', 'offscreen.html', 'offscreen.js', 'content/capture.js',
  'icons/work-edge-tools-16.svg', 'icons/work-edge-tools-32.svg', 'icons/work-edge-tools-48.svg', 'icons/work-edge-tools-128.svg'
]);
const unixFileMode = 0o100644;
const unixDirectoryMode = 0o40755;

function runtimeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (forbiddenSegment.has(entry.name)) return [];
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeFiles(fullPath);
    if (!entry.isFile() || /token/i.test(entry.name)) return [];
    const runtimePath = relative(extensionDirectory, fullPath);
    return requiredRuntimeEntries.has(runtimePath) ? [runtimePath] : [];
  });
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; }
function uint32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer; }

function runtimeDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const segments = file.split('/');
    segments.pop();
    while (segments.length) {
      directories.add(`${segments.join('/')}/`);
      segments.pop();
    }
  }
  return [...directories].sort();
}

function externalAttributes(isDirectory) {
  const mode = isDirectory ? unixDirectoryMode : unixFileMode;
  // The upper word is the Unix mode; DOS directory bit helps non-Unix extractors.
  return ((mode << 16) >>> 0) | (isDirectory ? 0x10 : 0);
}

// Store-only ZIPs keep the artifact portable without requiring a global zip utility.
function createZip(files, contentsFor = (name) => readFileSync(join(extensionDirectory, name))) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  const entries = [
    ...runtimeDirectories(files).map((name) => ({ name, isDirectory: true })),
    ...files.map((name) => ({ name, isDirectory: false }))
  ];
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = entry.isDirectory ? Buffer.alloc(0) : contentsFor(entry.name);
    const checksum = crc32(contents);
    const local = Buffer.concat([uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(contents.length), uint32(contents.length), uint16(name.length), uint16(0), name, contents]);
    const central = Buffer.concat([uint32(0x02014b50), uint16(0x0314), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(contents.length), uint32(contents.length), uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(externalAttributes(entry.isDirectory)), uint32(offset), name]);
    localRecords.push(local);
    centralRecords.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  return Buffer.concat([...localRecords, centralDirectory, uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length), uint32(centralDirectory.length), uint32(offset), uint16(0)]);
}

export function listZipEntryMetadata(file) {
  const archive = readFileSync(file);
  for (let position = archive.length - 22; position >= 0; position -= 1) {
    if (archive.readUInt32LE(position) !== 0x06054b50) continue;
    const count = archive.readUInt16LE(position + 10);
    let entryOffset = archive.readUInt32LE(position + 16);
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      if (archive.readUInt32LE(entryOffset) !== 0x02014b50) throw new Error('Invalid ZIP central-directory entry.');
      const nameLength = archive.readUInt16LE(entryOffset + 28);
      const extraLength = archive.readUInt16LE(entryOffset + 30);
      const commentLength = archive.readUInt16LE(entryOffset + 32);
      const name = archive.subarray(entryOffset + 46, entryOffset + 46 + nameLength).toString('utf8');
      const externalAttributes = archive.readUInt32LE(entryOffset + 38);
      entries.push({
        name,
        isDirectory: name.endsWith('/'),
        unixMode: (externalAttributes >>> 16) & 0o777
      });
      entryOffset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  throw new Error('ZIP end-of-central-directory record was not found.');
}

export function listZipEntries(file) {
  return listZipEntryMetadata(file).map(({ name }) => name);
}

function hostedConfiguration() {
  const ingest = (process.env.FBB_HOSTED_INGEST_URL || '').trim();
  const cockpit = (process.env.FBB_HOSTED_COCKPIT_URL || '').trim();
  for (const [name, value] of [['FBB_HOSTED_INGEST_URL', ingest], ['FBB_HOSTED_COCKPIT_URL', cockpit]]) {
    if (value && (new URL(value).protocol !== 'https:' || new URL(value).username || new URL(value).password)) throw new Error(`${name} must be an HTTPS URL without credentials.`);
  }
  return { ingest, cockpit };
}

function packagedContents(file, manifest, hosted) {
  if (file === 'manifest.json') {
    const origins = [hosted.ingest, hosted.cockpit].filter(Boolean).map((url) => `${new URL(url).origin}/*`);
    return Buffer.from(`${JSON.stringify({ ...manifest, host_permissions: [...new Set([...manifest.host_permissions, ...origins])] }, null, 2)}\n`);
  }
  let value = readFileSync(join(extensionDirectory, file), 'utf8');
  if (file === 'hosted-default.js') {
    value = value.replace("export const HOSTED_INGEST_URL = '';", `export const HOSTED_INGEST_URL = ${JSON.stringify(hosted.ingest)};`)
      .replace("export const HOSTED_COCKPIT_URL = '';", `export const HOSTED_COCKPIT_URL = ${JSON.stringify(hosted.cockpit)};`);
  }
  if (file === 'popup.html' || file === 'sidepanel.html') {
    const escape = (url) => url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    value = value.replace(/(id="brokerUrl" type="url" value=")[^"]*/g, `$1${escape(hosted.ingest)}`)
      .replace(/(id="cockpitUrl" type="url" value=")[^"]*/g, `$1${escape(hosted.cockpit)}`);
  }
  return Buffer.from(value);
}

function packageCloudExtension(files, manifest, hosted) {
  const directoryName = `field-browser-bridge-cloud-${manifest.version}`;
  const output = join(outputDirectory, directoryName);
  if (existsSync(output)) rmSync(output, { recursive: true, force: true });
  for (const file of files) {
    const destination = join(output, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, packagedContents(file, manifest, hosted));
  }
  // The cloud browser reaches its broker over the private Docker network (http://broker:8767),
  // so its CSP also allows plain http/ws. These two keys are the only manifest differences.
  const cloudCsp = { ...manifest.content_security_policy, extension_pages: manifest.content_security_policy.extension_pages.replace("connect-src 'self'", "connect-src 'self' http: ws:") };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({ ...manifest, host_permissions: ['<all_urls>'], content_security_policy: cloudCsp }, null, 2)}\n`);
  const defaultsFile = join(output, 'hosted-default.js');
  const defaults = readFileSync(defaultsFile, 'utf8').replace('export const ALLOW_PRIVATE_HTTP = false;', 'export const ALLOW_PRIVATE_HTTP = true;');
  if (!defaults.includes('export const ALLOW_PRIVATE_HTTP = true;')) throw new Error('Cloud package could not enable private HTTP.');
  writeFileSync(defaultsFile, defaults);
  console.log(`Created dist/${directoryName}/ with ${files.length} extension runtime files.`);
  return output;
}

export function packageExtension({ variant = 'default' } = {}) {
  if (!['default', 'cloud'].includes(variant)) throw new Error(`Unknown extension package variant: ${variant}`);
  const manifest = JSON.parse(readFileSync(join(extensionDirectory, 'manifest.json'), 'utf8'));
  const hosted = hostedConfiguration();
  const packageName = packageNameForManifest();
  const files = runtimeFiles(extensionDirectory).sort();
  if (!files.includes('manifest.json')) throw new Error('Extension manifest.json is required to package the extension.');
  mkdirSync(outputDirectory, { recursive: true });
  if (variant === 'cloud') return packageCloudExtension(files, manifest, hosted);
  const outputFile = join(outputDirectory, packageName);
  if (existsSync(outputFile)) rmSync(outputFile);
  writeFileSync(outputFile, createZip(files, (file) => packagedContents(file, manifest, hosted)));
  console.log(`Created dist/${packageName} with ${files.length} extension runtime files.`);
  return outputFile;
}

if (process.argv[1] === scriptFile) {
  const variantIndex = process.argv.indexOf('--variant');
  packageExtension({ variant: variantIndex === -1 ? 'default' : process.argv[variantIndex + 1] });
}
