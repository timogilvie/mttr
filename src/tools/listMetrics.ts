import {
  CloudWatchClient,
  ListMetricsCommand,
  type Metric,
} from '@aws-sdk/client-cloudwatch';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { serviceSearchTerms } from './serviceNames.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class ListMetricsToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ListMetricsToolError';
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAGES = 10;

const argsSchema = z
  .object({
    namespace: z.string().min(1).optional(),
    metric_name: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    limit: z.number().optional(),
  })
  .refine((args) => Boolean(args.namespace || args.metric_name || args.search), {
    message: 'Provide at least one of namespace, metric_name, or search',
  });

type ListMetricsArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    namespace: {
      type: 'string',
      description: 'Exact CloudWatch metric namespace to list, e.g. "AWS/Lambda" or a custom namespace.',
    },
    metric_name: {
      type: 'string',
      description: 'Exact metric name to match across namespaces.',
    },
    search: {
      type: 'string',
      description:
        'Service name or substring to match (case-insensitive) against namespace, metric name, and dimension values, e.g. "deltaone-anomaly-detection".',
    },
    limit: {
      type: 'number',
      description: `Max metrics to return (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`,
    },
  },
  required: [],
} as const;

function matchesSearch(metric: Metric, terms: string[]): boolean {
  const haystack = [
    metric.Namespace ?? '',
    metric.MetricName ?? '',
    ...(metric.Dimensions ?? []).flatMap((d) => [d.Name ?? '', d.Value ?? '']),
  ]
    .join(' ')
    .toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function formatMetric(metric: Metric): string {
  const dimensions = (metric.Dimensions ?? [])
    .map((d) => `${d.Name ?? 'unknown'}=${d.Value ?? ''}`)
    .join(', ');
  return (
    `namespace=${metric.Namespace ?? 'unknown'}, metric=${metric.MetricName ?? 'unknown'}` +
    (dimensions ? `, dimensions=[${dimensions}]` : ', dimensions=[]')
  );
}

async function handler(args: ListMetricsArgs, ctx: ToolContext): Promise<string> {
  const limit =
    args.limit && args.limit > 0 ? Math.min(Math.floor(args.limit), MAX_LIMIT) : DEFAULT_LIMIT;
  const terms = args.search ? serviceSearchTerms(args.search) : null;

  const client = new CloudWatchClient({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });

  try {
    const matches: Metric[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const response = await client.send(
        new ListMetricsCommand({
          Namespace: args.namespace,
          MetricName: args.metric_name,
          NextToken: nextToken,
        })
      );

      for (const metric of response.Metrics ?? []) {
        if (terms && !matchesSearch(metric, terms)) {
          continue;
        }
        matches.push(metric);
        if (matches.length >= limit) {
          truncated = true;
          nextToken = undefined;
          break;
        }
      }

      if (matches.length >= limit) {
        break;
      }

      nextToken = response.NextToken;
      pages += 1;
    } while (nextToken && pages < MAX_PAGES);

    const criteria = [
      args.namespace ? `namespace "${args.namespace}"` : null,
      args.metric_name ? `metric name "${args.metric_name}"` : null,
      args.search ? `search "${args.search}" (terms: ${terms?.join(', ')})` : null,
    ]
      .filter(Boolean)
      .join(', ');

    if (matches.length === 0) {
      return (
        `No CloudWatch metrics found for ${criteria}. ` +
        'Note: ListMetrics only returns metrics that received datapoints in the past two weeks, ' +
        'so a metric missing here may have stopped publishing more than two weeks ago or never existed.'
      );
    }

    const lines = matches.map(formatMetric);
    const header = `Found ${matches.length}${truncated ? '+' : ''} metric(s) for ${criteria}:`;
    return `${header}\n${lines.join('\n')}`;
  } catch (error) {
    throw new ListMetricsToolError(
      `list_metrics failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export const listMetricsTool: ToolDefinition<ListMetricsArgs> = {
  name: 'list_metrics',
  description:
    'Read-only: discover which CloudWatch metrics exist (namespace, metric name, dimensions) by exact namespace/name or by a service-name search. Use when Step 1 describes a metric problem (e.g. zero datapoints) but does not give the exact namespace/dimensions that get_metrics_and_alarms requires. Only metrics with datapoints in the past two weeks are returned.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
