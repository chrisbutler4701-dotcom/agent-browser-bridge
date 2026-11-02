import { Readable } from 'node:stream';

export async function invoke(server, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return new Promise((resolve, reject) => {
    const response = { status: 200, headers: {}, chunks: [] };
    const res = {
      writeHead(status, responseHeaders = {}) { response.status = status; response.headers = Object.fromEntries(Object.entries(responseHeaders).map(([key, value]) => [key.toLowerCase(), value])); return this; },
      end(chunk) { if (chunk !== undefined) response.chunks.push(Buffer.from(chunk)); response.body = Buffer.concat(response.chunks).toString('utf8'); resolve(response); },
      write(chunk) { response.chunks.push(Buffer.from(chunk)); return true; }
    };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}
