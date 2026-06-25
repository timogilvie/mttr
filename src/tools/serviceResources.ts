import type { CloudWatchMetricSignal } from '../types.js';

export interface EcsServiceResource {
  cluster?: string | undefined;
  serviceName: string;
}

export interface AlbResource {
  loadBalancer: string;
  targetGroups: string[];
}

export interface ServiceResource {
  logicalName: string;
  aliases: string[];
  ecsServices: EcsServiceResource[];
  logGroups: string[];
  alarms: string[];
  albs: AlbResource[];
  healthMetrics: CloudWatchMetricSignal[];
}

export interface ResolvedServiceResource extends ServiceResource {
  matchedBy: string[];
}

const KNOWN_SERVICE_RESOURCES: ServiceResource[] = [
  {
    logicalName: 'data-pipeline-api',
    aliases: ['hokusai-api-development', 'hokusai-reg-api-development', 'api'],
    ecsServices: [{ cluster: 'hokusai-development', serviceName: 'hokusai-api-development' }],
    logGroups: ['/ecs/hokusai-api-development'],
    alarms: [
      'hokusai-api-development-high-error-rate',
      'hokusai-api-development-running-tasks-low',
      'hokusai-api-development-unhealthy-targets',
    ],
    albs: [
      {
        loadBalancer: 'app/hokusai-registry-development/78840d73e3e9652e',
        targetGroups: ['targetgroup/hokusai-reg-api-development/aab4ed4b619b04c0'],
      },
    ],
    healthMetrics: [
      {
        namespace: 'AWS/ApplicationELB',
        metric_name: 'HTTPCode_Target_5XX_Count',
        stat: 'Sum',
        dimensions: [
          { name: 'LoadBalancer', value: 'app/hokusai-registry-development/78840d73e3e9652e' },
          { name: 'TargetGroup', value: 'targetgroup/hokusai-reg-api-development/aab4ed4b619b04c0' },
        ],
      },
    ],
  },
  {
    logicalName: 'auth-service',
    aliases: ['hokusai-auth-development'],
    ecsServices: [{ cluster: 'hokusai-development', serviceName: 'hokusai-auth-development' }],
    logGroups: ['/ecs/hokusai-auth/development'],
    alarms: [
      'hokusai-auth-development-task-health',
      'hokusai-auth-development-running-tasks-low',
      'hokusai-auth-development-service-health',
      'hokusai-auth-development-unhealthy-hosts',
      'hokusai-auth-development-high-error-rate',
      'hokusai-auth-development-redis-degradation',
    ],
    albs: [],
    healthMetrics: [
      {
        namespace: 'ECS/ContainerInsights',
        metric_name: 'HealthyTaskCount',
        stat: 'Average',
        dimensions: [
          { name: 'ServiceName', value: 'hokusai-auth-development' },
          { name: 'ClusterName', value: 'hokusai-development' },
        ],
      },
    ],
  },
  {
    logicalName: 'mlflow',
    aliases: ['hokusai-mlflow-development'],
    ecsServices: [{ cluster: 'hokusai-development', serviceName: 'hokusai-mlflow-development' }],
    logGroups: ['/ecs/hokusai-mlflow-development'],
    alarms: [
      'hokusai-mlflow-development-unhealthy-targets',
      'hokusai-mlflow-development-running-tasks-low',
      'hokusai-mlflow-development-excessive-task-stops',
    ],
    albs: [],
    healthMetrics: [],
  },
];

