import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LambdaClient,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  ListTagsCommand,
  ListAliasesCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  ECRClient,
  BatchGetImageCommand,
  DescribeImagesCommand,
  GetDownloadUrlForLayerCommand,
} from '@aws-sdk/client-ecr';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import {
  lambdaConfigurationTool,
  lambdaDeploymentMetadataTool,
  lambdaDeploymentProvenanceTool,
  LambdaToolError,
} from '../../tools/lambda.js';
import type { ToolContext } from '../../tools/types.js';

vi.mock('@aws-sdk/client-lambda', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-lambda')>(
    '@aws-sdk/client-lambda'
  );
  return {
    ...actual,
    LambdaClient: vi.fn(),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudformation')>(
    '@aws-sdk/client-cloudformation'
  );
  return {
    ...actual,
    CloudFormationClient: vi.fn(),
  };
});

vi.mock('@aws-sdk/client-ecr', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecr')>(
    '@aws-sdk/client-ecr'
  );
  return {
    ...actual,
    ECRClient: vi.fn(),
  };
});

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudtrail')>(
    '@aws-sdk/client-cloudtrail'
  );
  return {
    ...actual,
    CloudTrailClient: vi.fn(),
  };
});

const ctx: ToolContext = {
  region: 'us-east-1',
  maxAttempts: 3,
  timeoutMs: 2000,
  maxResultChars: 8000,
  defaultLookbackMinutes: 60,
  maxLookbackMinutes: 1440,
};

function mockClient(send: ReturnType<typeof vi.fn>): void {
  const destroy = vi.fn();
  vi.mocked(LambdaClient).mockImplementation(
    () => ({ send, destroy }) as unknown as LambdaClient
  );
}

function mockServiceClient<T>(client: unknown, send: ReturnType<typeof vi.fn>): void {
  const destroy = vi.fn();
  vi.mocked(client as new () => T).mockImplementation(
    () => ({ send, destroy }) as unknown as T
  );
}

