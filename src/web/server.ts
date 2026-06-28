import { loadConfig } from '../config.js';
import { createWebServer } from './api.js';

function getPort(): number {
  const raw = process.env['WEB_PORT'] ?? '3000';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEB_PORT must be a valid TCP port, got: ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createWebServer(config);
  const host = process.env['WEB_HOST'] ?? '0.0.0.0';
  const port = getPort();

  await app.listen({ host, port });
  console.log(`[mttr-web] Listening on http://${host}:${port}`);
}

main().catch((error) => {
  console.error('[mttr-web] Failed to start', error);
  process.exitCode = 1;
});
