import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  discoverLogGroupsTool,
  queryLogsTool,
  CloudWatchLogsToolError,
} from '../../tools/cloudwatchLogs.js';
import type { ToolContext } from '../../tools/types.js';

vi.mock('@aws-sdk/client-cloudwatch-logs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudwatch-logs')>(
    '@aws-sdk/client-cloudwatch-logs'
  );
  return {
    ...actual,
    CloudWatchLogsClient: vi.fn(),
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

const validArgs = {
  log_group: '/aws/app/data-pipeline-api',
  filter_or_query: 'stats count(*) by status',
};

function mockClient(send: ReturnType<typeof vi.fn>): void {
  const destroy = vi.fn();
  vi.mocked(CloudWatchLogsClient).mockImplementation(
    () => ({ send, destroy }) as unknown as CloudWatchLogsClient
  );
}

describe('cloudwatchLogs query_logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a query and returns formatted completed rows', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-1' })
      .mockResolvedValueOnce({
        status: 'Complete',
        results: [
          [
            { field: 'status', value: '403' },
            { field: 'count(*)', value: '42' },
            { field: '@ptr', value: 'ignored' },
          ],
        ],
      });
    mockClient(send);

    const result = await queryLogsTool.handler(validArgs, ctx);

    expect(result).toContain('1 row');
    expect(result).toContain('status=403');
    expect(result).toContain('count(*)=42');
    expect(result).not.toContain('@ptr');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(StartQueryCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetQueryResultsCommand);
  });

  it('uses absolute start and end times when provided', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-1' })
      .mockResolvedValueOnce({ status: 'Complete', results: [] });
    mockClient(send);

    const result = await queryLogsTool.handler(
      {
        ...validArgs,
        start_time: '2026-06-05T11:35:04.000Z',
        end_time: '2026-06-06T11:35:04.000Z',
      },
      ctx
    );

    const command = send.mock.calls[0]?.[0] as StartQueryCommand;
    expect(command.input.startTime).toBe(Date.parse('2026-06-05T11:35:04.000Z') / 1000);
    expect(command.input.endTime).toBe(Date.parse('2026-06-06T11:35:04.000Z') / 1000);
    expect(result).toContain(
      'Query window: 2026-06-05T11:35:04.000Z to 2026-06-06T11:35:04.000Z'
    );
  });

  it('reports zero matching rows clearly', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-1' })
      .mockResolvedValueOnce({ status: 'Complete', results: [] });
    mockClient(send);

    const result = await queryLogsTool.handler(validArgs, ctx);
    expect(result).toContain('0 matching rows');
  });

  it('throws when the query fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-1' })
      .mockResolvedValueOnce({ status: 'Failed' });
    mockClient(send);

    await expect(queryLogsTool.handler(validArgs, ctx)).rejects.toThrow(CloudWatchLogsToolError);
  });

  it('stops the query and throws on timeout', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-1' })
      .mockResolvedValue({ status: 'Running' });
    mockClient(send);

    await expect(queryLogsTool.handler(validArgs, { ...ctx, timeoutMs: 0 })).rejects.toThrow(
      /did not complete/
    );

    const stopCall = send.mock.calls.find((c) => c[0] instanceof StopQueryCommand);
    expect(stopCall).toBeDefined();
  });

  it('wraps AWS errors in CloudWatchLogsToolError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    mockClient(send);

    await expect(queryLogsTool.handler(validArgs, ctx)).rejects.toThrow(CloudWatchLogsToolError);
  });

  it('validates arguments via argsSchema', () => {
    expect(queryLogsTool.argsSchema.safeParse({ log_group: '', filter_or_query: 'x' }).success).toBe(
      false
    );
    expect(queryLogsTool.argsSchema.safeParse(validArgs).success).toBe(true);
  });
});

describe('cloudwatchLogs discover_log_groups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns candidate log groups containing the service name', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      logGroups: [
        { logGroupName: '/aws/lambda/other-service', storedBytes: 10 },
        {
          logGroupName: '/aws/ecs/data-pipeline-api',
          creationTime: Date.parse('2026-06-09T12:00:00Z'),
          storedBytes: 2048,
        },
      ],
    });
    mockClient(send);

    const result = await discoverLogGroupsTool.handler({ service_name: 'data-pipeline-api' }, ctx);

    expect(result).toContain('Found 1 candidate');
    expect(result).toContain('/aws/ecs/data-pipeline-api');
    expect(result).toContain('storedBytes=2048');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeLogGroupsCommand);
  });

  it('falls back to meaningful service-name tokens for aliased log groups', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      logGroups: [
        { logGroupName: '/ecs/hokusai-api-development', storedBytes: 11701821 },
        { logGroupName: '/ecs/hokusai-auth/development', storedBytes: 42076235 },
      ],
    });
    mockClient(send);

    const result = await discoverLogGroupsTool.handler({ service_name: 'data-pipeline-api' }, ctx);

    expect(result).toContain('/ecs/hokusai-api-development');
    expect(result).toContain('using terms: data-pipeline-api, api');
    expect(result).not.toContain('/ecs/hokusai-auth/development');
  });

  it('ranks ECS application log groups ahead of database and migration candidates', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      logGroups: [
        { logGroupName: '/aws/rds/instance/hokusai-auth-development/postgresql' },
        { logGroupName: '/aws/rds/proxy/hokusai-auth-proxy-development' },
        { logGroupName: '/ecs/hokusai-auth-migrations' },
        { logGroupName: '/ecs/hokusai-auth/development' },
      ],
    });
    mockClient(send);

    const result = await discoverLogGroupsTool.handler({ service_name: 'auth-service' }, ctx);
    const firstResultLine = result.split('\n')[1];

    expect(firstResultLine).toContain('/ecs/hokusai-auth/development');
  });

  it('paginates until it finds enough matches', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        logGroups: [{ logGroupName: '/aws/ecs/unrelated' }],
        nextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        logGroups: [
          { logGroupName: '/aws/ecs/data-pipeline-api/access' },
          { logGroupName: '/aws/ecs/data-pipeline-api/app' },
        ],
      });
    mockClient(send);

    const result = await discoverLogGroupsTool.handler(
      { service_name: 'data-pipeline-api', limit: 2 },
      ctx
    );

    expect(result).toContain('/aws/ecs/data-pipeline-api/access');
    expect(result).toContain('/aws/ecs/data-pipeline-api/app');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports no matching log groups clearly', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      logGroups: [{ logGroupName: '/aws/ecs/other-service' }],
    });
    mockClient(send);

    const result = await discoverLogGroupsTool.handler({ service_name: 'data-pipeline-api' }, ctx);

    expect(result).toContain('No CloudWatch log groups found');
    expect(result).toContain('data-pipeline-api, api');
  });

  it('validates discovery arguments via argsSchema', () => {
    expect(discoverLogGroupsTool.argsSchema.safeParse({ service_name: '' }).success).toBe(false);
    expect(
      discoverLogGroupsTool.argsSchema.safeParse({ service_name: 'data-pipeline-api' }).success
    ).toBe(true);
  });
});