describe('lambda tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns Lambda configuration without environment values', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      FunctionName: 'hokusai-deltaone-anomaly-detector-development',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:detector',
      Runtime: 'python3.12',
      Handler: 'deltaone_detector_lambda.handler',
      Version: '$LATEST',
      LastModified: '2026-06-12T13:45:00.000+0000',
      RevisionId: 'rev-1',
      Role: 'arn:aws:iam::123:role/lambda-role',
      Timeout: 60,
      MemorySize: 512,
      CodeSha256: 'abc123',
      Environment: { Variables: { RPC_URL: 'https://secret.example', API_KEY: 'secret' } },
      VpcConfig: { VpcId: 'vpc-1', SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] },
    });
    mockClient(send);

    const result = await lambdaConfigurationTool.handler(
      {
        function_name: 'hokusai-deltaone-anomaly-detector-development',
        include_environment_keys: true,
      },
      ctx
    );

    expect(result).toContain('runtime=python3.12');
    expect(result).toContain('handler=deltaone_detector_lambda.handler');
    expect(result).toContain('environmentKeys=[API_KEY, RPC_URL]');
    expect(result).not.toContain('https://secret.example');
    expect(result).not.toContain('secret');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetFunctionConfigurationCommand);
  });

  it('returns deployment metadata, versions, and aliases', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetFunctionCommand) {
        return Promise.resolve({
          Configuration: {
            FunctionName: 'detector',
            Runtime: 'python3.12',
            Handler: 'handler.main',
            Version: '$LATEST',
            LastModified: '2026-06-12T13:45:00.000+0000',
            CodeSha256: 'latest-sha',
          },
          Code: {
            RepositoryType: 'ECR',
            ImageUri: 'repo:tag',
            ResolvedImageUri: 'repo@sha256:123',
          },
        });
      }
      if (command instanceof ListVersionsByFunctionCommand) {
        return Promise.resolve({
          Versions: [
            {
              Version: '7',
              LastModified: '2026-06-12T13:45:00.000+0000',
              CodeSha256: 'version-sha',
              RevisionId: 'rev-7',
            },
          ],
        });
      }
      if (command instanceof ListAliasesCommand) {
        return Promise.resolve({ Aliases: [{ Name: 'live', FunctionVersion: '7' }] });
      }
      return Promise.reject(new Error('unexpected command'));
    });
    mockClient(send);

    const result = await lambdaDeploymentMetadataTool.handler({ function_name: 'detector' }, ctx);

    expect(result).toContain('Current function artifact');
    expect(result).toContain('resolvedImageUri=repo@sha256:123');
    expect(result).toContain('version=7');
    expect(result).toContain('alias=live functionVersion=7');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('returns Lambda image deployment provenance across tags, ECR, CloudFormation, and CloudTrail', async () => {
    const lambdaSend = vi.fn((command: unknown) => {
      if (command instanceof GetFunctionCommand) {
        return Promise.resolve({
          Configuration: {
            FunctionName: 'detector',
            FunctionArn: 'arn:aws:lambda:us-east-1:123:function:detector',
            PackageType: 'Image',
            Version: '$LATEST',
            LastModified: '2026-06-12T13:51:09.000+0000',
            RevisionId: 'lambda-rev',
            CodeSha256: 'code-sha',
          },
          Code: {
            ImageUri: '123.dkr.ecr.us-east-1.amazonaws.com/hokusai/detector:prod-42',
            ResolvedImageUri:
              '123.dkr.ecr.us-east-1.amazonaws.com/hokusai/detector@sha256:abc',
          },
        });
      }
      if (command instanceof ListTagsCommand) {
        return Promise.resolve({
          Tags: {
            GitHubRunId: '999',
            GitCommit: 'abc123',
            API_TOKEN: 'should-not-print',
          },
        });
      }
      return Promise.reject(new Error('unexpected lambda command'));
    });
    const ecrSend = vi.fn((command: unknown) => {
      if (command instanceof DescribeImagesCommand) {
        return Promise.resolve({
          imageDetails: [
            {
              imageDigest: 'sha256:abc',
              imageTags: ['prod-42', 'git-abc123'],
              imagePushedAt: new Date('2026-06-12T13:49:00Z'),
              imageSizeInBytes: 1234,
            },
          ],
        });
      }
      if (command instanceof BatchGetImageCommand) {
        return Promise.resolve({
          images: [
            {
              imageManifest: JSON.stringify({
                config: { digest: 'sha256:config' },
              }),
            },
          ],
        });
      }
      if (command instanceof GetDownloadUrlForLayerCommand) {
        return Promise.resolve({ downloadUrl: 'https://example.test/config' });
      }
      return Promise.reject(new Error('unexpected ecr command'));
    });
    const cloudFormationSend = vi.fn((command: unknown) => {
      if (command instanceof DescribeStackResourcesCommand) {
        return Promise.resolve({
          StackResources: [
            {
              StackName: 'detector-stack',
              LogicalResourceId: 'DetectorFunction',
              PhysicalResourceId: 'detector',
              ResourceStatus: 'UPDATE_COMPLETE',
              LastUpdatedTimestamp: new Date('2026-06-12T13:51:00Z'),
            },
          ],
        });
      }
      if (command instanceof DescribeStacksCommand) {
        return Promise.resolve({
          Stacks: [
            {
              Parameters: [
                { ParameterKey: 'GitHubSha', ParameterValue: 'abc123' },
                { ParameterKey: 'Password', ParameterValue: 'do-not-print' },
              ],
            },
          ],
        });
      }
      if (command instanceof DescribeStackEventsCommand) {
        return Promise.resolve({
          StackEvents: [
            {
              Timestamp: new Date('2026-06-12T13:51:02Z'),
              ResourceStatus: 'UPDATE_COMPLETE',
              LogicalResourceId: 'DetectorFunction',
              ResourceType: 'AWS::Lambda::Function',
            },
          ],
        });
      }
      return Promise.reject(new Error('unexpected cloudformation command'));
    });
    const cloudTrailSend = vi.fn((command: unknown) => {
      if (command instanceof LookupEventsCommand) {
        return Promise.resolve({
          Events: [
            {
              EventId: 'evt-1',
              EventName: 'UpdateFunctionCode',
              EventSource: 'lambda.amazonaws.com',
              EventTime: new Date('2026-06-12T13:51:08Z'),
              Username: 'github-actions-role/GitHubActions',
              Resources: [{ ResourceType: 'AWS::Lambda::Function', ResourceName: 'detector' }],
              CloudTrailEvent: JSON.stringify({
                userIdentity: {
                  arn: 'arn:aws:sts::123:assumed-role/github-actions-role/GitHubActions',
                  sessionContext: {
                    sessionIssuer: { userName: 'github-actions-role' },
                  },
                },
              }),
            },
          ],
        });
      }
      return Promise.reject(new Error('unexpected cloudtrail command'));
    });
    mockClient(lambdaSend);
    mockServiceClient<ECRClient>(ECRClient, ecrSend);
    mockServiceClient<CloudFormationClient>(CloudFormationClient, cloudFormationSend);
    mockServiceClient<CloudTrailClient>(CloudTrailClient, cloudTrailSend);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          config: {
            Labels: {
              'org.opencontainers.image.revision': 'abc123',
              'org.opencontainers.image.source': 'https://github.com/org/repo',
            },
          },
        }),
      })
    );

    const result = await lambdaDeploymentProvenanceTool.handler(
      {
        function_name: 'detector',
        start_time: '2026-06-12T13:45:00Z',
        end_time: '2026-06-12T14:00:00Z',
      },
      ctx
    );

    expect(result).toContain('lastModified=2026-06-12T13:51:09.000+0000');
    expect(result).toContain('GitHubRunId=999');
    expect(result).toContain('digest=sha256:abc');
    expect(result).toContain('tags=[prod-42, git-abc123]');
    expect(result).toContain('org.opencontainers.image.revision=abc123');
    expect(result).toContain('stack=detector-stack');
    expect(result).toContain('GitHubSha=abc123');
    expect(result).toContain('2026-06-12T13:51:02.000Z UPDATE_COMPLETE DetectorFunction');
    expect(result).toContain('UpdateFunctionCode');
    expect(result).toContain('sessionIssuer=github-actions-role');
    expect(result).not.toContain('should-not-print');
    expect(result).not.toContain('do-not-print');
  });

  it('degrades optional provenance sections when permissions are partial', async () => {
    const lambdaSend = vi.fn((command: unknown) => {
      if (command instanceof GetFunctionCommand) {
        return Promise.resolve({
          Configuration: {
            FunctionName: 'detector',
            FunctionArn: 'arn:aws:lambda:us-east-1:123:function:detector',
            PackageType: 'Image',
          },
          Code: {
            ResolvedImageUri:
              '123.dkr.ecr.us-east-1.amazonaws.com/hokusai/detector@sha256:abc',
          },
        });
      }
      if (command instanceof ListTagsCommand) {
        return Promise.reject(new Error('AccessDenied: tags'));
      }
      return Promise.reject(new Error('unexpected lambda command'));
    });
    mockClient(lambdaSend);
    mockServiceClient<ECRClient>(ECRClient, vi.fn().mockRejectedValue(new Error('AccessDenied: ecr')));
    mockServiceClient<CloudFormationClient>(
      CloudFormationClient,
      vi.fn().mockRejectedValue(new Error('AccessDenied: cloudformation'))
    );
    mockServiceClient<CloudTrailClient>(
      CloudTrailClient,
      vi.fn().mockRejectedValue(new Error('AccessDenied: cloudtrail'))
    );

    const result = await lambdaDeploymentProvenanceTool.handler(
      { function_name: 'detector', lookback_minutes: 30 },
      ctx
    );

    expect(result).toContain('Lambda deployment provenance:');
    expect(result).toContain('Lambda tags: unavailable');
    expect(result).toContain('ECR image: unavailable');
    expect(result).toContain('CloudFormation: unavailable');
    expect(result).toContain('CloudTrail deployment actors: unavailable');
  });

  it('wraps AWS errors in LambdaToolError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    mockClient(send);

    await expect(
      lambdaConfigurationTool.handler({ function_name: 'detector' }, ctx)
    ).rejects.toThrow(LambdaToolError);
  });

  it('validates arguments via argsSchema', () => {
    expect(lambdaConfigurationTool.argsSchema.safeParse({ function_name: '' }).success).toBe(false);
    expect(
      lambdaDeploymentMetadataTool.argsSchema.safeParse({ function_name: 'detector' }).success
    ).toBe(true);
    expect(
      lambdaDeploymentProvenanceTool.argsSchema.safeParse({ function_name: 'detector' }).success
    ).toBe(true);
  });
});
