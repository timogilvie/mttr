import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  DescribeAlarmHistoryCommand,
  type Datapoint,
  type AlarmHistoryItem,
} from '@aws-sdk/client-cloudwatch';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveToolTimeRange } from './types.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class CloudWatchMetricsToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'CloudWatchMetricsToolError';
  }
}

const STATISTICS = ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'] as const;
const PERIOD_SECONDS = 300;
const MAX_ALARM_HISTORY_ITEMS = 20;

const argsSchema = z.object({
  namespace: z.string().min(1),
  metric_name: z.string().min(1),
  dimensions: z
    .array(z.object({ name: z.string().min(1), value: z.string() }))
    .optional(),
  stat: z.enum(STATISTICS).optional(),
  lookback_minutes: z.number().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  alarm_name: z.string().optional(),
});

type MetricsArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    namespace: { type: 'string', description: 'CloudWatch metric namespace, e.g. "AWS/ApplicationELB".' },
    metric_name: { type: 'string', description: 'Metric name, e.g. "HTTPCode_Target_4XX_Count".' },
    dimensions: {
      type: 'array',
      description: 'Metric dimensions as name/value pairs.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' } },
        required: ['name', 'value'],
      },
    },
    stat: {
      type: 'string',
      enum: [...STATISTICS],
      description: 'Statistic to retrieve (default Average).',
    },
    lookback_minutes: {
      type: 'number',
      description:
        'How far back to read, in minutes. Used only when start_time/end_time are not provided. Clamped to the configured maximum.',
    },
    start_time: {
      type: 'string',
      description:
        'Optional ISO-8601 UTC start time. Use with end_time when the health report provides an exact window.',
    },
    end_time: {
      type: 'string',
      description:
        'Optional ISO-8601 UTC end time. Use with start_time when the health report provides an exact window.',
    },
    alarm_name: {
      type: 'string',
      description: 'Optional alarm name to also fetch state-transition history for.',
    },
  },
  required: ['namespace', 'metric_name'],
} as const;

function formatDatapoints(stat: string, datapoints: Datapoint[]): string {
  if (datapoints.length === 0) {
    return 'No metric datapoints in the requested window.';
  }
  const sorted = [...datapoints].sort(
    (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0)
  );
  const lines = sorted.map((dp) => {
    const ts = dp.Timestamp?.toISOString() ?? 'unknown';
    const value = (dp as Record<string, unknown>)[stat];
    const unit = dp.Unit ? ` ${dp.Unit}` : '';
    return `${ts}: ${stat}=${value ?? 'n/a'}${unit}`;
  });
  return `Metric datapoints (${datapoints.length}):\n${lines.join('\n')}`;
}

function formatAlarmHistory(items: AlarmHistoryItem[]): string {
  if (items.length === 0) {
    return 'No alarm history in the requested window.';
  }
  const lines = items
    .slice(0, MAX_ALARM_HISTORY_ITEMS)
    .map((item) => {
      const ts = item.Timestamp?.toISOString() ?? 'unknown';
      return `${ts}: ${item.HistorySummary ?? item.HistoryItemType ?? 'event'}`;
    });
  return `Alarm history (${items.length}):\n${lines.join('\n')}`;
}

async function handler(args: MetricsArgs, ctx: ToolContext): Promise<string> {
  const stat = args.stat ?? 'Average';
  const range = resolveToolTimeRange(args, ctx);
  const startTime = range.start;
  const endTime = range.end;

  const client = new CloudWatchClient({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });

  try {
    const metrics = await client.send(
      new GetMetricStatisticsCommand({
        Namespace: args.namespace,
        MetricName: args.metric_name,
        Dimensions: args.dimensions?.map((d) => ({ Name: d.name, Value: d.value })),
        StartTime: startTime,
        EndTime: endTime,
        Period: PERIOD_SECONDS,
        Statistics: [stat],
      })
    );

    const sections = [
      `Query window: ${range.description}`,
      formatDatapoints(stat, metrics.Datapoints ?? []),
    ];

    if (args.alarm_name) {
      const history = await client.send(
        new DescribeAlarmHistoryCommand({
          AlarmName: args.alarm_name,
          StartDate: startTime,
          EndDate: endTime,
          HistoryItemType: 'StateUpdate',
        })
      );
      sections.push(formatAlarmHistory(history.AlarmHistoryItems ?? []));
    }

    return sections.join('\n\n');
  } catch (error) {
    if (error instanceof CloudWatchMetricsToolError) {
      throw error;
    }
    throw new CloudWatchMetricsToolError(
      `get_metrics_and_alarms failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export const metricsAndAlarmsTool: ToolDefinition<MetricsArgs> = {
  name: 'get_metrics_and_alarms',
  description:
    'Read-only: fetch CloudWatch metric statistics for a metric and, optionally, an alarm’s state-transition history. Use to corroborate or refute a finding with quantitative evidence.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
