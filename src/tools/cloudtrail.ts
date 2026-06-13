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
const DETAIL_MODES = ['safe', 'off'] as const;
const MAX_DETAIL_VALUE_CHARS = 500;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_KEYS = 20;
const REDACTED = '[redacted]';

type DetailMode = (typeof DETAIL_MODES)[number];

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
    detail_mode: emptyToUndefined(input['detail_mode'] ?? input['detailMode']),
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
  detail_mode: z.preprocess(emptyToUndefined, z.enum(DETAIL_MODES).optional()),
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
    detail_mode: {
      type: 'string',
      enum: [...DETAIL_MODES],
      description:
        'Controls CloudTrailEvent request/response detail output. Defaults to safe allowlisted details for known change events; use off for the legacy terse event summary.',
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== undefined && asRecord(value) !== undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function isSecretLikeKey(key: string): boolean {
  return /(?:authorization|password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential|session[-_]?token|secretString|secretBinary|value)$/i.test(
    key
  );
}

function redactSecretSubstrings(value: string): string {
  return value
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bASIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `${REDACTED}`)
    .replace(
      /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret)=([^&\s,}]+)/gi,
      `$1=${REDACTED}`
    );
}

function truncateValue(value: string, maxChars = MAX_DETAIL_VALUE_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}

function redactValue(value: unknown, key = '', depth = 0): unknown {
  if (key && isSecretLikeKey(key)) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return truncateValue(redactSecretSubstrings(value));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      return `[array:${value.length}]`;
    }
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, '', depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return String(value);
  }
  if (depth >= 3) {
    return `[object:${Object.keys(record).length}]`;
  }
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey, depth + 1)])
  );
}

function detailPart(key: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    return `${key}=${truncateValue(redactSecretSubstrings(value))}`;
  }
  return `${key}=${JSON.stringify(redactValue(value, key))}`;
}

function decodeJsonString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const candidates = [value];
  try {
    candidates.push(decodeURIComponent(value));
  } catch {
    // CloudTrail sometimes stores plain JSON and sometimes URL-encoded JSON.
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep trying candidates before giving up.
    }
  }
  return value;
}

function summarizeList(value: unknown): string {
  const items = asArray(value)
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_ARRAY_ITEMS);
  const suffix = asArray(value).length > items.length ? ', ...' : '';
  return items.length === 0 ? '[]' : `[${items.join(', ')}${suffix}]`;
}

function summarizePolicyDocument(value: unknown): string {
  const document = asRecord(decodeJsonString(value));
  if (!document) {
    return 'policyDocument=unparseable';
  }
  const statements = asArray(document['Statement']).map(asRecord).filter(isRecord);
  if (statements.length === 0) {
    return 'policyDocument=statements[]';
  }
  const statementSummary = statements.slice(0, MAX_ARRAY_ITEMS).map((statement, index) => {
    const parts = [
      `statement${index + 1}`,
      `effect=${asString(statement['Effect']) ?? 'unknown'}`,
      `actions=${summarizeList(statement['Action'] ?? statement['NotAction'])}`,
      `resources=${summarizeList(statement['Resource'] ?? statement['NotResource'])}`,
    ];
    const sid = asString(statement['Sid']);
    if (sid) {
      parts.push(`sid=${sid}`);
    }
    return `{${parts.join(' ')}}`;
  });
  const suffix = statements.length > statementSummary.length ? ', ...' : '';
  return `policyDocument=${statementSummary.join(', ')}${suffix}`;
}

function formatIamDetails(eventName: string, request: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const field of ['roleName', 'policyName', 'userName', 'groupName'] as const) {
    const part = detailPart(field, request[field]);
    if (part) {
      parts.push(part);
    }
  }
  if (
    [
      'PutRolePolicy',
      'PutUserPolicy',
      'PutGroupPolicy',
      'CreatePolicy',
      'CreatePolicyVersion',
      'SetDefaultPolicyVersion',
    ].includes(eventName) &&
    request['policyDocument'] !== undefined
  ) {
    parts.push(summarizePolicyDocument(request['policyDocument']));
  }
  for (const field of ['policyArn', 'permissionsBoundary', 'roleArn'] as const) {
    const part = detailPart(field, request[field]);
    if (part) {
      parts.push(part);
    }
  }
  return parts;
}

function formatLambdaDetails(request: Record<string, unknown>, response: Record<string, unknown>): string[] {
  return [
    detailPart('functionName', request['functionName'] ?? response['functionName']),
    detailPart('runtime', request['runtime'] ?? response['runtime']),
    detailPart('handler', request['handler'] ?? response['handler']),
    detailPart('role', request['role'] ?? response['role']),
    detailPart('timeout', request['timeout'] ?? response['timeout']),
    detailPart('memorySize', request['memorySize'] ?? response['memorySize']),
    detailPart('revisionId', request['revisionId'] ?? response['revisionId']),
    detailPart('codeSha256', response['codeSha256']),
    detailPart('imageUri', request['imageUri']),
    request['environment'] !== undefined ? detailPart('environment', request['environment']) : null,
  ].filter((part): part is string => Boolean(part));
}

