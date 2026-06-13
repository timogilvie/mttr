import {
  EventBridgeClient,
  DescribeRuleCommand,
  ListTargetsByRuleCommand,
  type Target,
} from '@aws-sdk/client-eventbridge';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class EventBridgeToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'EventBridgeToolError';
  }
}

const MAX_TARGETS = 20;

const argsSchema = z.object({
  rule_name: z.string().min(1),
  event_bus_name: z.string().min(1).optional(),
});

type EventBridgeRuleArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    rule_name: {
      type: 'string',
      description:
        'EventBridge rule name, e.g. "hokusai-deltaone-anomaly-detector-schedule-development".',
    },
    event_bus_name: {
      type: 'string',
      description: 'Optional event bus name. Omit for the default event bus.',
    },
  },
  required: ['rule_name'],
} as const;

function truncateValue(value: string | undefined, maxChars: number): string {
  if (!value) {
    return 'n/a';
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}

function formatTarget(target: Target): string {
  const parts = [
    `targetId=${target.Id ?? 'unknown'}`,
    `arn=${target.Arn ?? 'unknown'}`,
  ];
  if (target.RoleArn) {
    parts.push(`roleArn=${target.RoleArn}`);
  }
  if (target.RetryPolicy) {
    parts.push(
      `retryPolicy(maxAgeSeconds=${target.RetryPolicy.MaximumEventAgeInSeconds ?? 'n/a'}, maxAttempts=${target.RetryPolicy.MaximumRetryAttempts ?? 'n/a'})`
    );
  }
  if (target.DeadLetterConfig?.Arn) {
    parts.push(`deadLetterArn=${target.DeadLetterConfig.Arn}`);
  }
  if (target.Input !== undefined) {
    parts.push(`input=${truncateValue(target.Input, 500)}`);
  }
  if (target.InputPath !== undefined) {
    parts.push(`inputPath=${target.InputPath}`);
  }
  if (target.InputTransformer) {
    parts.push('inputTransformer=present');
  }
  return parts.join(' ');
}

async function handler(args: EventBridgeRuleArgs, ctx: ToolContext): Promise<string> {
  const client = new EventBridgeClient({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });

  try {
    const rule = await client.send(
      new DescribeRuleCommand({
        Name: args.rule_name,
        EventBusName: args.event_bus_name,
      })
    );
    const targets = await client.send(
      new ListTargetsByRuleCommand({
        Rule: args.rule_name,
        EventBusName: args.event_bus_name,
        Limit: MAX_TARGETS,
      })
    );

    const sections = [
      [
        `rule=${rule.Name ?? args.rule_name}`,
        `arn=${rule.Arn ?? 'unknown'}`,
        `state=${rule.State ?? 'unknown'}`,
        `eventBusName=${rule.EventBusName ?? args.event_bus_name ?? 'default'}`,
        `scheduleExpression=${rule.ScheduleExpression ?? 'n/a'}`,
        `eventPattern=${truncateValue(rule.EventPattern, 500)}`,
        `roleArn=${rule.RoleArn ?? 'n/a'}`,
        `description=${rule.Description ?? 'n/a'}`,
      ].join('\n'),
    ];

    const targetLines = (targets.Targets ?? []).map(formatTarget);
    sections.push(
      targetLines.length === 0
        ? 'Targets: none found.'
        : `Targets (showing ${targetLines.length}):\n${targetLines.join('\n')}`
    );
    return sections.join('\n\n');
  } catch (error) {
    throw new EventBridgeToolError(
      `get_eventbridge_rule failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export const eventBridgeRuleTool: ToolDefinition<EventBridgeRuleArgs> = {
  name: 'get_eventbridge_rule',
  description:
    'Read-only: fetch an EventBridge rule schedule/pattern, state, role, targets, target input, retry policy, and DLQ configuration for schedule-driven workloads.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
