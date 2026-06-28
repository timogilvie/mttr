const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|authorization|token|secret|password|credential|connectionstring|database_url|pooled_database_url|webhook)/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[Max depth exceeded]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : sanitize(item, depth + 1);
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  }
  return value;
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  return JSON.stringify(sanitize(value), null, 2);
}

export function compactToolTrace(value: unknown): string[] {
  const text = prettyJson(value);
  const toolMatches = text.match(/"tool"\s*:\s*"[^"]+"|"tool_name"\s*:\s*"[^"]+"/g) ?? [];
  return [...new Set(toolMatches.map((item) => item.replace(/[",]/g, '').trim()))].slice(0, 8);
}
