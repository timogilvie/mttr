import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  albAccessLogsTool,
  parseAccessLogLine,
  tokenizeAccessLogLine,
} from '../../tools/albAccessLogs.js';
import type { ToolContext } from '../../tools/types.js';

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return { ...actual, ElasticLoadBalancingV2Client: vi.fn() };
});

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return { ...actual, S3Client: vi.fn() };
});

const ctx: ToolContext = {
  region: 'us-east-1',
  maxAttempts: 3,
  timeoutMs: 20000,
  maxResultChars: 8000,
  defaultLookbackMinutes: 60,
  maxLookbackMinutes: 1440,
  defaultStartTime: '2026-06-11T14:00:00.000Z',
  defaultEndTime: '2026-06-11T16:00:00.000Z',
};

const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/hokusai-reg-api-development/def456';
const LOG_KEY =
  'AWSLogs/123456789012/elasticloadbalancing/us-east-1/2026/06/11/123456789012_elasticloadbalancing_us-east-1_app.hokusai-reg-api-development.def456_20260611T1420Z_10.0.0.1_abc.log.gz';

function logLine(
  time: string,
  elbStatus: string,
  targetStatus: string,
  method: string,
  path: string,
  errorReason = '-'
): string {
  return (
    `http ${time} app/hokusai-reg-api-development/def456 203.0.113.5:51234 10.0.1.23:3000 ` +
    `0.001 0.045 0.000 ${elbStatus} ${targetStatus} 156 312 ` +
    `"${method} https://api.example.com:443${path} HTTP/1.1" "curl/8.0 (test agent)" - - ` +
    `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/abc "Root=1-abc" ` +
    `"api.example.com" "-" 0 ${time} "forward" "-" "${errorReason}" "10.0.1.23:3000" "-" "-" "-"`
  );
}

function mockClients(options: {
  attributes?: Record<string, string>;
  keys?: { Key: string; Size?: number }[];
  body?: string;
}): { elbSend: ReturnType<typeof vi.fn>; s3Send: ReturnType<typeof vi.fn> } {
  const attributes = options.attributes ?? {
    'access_logs.s3.enabled': 'true',
    'access_logs.s3.bucket': 'alb-logs-bucket',
    'access_logs.s3.prefix': '',
  };

  const elbSend = vi.fn((command: unknown) => {
    if (command instanceof DescribeLoadBalancersCommand) {
      return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
    }
    if (command instanceof DescribeLoadBalancerAttributesCommand) {
      return Promise.resolve({
        Attributes: Object.entries(attributes).map(([Key, Value]) => ({ Key, Value })),
      });
    }
    return Promise.reject(new Error('Unexpected ELB command'));
  });

  const s3Send = vi.fn((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: options.keys ?? [] });
    }
    if (command instanceof GetObjectCommand) {
      return Promise.resolve({
        Body: {
          transformToByteArray: async (): Promise<Uint8Array> =>
            gzipSync(Buffer.from(options.body ?? '')),
        },
      });
    }
    return Promise.reject(new Error('Unexpected S3 command'));
  });

  const destroy = vi.fn();
  vi.mocked(ElasticLoadBalancingV2Client).mockImplementation(
    () => ({ send: elbSend, destroy }) as unknown as ElasticLoadBalancingV2Client
  );
  vi.mocked(S3Client).mockImplementation(() => ({ send: s3Send, destroy }) as unknown as S3Client);
  return { elbSend, s3Send };
}

