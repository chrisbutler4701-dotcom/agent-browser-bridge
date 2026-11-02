import { loadFirstBootSecrets } from '../broker/src/first-boot.js';

try {
  const token = process.env.WORK_EDGE_MCP_TOKEN || loadFirstBootSecrets(process.env).ownerMcpToken;
  process.stdout.write(`${token}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