function formatEventBridgeDetails(eventName: string, request: Record<string, unknown>): string[] {
  const parts = [
    detailPart('name', request['name']),
    detailPart('rule', request['rule']),
    detailPart('eventBusName', request['eventBusName']),
    detailPart('scheduleExpression', request['scheduleExpression']),
    detailPart('state', request['state']),
    detailPart('description', request['description']),
  ].filter((part): part is string => Boolean(part));
  if (eventName === 'PutTargets') {
    const targets = asArray(request['targets'])
      .map(asRecord)
      .filter(isRecord)
      .slice(0, MAX_ARRAY_ITEMS)
      .map((target) =>
        [
          detailPart('id', target['id']),
          detailPart('arn', target['arn']),
          detailPart('roleArn', target['roleArn']),
          detailPart('input', decodeJsonString(target['input'])),
          detailPart('inputPath', target['inputPath']),
        ]
          .filter(Boolean)
          .join(' ')
      );
    if (targets.length > 0) {
      parts.push(`targets=[${targets.join('; ')}]`);
    }
  }
  return parts;
}

function formatSsmDetails(eventName: string, request: Record<string, unknown>, response: Record<string, unknown>): string[] {
  return [
    detailPart('name', request['name']),
    detailPart('type', request['type']),
    detailPart('keyId', request['keyId']),
    detailPart('tier', request['tier']),
    detailPart('overwrite', request['overwrite']),
    detailPart('version', response['version']),
    eventName === 'PutParameter' ? 'value=redacted' : null,
  ].filter((part): part is string => Boolean(part));
}

function formatSecretsManagerDetails(
  request: Record<string, unknown>,
  response: Record<string, unknown>
): string[] {
  return [
    detailPart('name', request['name'] ?? response['name']),
    detailPart('arn', response['arn']),
    detailPart('kmsKeyId', request['kmsKeyId']),
    detailPart('description', request['description']),
    detailPart('versionId', response['versionId']),
    request['secretString'] !== undefined || request['secretBinary'] !== undefined ? 'secretValue=redacted' : null,
  ].filter((part): part is string => Boolean(part));
}

function formatCloudFormationDetails(request: Record<string, unknown>, response: Record<string, unknown>): string[] {
  return [
    detailPart('stackName', request['stackName']),
    detailPart('stackId', response['stackId']),
    detailPart('changeSetName', request['changeSetName']),
    detailPart('templateURL', request['templateURL']),
    detailPart('roleARN', request['roleARN']),
    request['parameters'] !== undefined ? detailPart('parameters', request['parameters']) : null,
    request['capabilities'] !== undefined ? detailPart('capabilities', request['capabilities']) : null,
  ].filter((part): part is string => Boolean(part));
}

function formatDeploymentDetails(request: Record<string, unknown>, response: Record<string, unknown>): string[] {
  return [
    detailPart('applicationName', request['applicationName'] ?? response['applicationName']),
    detailPart('deploymentGroupName', request['deploymentGroupName'] ?? response['deploymentGroupName']),
    detailPart('deploymentId', response['deploymentId']),
    detailPart('revision', request['revision']),
  ].filter((part): part is string => Boolean(part));
}

function formatEventDetails(event: Event, detail: Record<string, unknown> | null, mode: DetailMode): string | null {
  if (mode === 'off' || !detail) {
    return null;
  }
  const eventSource = asString(detail['eventSource']) ?? event.EventSource ?? '';
  const eventName = asString(detail['eventName']) ?? event.EventName ?? '';
  const request = asRecord(detail['requestParameters']) ?? {};
  const response = asRecord(detail['responseElements']) ?? {};
  let parts: string[] = [];

  if (eventSource === 'iam.amazonaws.com') {
    parts = formatIamDetails(eventName, request);
  } else if (eventSource === 'lambda.amazonaws.com') {
    parts = formatLambdaDetails(request, response);
  } else if (eventSource === 'events.amazonaws.com') {
    parts = formatEventBridgeDetails(eventName, request);
  } else if (eventSource === 'ssm.amazonaws.com') {
    parts = formatSsmDetails(eventName, request, response);
  } else if (eventSource === 'secretsmanager.amazonaws.com') {
    parts = formatSecretsManagerDetails(request, response);
  } else if (eventSource === 'cloudformation.amazonaws.com') {
    parts = formatCloudFormationDetails(request, response);
  } else if (eventSource === 'codedeploy.amazonaws.com') {
    parts = formatDeploymentDetails(request, response);
  }

  return parts.length > 0 ? `details=[${parts.join(' ')}]` : null;
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

function formatEvent(event: Event, mode: DetailMode): string {
  const detail = parseCloudTrailEvent(event);
  const userIdentity = detail?.['userIdentity'] as Record<string, unknown> | undefined;
  const errorCode = detail?.['errorCode'];
  const sourceIp = detail?.['sourceIPAddress'];
  const resources = (event.Resources ?? [])
    .map((resource) => `${resource.ResourceType ?? 'resource'}=${resource.ResourceName ?? 'unknown'}`)
    .join(', ');
  const parts = [
    `${event.EventTime?.toISOString() ?? 'unknown'} ${event.EventName ?? 'unknown'}`,
    `source=${event.EventSource ?? 'unknown'}`,
    `username=${event.Username ?? 'unknown'}`,
    `identityType=${typeof userIdentity?.['type'] === 'string' ? userIdentity['type'] : 'unknown'}`,
    `sourceIp=${typeof sourceIp === 'string' ? sourceIp : 'unknown'}`,
    `errorCode=${typeof errorCode === 'string' ? errorCode : 'none'}`,
    resources ? `resources=[${resources}]` : 'resources=[]',
  ];
  const eventDetails = formatEventDetails(event, detail, mode);
  if (eventDetails) {
    parts.push(eventDetails);
  }
  return parts.join(' ');
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
  const detailMode = args.detail_mode ?? 'safe';
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

    return `CloudTrail events (${events.length}) in ${startTime.toISOString()}..${endTime.toISOString()}${filters ? ` for ${filters}` : ''}:\n${events.map((event) => formatEvent(event, detailMode)).join('\n')}`;
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