describe('albAccessLogs query_alb_access_logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses the LoadBalancer dimension form and breaks down 5xx by status and path', async () => {
    const body = [
      logLine('2026-06-11T14:18:21.283340Z', '502', '-', 'POST', '/api/ingest'),
      logLine('2026-06-11T14:43:02.100000Z', '502', '-', 'POST', '/api/ingest'),
      logLine('2026-06-11T15:23:11.000000Z', '500', '500', 'GET', '/api/items'),
      logLine('2026-06-11T14:19:00.000000Z', '200', '200', 'GET', '/health'),
      // Outside the window: must be excluded.
      logLine('2026-06-11T11:00:00.000000Z', '502', '-', 'POST', '/api/ingest'),
    ].join('\n');
    const { elbSend } = mockClients({ keys: [{ Key: LOG_KEY, Size: 1000 }], body });

    const result = await albAccessLogsTool.handler(
      { load_balancer: 'app/hokusai-reg-api-development/def456', status_class: '5xx' },
      ctx
    );

    expect(elbSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeLoadBalancersCommand);
    expect(
      (elbSend.mock.calls[0]?.[0] as DescribeLoadBalancersCommand).input.Names
    ).toEqual(['hokusai-reg-api-development']);

    expect(result).toContain('4 request(s) in window, 3 matching the status filter');
    expect(result).toContain('elb_status=502 target_status=- POST /api/ingest: 2');
    expect(result).toContain('elb_status=500 target_status=500 GET /api/items: 1');
    expect(result).not.toContain('/health');
  });

  it('reports access logging disabled as an observability gap', async () => {
    mockClients({ attributes: { 'access_logs.s3.enabled': 'false' } });

    const result = await albAccessLogsTool.handler(
      { load_balancer: 'hokusai-reg-api-development' },
      ctx
    );

    expect(result).toContain('Access logging is DISABLED');
    expect(result).toContain('observability gap');
  });

  it('reports when no log files exist for the window', async () => {
    mockClients({ keys: [] });

    const result = await albAccessLogsTool.handler(
      { load_balancer: 'hokusai-reg-api-development' },
      ctx
    );

    expect(result).toContain('No access log files found for this window');
  });

  it('skips files stamped outside the window', async () => {
    const outsideKey = LOG_KEY.replace('20260611T1420Z', '20260611T0300Z');
    const { s3Send } = mockClients({ keys: [{ Key: outsideKey, Size: 1000 }] });

    await albAccessLogsTool.handler({ load_balancer: 'hokusai-reg-api-development' }, ctx);

    const getCalls = s3Send.mock.calls.filter(
      (call) => call[0] instanceof GetObjectCommand
    );
    expect(getCalls).toHaveLength(0);
  });

  it('validates arguments via argsSchema', () => {
    expect(albAccessLogsTool.argsSchema.safeParse({ load_balancer: '' }).success).toBe(false);
    expect(
      albAccessLogsTool.argsSchema.safeParse({ load_balancer: 'x', status_class: 'banana' }).success
    ).toBe(false);
    expect(
      albAccessLogsTool.argsSchema.safeParse({ load_balancer: 'x', status_class: '5xx' }).success
    ).toBe(true);
  });
});

describe('albAccessLogs line parsing', () => {
  it('tokenizes quoted fields containing spaces', () => {
    const tokens = tokenizeAccessLogLine('a "b c" d "e f g" h');
    expect(tokens).toEqual(['a', 'b c', 'd', 'e f g', 'h']);
  });

  it('parses status, method, path, target, and error reason from a full line', () => {
    const entry = parseAccessLogLine(
      logLine('2026-06-11T14:18:21.283340Z', '502', '-', 'POST', '/api/ingest?limit=5', 'TargetClosedConnection')
    );

    expect(entry).not.toBeNull();
    expect(entry?.time.toISOString()).toBe('2026-06-11T14:18:21.283Z');
    expect(entry?.elbStatus).toBe('502');
    expect(entry?.targetStatus).toBe('-');
    expect(entry?.method).toBe('POST');
    expect(entry?.path).toBe('/api/ingest');
    expect(entry?.target).toBe('10.0.1.23:3000');
    expect(entry?.errorReason).toBe('TargetClosedConnection');
  });

  it('returns null for malformed lines', () => {
    expect(parseAccessLogLine('garbage')).toBeNull();
    expect(parseAccessLogLine('http not-a-date elb')).toBeNull();
  });
});
