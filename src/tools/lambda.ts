import {
  LambdaClient,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  ListAliasesCommand,
  ListVersionsByFunctionCommand,
  type AliasConfiguration,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
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

const functionArgsSchema = z.object({
  function_name: z.string().min(1),
  qualifier: z.string().min(1).optional(),
  include_environment_keys: z.boolean().optional(),
});

const deploymentArgsSchema = z.object({
  function_name: z.string().min(1),
  qualifier: z.string().min(1).optional(),
});

type FunctionArgs = z.infer<typeof functionArgsSchema>;
type DeploymentArgs = z.infer<typeof deploymentArgsSchema>;

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
