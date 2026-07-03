import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  DescribeAlarmsForMetricCommand,
  type MetricAlarm,
  type CompositeAlarm,
} from '@aws-sdk/client-cloudwatch';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { serviceSearchTerms } from './serviceNames.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class FindAlarmsToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'FindAlarmsToolError';
  }
}

const MAX_ALARMS = 50;
const MAX_PAGES = 10;

function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function normalizeArgs(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const input = value as Record<string, unknown>;
  const namespace = emptyToUndefined(input['namespace']);
  const metricName = emptyToUndefined(input['metric_name'] ?? input['metricName'] ?? input['metric']);
  const search = emptyToUndefined(input['search'] ?? input['service'] ?? input['service_name']);
  const alarmNamePrefix = emptyToUndefined(
    input['alarm_name_prefix'] ?? input['alarmNamePrefix'] ?? input['prefix']
  );
  return {
    ...input,
    namespace,
    metric_name: metricName,
    search: search ?? (!(namespace && metricName) ? metricName ?? namespace : undefined),
    alarm_name_prefix: alarmNamePrefix,
  };
}

const argsSchema = z.preprocess(normalizeArgs, z
  .object({
    namespace: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    metric_name: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    dimensions: z
      .array(z.object({ name: z.string().min(1), value: z.string() }))
      .optional(),
    search: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    alarm_name_prefix: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  })
  .refine(
    (args) =>
      Boolean(args.search || args.alarm_name_prefix || (args.namespace && args.metric_name)),
    { message: 'Provide search, alarm_name_prefix, or both namespace and metric_name' }
  ));

type FindAlarmsArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    namespace: {
      type: 'string',
      description:
        'Metric namespace; with metric_name, finds alarms watching that exact metric.',
    },
    metric_name: {
      type: 'string',
      description: 'Metric name; with namespace, finds alarms watching that exact metric.',
    },
    dimensions: {
      type: 'array',
      description:
        'Metric dimensions as name/value pairs. Alarms on dimensioned metrics are only matched when the exact dimensions are supplied.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' } },
        required: ['name', 'value'],
      },
    },
    search: {
      type: 'string',
      description:
        'Service name or substring matched (case-insensitive) against alarm names, namespaces, and metric names of all alarms.',
    },
    alarm_name_prefix: {
      type: 'string',
      description: 'Exact alarm-name prefix to list, e.g. "deltaone-".',
    },
  },
  required: [],
} as const;

function formatMetricAlarm(alarm: MetricAlarm): string {
  const parts = [
    `alarm=${alarm.AlarmName ?? 'unknown'}`,
    `state=${alarm.StateValue ?? 'unknown'}`,
  ];
  if (alarm.StateUpdatedTimestamp) {
    parts.push(`stateUpdated=${alarm.StateUpdatedTimestamp.toISOString()}`);
  }
  if (alarm.Namespace || alarm.MetricName) {
    parts.push(`metric=${alarm.Namespace ?? '?'}/${alarm.MetricName ?? '?'}`);
  }
  if (alarm.Dimensions && alarm.Dimensions.length > 0) {
    parts.push(
      `dimensions=[${alarm.Dimensions.map((d) => `${d.Name ?? '?'}=${d.Value ?? '?'}`).join(', ')}]`
    );
  }
  if (alarm.Statistic || alarm.ExtendedStatistic) {
    parts.push(`stat=${alarm.Statistic ?? alarm.ExtendedStatistic}`);
  }
  if (alarm.ComparisonOperator !== undefined && alarm.Threshold !== undefined) {
    parts.push(`condition=${alarm.ComparisonOperator} ${alarm.Threshold}`);
  }
  if (alarm.Period !== undefined && alarm.EvaluationPeriods !== undefined) {
    parts.push(`evaluationPeriod=${alarm.Period}s x ${alarm.EvaluationPeriods}`);
  }
  if (alarm.DatapointsToAlarm !== undefined) {
    parts.push(`datapointsToAlarm=${alarm.DatapointsToAlarm}`);
  }
  if (alarm.TreatMissingData) {
    parts.push(`treatMissingData=${alarm.TreatMissingData}`);
  }
  if (alarm.ActionsEnabled !== undefined) {
    parts.push(`actionsEnabled=${alarm.ActionsEnabled}`);
  }
  return parts.join(', ');
}

