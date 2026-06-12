import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  DescribeAlarmsForMetricCommand,
} from '@aws-sdk/client-cloudwatch';
import { findAlarmsTool, FindAlarmsToolError } from '../../tools/alarms.js';
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

describe('alarms find_alarms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('describes alarms watching an exact metric', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      MetricAlarms: [
        {
          AlarmName: 'detector-liveness-missing',
          StateValue: 'ALARM',
          StateUpdatedTimestamp: new Date('2026-06-06T10:00:00Z'),
          Namespace: 'Hokusai/Detectors',
          MetricName: 'DetectorLiveness',
          Statistic: 'Sum',
          ComparisonOperator: 'LessThanThreshold',
          Threshold: 1,
          TreatMissingData: 'breaching',
          ActionsEnabled: true,
        },
      ],
    });
    mockClient(send);

    const result = await findAlarmsTool.handler(
      {
        namespace: 'Hokusai/Detectors',
        metric_name: 'DetectorLiveness',
        dimensions: [{ name: 'Detector', value: 'deltaone-anomaly-detection' }],
      },
      ctx
    );

    expect(result).toContain('Found 1 alarm(s) watching metric Hokusai/Detectors/DetectorLiveness');
    expect(result).toContain('alarm=detector-liveness-missing');
    expect(result).toContain('state=ALARM');
    expect(result).toContain('condition=LessThanThreshold 1');
    expect(result).toContain('treatMissingData=breaching');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeAlarmsForMetricCommand);
  });

  it('states plainly when a metric has no alarm coverage', async () => {
    const send = vi.fn().mockResolvedValueOnce({ MetricAlarms: [] });
    mockClient(send);

    const result = await findAlarmsTool.handler(
      { namespace: 'Hokusai/Detectors', metric_name: 'DetectorLiveness' },
      ctx
    );

    expect(result).toContain('No alarms found watching metric');
    expect(result).toContain('no alarm coverage');
    expect(result).toContain('exact dimensions');
  });

  it('searches all alarms by service terms', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      MetricAlarms: [
        {
          AlarmName: 'deltaone-detector-errors',
          StateValue: 'OK',
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
        },
        {
          AlarmName: 'unrelated-alb-alarm',
          StateValue: 'OK',
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'HTTPCode_Target_5XX_Count',
        },
      ],
      CompositeAlarms: [
        { AlarmName: 'deltaone-rollup', StateValue: 'OK' },
      ],
    });
    mockClient(send);

    const result = await findAlarmsTool.handler({ search: 'deltaone-anomaly-detection' }, ctx);

    expect(result).toContain('deltaone-detector-errors');
    expect(result).toContain('deltaone-rollup (composite)');
    expect(result).not.toContain('unrelated-alb-alarm');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeAlarmsCommand);
  });

  it('reports no matches for a search clearly', async () => {
    const send = vi.fn().mockResolvedValueOnce({ MetricAlarms: [], CompositeAlarms: [] });
    mockClient(send);

    const result = await findAlarmsTool.handler({ search: 'deltaone-anomaly-detection' }, ctx);

    expect(result).toContain('No alarms found');
    expect(result).toContain('No alarm coverage matches this search');
  });

  it('wraps AWS errors in FindAlarmsToolError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttling'));
    mockClient(send);

    await expect(findAlarmsTool.handler({ search: 'svc' }, ctx)).rejects.toThrow(
      FindAlarmsToolError
    );
  });

  it('requires search, alarm_name_prefix, or a namespace + metric_name pair', () => {
    expect(findAlarmsTool.argsSchema.safeParse({}).success).toBe(false);
    expect(findAlarmsTool.argsSchema.safeParse({ namespace: 'AWS/Lambda' }).success).toBe(false);
    expect(
      findAlarmsTool.argsSchema.safeParse({ namespace: 'AWS/Lambda', metric_name: 'Errors' })
        .success
    ).toBe(true);
    expect(findAlarmsTool.argsSchema.safeParse({ search: 'svc' }).success).toBe(true);
    expect(findAlarmsTool.argsSchema.safeParse({ alarm_name_prefix: 'deltaone-' }).success).toBe(
      true
    );
  });
});
