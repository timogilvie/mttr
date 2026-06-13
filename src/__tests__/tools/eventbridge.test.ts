import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventBridgeClient,
  DescribeRuleCommand,
  ListTargetsByRuleCommand,
} from '@aws-sdk/client-eventbridge';
import { eventBridgeRuleTool, EventBridgeToolError } from '../../tools/eventbridge.js';
import type { ToolContext } from '../../tools/types.js';

vi.mock('@aws-sdk/client-eventbridge', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-eventbridge')>(
    '@aws-sdk/client-eventbridge'
  );
  return {
    ...actual,
    EventBridgeClient: vi.fn(),
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
  vi.mocked(EventBridgeClient).mockImplementation(
    () => ({ send, destroy }) as unknown as EventBridgeClient
  );
}

describe('eventbridge get_eventbridge_rule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rule details and targets', async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof DescribeRuleCommand) {
        return Promise.resolve({
          Name: 'detector-schedule',
          Arn: 'arn:aws:events:us-east-1:123:rule/detector-schedule',
          State: 'ENABLED',
          ScheduleExpression: 'rate(1 minute)',
          EventBusName: 'default',
        });
      }
      if (command instanceof ListTargetsByRuleCommand) {
        return Promise.resolve({
          Targets: [
            {
              Id: 'lambda-target',
              Arn: 'arn:aws:lambda:us-east-1:123:function:detector',
              Input: '{"range":"latest"}',
              RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
              DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:123:dlq' },
            },
          ],
        });
      }
      return Promise.reject(new Error('unexpected command'));
    });
    mockClient(send);

    const result = await eventBridgeRuleTool.handler({ rule_name: 'detector-schedule' }, ctx);

    expect(result).toContain('state=ENABLED');
    expect(result).toContain('scheduleExpression=rate(1 minute)');
    expect(result).toContain('targetId=lambda-target');
    expect(result).toContain('retryPolicy(maxAgeSeconds=3600, maxAttempts=2)');
    expect(result).toContain('deadLetterArn=arn:aws:sqs:us-east-1:123:dlq');
  });

  it('wraps AWS errors in EventBridgeToolError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('not found'));
    mockClient(send);

    await expect(eventBridgeRuleTool.handler({ rule_name: 'missing' }, ctx)).rejects.toThrow(
      EventBridgeToolError
    );
  });

  it('validates arguments via argsSchema', () => {
    expect(eventBridgeRuleTool.argsSchema.safeParse({ rule_name: '' }).success).toBe(false);
    expect(eventBridgeRuleTool.argsSchema.safeParse({ rule_name: 'rule' }).success).toBe(true);
  });
});
