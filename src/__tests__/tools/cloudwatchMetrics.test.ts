import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  DescribeAlarmHistoryCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  metricsAndAlarmsTool,
  CloudWatchMetricsToolError,
} from '../../tools/cloudwatchMetrics.js';
import type { ToolContext } from '../../tools/types.js';

vi.mock('@aws-sdk/client-cloudwatch', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudwatch')>(
    '@aws-sdk/client-cloudwatch'
  );
  return {
    ...actual,
    CloudWatchClient: vi.fn(),
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
  namespace: 'AWS/ApplicationELB',
  metric_name: 'HTTPCode_Target_4XX_Count',
  stat: 'Sum' as const,
};

function mockClient(send: ReturnType<typeof vi.fn>): void {
  const destroy = vi.fn();
  vi.mocked(CloudWatchClient).mockImplementation(
    () => ({ send, destroy }) as unknown as CloudWatchClient
  );
}

describe('cloudwatchMetrics get_metrics_and_alarms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted datapoints sorted by timestamp', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Datapoints: [
        { Timestamp: new Date('2026-06-07T10:05:00Z'), Sum: 12, Unit: 'Count' },
        { Timestamp: new Date('2026-06-07T10:00:00Z'), Sum: 5, Unit: 'Count' },
      ],
    });
    mockClient(send);

    const result = await metricsAndAlarmsTool.handler(validArgs, ctx);

    expect(result).toContain('Metric datapoints (2)');
    expect(result).toContain('Sum=5 Count');
    expect(result).toContain('Sum=12 Count');
    // earlier timestamp should be listed before the later one
    expect(result.indexOf('10:00:00')).toBeLessThan(result.indexOf('10:05:00'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetMetricStatisticsCommand);
  });

  it('reports clearly when there are no datapoints', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Datapoints: [] });
    mockClient(send);

    const result = await metricsAndAlarmsTool.handler(validArgs, ctx);
    expect(result).toContain('No metric datapoints');
  });

  it('fetches alarm history when alarm_name is provided', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Datapoints: [] })
      .mockResolvedValueOnce({
        AlarmHistoryItems: [
          {
            Timestamp: new Date('2026-06-07T10:00:00Z'),
            HistorySummary: 'Alarm updated from OK to ALARM',
          },
        ],
      });
    mockClient(send);

    const result = await metricsAndAlarmsTool.handler(
      { ...validArgs, alarm_name: 'high-error-rate' },
      ctx
    );

    expect(result).toContain('Alarm history (1)');
    expect(result).toContain('OK to ALARM');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DescribeAlarmHistoryCommand);
  });

  it('does not query alarm history without alarm_name', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Datapoints: [] });
    mockClient(send);

    await metricsAndAlarmsTool.handler(validArgs, ctx);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('wraps AWS errors in CloudWatchMetricsToolError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttling'));
    mockClient(send);

    await expect(metricsAndAlarmsTool.handler(validArgs, ctx)).rejects.toThrow(
      CloudWatchMetricsToolError
    );
  });

  it('validates arguments via argsSchema', () => {
    expect(metricsAndAlarmsTool.argsSchema.safeParse({ namespace: 'x' }).success).toBe(false);
    expect(metricsAndAlarmsTool.argsSchema.safeParse(validArgs).success).toBe(true);
    expect(
      metricsAndAlarmsTool.argsSchema.safeParse({ ...validArgs, stat: 'Median' }).success
    ).toBe(false);
  });
});