const ALB_DIMS_RE = /_ALB dims:\s*TargetGroup=`([^`]+)`\s+LoadBalancer=`([^`]+)`_/gi;
const ECS_SERVICE_RE = /\b(?:ECS service is|ECS service:)\s*`?([A-Za-z0-9_.:/-]+)`?/gi;
const LOG_GROUP_RE = /\b(?:logGroupName=|log_group=)(\/[A-Za-z0-9_.:/-]+)\b/gi;
const ALARM_RE = /\balarm=([A-Za-z0-9_.:/-]+)|\balarm\s+([A-Za-z0-9][A-Za-z0-9_.:/-]*alarm[A-Za-z0-9_.:/-]*)/gi;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function cloneResource(resource: ServiceResource): ResolvedServiceResource {
  return {
    logicalName: resource.logicalName,
    aliases: [...resource.aliases],
    ecsServices: resource.ecsServices.map((service) => ({ ...service })),
    logGroups: [...resource.logGroups],
    alarms: [...resource.alarms],
    albs: resource.albs.map((alb) => ({
      loadBalancer: alb.loadBalancer,
      targetGroups: [...alb.targetGroups],
    })),
    healthMetrics: resource.healthMetrics.map((metric) => ({
      ...metric,
      dimensions: metric.dimensions.map((dimension) => ({ ...dimension })),
    })),
    matchedBy: [],
  };
}

function matchesResource(resource: ServiceResource, serviceName: string): boolean {
  const target = normalize(serviceName);
  const names = [resource.logicalName, ...resource.aliases, ...resource.ecsServices.map((s) => s.serviceName)];
  return names.some((name) => {
    const candidate = normalize(name);
    return candidate === target || candidate.includes(target) || target.includes(candidate);
  });
}

function parsedResource(serviceName: string, evidenceText: string): ResolvedServiceResource {
  const resource: ResolvedServiceResource = {
    logicalName: serviceName,
    aliases: [],
    ecsServices: [],
    logGroups: [],
    alarms: [],
    albs: [],
    healthMetrics: [],
    matchedBy: ['evidence'],
  };

  for (const match of evidenceText.matchAll(ECS_SERVICE_RE)) {
    const service = match[1]?.replace(/[.,;:)]+$/g, '');
    if (service) {
      resource.ecsServices.push({ serviceName: service });
      resource.aliases.push(service);
    }
  }

  for (const match of evidenceText.matchAll(LOG_GROUP_RE)) {
    const logGroup = match[1]?.replace(/[.,;:)]+$/g, '');
    if (logGroup) {
      resource.logGroups.push(logGroup);
    }
  }

  for (const match of evidenceText.matchAll(ALARM_RE)) {
    const alarm = (match[1] ?? match[2])?.replace(/[.,;:)]+$/g, '');
    if (alarm) {
      resource.alarms.push(alarm);
    }
  }

  for (const match of evidenceText.matchAll(ALB_DIMS_RE)) {
    const targetGroup = match[1];
    const loadBalancer = match[2];
    if (targetGroup && loadBalancer) {
      resource.albs.push({ loadBalancer, targetGroups: [targetGroup] });
      resource.healthMetrics.push({
        namespace: 'AWS/ApplicationELB',
        metric_name: 'HTTPCode_Target_5XX_Count',
        stat: 'Sum',
        dimensions: [
          { name: 'LoadBalancer', value: loadBalancer },
          { name: 'TargetGroup', value: targetGroup },
        ],
      });
    }
  }

  resource.aliases = unique(resource.aliases);
  resource.logGroups = unique(resource.logGroups);
  resource.alarms = unique(resource.alarms);
  return resource;
}

function mergeResources(primary: ResolvedServiceResource, added: ResolvedServiceResource): ResolvedServiceResource {
  const albs = [...primary.albs];
  for (const alb of added.albs) {
    const existing = albs.find((candidate) => candidate.loadBalancer === alb.loadBalancer);
    if (existing) {
      existing.targetGroups = unique([...existing.targetGroups, ...alb.targetGroups]);
    } else {
      albs.push({ loadBalancer: alb.loadBalancer, targetGroups: [...alb.targetGroups] });
    }
  }

  return {
    ...primary,
    aliases: unique([...primary.aliases, ...added.aliases]),
    ecsServices: [...primary.ecsServices, ...added.ecsServices].filter(
      (service, index, services) =>
        services.findIndex(
          (candidate) =>
            candidate.serviceName === service.serviceName && candidate.cluster === service.cluster
        ) === index
    ),
    logGroups: unique([...primary.logGroups, ...added.logGroups]),
    alarms: unique([...primary.alarms, ...added.alarms]),
    albs,
    healthMetrics: [...primary.healthMetrics, ...added.healthMetrics],
    matchedBy: unique([...primary.matchedBy, ...added.matchedBy]),
  };
}

export function listKnownServiceResources(): ServiceResource[] {
  return KNOWN_SERVICE_RESOURCES.map((resource) => cloneResource(resource));
}

export function serviceAliasesFor(serviceName: string): string[] {
  return resolveServiceResource(serviceName).aliases;
}

export function resolveServiceResource(
  serviceName: string,
  evidenceText = ''
): ResolvedServiceResource {
  const known = KNOWN_SERVICE_RESOURCES.find((resource) => matchesResource(resource, serviceName));
  const base = known ? cloneResource(known) : cloneResource({
    logicalName: serviceName,
    aliases: [],
    ecsServices: [],
    logGroups: [],
    alarms: [],
    albs: [],
    healthMetrics: [],
  });
  base.matchedBy = known ? ['known-registry'] : [];

  const parsed = evidenceText.trim() === '' ? null : parsedResource(serviceName, evidenceText);
  return parsed ? mergeResources(base, parsed) : base;
}

export function preferredEcsService(
  serviceName: string,
  evidenceText = ''
): EcsServiceResource | undefined {
  return resolveServiceResource(serviceName, evidenceText).ecsServices[0];
}

export function preferredLogGroup(serviceName: string, evidenceText = ''): string | undefined {
  return resolveServiceResource(serviceName, evidenceText).logGroups[0];
}

export function preferredAlbLoadBalancer(serviceName: string, evidenceText = ''): string | undefined {
  return resolveServiceResource(serviceName, evidenceText).albs[0]?.loadBalancer;
}
