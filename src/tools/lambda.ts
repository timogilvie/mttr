import {
  LambdaClient,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  ListTagsCommand,
  ListAliasesCommand,
  ListVersionsByFunctionCommand,
  type AliasConfiguration,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  type Parameter,
  type StackEvent,
  type StackResource,
} from '@aws-sdk/client-cloudformation';
import {
  ECRClient,
  BatchGetImageCommand,
  DescribeImagesCommand,
  GetDownloadUrlForLayerCommand,
  type ImageDetail,
} from '@aws-sdk/client-ecr';
import {
  CloudTrailClient,
  LookupEventsCommand,
  type Event as CloudTrailEvent,
} from '@aws-sdk/client-cloudtrail';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveToolTimeRange } from './types.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class LambdaToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'LambdaToolError';
  }
}

const MAX_ENV_VARS_SHOWN = 30;
const MAX_LAYERS_SHOWN = 10;
const MAX_VERSIONS_SHOWN = 10;
const MAX_ALIASES_SHOWN = 20;
const MAX_TAGS_SHOWN = 20;
const MAX_LABELS_SHOWN = 20;
const MAX_STACK_EVENTS_SHOWN = 12;
const MAX_CLOUDTRAIL_EVENTS_SHOWN = 12;
const SOURCE_METADATA_KEY =
  /(?:github|git|commit|sha|revision|source|repo|repository|workflow|run|build|version|release|branch|tag|image)/i;
const SECRET_KEY =
  /(?:authorization|password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential|session[-_]?token|value)$/i;
const DEPLOYMENT_EVENT_NAMES = [
  'UpdateFunctionCode',
  'UpdateFunctionConfiguration',
  'PublishVersion',
  'UpdateAlias',
  'CreateAlias',
  'TagResource',
  'UntagResource',
  'UpdateStack',
  'CreateChangeSet',
  'ExecuteChangeSet',
  'ContinueUpdateRollback',
  'PutRolePolicy',
  'AttachRolePolicy',
  'DetachRolePolicy',
  'CreatePolicyVersion',
  'SetDefaultPolicyVersion',
];

function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function normalizeFunctionArgs(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const input = value as Record<string, unknown>;
  return {
    ...input,
    function_name:
      input['function_name'] ??
      input['functionName'] ??
      input['function'] ??
      input['lambda_function'] ??
      input['lambdaFunction'],
    qualifier: emptyToUndefined(input['qualifier'] ?? input['version'] ?? input['alias']),
  };
}

const functionArgsSchema = z.preprocess(normalizeFunctionArgs, z.object({
  function_name: z.string().min(1),
  qualifier: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  include_environment_keys: z.boolean().optional(),
}));

const deploymentArgsSchema = z.preprocess(normalizeFunctionArgs, z.object({
  function_name: z.string().min(1),
  qualifier: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
}));

const provenanceArgsSchema = z.preprocess(normalizeFunctionArgs, z.object({
  function_name: z.string().min(1),
  qualifier: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  lookback_minutes: z.number().optional(),
}));

type FunctionArgs = z.infer<typeof functionArgsSchema>;
type DeploymentArgs = z.infer<typeof deploymentArgsSchema>;
type ProvenanceArgs = z.infer<typeof provenanceArgsSchema>;

const functionParametersJsonSchema = {
  type: 'object',
  properties: {
    function_name: {
      type: 'string',
      description:
        'Lambda function name or ARN, e.g. "hokusai-deltaone-anomaly-detector-development".',
    },
    qualifier: {
      type: 'string',
      description: 'Optional version or alias to inspect.',
    },
    include_environment_keys: {
      type: 'boolean',
      description:
        'When true, include environment variable names only. Values are never returned.',
    },
  },
  required: ['function_name'],
} as const;

const deploymentParametersJsonSchema = {
  type: 'object',
  properties: {
    function_name: {
      type: 'string',
      description:
        'Lambda function name or ARN, e.g. "hokusai-deltaone-anomaly-detector-development".',
    },
    qualifier: {
      type: 'string',
      description: 'Optional version or alias to inspect with GetFunction.',
    },
  },
  required: ['function_name'],
} as const;

