import type { Severity } from './types.js';

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
    closureEnabled: boolean;
    closureMaxToolIterations: number;
    closureMaxToolCalls: number;
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
    backend: 'file' | 'postgres';
    path: string;
  };
  database: {
    url?: string;
    runtimeUrl?: string;
    ssl: boolean;
    maxConnections: number;
    idleTimeoutMs: number;
  };
  alerts: {
    slack: {
      webhookUrl?: string;
      channel: string;
      timeoutMs: number;
    };
  };
  timeouts: {
    llmMs: number;
    s3Ms: number;
  };
  alarm: {
    webhook: {
      enabled: boolean;
      pathToken?: string;
      verifySignature: boolean;
      autoconfirm: boolean;
    };
    trigger: {
      minSeverity: Severity;
      cooldownMs: number;
      pollMs: number;
      coalesceMs: number;
    };
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

function getEnvOptional(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
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

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (/^(?:1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(?:0|false|no|off)$/i.test(value)) {
    return false;
  }
  throw new Error(`Environment variable ${key} must be a valid boolean, got: ${value}`);
}

function getStateBackend(): 'file' | 'postgres' {
  const value = getEnv('STATE_BACKEND', 'file');
  if (value === 'file' || value === 'postgres') {
    return value;
  }
  throw new Error(`Environment variable STATE_BACKEND must be "file" or "postgres", got: ${value}`);
}

const SEVERITIES: readonly Severity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function getEnvSeverity(key: string, defaultValue: Severity): Severity {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const normalized = value.toUpperCase();
  if ((SEVERITIES as readonly string[]).includes(normalized)) {
    return normalized as Severity;
  }
  throw new Error(
    `Environment variable ${key} must be one of ${SEVERITIES.join(', ')}, got: ${value}`
  );
}

export function loadConfig(): Config {
  const stateBackend = getStateBackend();
  const databaseUrl = getEnvOptional('DATABASE_URL');
  const pooledDatabaseUrl = getEnvOptional('POOLED_DATABASE_URL');
  const databaseRuntimeUrl = pooledDatabaseUrl ?? databaseUrl;
  const slackWebhookUrl = getEnvOptional('SLACK_WEBHOOK_URL');
  if (stateBackend === 'postgres' && !databaseUrl) {
    throw new Error('DATABASE_URL is required when STATE_BACKEND=postgres');
  }
  const alarmWebhookEnabled = getEnvBoolean('ALARM_WEBHOOK_ENABLED', false);
  const alarmWebhookPathToken = getEnvOptional('ALARM_WEBHOOK_PATH_TOKEN');
  if (alarmWebhookEnabled && !alarmWebhookPathToken) {
    throw new Error('ALARM_WEBHOOK_PATH_TOKEN is required when ALARM_WEBHOOK_ENABLED=true');
  }

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
      closureEnabled: getEnvBoolean('INVESTIGATE_CLOSURE_ENABLED', true),
      closureMaxToolIterations: getEnvNumber('INVESTIGATE_CLOSURE_MAX_TOOL_ITERATIONS', 2),
      closureMaxToolCalls: getEnvNumber('INVESTIGATE_CLOSURE_MAX_TOOL_CALLS', 3),
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
      intervalMs: getEnvNumber('MONITOR_INTERVAL_MS', 900000),
    },
    state: {
      backend: stateBackend,
      path: getEnv('AGENT_STATE_PATH', '.mttr-state.json'),
    },
    database: {
      ...(databaseUrl ? { url: databaseUrl } : {}),
      ...(databaseRuntimeUrl ? { runtimeUrl: databaseRuntimeUrl } : {}),
      ssl: getEnvBoolean('DATABASE_SSL', false),
      maxConnections: getEnvNumber('DATABASE_MAX_CONNECTIONS', 4),
      idleTimeoutMs: getEnvNumber('DATABASE_IDLE_TIMEOUT_MS', 30000),
    },
    alerts: {
      slack: {
        ...(slackWebhookUrl ? { webhookUrl: slackWebhookUrl } : {}),
        channel: getEnv('SLACK_ALERT_CHANNEL', 'slack'),
        timeoutMs: getEnvNumber('SLACK_ALERT_TIMEOUT_MS', 10000),
      },
    },
    timeouts: {
      llmMs: getEnvNumber('LLM_TIMEOUT_MS', 60000),
      s3Ms: getEnvNumber('S3_TIMEOUT_MS', 15000),
    },
    alarm: {
      webhook: {
        enabled: alarmWebhookEnabled,
        ...(alarmWebhookPathToken ? { pathToken: alarmWebhookPathToken } : {}),
        verifySignature: getEnvBoolean('ALARM_WEBHOOK_VERIFY_SIGNATURE', true),
        autoconfirm: getEnvBoolean('ALARM_WEBHOOK_AUTOCONFIRM', true),
      },
      trigger: {
        minSeverity: getEnvSeverity('ALARM_TRIGGER_MIN_SEVERITY', 'CRITICAL'),
        cooldownMs: getEnvNumber('ALARM_TRIGGER_COOLDOWN_MS', 600000),
        pollMs: getEnvNumber('ALARM_TRIGGER_POLL_MS', 5000),
        coalesceMs: getEnvNumber('ALARM_TRIGGER_COALESCE_MS', 2000),
      },
    },
  };
}
