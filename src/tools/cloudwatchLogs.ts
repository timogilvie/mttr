import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
  type ResultField,
  type LogGroup,
} from '@aws-sdk/client-cloudwatch-logs';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { clampLookback } from './types.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class CloudWatchLogsToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'CloudWatchLogsToolError';
  }
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_DISCOVERY_LIMIT = 10;
const MAX_DISCOVERY_LIMIT = 50;
const MAX_DISCOVERY_PAGES = 20;
const POLL_INTERVAL_MS = 500;
const GENERIC_SERVICE_TOKENS = new Set([
  'app',
  'application',
  'backend',
  'data',
  'development',
  'pipeline',
  'prod',
  'production',
  'service',
]);

const argsSchema = z.object({
  log_group: z.string().min(1),
  filter_or_query: z.string().min(1),
  lookback_minutes: z.number().optional(),
  limit: z.number().optional(),
});

type QueryLogsArgs = z.infer<typeof argsSchema>;

const discoverArgsSchema = z.object({
  service_name: z.string().min(1),
  limit: z.number().optional(),
});

type DiscoverLogGroupsArgs = z.infer<typeof discoverArgsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    log_group: {
      type: 'string',
      description: 'CloudWatch Logs log group name to query.',
    },
    filter_or_query: {
      type: 'string',
      description:
        'A CloudWatch Logs Insights query string, e.g. "stats count(*) by status" or a filter expression.',
    },
    lookback_minutes: {
      type: 'number',
      description: 'How far back to search, in minutes. Clamped to the configured maximum.',
    },
    limit: {
      type: 'number',
      description: `Max rows to return (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`,
    },
  },
  required: ['log_group', 'filter_or_query'],
} as const;

const discoverParametersJsonSchema = {
  type: 'object',
  properties: {
    service_name: {
      type: 'string',
      description:
        'Service name or distinctive substring to find in CloudWatch Logs log group names.',
    },
    limit: {
      type: 'number',
      description: `Max log groups to return (default ${DEFAULT_DISCOVERY_LIMIT}, capped at ${MAX_DISCOVERY_LIMIT}).`,
    },
  },
  required: ['service_name'],
} as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function formatRows(rows: ResultField[][]): string {
  if (rows.length === 0) {
    return 'Query completed with 0 matching rows.';
  }
  const lines = rows.map((row) =>
    row
      .filter((field) => field.field !== '@ptr')
      .map((field) => `${field.field ?? ''}=${field.value ?? ''}`)
      .join(', ')
  );
  return `Query returned ${rows.length} row(s):\n${lines.join('\n')}`;
}

function discoveryTerms(serviceName: string): string[] {
  const normalized = serviceName.toLowerCase();
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !GENERIC_SERVICE_TOKENS.has(token));
  return [...new Set([normalized, ...tokens])];
}

function formatLogGroups(
  serviceName: string,
  groups: LogGroup[],
  searchedTerms: string[] = [serviceName]
): string {
  if (groups.length === 0) {
    return `No CloudWatch log groups found for "${serviceName}" using terms: ${searchedTerms.join(', ')}.`;
  }

  const lines = groups.map((group) => {
    const parts = [`logGroupName=${group.logGroupName ?? 'unknown'}`];
    if (group.creationTime) {
      parts.push(`created=${new Date(group.creationTime).toISOString()}`);
    }
    if (group.storedBytes !== undefined) {
      parts.push(`storedBytes=${group.storedBytes}`);
    }
    return parts.join(', ');
  });

  return `Found ${groups.length} candidate log group(s) for "${serviceName}" using terms: ${searchedTerms.join(', ')}:\n${lines.join('\n')}`;
}

function scoreLogGroup(group: LogGroup, terms: string[]): number {
  const name = (group.logGroupName ?? '').toLowerCase();
  let score = 0;

  if (name.startsWith('/ecs/')) {
    score += 20;
  }
  if (name.includes('/api/') || name.includes('-api-') || name.includes('/auth/')) {
    score += 5;
  }
  if (name.includes('db-init') || name.includes('migration') || name.includes('/rds/')) {
    score -= 10;
  }
  if (name.includes('proxy')) {
    score -= 5;
  }

  score += terms.filter((term) => name.includes(term)).length;

  return score;
}

