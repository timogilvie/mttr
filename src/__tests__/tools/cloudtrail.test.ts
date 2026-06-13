import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { cloudTrailLookupTool, CloudTrailToolError } from '../../tools/cloudtrail.js';
import type { ToolContext } from '../../tools/types.js';

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
  defaultStartTime: '2026-06-12T13:00:00.000Z',
  defaultEndTime: '2026-06-12T14:00:00.000Z',
};

function mockClient(send: ReturnType<typeof vi.fn>): void {
  const destroy = vi.fn();
  vi.mocked(CloudTrailClient).mockImplementation(
    () => ({ send, destroy }) as unknown as CloudTrailClient
  );
}

describe('cloudtrail lookup_cloudtrail_events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('looks up resource events over the report window and filters by event name', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:45:00Z'),
          EventName: 'UpdateFunctionCode',
          EventSource: 'lambda.amazonaws.com',
          Username: 'ci-role',
          Resources: [
            {
              ResourceType: 'AWS::Lambda::Function',
              ResourceName: 'detector',
            },
          ],
          CloudTrailEvent: JSON.stringify({
            userIdentity: { type: 'AssumedRole' },
            sourceIPAddress: '1.2.3.4',
          }),
        },
        {
          EventTime: new Date('2026-06-12T13:50:00Z'),
          EventName: 'TagResource',
          EventSource: 'lambda.amazonaws.com',
          Resources: [{ ResourceName: 'detector' }],
        },
      ],
    });
    mockClient(send);

    const result = await cloudTrailLookupTool.handler(
      {
        resource_name: 'detector',
        event_names: ['UpdateFunctionCode'],
      },
      ctx
    );

    const command = send.mock.calls[0]?.[0] as LookupEventsCommand;
    expect(command.input.StartTime?.toISOString()).toBe('2026-06-12T13:00:00.000Z');
    expect(command.input.EndTime?.toISOString()).toBe('2026-06-12T14:00:00.000Z');
    expect(command.input.LookupAttributes).toEqual([
      { AttributeKey: 'ResourceName', AttributeValue: 'detector' },
    ]);
    expect(result).toContain('UpdateFunctionCode');
    expect(result).toContain('identityType=AssumedRole');
    expect(result).not.toContain('TagResource');
  });

  it('supports explicit lookup attributes', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Events: [] });
    mockClient(send);

    await cloudTrailLookupTool.handler(
      {
        attribute_key: 'EventName',
        attribute_value: 'UpdateFunctionConfiguration',
        start_time: '2026-06-12T12:00:00Z',
        end_time: '2026-06-12T13:00:00Z',
      },
      ctx
    );

    const command = send.mock.calls[0]?.[0] as LookupEventsCommand;
    expect(command.input.LookupAttributes).toEqual([
      { AttributeKey: 'EventName', AttributeValue: 'UpdateFunctionConfiguration' },
    ]);
  });

  it('rejects unpaired lookup attributes', async () => {
    await expect(
      cloudTrailLookupTool.handler({ attribute_key: 'EventName' }, ctx)
    ).rejects.toThrow(CloudTrailToolError);
  });

  it('validates arguments via argsSchema', () => {
    expect(
      cloudTrailLookupTool.argsSchema.safeParse({ attribute_key: 'Unsupported' }).success
    ).toBe(false);
    expect(
      cloudTrailLookupTool.argsSchema.safeParse({
        attribute_key: 'EventName',
        attribute_value: 'UpdateFunctionCode',
      }).success
    ).toBe(true);
  });

  it('includes safe IAM PutRolePolicy policy details by default', async () => {
    const policy = encodeURIComponent(
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowSchedule',
            Effect: 'Allow',
            Action: ['events:PutRule', 'events:PutTargets'],
            Resource: 'arn:aws:events:us-east-1:123456789012:rule/detector',
          },
        ],
      })
    );
    const send = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:51:00Z'),
          EventName: 'PutRolePolicy',
          EventSource: 'iam.amazonaws.com',
          Username: 'GitHubActions',
          Resources: [{ ResourceType: 'AWS::IAM::Role', ResourceName: 'detector-role' }],
          CloudTrailEvent: JSON.stringify({
            eventSource: 'iam.amazonaws.com',
            eventName: 'PutRolePolicy',
            userIdentity: { type: 'AssumedRole' },
            requestParameters: {
              roleName: 'detector-role',
              policyName: 'allow-events-update',
              policyDocument: policy,
            },
          }),
        },
      ],
    });
    mockClient(send);

    const result = await cloudTrailLookupTool.handler({ event_names: ['PutRolePolicy'] }, ctx);

    expect(result).toContain('policyName=allow-events-update');
    expect(result).toContain('roleName=detector-role');
    expect(result).toContain('actions=[events:PutRule, events:PutTargets]');
    expect(result).toContain(
      'resources=[arn:aws:events:us-east-1:123456789012:rule/detector]'
    );
    expect(result).not.toContain('%7B');
    expect(result).not.toContain('"Statement"');
  });

  it('includes allowlisted Lambda update details', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:40:00Z'),
          EventName: 'UpdateFunctionConfiguration',
          EventSource: 'lambda.amazonaws.com',
          Username: 'ci-role',
          Resources: [{ ResourceType: 'AWS::Lambda::Function', ResourceName: 'detector' }],
          CloudTrailEvent: JSON.stringify({
            eventSource: 'lambda.amazonaws.com',
            eventName: 'UpdateFunctionConfiguration',
            requestParameters: {
              functionName: 'detector',
              runtime: 'nodejs22.x',
              timeout: 30,
              environment: {
                variables: {
                  LOG_LEVEL: 'debug',
                  API_TOKEN: 'super-secret-token',
                },
              },
            },
          }),
        },
      ],
    });
    mockClient(send);

    const result = await cloudTrailLookupTool.handler(
      { event_names: ['UpdateFunctionConfiguration'] },
      ctx
    );

    expect(result).toContain('functionName=detector');
    expect(result).toContain('runtime=nodejs22.x');
    expect(result).toContain('timeout=30');
    expect(result).toContain('"API_TOKEN":"[redacted]"');
    expect(result).not.toContain('super-secret-token');
  });

  it('redacts secret-like EventBridge target input details', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:49:00Z'),
          EventName: 'PutTargets',
          EventSource: 'events.amazonaws.com',
          Username: 'GitHubActions',
          CloudTrailEvent: JSON.stringify({
            eventSource: 'events.amazonaws.com',
            eventName: 'PutTargets',
            requestParameters: {
              rule: 'detector-schedule',
              targets: [
                {
                  id: 'detector',
                  arn: 'arn:aws:lambda:us-east-1:123456789012:function:detector',
                  input: JSON.stringify({
                    detector: 'deltaone',
                    password: 'do-not-emit',
                    nested: { apiKey: 'also-secret' },
                  }),
                },
              ],
            },
          }),
        },
      ],
    });
    mockClient(send);

    const result = await cloudTrailLookupTool.handler({ event_names: ['PutTargets'] }, ctx);

    expect(result).toContain('rule=detector-schedule');
    expect(result).toContain('"detector":"deltaone"');
    expect(result).toContain('"password":"[redacted]"');
    expect(result).toContain('"apiKey":"[redacted]"');
    expect(result).not.toContain('do-not-emit');
    expect(result).not.toContain('also-secret');
  });

  it('keeps malformed CloudTrailEvent JSON events without details', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:55:00Z'),
          EventName: 'PutRolePolicy',
          EventSource: 'iam.amazonaws.com',
          Username: 'GitHubActions',
          CloudTrailEvent: '{not-json',
        },
      ],
    });
    mockClient(send);

    const result = await cloudTrailLookupTool.handler({ event_names: ['PutRolePolicy'] }, ctx);

    expect(result).toContain('PutRolePolicy');
    expect(result).toContain('identityType=unknown');
    expect(result).not.toContain('details=[');
  });

  it('redacts secret values and supports disabling details', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:42:00Z'),
          EventName: 'PutParameter',
          EventSource: 'ssm.amazonaws.com',
          Username: 'ci-role',
          CloudTrailEvent: JSON.stringify({
            eventSource: 'ssm.amazonaws.com',
            eventName: 'PutParameter',
            requestParameters: {
              name: '/detector/password',
              type: 'SecureString',
              value: 'plain-secret',
              keyId: 'alias/detector',
            },
            responseElements: {
              version: 7,
            },
          }),
        },
      ],
    });
    mockClient(send);

    const result = await cloudTrailLookupTool.handler({ event_names: ['PutParameter'] }, ctx);

    expect(result).toContain('name=/detector/password');
    expect(result).toContain('type=SecureString');
    expect(result).toContain('value=redacted');
    expect(result).toContain('version=7');
    expect(result).not.toContain('plain-secret');

    const offSend = vi.fn().mockResolvedValueOnce({
      Events: [
        {
          EventTime: new Date('2026-06-12T13:42:00Z'),
          EventName: 'PutParameter',
          EventSource: 'ssm.amazonaws.com',
          Username: 'ci-role',
          CloudTrailEvent: JSON.stringify({
            eventSource: 'ssm.amazonaws.com',
            eventName: 'PutParameter',
            requestParameters: { name: '/detector/password', value: 'plain-secret' },
          }),
        },
      ],
    });
    mockClient(offSend);

    const terse = await cloudTrailLookupTool.handler(
      { event_names: ['PutParameter'], detail_mode: 'off' },
      ctx
    );

    expect(terse).not.toContain('details=[');
    expect(terse).not.toContain('plain-secret');
  });
});
