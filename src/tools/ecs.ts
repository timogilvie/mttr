import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  type Service,
  type Task,
} from '@aws-sdk/client-ecs';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveToolTimeRange } from './types.js';
import { serviceSearchTerms } from './serviceNames.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class EcsToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'EcsToolError';
  }
}

const MAX_CLUSTERS = 10;
const MAX_SERVICE_PAGES_PER_CLUSTER = 3;
const MAX_MATCHED_SERVICES = 3;
const MAX_EVENTS = 20;
const MAX_RECENT_EVENTS_FALLBACK = 5;
const MAX_STOPPED_TASKS_DESCRIBED = 20;
const MAX_STOPPED_TASKS_SHOWN = 10;

const argsSchema = z.object({
  service_name: z.string().min(1),
  cluster: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  lookback_minutes: z.number().optional(),
});

type EcsServiceEventsArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    service_name: {
      type: 'string',
      description: 'ECS service name or distinctive substring, e.g. "data-pipeline-api".',
    },
    cluster: {
      type: 'string',
      description: 'Optional ECS cluster name or substring to restrict the search.',
    },
    lookback_minutes: {
      type: 'number',
      description:
        'Fallback relative lookback in minutes. Ignored when start_time and end_time are supplied or a report window is available.',
    },
    start_time: {
      type: 'string',
      description: 'Optional absolute window start as an ISO timestamp. Must be paired with end_time.',
    },
    end_time: {
      type: 'string',
      description: 'Optional absolute window end as an ISO timestamp. Must be paired with start_time.',
    },
  },
  required: ['service_name'],
} as const;

interface MatchedService {
  clusterArn: string;
  clusterName: string;
  serviceArn: string;
  serviceName: string;
  score: number;
}

function arnSuffix(arn: string): string {
  const lastSlash = arn.lastIndexOf('/');
  return lastSlash >= 0 ? arn.slice(lastSlash + 1) : arn;
}

function scoreServiceName(name: string, fullName: string, terms: string[]): number {
  const lower = name.toLowerCase();
  let score = 0;
  if (lower === fullName) {
    score += 10;
  }
  if (lower.includes(fullName)) {
    score += 5;
  }
  score += terms.filter((term) => lower.includes(term)).length;
  return score;
}

function createClient(ctx: ToolContext): ECSClient {
  return new ECSClient({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });
}

async function findMatchingServices(
  client: ECSClient,
  serviceName: string,
  clusterFilter?: string
): Promise<MatchedService[]> {
  const fullName = serviceName.toLowerCase();
  const terms = serviceSearchTerms(serviceName);
  const clusterTerm = clusterFilter?.toLowerCase();

  const clustersResponse = await client.send(new ListClustersCommand({ maxResults: 100 }));
  const clusterArns = (clustersResponse.clusterArns ?? [])
    .filter((arn) => !clusterTerm || arn.toLowerCase().includes(clusterTerm))
    .slice(0, MAX_CLUSTERS);

  const matches: MatchedService[] = [];
  for (const clusterArn of clusterArns) {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const response = await client.send(
        new ListServicesCommand({ cluster: clusterArn, maxResults: 100, nextToken })
      );
      for (const serviceArn of response.serviceArns ?? []) {
        const name = arnSuffix(serviceArn);
        const score = scoreServiceName(name, fullName, terms);
        if (score > 0) {
          matches.push({
            clusterArn,
            clusterName: arnSuffix(clusterArn),
            serviceArn,
            serviceName: name,
            score,
          });
        }
      }
      nextToken = response.nextToken;
      pages += 1;
    } while (nextToken && pages < MAX_SERVICE_PAGES_PER_CLUSTER);
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, MAX_MATCHED_SERVICES);
}

