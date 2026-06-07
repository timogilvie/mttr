import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
  type ResultField,
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
const POLL_INTERVAL_MS = 500;

const argsSchema = z.object({
  log_group: z.string().min(1),
  filter_or_query: z.string().min(1),
  lookback_minutes: z.number().optional(),
  limit: z.number().optional(),
});

type QueryLogsArgs = z.infer<typeof argsSchema>;

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