const provenanceParametersJsonSchema = {
  type: 'object',
  properties: {
    function_name: {
      type: 'string',
      description:
        'Lambda function name or ARN, e.g. "hokusai-deltaone-anomaly-detector-development".',
    },
    qualifier: {
      type: 'string',
      description: 'Optional version or alias to inspect with GetFunction.',
    },
    start_time: {
      type: 'string',
      description:
        'Optional absolute provenance window start as an ISO timestamp. Must be paired with end_time.',
    },
    end_time: {
      type: 'string',
      description:
        'Optional absolute provenance window end as an ISO timestamp. Must be paired with start_time.',
    },
    lookback_minutes: {
      type: 'number',
      description:
        'Fallback relative lookback in minutes when no absolute report window is available.',
    },
  },
  required: ['function_name'],
} as const;

function formatLayers(config: FunctionConfiguration): string {
  const layers = (config.Layers ?? []).slice(0, MAX_LAYERS_SHOWN);
  if (layers.length === 0) {
    return 'layers=[]';
  }
  return `layers=[${layers.map((layer) => layer.Arn ?? 'unknown').join(', ')}]`;
}

function formatVpc(config: FunctionConfiguration): string {
  const vpc = config.VpcConfig;
  if (!vpc) {
    return 'vpc=none';
  }
  return [
    `vpcId=${vpc.VpcId ?? 'none'}`,
    `subnets=${(vpc.SubnetIds ?? []).length}`,
    `securityGroups=${(vpc.SecurityGroupIds ?? []).length}`,
  ].join(' ');
}

function formatEnvironmentKeys(config: FunctionConfiguration): string {
  const keys = Object.keys(config.Environment?.Variables ?? {})
    .sort()
    .slice(0, MAX_ENV_VARS_SHOWN);
  if (keys.length === 0) {
    return 'environmentKeys=[]';
  }
  const suffix =
    Object.keys(config.Environment?.Variables ?? {}).length > keys.length ? ', ...' : '';
  return `environmentKeys=[${keys.join(', ')}${suffix}]`;
}

function formatConfig(config: FunctionConfiguration, includeEnvironmentKeys: boolean): string {
  const lines = [
    `function=${config.FunctionName ?? 'unknown'}`,
    `arn=${config.FunctionArn ?? 'unknown'}`,
    `runtime=${config.Runtime ?? 'unknown'} handler=${config.Handler ?? 'unknown'} packageType=${config.PackageType ?? 'unknown'}`,
    `version=${config.Version ?? 'unknown'} lastModified=${config.LastModified ?? 'unknown'} revisionId=${config.RevisionId ?? 'unknown'}`,
    `role=${config.Role ?? 'unknown'}`,
    `timeoutSeconds=${config.Timeout ?? 'unknown'} memoryMb=${config.MemorySize ?? 'unknown'} ephemeralStorageMb=${config.EphemeralStorage?.Size ?? 'unknown'}`,
    `state=${config.State ?? 'unknown'} stateReason=${config.StateReason ?? 'none'} lastUpdateStatus=${config.LastUpdateStatus ?? 'unknown'} lastUpdateReason=${config.LastUpdateStatusReason ?? 'none'}`,
    `codeSha256=${config.CodeSha256 ?? 'unknown'} codeSize=${config.CodeSize ?? 'unknown'}`,
    formatLayers(config),
    formatVpc(config),
  ];
  if (includeEnvironmentKeys) {
    lines.push(formatEnvironmentKeys(config));
  }
  return lines.join('\n');
}

function formatAlias(alias: AliasConfiguration): string {
  const parts = [
    `alias=${alias.Name ?? 'unknown'}`,
    `functionVersion=${alias.FunctionVersion ?? 'unknown'}`,
  ];
  if (alias.Description) {
    parts.push(`description="${alias.Description}"`);
  }
  if (alias.RoutingConfig?.AdditionalVersionWeights) {
    const weights = Object.entries(alias.RoutingConfig.AdditionalVersionWeights)
      .map(([version, weight]) => `${version}:${weight}`)
      .join(', ');
    parts.push(`routingWeights=[${weights}]`);
  }
  return parts.join(' ');
}

