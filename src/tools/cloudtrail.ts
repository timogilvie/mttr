import {
  CloudTrailClient,
  LookupEventsCommand,
  type Event,
  type LookupAttribute,
} from '@aws-sdk/client-cloudtrail';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveToolTimeRange } from './types.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class CloudTrailToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'CloudTrailToolError';
  }
}

const ATTRIBUTE_KEYS = [
  'EventId',
  'EventName',
  'ReadOnly',
  'Username',
  'ResourceType',
  'ResourceName',
  'EventSource',
  'AccessKeyId',
] as const;

const MAX_RESULTS = 50;

function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function normalizeArgs(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const input = value as Record<string, unknown>;
  return {
    ...input,
    attribute_key: emptyToUndefined(input['attribute_key'] ?? input['attributeKey']),
    attribute_value: emptyToUndefined(input['attribute_value'] ?? input['attributeValue']),
    resource_name: emptyToUndefined(
      input['resource_name'] ?? input['resourceName'] ?? input['resource'] ?? input['function_name']
    ),
  };
}

const argsSchema = z.preprocess(normalizeArgs, z.object({
  attribute_key: z.preprocess(emptyToUndefined, z.enum(ATTRIBUTE_KEYS).optional()),
  attribute_value: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  event_names: z.array(z.string().min(1)).optional(),
  resource_name: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  lookback_minutes: z.number().optional(),
  limit: z.number().optional(),
}));

type CloudTrailArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    attribute_key: {
      type: 'string',
      enum: [...ATTRIBUTE_KEYS],
      description:
        'Optional CloudTrail LookupAttribute key. Use with attribute_value for direct lookup.',
    },
    attribute_value: {
      type: 'string',
      description: 'CloudTrail LookupAttribute value paired with attribute_key.',
    },
    event_names: {
      type: 'array',
      description:
        'Optional event names to filter returned events client-side, e.g. ["UpdateFunctionCode", "UpdateFunctionConfiguration"].',
      items: { type: 'string' },
    },
    resource_name: {
      type: 'string',
      description:
        'Optional resource name to filter returned events client-side. If no lookup attribute is supplied, this is used as ResourceName lookup.',
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
      description: `Max events to return (default 20, capped at ${MAX_RESULTS}).`,
    },
  },
  required: [],
} as const;

function lookupAttributes(args: CloudTrailArgs): LookupAttribute[] | undefined {
  if (args.attribute_key && args.attribute_value) {
    return [{ AttributeKey: args.attribute_key, AttributeValue: args.attribute_value }];
  }
  if (args.resource_name) {
    return [{ AttributeKey: 'ResourceName', AttributeValue: args.resource_name }];
  }
  return undefined;
}

function parseCloudTrailEvent(event: Event): Record<string, unknown> | null {
  if (!event.CloudTrailEvent) {
    return null;
  }
  try {
    return JSON.parse(event.CloudTrailEvent) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function eventMatches(event: Event, args: CloudTrailArgs): boolean {
  if (args.event_names && args.event_names.length > 0 && !args.event_names.includes(event.EventName ?? '')) {
    return false;
  }
  if (args.resource_name) {
    const resources = event.Resources ?? [];
    if (!resources.some((resource) => resource.ResourceName === args.resource_name)) {
      return false;
    }
  }
  return true;
}

function formatEvent(event: Event): string {
  const detail = parseCloudTrailEvent(event);
  const userIdentity = detail?.['userIdentity'] as Record<string, unknown> | undefined;
  const errorCode = detail?.['errorCode'];
  const sourceIp = detail?.['sourceIPAddress'];
  const resources = (event.Resources ?? [])
    .map((resource) => `${resource.ResourceType ?? 'resource'}=${resource.ResourceName ?? 'unknown'}`)
    .join(', ');
  return [
    `${event.EventTime?.toISOString() ?? 'unknown'} ${event.EventName ?? 'unknown'}`,
    `source=${event.EventSource ?? 'unknown'}`,
    `username=${event.Username ?? 'unknown'}`,
    `identityType=${typeof userIdentity?.['type'] === 'string' ? userIdentity['type'] : 'unknown'}`,
    `sourceIp=${typeof sourceIp === 'string' ? sourceIp : 'unknown'}`,
    `errorCode=${typeof errorCode === 'string' ? errorCode : 'none'}`,
    resources ? `resources=[${resources}]` : 'resources=[]',
  ].join(' ');
}

async function handler(args: CloudTrailArgs, ctx: ToolContext): Promise<string> {
  if ((args.attribute_key && !args.attribute_value) || (!args.attribute_key && args.attribute_value)) {
    throw new CloudTrailToolError('attribute_key and attribute_value must be provided together');
  }

  const { startTime, endTime } = resolveToolTimeRange(
    args.start_time,
    args.end_time,
    args.lookback_minutes,
    ctx
  );
  const maxResults =
    args.limit && args.limit > 0 ? Math.min(Math.floor(args.limit), MAX_RESULTS) : 20;
  const client = new CloudTrailClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });

  try {
    const response = await client.send(
      new LookupEventsCommand({
        StartTime: startTime,
        EndTime: endTime,
        LookupAttributes: lookupAttributes(args),
        MaxResults: maxResults,
      })
    );
    const events = (response.Events ?? []).filter((event) => eventMatches(event, args));
    const filters = [
      args.attribute_key && args.attribute_value
        ? `${args.attribute_key}=${args.attribute_value}`
        : null,
      args.resource_name ? `resource_name=${args.resource_name}` : null,
      args.event_names?.length ? `event_names=[${args.event_names.join(', ')}]` : null,
    ]
      .filter(Boolean)
      .join(', ');

    if (events.length === 0) {
      return `No CloudTrail events found in ${startTime.toISOString()}..${endTime.toISOString()}${filters ? ` for ${filters}` : ''}.`;
    }

    return `CloudTrail events (${events.length}) in ${startTime.toISOString()}..${endTime.toISOString()}${filters ? ` for ${filters}` : ''}:\n${events.map(formatEvent).join('\n')}`;
  } catch (error) {
    if (error instanceof CloudTrailToolError) {
      throw error;
    }
    throw new CloudTrailToolError(
      `lookup_cloudtrail_events failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export const cloudTrailLookupTool: ToolDefinition<CloudTrailArgs> = {
  name: 'lookup_cloudtrail_events',
  description:
    'Read-only: look up CloudTrail management events over the report window or an explicit time range to correlate incidents with Lambda, EventBridge, IAM, SSM, Secrets Manager, or deployment changes.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
