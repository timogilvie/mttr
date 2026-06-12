import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudWatchClient, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { listMetricsTool, ListMetricsToolError } from '../../tools/listMetrics.js';
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

function mockClient(send: ReturnType<typeof vi.fn>): void {
  const destroy = vi.fn();
  vi.mocked(CloudWatchClient).mockImplementation(
    () => ({ send, destroy }) as unknown as CloudWatchClient
  );
}

describe('listMetrics list_metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists metrics for an exact namespace', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Metrics: [
        {
          Namespace: 'Hokusai/Detectors',
          MetricName: 'DetectorLiveness',
          Dimensions: [{ Name: 'Detector', Value: 'deltaone-anomaly-detection' }],
        },
      ],
    });
    mockClient(send);

    const result = await listMetricsTool.handler({ namespace: 'Hokusai/Detectors' }, ctx);

    expect(result).toContain('Found 1 metric(s)');
    expect(result).toContain(
      'namespace=Hokusai/Detectors, metric=DetectorLiveness, dimensions=[Detector=deltaone-anomaly-detection]'
    );
    const command = send.mock.calls[0]?.[0] as ListMetricsCommand;
    expect(command.input.Namespace).toBe('Hokusai/Detectors');
  });

  it('filters by search terms across namespace, name, and dimension values', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Metrics: [
        {
          Namespace: 'Hokusai/Detectors',
          MetricName: 'DetectorLiveness',
          Dimensions: [{ Name: 'Detector', Value: 'deltaone-anomaly-detection' }],
        },
        {
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'RequestCount',
          Dimensions: [{ Name: 'LoadBalancer', Value: 'app/other/123' }],
        },
      ],
    });
    mockClient(send);

    const result = await listMetricsTool.handler({ search: 'deltaone-anomaly-detection' }, ctx);

    expect(result).toContain('DetectorLiveness');
    expect(result).not.toContain('RequestCount');
  });

  it('paginates until the limit is reached', async () => {
    const metric = (name: string) => ({
      Namespace: 'Custom',
      MetricName: name,
      Dimensions: [],
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Metrics: [metric('a')], NextToken: 'next' })
      .mockResolvedValueOnce({ Metrics: [metric('b')] });
    mockClient(send);

    const result = await listMetricsTool.handler({ namespace: 'Custom' }, ctx);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toContain('Found 2 metric(s)');
  });

  it('explains the two-week visibility caveat when nothing matches', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Metrics: [] });
    mockClient(send);

    const result = await listMetricsTool.handler({ search: 'missing-service' }, ctx);

    expect(result).toContain('No CloudWatch metrics found');
    expect(result).toContain('past two weeks');
  });

  it('wraps AWS errors in ListMetricsToolError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    mockClient(send);

    await expect(listMetricsTool.handler({ namespace: 'Custom' }, ctx)).rejects.toThrow(
      ListMetricsToolError
    );
  });

  it('requires at least one of namespace, metric_name, or search', () => {
    expect(listMetricsTool.argsSchema.safeParse({}).success).toBe(false);
    expect(listMetricsTool.argsSchema.safeParse({ search: 'svc' }).success).toBe(true);
    expect(listMetricsTool.argsSchema.safeParse({ namespace: 'AWS/Lambda' }).success).toBe(true);
    expect(listMetricsTool.argsSchema.safeParse({ metric_name: 'Errors' }).success).toBe(true);
  });
});