function redactSecretSubstrings(value: string): string {
  return value
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\bASIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[redacted]')
    .replace(
      /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret)=([^&\s,}]+)/gi,
      '$1=[redacted]'
    );
}

function safeValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return 'unknown';
  }
  if (SECRET_KEY.test(key)) {
    return '[redacted]';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return redactSecretSubstrings(text).slice(0, 240);
}

function sourceMetadataEntries(record: Record<string, unknown> | undefined): string[] {
  if (!record) {
    return [];
  }
  return Object.entries(record)
    .filter(([key]) => SOURCE_METADATA_KEY.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_TAGS_SHOWN)
    .map(([key, value]) => `${key}=${safeValue(key, value)}`);
}

function formatLambdaTags(tags: Record<string, string> | undefined): string {
  const entries = sourceMetadataEntries(tags);
  const keys = Object.keys(tags ?? {}).sort();
  if (entries.length === 0) {
    return `Lambda tags: no source/build metadata tags found. tagKeys=[${keys
      .slice(0, MAX_TAGS_SHOWN)
      .join(', ')}${keys.length > MAX_TAGS_SHOWN ? ', ...' : ''}]`;
  }
  return `Lambda tags/source metadata:\n${entries.join('\n')}`;
}

interface ParsedImageUri {
  registryId?: string | undefined;
  repositoryName: string;
  imageTag?: string | undefined;
  imageDigest?: string | undefined;
}

function parseEcrImageUri(uri: string | undefined): ParsedImageUri | null {
  if (!uri) {
    return null;
  }
  const match = uri.match(/^(?:(\d+)\.dkr\.ecr\.[^/]+\.amazonaws\.com\/)?(.+)$/);
  if (!match) {
    return null;
  }
  const registryId = match[1];
  const remainder = match[2];
  if (!remainder) {
    return null;
  }
  const digestIndex = remainder.indexOf('@sha256:');
  if (digestIndex >= 0) {
    return {
      registryId,
      repositoryName: remainder.slice(0, digestIndex),
      imageDigest: remainder.slice(digestIndex + 1),
    };
  }
  const tagIndex = remainder.lastIndexOf(':');
  if (tagIndex > 0) {
    return {
      registryId,
      repositoryName: remainder.slice(0, tagIndex),
      imageTag: remainder.slice(tagIndex + 1),
    };
  }
  return { registryId, repositoryName: remainder };
}