function taskDefinitionLabel(arn: string | undefined): string {
  if (!arn) {
    return 'unknown';
  }
  return arnSuffix(arn.replace(/^.*task-definition\//, ''));
}

function formatDeployments(service: Service): string[] {
  const deployments = service.deployments ?? [];
  if (deployments.length === 0) {
    return ['Deployments: none reported.'];
  }
  const lines = deployments.map((deployment) => {
    const parts = [
      `${deployment.status ?? 'UNKNOWN'} taskDefinition=${taskDefinitionLabel(deployment.taskDefinition)}`,
    ];
    if (deployment.rolloutState) {
      parts.push(`rolloutState=${deployment.rolloutState}`);
    }
    if (deployment.rolloutStateReason) {
      parts.push(`reason="${deployment.rolloutStateReason}"`);
    }
    if (deployment.createdAt) {
      parts.push(`createdAt=${deployment.createdAt.toISOString()}`);
    }
    if (deployment.updatedAt) {
      parts.push(`updatedAt=${deployment.updatedAt.toISOString()}`);
    }
    parts.push(
      `desired=${deployment.desiredCount ?? 'n/a'} running=${deployment.runningCount ?? 'n/a'} failed=${deployment.failedTasks ?? 'n/a'}`
    );
    return `  ${parts.join(' ')}`;
  });
  return ['Deployments:', ...lines];
}

function formatEvents(service: Service, startTime: Date, endTime: Date): string[] {
  const events = service.events ?? [];
  const inWindow = events.filter((event) => {
    const at = event.createdAt?.getTime();
    return at !== undefined && at >= startTime.getTime() && at <= endTime.getTime();
  });

  if (inWindow.length > 0) {
    const shown = inWindow.slice(0, MAX_EVENTS);
    const lines = shown.map(
      (event) => `  ${event.createdAt?.toISOString() ?? 'unknown'}: ${event.message ?? ''}`
    );
    return [`Service events in window (showing ${shown.length} of ${inWindow.length}):`, ...lines];
  }

  const recent = events.slice(0, MAX_RECENT_EVENTS_FALLBACK);
  if (recent.length === 0) {
    return ['Service events: none recorded.'];
  }
  const lines = recent.map(
    (event) => `  ${event.createdAt?.toISOString() ?? 'unknown'}: ${event.message ?? ''}`
  );
  return [
    `Service events: none in the requested window; ${recent.length} most recent shown for context:`,
    ...lines,
  ];
}

function formatStoppedTask(task: Task): string {
  const parts = [`task ${arnSuffix(task.taskArn ?? 'unknown')}`];
  parts.push(`taskDefinition=${taskDefinitionLabel(task.taskDefinitionArn)}`);
  if (task.startedAt) {
    parts.push(`startedAt=${task.startedAt.toISOString()}`);
  }
  if (task.stoppedAt) {
    parts.push(`stoppedAt=${task.stoppedAt.toISOString()}`);
  }
  if (task.stopCode) {
    parts.push(`stopCode=${task.stopCode}`);
  }
  if (task.stoppedReason) {
    parts.push(`stoppedReason="${task.stoppedReason}"`);
  }
  const containers = (task.containers ?? [])
    .map((container) => {
      const detail = [container.name ?? 'container'];
      if (container.exitCode !== undefined) {
        detail.push(`exitCode=${container.exitCode}`);
      }
      if (container.reason) {
        detail.push(`reason="${container.reason}"`);
      }
      return detail.join(' ');
    })
    .join('; ');
  if (containers) {
    parts.push(`containers: ${containers}`);
  }
  return `  ${parts.join(' ')}`;
}

async function gatherStoppedTasks(
  client: ECSClient,
  match: MatchedService,
  startTime: Date,
  endTime: Date
): Promise<string[]> {
  const listed = await client.send(
    new ListTasksCommand({
      cluster: match.clusterArn,
      serviceName: match.serviceName,
      desiredStatus: 'STOPPED',
      maxResults: 100,
    })
  );
  const taskArns = (listed.taskArns ?? []).slice(0, MAX_STOPPED_TASKS_DESCRIBED);
  if (taskArns.length === 0) {
    return ['Stopped tasks: none found.'];
  }

  const described = await client.send(
    new DescribeTasksCommand({ cluster: match.clusterArn, tasks: taskArns })
  );
  const tasks = described.tasks ?? [];
  const inWindow = tasks.filter((task) => {
    const at = task.stoppedAt?.getTime();
    return at !== undefined && at >= startTime.getTime() && at <= endTime.getTime();
  });

  if (inWindow.length > 0) {
    const shown = inWindow.slice(0, MAX_STOPPED_TASKS_SHOWN);
    return [
      `Stopped tasks in window (showing ${shown.length} of ${inWindow.length}):`,
      ...shown.map(formatStoppedTask),
    ];
  }

  const recent = [...tasks]
    .sort((a, b) => (b.stoppedAt?.getTime() ?? 0) - (a.stoppedAt?.getTime() ?? 0))
    .slice(0, MAX_RECENT_EVENTS_FALLBACK);
  return [
    `Stopped tasks: none stopped in the requested window; ${recent.length} most recently stopped shown for context:`,
    ...recent.map(formatStoppedTask),
  ];
}

async function handler(args: EcsServiceEventsArgs, ctx: ToolContext): Promise<string> {
  const { startTime, endTime } = resolveToolTimeRange(
    args.start_time,
    args.end_time,
    args.lookback_minutes,
    ctx
  );

  const client = createClient(ctx);
  try {
    const matches = await findMatchingServices(client, args.service_name, args.cluster);
    if (matches.length === 0) {
      return `No ECS services found matching "${args.service_name}"${args.cluster ? ` in clusters matching "${args.cluster}"` : ''}.`;
    }

    const sections: string[] = [
      `ECS evidence for "${args.service_name}" in window ${startTime.toISOString()}..${endTime.toISOString()}:`,
    ];

    for (const match of matches) {
      const described = await client.send(
        new DescribeServicesCommand({ cluster: match.clusterArn, services: [match.serviceName] })
      );
      const service = described.services?.[0];
      if (!service) {
        sections.push(`Service ${match.serviceName} (cluster ${match.clusterName}): not found.`);
        continue;
      }

      const lines = [
        `Service ${match.serviceName} (cluster ${match.clusterName}): status=${service.status ?? 'unknown'} ` +
          `desired=${service.desiredCount ?? 'n/a'} running=${service.runningCount ?? 'n/a'} pending=${service.pendingCount ?? 'n/a'} ` +
          `taskDefinition=${taskDefinitionLabel(service.taskDefinition)}`,
        ...formatDeployments(service),
        ...formatEvents(service, startTime, endTime),
        ...(await gatherStoppedTasks(client, match, startTime, endTime)),
      ];
      sections.push(lines.join('\n'));
    }

    return sections.join('\n\n');
  } catch (error) {
    if (error instanceof EcsToolError) {
      throw error;
    }
    throw new EcsToolError(
      `get_ecs_service_events failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    client.destroy();
  }
}

export interface ServiceLogGroup {
  logGroup: string;
  serviceName: string;
  containerName: string;
}

/**
 * Deterministically resolve a service name to CloudWatch log groups by reading
 * the awslogs configuration from the task definitions of matching ECS
 * services. Used by discover_log_groups to supplement name-based matching.
 */
export async function resolveServiceLogGroups(
  serviceName: string,
  ctx: ToolContext
): Promise<ServiceLogGroup[]> {
  const client = createClient(ctx);
  try {
    const matches = await findMatchingServices(client, serviceName);
    const results: ServiceLogGroup[] = [];
    const seenTaskDefinitions = new Set<string>();

    for (const match of matches) {
      const described = await client.send(
        new DescribeServicesCommand({ cluster: match.clusterArn, services: [match.serviceName] })
      );
      const taskDefinitionArn = described.services?.[0]?.taskDefinition;
      if (!taskDefinitionArn || seenTaskDefinitions.has(taskDefinitionArn)) {
        continue;
      }
      seenTaskDefinitions.add(taskDefinitionArn);

      const definition = await client.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn })
      );
      for (const container of definition.taskDefinition?.containerDefinitions ?? []) {
        const logConfiguration = container.logConfiguration;
        const logGroup = logConfiguration?.options?.['awslogs-group'];
        if (logConfiguration?.logDriver === 'awslogs' && logGroup) {
          results.push({
            logGroup,
            serviceName: match.serviceName,
            containerName: container.name ?? 'container',
          });
        }
      }
    }

    return results;
  } finally {
    client.destroy();
  }
}

export const ecsServiceEventsTool: ToolDefinition<EcsServiceEventsArgs> = {
  name: 'get_ecs_service_events',
  description:
    'Read-only: fetch ECS service deployment state, service events, and stopped-task reasons (exit codes, OOM kills, failed health checks) for services matching a name. Use to correlate errors with deployments or task crashes/restarts.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
