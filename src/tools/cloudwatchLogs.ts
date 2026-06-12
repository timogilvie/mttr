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
import { resolveToolTimeRange } from './types.js';
import { serviceSearchTerms } from './serviceNames.js';
import { resolveServiceLogGroups, type ServiceLogGroup } from './ecs.js';
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

const argsSchema = z.object({
  log_group: z.string().min(1),
  filter_or_query: z.string().min(1),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
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
      description:
        'Fallback relative lookback in minutes. Ignored when start_time and end_time are supplied or a report window is available.',
    },
    start_time: {
      type: 'string',
      description: 'Optional absolute query start time as an ISO timestamp. Must be paired with end_time.',
    },
    end_time: {
      type: 'string',
      description: 'Optional absolute query end time as an ISO timestamp. Must be paired with start_time.',
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

function formatLogGroups(
  serviceName: string,
  groups: LogGroup[],
  searchedTerms: string[] = [serviceName],
  ecsResolved: ServiceLogGroup[] = []
): string {
  const ecsNames = new Set(ecsResolved.map((resolved) => resolved.logGroup));
  const ecsLines = ecsResolved.map(
    (resolved) =>
      `logGroupName=${resolved.logGroup}, source=ecs-task-definition (service ${resolved.serviceName}, container ${resolved.containerName})`
  );
  const nameLines = groups
    .filter((group) => !ecsNames.has(group.logGroupName ?? ''))
    .map((group) => {
      const parts = [`logGroupName=${group.logGroupName ?? 'unknown'}`];
      if (group.creationTime) {
        parts.push(`created=${new Date(group.creationTime).toISOString()}`);
      }
      if (group.storedBytes !== undefined) {
        parts.push(`storedBytes=${group.storedBytes}`);
      }
      return parts.join(', ');
    });

  if (ecsLines.length === 0 && nameLines.length === 0) {
    return `No CloudWatch log groups found for "${serviceName}" using terms: ${searchedTerms.join(', ')}, and no matching ECS service declares an awslogs log group.`;
  }

  const sections: string[] = [];
  if (ecsLines.length > 0) {
    sections.push(
      `Authoritative log group(s) for "${serviceName}" resolved from ECS task definitions:\n${ecsLines.join('\n')}`
    );
  }
  if (nameLines.length > 0) {
    sections.push(
      `Found ${nameLines.length} candidate log group(s) for "${serviceName}" by name match using terms: ${searchedTerms.join(', ')}:\n${nameLines.join('\n')}`
    );
  }
  return sections.join('\n');
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
  const terms = serviceSearchTerms(args.service_name);
  const limit =
    args.limit && args.limit > 0
      ? Math.min(Math.floor(args.limit), MAX_DISCOVERY_LIMIT)
      : DEFAULT_DISCOVERY_LIMIT;

  // Deterministic resolution first: the awslogs group declared by a matching
  // ECS service's task definition. Degrades to name matching when ECS is
  // unreachable or not permitted.
  let ecsResolved: ServiceLogGroup[] = [];
  let ecsError: string | undefined;
  try {
    ecsResolved = await resolveServiceLogGroups(args.service_name, ctx);
  } catch (error) {
    ecsError = error instanceof Error ? error.message : String(error);
  }

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
            nextToken = undefined;
            break;
          }
        }
      }

      if (matches.length >= limit) {
        break;
      }

      nextToken = response.nextToken;
      pages += 1;
    } while (nextToken && pages < MAX_DISCOVERY_PAGES);

    const formatted = formatLogGroups(
      args.service_name,
      [...matches].sort((a, b) => scoreLogGroup(b, terms) - scoreLogGroup(a, terms)),
      terms,
      ecsResolved
    );
    return ecsError === undefined
      ? formatted
      : `${formatted}\n(ECS-based resolution unavailable: ${ecsError})`;
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
  const timeRange = resolveToolTimeRange(
    args.start_time,
    args.end_time,
    args.lookback_minutes,
    ctx
  );
  const startTime = Math.floor(timeRange.startTime.getTime() / 1000);
  const endTime = Math.floor(timeRange.endTime.getTime() / 1000);
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
    'Read-only: find CloudWatch log groups for a service, first by reading the awslogs configuration of matching ECS task definitions (authoritative), then by log group name match. Use before query_logs when Step 1 names a service but not a log group.',
  parametersJsonSchema: discoverParametersJsonSchema,
  argsSchema: discoverArgsSchema,
  handler: discoverHandler,
};