async function discoverHandler(args: DiscoverLogGroupsArgs, ctx: ToolContext): Promise<string> {
  const terms = discoveryTerms(args.service_name);
  const limit =
    args.limit && args.limit > 0
      ? Math.min(Math.floor(args.limit), MAX_DISCOVERY_LIMIT)
      : DEFAULT_DISCOVERY_LIMIT;

  const client = new CloudWatchLogsClient({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });

  try {
    const matches: LogGroup[] = [];
    const seen = new Set<string>();
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await client.send(
        new DescribeLogGroupsCommand({
          nextToken,
          limit: 50,
        })
      );

      for (const group of response.logGroups ?? []) {
        const name = group.logGroupName ?? '';
        const lowerName = name.toLowerCase();
        if (terms.some((term) => lowerName.includes(term)) && !seen.has(name)) {
          seen.add(name);
          matches.push(group);
          if (matches.length >= limit) {
            return formatLogGroups(
              args.service_name,
              [...matches].sort((a, b) => scoreLogGroup(b, terms) - scoreLogGroup(a, terms)),
              terms
            );
          }
        }
      }

      nextToken = response.nextToken;
      pages += 1;
    } while (nextToken && pages < MAX_DISCOVERY_PAGES);

    return formatLogGroups(
      args.service_name,
      [...matches].sort((a, b) => scoreLogGroup(b, terms) - scoreLogGroup(a, terms)),
      terms
    );
  } catch (error) {
    throw new CloudWatchLogsToolError(
      `discover_log_groups failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

async function handler(args: QueryLogsArgs, ctx: ToolContext): Promise<string> {
  const lookbackMinutes = clampLookback(args.lookback_minutes, ctx);
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - lookbackMinutes * 60;
  const limit =
    args.limit && args.limit > 0 ? Math.min(Math.floor(args.limit), MAX_LIMIT) : DEFAULT_LIMIT;

  const client = new CloudWatchLogsClient({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });

  try {
    const started = await client.send(
      new StartQueryCommand({
        logGroupName: args.log_group,
        startTime,
        endTime,
        queryString: args.filter_or_query,
        limit,
      })
    );

    const queryId = started.queryId;
    if (!queryId) {
      throw new CloudWatchLogsToolError('StartQuery returned no queryId');
    }

    const deadline = Date.now() + ctx.timeoutMs;
    for (;;) {
      const results = await client.send(new GetQueryResultsCommand({ queryId }));
      const status = results.status;

      if (status === 'Complete') {
        return formatRows(results.results ?? []);
      }
      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        throw new CloudWatchLogsToolError(`Logs Insights query ${status}`);
      }

      if (Date.now() >= deadline) {
        await client.send(new StopQueryCommand({ queryId })).catch(() => undefined);
        throw new CloudWatchLogsToolError(
          `Logs Insights query did not complete within ${ctx.timeoutMs}ms`
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    if (error instanceof CloudWatchLogsToolError) {
      throw error;
    }
    throw new CloudWatchLogsToolError(
      `query_logs failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export const queryLogsTool: ToolDefinition<QueryLogsArgs> = {
  name: 'query_logs',
  description:
    'Run a read-only CloudWatch Logs Insights query against a log group to gather evidence (e.g. break down errors by status code). Returns compact result rows.',
  parametersJsonSchema,
  argsSchema,
  handler,
};

export const discoverLogGroupsTool: ToolDefinition<DiscoverLogGroupsArgs> = {
  name: 'discover_log_groups',
  description:
    'Read-only: find candidate CloudWatch log groups whose names contain a service name. Use before query_logs when Step 1 names a service but not a log group.',
  parametersJsonSchema: discoverParametersJsonSchema,
  argsSchema: discoverArgsSchema,
  handler: discoverHandler,
};
