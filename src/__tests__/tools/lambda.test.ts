import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LambdaClient,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  ListAliasesCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  lambdaConfigurationTool,
  lambdaDeploymentMetadataTool,
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

describe('lambda tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
});