function formatImageDetail(detail: ImageDetail | undefined): string {
  if (!detail) {
    return 'ECR image: no image details found.';
  }
  return [
    'ECR image:',
    `digest=${detail.imageDigest ?? 'unknown'}`,
    `tags=[${(detail.imageTags ?? []).slice(0, MAX_TAGS_SHOWN).join(', ')}]`,
    `pushedAt=${detail.imagePushedAt?.toISOString() ?? 'unknown'}`,
    `sizeBytes=${detail.imageSizeInBytes ?? 'unknown'}`,
  ].join('\n');
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function fetchImageLabels(
  client: ECRClient,
  image: ParsedImageUri,
  imageDigest: string | undefined
): Promise<string> {
  if (!imageDigest) {
    return 'ECR image labels: unavailable (image digest not known).';
  }
  const manifestResponse = await client.send(
    new BatchGetImageCommand({
      registryId: image.registryId,
      repositoryName: image.repositoryName,
      imageIds: [{ imageDigest }],
      acceptedMediaTypes: [
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ],
    })
  );
  const manifest = parseJsonRecord(manifestResponse.images?.[0]?.imageManifest);
  const config = manifest?.['config'];
  const configDigest =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>)['digest']
      : undefined;
  if (typeof configDigest !== 'string') {
    return 'ECR image labels: unavailable (manifest config digest not found).';
  }

  const layer = await client.send(
    new GetDownloadUrlForLayerCommand({
      registryId: image.registryId,
      repositoryName: image.repositoryName,
      layerDigest: configDigest,
    })
  );
  if (!layer.downloadUrl) {
    return 'ECR image labels: unavailable (config download URL missing).';
  }

  const response = await fetch(layer.downloadUrl);
  if (!response.ok) {
    return `ECR image labels: unavailable (config fetch HTTP ${response.status}).`;
  }
  const configJson = (await response.json()) as unknown;
  const configRecord =
    configJson && typeof configJson === 'object' && !Array.isArray(configJson)
      ? (configJson as Record<string, unknown>)
      : undefined;
  const imageConfig = configRecord?.['config'];
  const labels =
    imageConfig && typeof imageConfig === 'object' && !Array.isArray(imageConfig)
      ? (imageConfig as Record<string, unknown>)['Labels']
      : undefined;
  const entries = sourceMetadataEntries(
    labels && typeof labels === 'object' && !Array.isArray(labels)
      ? (labels as Record<string, unknown>)
      : undefined
  ).slice(0, MAX_LABELS_SHOWN);
  return entries.length === 0
    ? 'ECR image labels: no source/build metadata labels found.'
    : `ECR image labels/source metadata:\n${entries.join('\n')}`;
}

async function runOptional(label: string, action: () => Promise<string>): Promise<string> {
  try {
    return await action();
  } catch (error) {
    return `${label}: unavailable (${error instanceof Error ? error.message : String(error)}).`;
  }
}

async function getEcrProvenance(imageUri: string | undefined, ctx: ToolContext): Promise<string> {
  const image = parseEcrImageUri(imageUri);
  if (!image) {
    return 'ECR image: no ECR image URI found on Lambda code metadata.';
  }
  const client = new ECRClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
  try {
    const describe = await client.send(
      new DescribeImagesCommand({
        registryId: image.registryId,
        repositoryName: image.repositoryName,
        imageIds: [
          image.imageDigest
            ? { imageDigest: image.imageDigest }
            : image.imageTag
              ? { imageTag: image.imageTag }
              : {},
        ],
      })
    );
    const detail = describe.imageDetails?.[0];
    const labels = await runOptional('ECR image labels', () =>
      fetchImageLabels(client, image, detail?.imageDigest ?? image.imageDigest)
    );
    return `${formatImageDetail(detail)}\n${labels}`;
  } finally {
    client.destroy();
  }
}

function stackIdentifier(resource: StackResource | undefined): string | undefined {
  return resource?.StackName ?? resource?.StackId;
}

function formatStackResource(resource: StackResource | undefined): string {
  if (!resource) {
    return 'CloudFormation: no stack resource found for Lambda physical resource id.';
  }
  return [
    'CloudFormation resource:',
    `stack=${resource.StackName ?? resource.StackId ?? 'unknown'}`,
    `logicalResourceId=${resource.LogicalResourceId ?? 'unknown'}`,
    `physicalResourceId=${resource.PhysicalResourceId ?? 'unknown'}`,
    `resourceStatus=${resource.ResourceStatus ?? 'unknown'}`,
    `lastUpdated=${resource.Timestamp?.toISOString() ?? 'unknown'}`,
  ].join('\n');
}

function formatStackParameters(parameters: Parameter[] | undefined): string {
  const entries = (parameters ?? [])
    .filter((parameter) => parameter.ParameterKey && SOURCE_METADATA_KEY.test(parameter.ParameterKey))
    .slice(0, MAX_TAGS_SHOWN)
    .map((parameter) => `${parameter.ParameterKey}=${safeValue(parameter.ParameterKey ?? '', parameter.ParameterValue)}`);
  return entries.length === 0
    ? 'CloudFormation stack parameters: no source/build metadata parameters found.'
    : `CloudFormation stack source parameters:\n${entries.join('\n')}`;
}

