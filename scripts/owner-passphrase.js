import { loadFirstBootSecrets } from '../broker/src/first-boot.js';

try {
  const passphrase = process.env.FBB_OWNER_PASSPHRASE || loadFirstBootSecrets(process.env).ownerPassphrase;
  process.stdout.write(`${passphrase}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
