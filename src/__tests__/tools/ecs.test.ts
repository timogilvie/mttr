import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';
import { ecsServiceEventsTool, resolveServiceLogGroups } from '../../tools/ecs.js';
import type { ToolContext } from '../../tools/types.js';

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn(),
  };
});

const ctx: ToolContext = {
  region: 'us-east-1',
  maxAttempts: 3,
  timeoutMs: 2000,
  maxResultChars: 8000,
  defaultLookbackMinutes: 60,
  maxLookbackMinutes: 1440,
  defaultStartTime: '2026-06-11T14:00:00.000Z',
  defaultEndTime: '2026-06-11T16:00:00.000Z',
};

const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/hokusai-development';
const SERVICE_ARN =
  'arn:aws:ecs:us-east-1:123456789012:service/hokusai-development/hokusai-reg-api-development';
const TASK_DEFINITION_ARN =
  'arn:aws:ecs:us-east-1:123456789012:task-definition/hokusai-reg-api:42';

interface CommandResponses {
  listClusters?: unknown;
  listServices?: unknown;
  describeServices?: unknown;
  listTasks?: unknown;
  describeTasks?: unknown;
  describeTaskDefinition?: unknown;
}

function mockClient(responses: CommandResponses): ReturnType<typeof vi.fn> {
  const send = vi.fn((command: unknown) => {
    if (command instanceof ListClustersCommand) {
      return Promise.resolve(responses.listClusters ?? { clusterArns: [CLUSTER_ARN] });
    }
    if (command instanceof ListServicesCommand) {
      return Promise.resolve(responses.listServices ?? { serviceArns: [SERVICE_ARN] });
    }
    if (command instanceof DescribeServicesCommand) {
      return Promise.resolve(responses.describeServices ?? { services: [] });
    }
    if (command instanceof ListTasksCommand) {
      return Promise.resolve(responses.listTasks ?? { taskArns: [] });
    }
    if (command instanceof DescribeTasksCommand) {
      return Promise.resolve(responses.describeTasks ?? { tasks: [] });
    }
    if (command instanceof DescribeTaskDefinitionCommand) {
      return Promise.resolve(responses.describeTaskDefinition ?? {});
    }
    return Promise.reject(new Error(`Unexpected command: ${String(command)}`));
  });
  const destroy = vi.fn();
  vi.mocked(ECSClient).mockImplementation(() => ({ send, destroy }) as unknown as ECSClient);
  return send;
}

describe('ecs get_ecs_service_events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports service status, deployments, in-window events, and stopped tasks', async () => {
    mockClient({
      describeServices: {
        services: [
          {
            serviceName: 'hokusai-reg-api-development',
            status: 'ACTIVE',
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            taskDefinition: TASK_DEFINITION_ARN,
            deployments: [
              {
                status: 'PRIMARY',
                taskDefinition: TASK_DEFINITION_ARN,
                rolloutState: 'COMPLETED',
                createdAt: new Date('2026-06-11T14:15:00Z'),
                updatedAt: new Date('2026-06-11T14:25:00Z'),
                desiredCount: 2,
                runningCount: 2,
                failedTasks: 0,
              },
            ],
            events: [
              {
                createdAt: new Date('2026-06-11T14:20:00Z'),
                message: '(service hokusai-reg-api-development) has started 1 tasks.',
              },
              {
                createdAt: new Date('2026-06-10T09:00:00Z'),
                message: 'old event outside window',
              },
            ],
          },
        ],
      },
      listTasks: { taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/hokusai-development/abc'] },
      describeTasks: {
        tasks: [
          {
            taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/hokusai-development/abc',
            taskDefinitionArn: TASK_DEFINITION_ARN,
            startedAt: new Date('2026-06-11T12:00:00Z'),
            stoppedAt: new Date('2026-06-11T14:19:00Z'),
            stopCode: 'TaskFailedToStart',
            stoppedReason: 'OutOfMemoryError: Container killed due to memory usage',
            containers: [{ name: 'api', exitCode: 137, reason: 'OutOfMemoryError' }],
          },
        ],
      },
    });

    const result = await ecsServiceEventsTool.handler(
      { service_name: 'hokusai-reg-api-development' },
      ctx
    );

    expect(result).toContain('status=ACTIVE desired=2 running=2 pending=0');
    expect(result).toContain('taskDefinition=hokusai-reg-api:42');
    expect(result).toContain('PRIMARY taskDefinition=hokusai-reg-api:42 rolloutState=COMPLETED');
    expect(result).toContain('has started 1 tasks');
    expect(result).not.toContain('old event outside window');
    expect(result).toContain('Stopped tasks in window');
    expect(result).toContain('stopCode=TaskFailedToStart');
    expect(result).toContain('exitCode=137');
  });

  it('reports when no services match', async () => {
    mockClient({ listServices: { serviceArns: ['arn:aws:ecs:us-east-1:1:service/c/unrelated'] } });

    const result = await ecsServiceEventsTool.handler({ service_name: 'deltaone-anomaly' }, ctx);

    expect(result).toContain('No ECS services found matching "deltaone-anomaly"');
  });

  it('shows most recent events for context when none fall in the window', async () => {
    mockClient({
      describeServices: {
        services: [
          {
            serviceName: 'hokusai-reg-api-development',
            status: 'ACTIVE',
            events: [{ createdAt: new Date('2026-06-01T00:00:00Z'), message: 'steady state' }],
          },
        ],
      },
    });

    const result = await ecsServiceEventsTool.handler(
      { service_name: 'hokusai-reg-api-development' },
      ctx
    );

    expect(result).toContain('none in the requested window');
    expect(result).toContain('steady state');
    expect(result).toContain('Stopped tasks: none found.');
  });

  it('validates arguments via argsSchema', () => {
    expect(ecsServiceEventsTool.argsSchema.safeParse({ service_name: '' }).success).toBe(false);
    expect(
      ecsServiceEventsTool.argsSchema.safeParse({ service_name: 'data-pipeline-api' }).success
    ).toBe(true);
  });
});

describe('ecs resolveServiceLogGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves awslogs groups from matching task definitions', async () => {
    mockClient({
      describeServices: {
        services: [
          { serviceName: 'hokusai-reg-api-development', taskDefinition: TASK_DEFINITION_ARN },
        ],
      },
      describeTaskDefinition: {
        taskDefinition: {
          containerDefinitions: [
            {
              name: 'api',
              logConfiguration: {
                logDriver: 'awslogs',
                options: { 'awslogs-group': '/ecs/hokusai-api-development' },
              },
            },
            {
              name: 'sidecar',
              logConfiguration: { logDriver: 'fluentd', options: {} },
            },
          ],
        },
      },
    });

    const groups = await resolveServiceLogGroups('hokusai-reg-api-development', ctx);

    expect(groups).toEqual([
      {
        logGroup: '/ecs/hokusai-api-development',
        serviceName: 'hokusai-reg-api-development',
        containerName: 'api',
      },
    ]);
  });

  it('returns an empty list when no services match', async () => {
    mockClient({ listServices: { serviceArns: [] } });

    const groups = await resolveServiceLogGroups('deltaone-anomaly-detection', ctx);

    expect(groups).toEqual([]);
  });
});
