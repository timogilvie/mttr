import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFile(path = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) {
    return;
  }

  const contents = readFileSync(path, 'utf8');

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }

    if (env[key] !== undefined) {
      continue;
    }

    env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  const quote = value[0];
  const isQuoted = (quote === '"' || quote === "'") && value[value.length - 1] === quote;

  if (!isQuoted) {
    const commentIndex = value.indexOf(' #');
    return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
  }

  const unquoted = value.slice(1, -1);
  if (quote === "'") {
    return unquoted;
  }

  return unquoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
}
