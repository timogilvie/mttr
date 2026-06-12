import { loadEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';

function main() {
  console.log('[Main] Hokusai Monitoring Agent starting');
  loadEnvFile();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('[Main] Configuration error:', error);
    process.exit(1);
  }

  const orchestrator = new Orchestrator(config);

  process.on('SIGINT', () => {
    console.log('\n[Main] Received SIGINT, shutting down');
    orchestrator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Main] Received SIGTERM, shutting down');
    orchestrator.stop();
    process.exit(0);
  });

  orchestrator.start();
}

main();
