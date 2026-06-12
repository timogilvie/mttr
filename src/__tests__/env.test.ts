import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '../env.js';

describe('loadEnvFile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads variables from a .env file', () => {
    const envPath = writeTempEnv('OPENROUTER_API_KEY=test-key\nMONITOR_INTERVAL_MS=1000\n');
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile(envPath, env);

    expect(env['OPENROUTER_API_KEY']).toBe('test-key');
    expect(env['MONITOR_INTERVAL_MS']).toBe('1000');
  });

  it('does not override existing environment variables', () => {
    const envPath = writeTempEnv('OPENROUTER_API_KEY=file-key\n');
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'shell-key' };

    loadEnvFile(envPath, env);

    expect(env['OPENROUTER_API_KEY']).toBe('shell-key');
  });

  it('ignores missing files', () => {
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile('/tmp/hokusai-missing-env-file', env);

    expect(env).toEqual({});
  });

  function writeTempEnv(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'hokusai-env-test-'));
    tempDirs.push(dir);
    const envPath = join(dir, '.env');
    writeFileSync(envPath, contents);
    return envPath;
  }
});