function eventInRange(event: StackEvent, startTime: Date, endTime: Date): boolean {
  const timestamp = event.Timestamp?.getTime();
  return timestamp !== undefined && timestamp >= startTime.getTime() && timestamp <= endTime.getTime();
}

function formatStackEvent(event: StackEvent): string {
  return [
    event.Timestamp?.toISOString() ?? 'unknown',
    event.ResourceStatus ?? 'unknown',
    event.LogicalResourceId ?? 'unknown',
    event.ResourceType ?? 'unknown',
    event.ResourceStatusReason ? `reason=${safeValue('reason', event.ResourceStatusReason)}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

async function getCloudFormationProvenance(
  functionName: string,
  startTime: Date,
  endTime: Date,
  ctx: ToolContext
): Promise<string> {
  const client = new CloudFormationClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
  try {
    const resources = await client.send(
      new DescribeStackResourcesCommand({ PhysicalResourceId: functionName })
    );
    const resource = resources.StackResources?.[0];
    const stack = stackIdentifier(resource);
    if (!resource || !stack) {
      return formatStackResource(resource);
    }

    const [stackDetail, stackEvents] = await Promise.all([
      runOptional('CloudFormation stack parameters', async () => {
        const stacks = await client.send(new DescribeStacksCommand({ StackName: stack }));
        return formatStackParameters(stacks.Stacks?.[0]?.Parameters);
      }),
      runOptional('CloudFormation stack events', async () => {
        const events = await client.send(new DescribeStackEventsCommand({ StackName: stack }));
        const relevant = (events.StackEvents ?? [])
          .filter((event) => eventInRange(event, startTime, endTime))
          .slice(0, MAX_STACK_EVENTS_SHOWN);
        return relevant.length === 0
          ? `CloudFormation stack events: none found in ${startTime.toISOString()}..${endTime.toISOString()}.`
          : `CloudFormation stack events in ${startTime.toISOString()}..${endTime.toISOString()}:\n${relevant
              .map(formatStackEvent)
              .join('\n')}`;
      }),
    ]);
    return `${formatStackResource(resource)}\n${stackDetail}\n${stackEvents}`;
  } finally {
    client.destroy();
  }
}

function parseCloudTrailJson(event: CloudTrailEvent): Record<string, unknown> | null {
  if (!event.CloudTrailEvent) {
    return null;
  }
  return parseJsonRecord(event.CloudTrailEvent);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === 'object' && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : undefined;
}

function formatCloudTrailIdentity(detail: Record<string, unknown> | null, event: CloudTrailEvent): string {
  const identity = nestedRecord(detail, 'userIdentity');
  const sessionContext = nestedRecord(identity, 'sessionContext');
  const sessionIssuer = nestedRecord(sessionContext, 'sessionIssuer');
  const arn = safeValue('arn', identity?.['arn']);
  const issuer = safeValue(
    'sessionIssuer',
    sessionIssuer?.['userName'] ?? sessionIssuer?.['arn'] ?? identity?.['principalId'] ?? event.Username
  );
  return `actor=${event.Username ?? 'unknown'} identityArn=${arn} sessionIssuer=${issuer}`;
}

function formatCloudTrailDeploymentEvent(event: CloudTrailEvent): string {
  const detail = parseCloudTrailJson(event);
  const resources = (event.Resources ?? [])
    .map((resource) => `${resource.ResourceType ?? 'resource'}=${resource.ResourceName ?? 'unknown'}`)
    .join(', ');
  return [
    event.EventTime?.toISOString() ?? 'unknown',
    event.EventName ?? 'unknown',
    `source=${event.EventSource ?? 'unknown'}`,
    formatCloudTrailIdentity(detail, event),
    resources ? `resources=[${resources}]` : 'resources=[]',
  ].join(' ');
}

async function getCloudTrailProvenance(
  functionName: string,
  stackName: string | undefined,
  startTime: Date,
  endTime: Date,
  ctx: ToolContext
): Promise<string> {
  const client = new CloudTrailClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
  try {
    const lookups = [functionName, stackName].filter((value): value is string => Boolean(value));
    const events: CloudTrailEvent[] = [];
    for (const resourceName of lookups) {
      const response = await client.send(
        new LookupEventsCommand({
          StartTime: startTime,
          EndTime: endTime,
          LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: resourceName }],
          MaxResults: MAX_CLOUDTRAIL_EVENTS_SHOWN,
        })
      );
      events.push(...(response.Events ?? []));
    }
    const unique = new Map<string, CloudTrailEvent>();
    for (const event of events) {
      if (DEPLOYMENT_EVENT_NAMES.includes(event.EventName ?? '')) {
        unique.set(event.EventId ?? `${event.EventTime?.toISOString()}-${event.EventName}`, event);
      }
    }
    const formatted = [...unique.values()]
      .sort((a, b) => (b.EventTime?.getTime() ?? 0) - (a.EventTime?.getTime() ?? 0))
      .slice(0, MAX_CLOUDTRAIL_EVENTS_SHOWN);
    return formatted.length === 0
      ? `CloudTrail deployment actors: no deployment/change events found in ${startTime.toISOString()}..${endTime.toISOString()}.`
      : `CloudTrail deployment actors in ${startTime.toISOString()}..${endTime.toISOString()}:\n${formatted
          .map(formatCloudTrailDeploymentEvent)
          .join('\n')}`;
  } finally {
    client.destroy();
  }
}

async function configurationHandler(args: FunctionArgs, ctx: ToolContext): Promise<string> {
  const client = new LambdaClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
  try {
    const response = await client.send(
      new GetFunctionConfigurationCommand({
        FunctionName: args.function_name,
        Qualifier: args.qualifier,
      })
    );
    return formatConfig(response, args.include_environment_keys === true);
  } catch (error) {
    throw new LambdaToolError(
      `get_lambda_configuration failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

async function deploymentMetadataHandler(args: DeploymentArgs, ctx: ToolContext): Promise<string> {
  const client = new LambdaClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
  try {
    const sections: string[] = [];
    const getFunction = await client.send(
      new GetFunctionCommand({
        FunctionName: args.function_name,
        Qualifier: args.qualifier,
      })
    );
    if (getFunction.Configuration) {
      sections.push(`Current function artifact:\n${formatConfig(getFunction.Configuration, false)}`);
    }
    if (getFunction.Code) {
      sections.push(
        [
          'Code location metadata:',
          `repositoryType=${getFunction.Code.RepositoryType ?? 'unknown'}`,
          `imageUri=${getFunction.Code.ImageUri ?? 'n/a'}`,
          `resolvedImageUri=${getFunction.Code.ResolvedImageUri ?? 'n/a'}`,
          `locationPresent=${getFunction.Code.Location ? 'true' : 'false'}`,
        ].join('\n')
      );
    }

    const versions = await client.send(
      new ListVersionsByFunctionCommand({
        FunctionName: args.function_name,
        MaxItems: MAX_VERSIONS_SHOWN,
      })
    );
    const versionLines = (versions.Versions ?? []).map(
      (version) =>
        `version=${version.Version ?? 'unknown'} lastModified=${version.LastModified ?? 'unknown'} codeSha256=${version.CodeSha256 ?? 'unknown'} revisionId=${version.RevisionId ?? 'unknown'}`
    );
    sections.push(
      versionLines.length === 0
        ? 'Published versions: none found.'
        : `Published versions (showing ${versionLines.length}):\n${versionLines.join('\n')}`
    );

    const aliases = await client.send(
      new ListAliasesCommand({
        FunctionName: args.function_name,
        MaxItems: MAX_ALIASES_SHOWN,
      })
    );
    const aliasLines = (aliases.Aliases ?? []).map(formatAlias);
    sections.push(
      aliasLines.length === 0
        ? 'Aliases: none found.'
        : `Aliases (showing ${aliasLines.length}):\n${aliasLines.join('\n')}`
    );

    return sections.join('\n\n');
  } catch (error) {
    throw new LambdaToolError(
      `get_lambda_deployment_metadata failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

async function deploymentProvenanceHandler(args: ProvenanceArgs, ctx: ToolContext): Promise<string> {
  const { startTime, endTime, source } = resolveToolTimeRange(
    args.start_time,
    args.end_time,
    args.lookback_minutes,
    ctx
  );
  const lambda = new LambdaClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
  try {
    const getFunction = await lambda.send(
      new GetFunctionCommand({
        FunctionName: args.function_name,
        Qualifier: args.qualifier,
      })
    );
    const config = getFunction.Configuration;
    const functionName = config?.FunctionName ?? args.function_name;
    const functionArn = config?.FunctionArn;
    const imageUri = getFunction.Code?.ResolvedImageUri ?? getFunction.Code?.ImageUri;
    const sections = [
      [
        'Lambda deployment provenance:',
        `function=${functionName}`,
        `arn=${functionArn ?? 'unknown'}`,
        `packageType=${config?.PackageType ?? 'unknown'}`,
        `version=${config?.Version ?? 'unknown'}`,
        `lastModified=${config?.LastModified ?? 'unknown'}`,
        `revisionId=${config?.RevisionId ?? 'unknown'}`,
        `codeSha256=${config?.CodeSha256 ?? 'unknown'}`,
        `imageUri=${getFunction.Code?.ImageUri ?? 'n/a'}`,
        `resolvedImageUri=${getFunction.Code?.ResolvedImageUri ?? 'n/a'}`,
        `window=${startTime.toISOString()}..${endTime.toISOString()} source=${source}`,
      ].join('\n'),
    ];

    sections.push(
      await runOptional('Lambda tags', async () => {
        if (!functionArn) {
          return 'Lambda tags: unavailable (function ARN missing).';
        }
        const tags = await lambda.send(new ListTagsCommand({ Resource: functionArn }));
        return formatLambdaTags(tags.Tags);
      })
    );
    sections.push(await runOptional('ECR image', () => getEcrProvenance(imageUri, ctx)));
    sections.push(
      await runOptional('CloudFormation', () =>
        getCloudFormationProvenance(functionName, startTime, endTime, ctx)
      )
    );
    sections.push(
      await runOptional('CloudTrail deployment actors', () =>
        getCloudTrailProvenance(functionName, undefined, startTime, endTime, ctx)
      )
    );

    return sections.join('\n\n');
  } catch (error) {
    throw new LambdaToolError(
      `get_deployment_provenance failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    lambda.destroy();
  }
}

export const lambdaConfigurationTool: ToolDefinition<FunctionArgs> = {
  name: 'get_lambda_configuration',
  description:
    'Read-only: fetch Lambda runtime/configuration details including runtime, handler, role, timeout, memory, layers, VPC config, version, code hash, and optionally environment variable names only. Values are never returned.',
  parametersJsonSchema: functionParametersJsonSchema,
  argsSchema: functionArgsSchema,
  handler: configurationHandler,
};

export const lambdaDeploymentMetadataTool: ToolDefinition<DeploymentArgs> = {
  name: 'get_lambda_deployment_metadata',
  description:
    'Read-only: fetch Lambda deployment/artifact metadata, published versions, aliases, code hash, image metadata, and revision IDs to correlate a running function with a release or build.',
  parametersJsonSchema: deploymentParametersJsonSchema,
  argsSchema: deploymentArgsSchema,
  handler: deploymentMetadataHandler,
};

export const lambdaDeploymentProvenanceTool: ToolDefinition<ProvenanceArgs> = {
  name: 'get_deployment_provenance',
  description:
    'Read-only: connect a Lambda function to deployment provenance by joining Lambda tags/artifact metadata, ECR image digest/tags/source labels, CloudFormation stack resource/events, and CloudTrail deployment actors. Degrades gracefully when permissions are missing.',
  parametersJsonSchema: provenanceParametersJsonSchema,
  argsSchema: provenanceArgsSchema,
  handler: deploymentProvenanceHandler,
};
