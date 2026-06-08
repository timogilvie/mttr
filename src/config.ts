export interface Config {
  openrouter: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
  };
  investigate: {
    model: string;
    modelFallback: string;
    maxToolIterations: number;
    maxToolCalls: number;
    consecutiveFailureLimit: number;
    llmTimeoutMs: number;
  };
  tools: {
    timeoutMs: number;
    resultMaxChars: number;
    defaultLookbackMinutes: number;
    maxLookbackMinutes: number;
    maxConcurrency: number;
  };
  healthReport: {
    s3Uri: string;
  };
  aws: {
    region: string;
    maxAttempts: number;
  };
  monitoring: {
    intervalMs: number;
  };
  state: {
    path: string;
  };
  timeouts: {
    llmMs: number;
    s3Ms: number;
  };
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    return value;
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new Error(`Missing required environment variable: ${key}`);
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number, got: ${value}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    openrouter: {
      apiKey: getEnv('OPENROUTER_API_KEY'),
      model: getEnv('OPENROUTER_MODEL', 'openai/gpt-4o-mini'),
      baseUrl: getEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      maxRetries: getEnvNumber('OPENROUTER_MAX_RETRIES', 4),
      backoffBaseMs: getEnvNumber('OPENROUTER_BACKOFF_BASE_MS', 1000),
      backoffMaxMs: getEnvNumber('OPENROUTER_BACKOFF_MAX_MS', 30000),
    },
    investigate: {
      model: getEnv('INVESTIGATE_MODEL', 'openai/gpt-5.4'),
      modelFallback: getEnv('INVESTIGATE_MODEL_FALLBACK', 'anthropic/claude-3.5-sonnet'),
      maxToolIterations: getEnvNumber('INVESTIGATE_MAX_TOOL_ITERATIONS', 6),
      maxToolCalls: getEnvNumber('INVESTIGATE_MAX_TOOL_CALLS', 12),
      consecutiveFailureLimit: getEnvNumber('INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT', 3),
      llmTimeoutMs: getEnvNumber('INVESTIGATE_LLM_TIMEOUT_MS', 120000),
    },
    tools: {
      timeoutMs: getEnvNumber('TOOL_TIMEOUT_MS', 20000),
      resultMaxChars: getEnvNumber('TOOL_RESULT_MAX_CHARS', 8000),
      defaultLookbackMinutes: getEnvNumber('TOOL_DEFAULT_LOOKBACK_MINUTES', 60),
      maxLookbackMinutes: getEnvNumber('TOOL_MAX_LOOKBACK_MINUTES', 1440),
      maxConcurrency: getEnvNumber('TOOL_MAX_CONCURRENCY', 2),
    },
    healthReport: {
      s3Uri: getEnv(
        'HEALTH_REPORT_S3_URI',
        's3://hokusai-health-reports-development/latest/development/report.md'
      ),
    },
    aws: {
      region: getEnv('AWS_REGION', 'us-east-1'),
      maxAttempts: getEnvNumber('AWS_MAX_ATTEMPTS', 5),
    },
    monitoring: {
      intervalMs: getEnvNumber('MONITOR_INTERVAL_MS', 300000),
    },
    state: {
      path: getEnv('AGENT_STATE_PATH', '.mttr-state.json'),
    },
    timeouts: {
      llmMs: getEnvNumber('LLM_TIMEOUT_MS', 60000),
      s3Ms: getEnvNumber('S3_TIMEOUT_MS', 15000),
    },
  };
}
