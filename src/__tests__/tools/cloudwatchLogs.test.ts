import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { queryLogsTool, CloudWatchLogsToolError } from '../../tools/cloudwatchLogs.js';
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
