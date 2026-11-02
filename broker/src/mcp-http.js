export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26']);

export function negotiatedProtocolVersion(requested) {
  return MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}

export function isJsonRpcMessage(message) {
  return Boolean(message && typeof message === 'object' && !Array.isArray(message) && message.jsonrpc === '2.0');
}

export function expectsJsonRpcResponse(message) {
  return isJsonRpcMessage(message) && Object.hasOwn(message, 'id') && message.id !== undefined;
}

export async function readRequestBody(req, { maxBytes = 64 * 1024, form = false } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('Request body too large.');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (form) return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text);
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function sendHtml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end();
}

export function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}
