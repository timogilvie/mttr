import { describe, expect, it } from 'vitest';
import {
  preferredAlbLoadBalancer,
  preferredEcsService,
  preferredLogGroup,
  resolveServiceResource,
} from '../../tools/serviceResources.js';
import { serviceSearchTerms } from '../../tools/serviceNames.js';

describe('serviceResources', () => {
  it('resolves data-pipeline-api to exact known ECS, log, ALB, and target group identifiers', () => {
    const resource = resolveServiceResource('data-pipeline-api');

    expect(resource.logicalName).toBe('data-pipeline-api');
    expect(resource.ecsServices[0]).toEqual({
      cluster: 'hokusai-development',
      serviceName: 'hokusai-api-development',
    });
    expect(resource.logGroups).toContain('/ecs/hokusai-api-development');
    expect(resource.albs[0]).toEqual({
      loadBalancer: 'app/hokusai-registry-development/78840d73e3e9652e',
      targetGroups: ['targetgroup/hokusai-reg-api-development/aab4ed4b619b04c0'],
    });
  });

  it('resolves auth-service aliases to the ECS service and auth log group', () => {
    const resource = resolveServiceResource('hokusai-auth-development');

    expect(resource.logicalName).toBe('auth-service');
    expect(resource.ecsServices[0]).toEqual({
      cluster: 'hokusai-development',
      serviceName: 'hokusai-auth-development',
    });
    expect(resource.logGroups).toContain('/ecs/hokusai-auth/development');
    expect(resource.alarms).toContain('hokusai-auth-development-task-health');
  });

  it('resolves mlflow aliases to exact ECS and log group identifiers', () => {
    const resource = resolveServiceResource('mlflow');

    expect(resource.ecsServices[0]?.serviceName).toBe('hokusai-mlflow-development');
    expect(resource.logGroups).toContain('/ecs/hokusai-mlflow-development');
  });

  it('merges resource identifiers parsed from health report and tool evidence', () => {
    const evidence = `
### data-pipeline-api
_ALB dims: TargetGroup=\`targetgroup/report-target/123\` LoadBalancer=\`app/report-alb/456\`_
- ECS service: \`hokusai-report-api-development\`
logGroupName=/ecs/hokusai-report-api-development
alarm=hokusai-report-api-development-high-error-rate
`;

    const resource = resolveServiceResource('data-pipeline-api', evidence);

    expect(resource.ecsServices).toContainEqual({ serviceName: 'hokusai-report-api-development' });
    expect(resource.logGroups).toContain('/ecs/hokusai-report-api-development');
    expect(resource.alarms).toContain('hokusai-report-api-development-high-error-rate');
    expect(resource.albs).toContainEqual({
      loadBalancer: 'app/report-alb/456',
      targetGroups: ['targetgroup/report-target/123'],
    });
    expect(resource.healthMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: 'AWS/ApplicationELB',
          metric_name: 'HTTPCode_Target_5XX_Count',
          dimensions: [
            { name: 'LoadBalancer', value: 'app/report-alb/456' },
            { name: 'TargetGroup', value: 'targetgroup/report-target/123' },
          ],
        }),
      ])
    );
  });

  it('returns preferred exact targets for downstream tool calls', () => {
    expect(preferredEcsService('auth-service')).toEqual({
      cluster: 'hokusai-development',
      serviceName: 'hokusai-auth-development',
    });
    expect(preferredLogGroup('data-pipeline-api')).toBe('/ecs/hokusai-api-development');
    expect(preferredAlbLoadBalancer('data-pipeline-api')).toBe(
      'app/hokusai-registry-development/78840d73e3e9652e'
    );
  });

  it('expands generic service search terms with known aliases', () => {
    expect(serviceSearchTerms('data-pipeline-api')).toEqual(
      expect.arrayContaining([
        'data-pipeline-api',
        'hokusai-api-development',
        'hokusai-reg-api-development',
        'api',
        'reg',
      ])
    );
  });
});