function formatCompositeAlarm(alarm: CompositeAlarm): string {
  const parts = [
    `alarm=${alarm.AlarmName ?? 'unknown'} (composite)`,
    `state=${alarm.StateValue ?? 'unknown'}`,
  ];
  if (alarm.StateUpdatedTimestamp) {
    parts.push(`stateUpdated=${alarm.StateUpdatedTimestamp.toISOString()}`);
  }
  return parts.join(', ');
}

function alarmMatchesSearch(alarm: MetricAlarm, terms: string[]): boolean {
  const haystack = [
    alarm.AlarmName ?? '',
    alarm.Namespace ?? '',
    alarm.MetricName ?? '',
    ...(alarm.Dimensions ?? []).flatMap((d) => [d.Name ?? '', d.Value ?? '']),
  ]
    .join(' ')
    .toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

async function findForMetric(
  client: CloudWatchClient,
  args: FindAlarmsArgs
): Promise<string> {
  const response = await client.send(
    new DescribeAlarmsForMetricCommand({
      Namespace: args.namespace,
      MetricName: args.metric_name,
      Dimensions: args.dimensions?.map((d) => ({ Name: d.name, Value: d.value })),
    })
  );

  const alarms = response.MetricAlarms ?? [];
  const metricLabel = `${args.namespace}/${args.metric_name}`;
  if (alarms.length === 0) {
    return (
      `No alarms found watching metric ${metricLabel}` +
      (args.dimensions?.length
        ? ` with the given dimensions.`
        : `.`) +
      ' This metric has no alarm coverage as queried.' +
      (args.dimensions?.length
        ? ''
        : ' (Note: alarms on dimensioned metrics are only matched when the exact dimensions are supplied.)')
    );
  }
  return `Found ${alarms.length} alarm(s) watching metric ${metricLabel}:\n${alarms
    .map(formatMetricAlarm)
    .join('\n')}`;
}

async function findBySearch(
  client: CloudWatchClient,
  args: FindAlarmsArgs
): Promise<string> {
  const terms = args.search ? serviceSearchTerms(args.search) : null;
  const metricAlarms: MetricAlarm[] = [];
  const compositeAlarms: CompositeAlarm[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const response = await client.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: args.alarm_name_prefix,
        AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
        MaxRecords: 100,
        NextToken: nextToken,
      })
    );

    for (const alarm of response.MetricAlarms ?? []) {
      if (!terms || alarmMatchesSearch(alarm, terms)) {
        metricAlarms.push(alarm);
      }
    }
    for (const alarm of response.CompositeAlarms ?? []) {
      const name = (alarm.AlarmName ?? '').toLowerCase();
      if (!terms || terms.some((term) => name.includes(term))) {
        compositeAlarms.push(alarm);
      }
    }

    if (metricAlarms.length + compositeAlarms.length >= MAX_ALARMS) {
      break;
    }

    nextToken = response.NextToken;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES);

  const criteria = [
    args.alarm_name_prefix ? `prefix "${args.alarm_name_prefix}"` : null,
    args.search ? `search "${args.search}" (terms: ${terms?.join(', ')})` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const total = metricAlarms.length + compositeAlarms.length;
  if (total === 0) {
    return `No alarms found for ${criteria}. No alarm coverage matches this search.`;
  }

  const lines = [
    ...metricAlarms.slice(0, MAX_ALARMS).map(formatMetricAlarm),
    ...compositeAlarms.slice(0, Math.max(0, MAX_ALARMS - metricAlarms.length)).map(formatCompositeAlarm),
  ];
  return `Found ${total} alarm(s) for ${criteria}:\n${lines.join('\n')}`;
}

async function handler(args: FindAlarmsArgs, ctx: ToolContext): Promise<string> {
  const client = new CloudWatchClient({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });

  try {
    const sections: string[] = [];
    if (args.namespace && args.metric_name) {
      sections.push(await findForMetric(client, args));
    }
    if (args.search || args.alarm_name_prefix) {
      sections.push(await findBySearch(client, args));
    }
    return sections.join('\n\n');
  } catch (error) {
    if (error instanceof FindAlarmsToolError) {
      throw error;
    }
    throw new FindAlarmsToolError(
      `find_alarms failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export const findAlarmsTool: ToolDefinition<FindAlarmsArgs> = {
  name: 'find_alarms',
  description:
    'Read-only: list CloudWatch alarms with current state, exact metric identity (namespace/dimensions), threshold, evaluation period, and missing-data handling — either the alarms watching an exact metric (namespace + metric_name) or alarms matching a name search/prefix. Use to answer whether alarm coverage exists for a signal or service.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
