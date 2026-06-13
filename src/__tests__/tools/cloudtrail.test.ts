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
});
