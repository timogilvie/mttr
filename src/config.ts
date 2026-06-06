export interface Config {
  openrouter: {
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  healthReport: {
    s3Uri: string;
  };
  aws: {
    region: string;
  };
  monitoring: {
    intervalMs: number;
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
    },
    healthReport: {
      s3Uri: getEnv(
        'HEALTH_REPORT_S3_URI',
        's3://hokusai-health-reports-development/latest/development/report.md'
      ),
    },
    aws: {
      region: getEnv('AWS_REGION', 'us-east-1'),
    },
    monitoring: {
      intervalMs: getEnvNumber('MONITOR_INTERVAL_MS', 300000),
    },
    timeouts: {
      llmMs: getEnvNumber('LLM_TIMEOUT_MS', 60000),
      s3Ms: getEnvNumber('S3_TIMEOUT_MS', 15000),
    },
  };
}
