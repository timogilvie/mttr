import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as investigateStage from '../stages/investigate.js';
import { callOpenRouterWithTools } from '../llm/toolLoop.js';
import { discoverLogGroupsTool, queryLogsTool } from '../tools/cloudwatchLogs.js';
import { metricsAndAlarmsTool } from '../tools/cloudwatchMetrics.js';
import { albAccessLogsTool } from '../tools/albAccessLogs.js';
import { ecsServiceEventsTool } from '../tools/ecs.js';
import { listMetricsTool } from '../tools/listMetrics.js';
import { findAlarmsTool } from '../tools/alarms.js';
import {
  lambdaConfigurationTool,
  lambdaDeploymentMetadataTool,
  lambdaDeploymentProvenanceTool,
} from '../tools/lambda.js';
import { eventBridgeRuleTool } from '../tools/eventbridge.js';
import { cloudTrailLookupTool } from '../tools/cloudtrail.js';
import type { Config } from '../config.js';
import type {
  StageInput,
  ClassificationResult,
  InvestigationResult,
  EvidenceRequirementType,
} from '../types.js';

vi.mock('../llm/toolLoop.js');
vi.mock('../tools/cloudwatchLogs.js', () => ({
  discoverLogGroupsTool: {
    handler: vi.fn(),
  },
  queryLogsTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/cloudwatchMetrics.js', () => ({
  metricsAndAlarmsTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/albAccessLogs.js', () => ({
  albAccessLogsTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/ecs.js', () => ({
  ecsServiceEventsTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/listMetrics.js', () => ({
  listMetricsTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/alarms.js', () => ({
  findAlarmsTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/lambda.js', () => ({
  lambdaConfigurationTool: {
    handler: vi.fn(),
  },
  lambdaDeploymentMetadataTool: {
    handler: vi.fn(),
  },
  lambdaDeploymentProvenanceTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/eventbridge.js', () => ({
  eventBridgeRuleTool: {
    handler: vi.fn(),
  },
}));
vi.mock('../tools/cloudtrail.js', () => ({
  cloudTrailLookupTool: {
    handler: vi.fn(),
  },
}));

const mockLoop = vi.mocked(callOpenRouterWithTools);
const mockDiscoverLogGroups = vi.mocked(discoverLogGroupsTool.handler);
const mockQueryLogs = vi.mocked(queryLogsTool.handler);
const mockMetricsAndAlarms = vi.mocked(metricsAndAlarmsTool.handler);
const mockAlbAccessLogs = vi.mocked(albAccessLogsTool.handler);
const mockEcsServiceEvents = vi.mocked(ecsServiceEventsTool.handler);
const mockListMetrics = vi.mocked(listMetricsTool.handler);
const mockFindAlarms = vi.mocked(findAlarmsTool.handler);
const mockLambdaConfiguration = vi.mocked(lambdaConfigurationTool.handler);
const mockLambdaDeploymentMetadata = vi.mocked(lambdaDeploymentMetadataTool.handler);
const mockLambdaDeploymentProvenance = vi.mocked(lambdaDeploymentProvenanceTool.handler);
const mockEventBridgeRule = vi.mocked(eventBridgeRuleTool.handler);
const mockCloudTrailLookup = vi.mocked(cloudTrailLookupTool.handler);

const mockConfig: Config = {
  openrouter: {
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://test.com',
    maxRetries: 4,
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
  },
  investigate: {
    model: 'test-investigate-model',
    modelFallback: 'test-fallback-model',
    maxToolIterations: 6,
    maxToolCalls: 12,
    closureEnabled: true,
    closureMaxToolIterations: 2,
    closureMaxToolCalls: 3,
    consecutiveFailureLimit: 3,
    llmTimeoutMs: 120000,
  },
  tools: {
    timeoutMs: 20000,
    resultMaxChars: 8000,
    defaultLookbackMinutes: 60,
    maxLookbackMinutes: 1440,
    maxConcurrency: 2,
  },
  healthReport: { s3Uri: 's3://test/report.md' },
  aws: { region: 'us-east-1', maxAttempts: 5 },
  monitoring: { intervalMs: 5000 },
  state: { backend: 'file', path: '.test-mttr-state.json' },
  database: {
    ssl: false,
    maxConnections: 4,
    idleTimeoutMs: 30000,
  },
  alerts: {
    slack: {
      channel: 'slack',
      timeoutMs: 10000,
    },
  },
  timeouts: { llmMs: 5000, s3Ms: 5000 },
  alarm: {
    webhook: { enabled: false, verifySignature: true, autoconfirm: true },
    trigger: { minSeverity: 'CRITICAL', cooldownMs: 600000, pollMs: 5000, coalesceMs: 2000 },
  },
};

const mockInput: StageInput = { stage: 'Investigate', timestamp: '2026-06-07T12:00:00Z' };

const validInvestigationJson = JSON.stringify({
  summary: 'Investigated the 4xx finding.',
  overall_assessment: 'POSSIBLE_INCIDENT',
  overall_severity: 'MEDIUM',
  investigations: [],
  cross_cutting_observations: [],
  priority_order: [],
});

function investigationJsonWithClosureNeed(summary = 'Draft needs closure.'): string {
  return JSON.stringify({
    summary,
    overall_assessment: 'ACTIVE_INCIDENT',
    overall_severity: 'HIGH',
    investigations: [
      {
        incident_id: 'incident-1',
        title: 'Detector failing',
        original_classification: 'OBSERVABILITY_FAILURE',
        investigation_status: 'CONFIRMED_INCIDENT',
        severity: 'HIGH',
        confidence: 0.95,
        affected_services: ['deltaone-anomaly-detection'],
        confirmed_facts: ['Lambda is failing.'],
        supporting_evidence: ['Errors equal invocations.'],
        contradicting_evidence: [],
        likely_causes: [
          {
            cause: 'RPC request is rejected.',
            confidence: 0.8,
            evidence: ['Runtime logs show Invalid params.'],
          },
        ],
        unknowns: ['Whether a CloudTrail configuration change caused this.'],
        additional_data_needed: [],
        unresolved_evidence_requirements: [
          {
            type: 'CHANGE_EVENT_DETAILS',
            description: 'Inspect CloudTrail change events around the detector failure onset.',
            tool_hint: 'Use lookup_cloudtrail_events for the detector Lambda and schedule.',
          },
        ],
        recommended_next_investigation_steps: [
          {
            priority: 1,
            action: 'Query CloudTrail and CloudWatch metrics for the detector.',
            expected_signal: 'A dependency or metric change around failure onset.',
          },
        ],
        requires_more_evidence_before_mitigation: true,
        possible_future_remediation: [],
      },
    ],
    cross_cutting_observations: [],
    priority_order: [
      {
        rank: 1,
        incident_id: 'incident-1',
        title: 'Detector failing',
        reason: 'High-severity confirmed detector failure.',
      },
    ],
  });
}

const closedInvestigationJson = JSON.stringify({
  summary: 'Closure evidence gathered.',
  overall_assessment: 'ACTIVE_INCIDENT',
  overall_severity: 'HIGH',
  investigations: [
    {
      incident_id: 'incident-1',
      title: 'Detector failing',
      original_classification: 'OBSERVABILITY_FAILURE',
      investigation_status: 'CONFIRMED_INCIDENT',
      severity: 'HIGH',
      confidence: 0.95,
      affected_services: ['deltaone-anomaly-detection'],
      confirmed_facts: ['Closure pass queried CloudTrail.'],
      supporting_evidence: ['No CloudTrail changes were found.'],
      contradicting_evidence: [],
      likely_causes: [
        {
          cause: 'RPC request is rejected.',
          confidence: 0.8,
          evidence: ['Runtime logs show Invalid params.'],
        },
      ],
      unknowns: ['Root trigger remains outside available evidence.'],
      additional_data_needed: [],
      unresolved_evidence_requirements: [],
      recommended_next_investigation_steps: [
        {
          priority: 1,
          action: 'Review source code and upstream RPC contract manually.',
          expected_signal: 'A parameter-schema mismatch.',
        },
      ],
      requires_more_evidence_before_mitigation: true,
      possible_future_remediation: [],
    },
  ],
  cross_cutting_observations: [],
  priority_order: [
    {
      rank: 1,
      incident_id: 'incident-1',
      title: 'Detector failing',
      reason: 'High-severity confirmed detector failure.',
    },
  ],
});

function loopResult(content: string) {
  return { content, iterations: 1, toolCalls: 1, usedFallback: false };
}

const emptyClassification: ClassificationResult = {
  summary: 'No actionable incidents detected.',
  overall_severity: 'NONE',
  incidents: [],
  findings: [],
};

const classificationWithFinding: ClassificationResult = {
  summary: 'A finding to investigate.',
  overall_severity: 'MEDIUM',
  incidents: [],
  findings: [
    {
      title: 'High 4xx Error Rate in data-pipeline-api',
      classification: 'AUTH_FAILURE',
      severity: 'MEDIUM',
      confidence: 0.7,
      affected_services: ['data-pipeline-api'],
      evidence: ['60 4xx errors in ALB metrics.'],
      reason_not_incident: 'No supporting logs.',
    },
  ],
};

const fiveXxClassification: ClassificationResult = {
  summary: 'ALB 5xx detected.',
  overall_severity: 'HIGH',
  report_context: {
    window_start: '2026-06-05T11:35:04.881Z',
    window_end: '2026-06-06T11:35:04.881Z',
  },
  incidents: [
    {
      incident_id: 'mandatory-alb-5xx-data-pipeline-api-0',
      title: 'ALB 5xx responses for data-pipeline-api',
      classification: 'APPLICATION_ERROR',
      severity: 'HIGH',
      confidence: 0.9,
      affected_services: ['data-pipeline-api'],
      evidence: ['Health report shows 10 ALB 5xx responses.'],
      signals: {
        alarms: [],
        metrics: ['ALB 5xx responses: 10'],
        logs: [],
        cloudwatch_metrics: [
          {
            namespace: 'AWS/ApplicationELB',
            metric_name: 'HTTPCode_Target_5XX_Count',
            stat: 'Sum',
            dimensions: [
              { name: 'LoadBalancer', value: 'app/hokusai-reg-api-development/def456' },
              { name: 'TargetGroup', value: 'targetgroup/hokusai-reg-api-development/abc123' },
            ],
          },
        ],
      },
      suspected_causes: ['Application errors.'],
      investigation_plan: {
        priority: 1,
        estimated_user_impact: 'PARTIAL',
        first_actions: [],
        questions_to_answer: [],
        suggested_cloudwatch_queries: [],
      },
      recommended_next_stage: 'INVESTIGATE',
    },
  ],
  findings: [],
};

describe('investigate stage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoverLogGroups.mockResolvedValue(
      'Found 2 candidate log group(s):\n' +
        'logGroupName=/ecs/hokusai-api-development, storedBytes=11701821\n' +
        'logGroupName=/ecs/hokusai/api/development, storedBytes=0'
    );
    mockQueryLogs.mockResolvedValue(
      'Query returned 1 row(s):\nstatus=401, path=/api/probe, requests=12'
    );
    mockMetricsAndAlarms.mockResolvedValue(
      'Metric datapoints (1):\n2026-06-06T10:00:00.000Z: Sum=10 Count'
    );
    mockAlbAccessLogs.mockResolvedValue(
      'Breakdown by status and path:\n  elb_status=502 target_status=- POST /api/ingest: 7'
    );
    mockEcsServiceEvents.mockResolvedValue(
      'Service data-pipeline-api (cluster hokusai-development): status=ACTIVE'
    );
    mockListMetrics.mockResolvedValue(
      'Found 1 metric(s):\nnamespace=Hokusai/Detectors, metric=DetectorLiveness, dimensions=[Detector=deltaone-anomaly-detection]'
    );
    mockFindAlarms.mockResolvedValue('No alarms found for search "deltaone-anomaly-detection".');
    mockLambdaConfiguration.mockResolvedValue(
      'function=hokusai-deltaone-anomaly-detector-development\nruntime=python3.12'
    );
    mockLambdaDeploymentMetadata.mockResolvedValue(
      'Current function artifact:\ncodeSha256=abc123'
    );
    mockLambdaDeploymentProvenance.mockResolvedValue(
      'Lambda deployment provenance:\nimageUri=repo:tag\nCloudFormation stack events in window'
    );
    mockEventBridgeRule.mockResolvedValue(
      'rule=hokusai-deltaone-anomaly-detector-schedule-development\nstate=ENABLED'
    );
    mockCloudTrailLookup.mockResolvedValue('No CloudTrail events found.');
  });

  it('short-circuits on empty classification with no LLM call', async () => {
    const result = await investigateStage.run(mockInput, mockConfig, emptyClassification);

    expect(result.status).toBe('success');
    expect(mockLoop).not.toHaveBeenCalled();
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('NO_ACTIONABLE_INCIDENT');
    expect(data.overall_severity).toBe('NONE');
  });

  it('short-circuits on a Stage 1 failure fallback (empty arrays)', async () => {
    const failureFallback: ClassificationResult = {
      summary: 'Classification failed: LLM returned invalid JSON after retry',
      overall_severity: 'NONE',
      incidents: [],
      findings: [],
    };

    const result = await investigateStage.run(mockInput, mockConfig, failureFallback);

    expect(result.status).toBe('success');
    expect(mockLoop).not.toHaveBeenCalled();
    expect((result.data as InvestigationResult).overall_assessment).toBe('NO_ACTIONABLE_INCIDENT');
  });

  it('returns a validated investigation on the happy path', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(1);
    expect(mockDiscoverLogGroups).toHaveBeenCalledWith(
      { service_name: 'data-pipeline-api', limit: 5 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        lookback_minutes: mockConfig.tools.maxLookbackMinutes,
      }),
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockQueryLogs).toHaveBeenCalledTimes(1);
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('Pre-gathered Tool Evidence');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('standard 4xx/auth breakdown');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('1440 minute lookback');
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('POSSIBLE_INCIDENT');
    expect(data.overall_severity).toBe('MEDIUM');
  });

  it('pre-gathers warning samples for warning findings', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    const warningClassification: ClassificationResult = {
      summary: 'Warnings to investigate.',
      overall_severity: 'LOW',
      incidents: [],
      findings: [
        {
          title: 'High Warning Count in auth-service',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'LOW',
          confidence: 0.6,
          affected_services: ['auth-service'],
          evidence: ['65 warnings in recent logs.'],
          reason_not_incident: 'Warnings do not indicate a specific actionable incident.',
        },
      ],
    };

    const result = await investigateStage.run(mockInput, mockConfig, warningClassification);

    expect(result.status).toBe('success');
    expect(mockDiscoverLogGroups).toHaveBeenCalledWith(
      { service_name: 'auth-service', limit: 5 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        filter_or_query: expect.stringContaining('WARN'),
      }),
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('standard warning sample');
  });

  it('queries multiple non-empty candidate log groups during standard evidence gathering', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockDiscoverLogGroups.mockResolvedValue(
      'Found 3 candidate log group(s):\n' +
        'logGroupName=/ecs/hokusai-api-development, storedBytes=11701821\n' +
        'logGroupName=/ecs/hokusai-api-secondary, storedBytes=42\n' +
        'logGroupName=/ecs/hokusai/api/development, storedBytes=0'
    );

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockQueryLogs).toHaveBeenCalledTimes(2);
    expect(mockQueryLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ log_group: '/ecs/hokusai-api-development' }),
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ log_group: '/ecs/hokusai-api-secondary' }),
      expect.anything()
    );
  });

  it('pre-gathers structured CloudWatch metric evidence using the report window context', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    const classificationWithMetric: ClassificationResult = {
      summary: 'ALB 5xx detected.',
      overall_severity: 'HIGH',
      report_context: {
        window_start: '2026-06-05T11:35:04.881Z',
        window_end: '2026-06-06T11:35:04.881Z',
      },
      incidents: [
        {
          incident_id: 'mandatory-alb-5xx-data-pipeline-api-0',
          title: 'ALB 5xx responses for data-pipeline-api',
          classification: 'APPLICATION_ERROR',
          severity: 'HIGH',
          confidence: 0.9,
          affected_services: ['data-pipeline-api'],
          evidence: ['Health report shows 10 ALB 5xx responses.'],
          signals: {
            alarms: [],
            metrics: ['ALB 5xx responses: 10'],
            logs: [],
            cloudwatch_metrics: [
              {
                namespace: 'AWS/ApplicationELB',
                metric_name: 'HTTPCode_Target_5XX_Count',
                stat: 'Sum',
                dimensions: [
                  { name: 'LoadBalancer', value: 'app/hokusai-reg-api-development/def456' },
                  { name: 'TargetGroup', value: 'targetgroup/hokusai-reg-api-development/abc123' },
                ],
              },
            ],
          },
          suspected_causes: ['Application errors.'],
          investigation_plan: {
            priority: 1,
            estimated_user_impact: 'PARTIAL',
            first_actions: [],
            questions_to_answer: [],
            suggested_cloudwatch_queries: [],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithMetric);

    expect(result.status).toBe('success');
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AWS/ApplicationELB',
        metric_name: 'HTTPCode_Target_5XX_Count',
        stat: 'Sum',
      }),
      expect.objectContaining({
        defaultStartTime: '2026-06-05T11:35:04.881Z',
        defaultEndTime: '2026-06-06T11:35:04.881Z',
      })
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('metric AWS/ApplicationELB/HTTPCode_Target_5XX_Count');
  });

  it('pre-gathers ALB access logs, ECS events, and a 5xx log breakdown for 5xx incidents, narrowed to the metric spike', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockMetricsAndAlarms.mockResolvedValue(
      'Metric datapoints (2):\n' +
        '2026-06-05T14:18:00.000Z: Sum=2 Count\n' +
        '2026-06-05T15:48:00.000Z: Sum=3 Count'
    );

    const result = await investigateStage.run(mockInput, mockConfig, fiveXxClassification);

    expect(result.status).toBe('success');

    // Spike window: first/last non-zero datapoint padded by 15 minutes.
    const spikeWindow = {
      start_time: '2026-06-05T14:03:00.000Z',
      end_time: '2026-06-05T16:03:00.000Z',
    };

    expect(mockAlbAccessLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        load_balancer: 'app/hokusai-reg-api-development/def456',
        status_class: '5xx',
        ...spikeWindow,
      }),
      expect.anything()
    );
    expect(mockEcsServiceEvents).toHaveBeenCalledWith(
      expect.objectContaining({ service_name: 'data-pipeline-api', ...spikeWindow }),
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        filter_or_query: expect.stringContaining('/^5/'),
        ...spikeWindow,
      }),
      expect.anything()
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('ALB access-log 5xx breakdown');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('ECS service events for data-pipeline-api');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('narrowed to metric spike window');
  });

  it('pre-gathers an error-context log sample for 5xx incidents', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockMetricsAndAlarms.mockResolvedValue(
      'Metric datapoints (2):\n' +
        '2026-06-05T14:18:00.000Z: Sum=2 Count\n' +
        '2026-06-05T15:48:00.000Z: Sum=3 Count'
    );

    const result = await investigateStage.run(mockInput, mockConfig, fiveXxClassification);

    expect(result.status).toBe('success');
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        filter_or_query: expect.stringContaining('error|exception|timeout'),
        start_time: '2026-06-05T14:03:00.000Z',
        end_time: '2026-06-05T16:03:00.000Z',
        limit: 50,
      }),
      expect.anything()
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('error-context sample');
  });

  it('pre-gathers ECS resource saturation and deploy/config change correlation for confirmed application-error incidents, resolved generically from the ECS service-events tool output', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockMetricsAndAlarms.mockResolvedValue(
      'Metric datapoints (2):\n' +
        '2026-06-05T14:18:00.000Z: Sum=2 Count\n' +
        '2026-06-05T15:48:00.000Z: Sum=3 Count'
    );
    mockEcsServiceEvents.mockResolvedValue(
      'Service data-pipeline-api (cluster hokusai-development): status=ACTIVE'
    );
    mockCloudTrailLookup.mockResolvedValue(
      'Found 1 event(s):\neventName=UpdateService, eventTime=2026-06-05T14:10:00.000Z'
    );

    const result = await investigateStage.run(mockInput, mockConfig, fiveXxClassification);

    expect(result.status).toBe('success');
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AWS/ECS',
        metric_name: 'CPUUtilization',
        dimensions: [
          { name: 'ServiceName', value: 'data-pipeline-api' },
          { name: 'ClusterName', value: 'hokusai-development' },
        ],
        stat: 'Average',
      }),
      expect.anything()
    );
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AWS/ECS',
        metric_name: 'MemoryUtilization',
        dimensions: [
          { name: 'ServiceName', value: 'data-pipeline-api' },
          { name: 'ClusterName', value: 'hokusai-development' },
        ],
        stat: 'Average',
      }),
      expect.anything()
    );
    expect(mockCloudTrailLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_name: 'data-pipeline-api',
        event_names: expect.arrayContaining(['UpdateService', 'RegisterTaskDefinition']),
      }),
      expect.anything()
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain(
      'ECS resource saturation (CPU/Memory) for data-pipeline-api'
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain(
      'CloudTrail ECS service changes for data-pipeline-api'
    );
  });

  it('resolves ECS causal-evidence targets generically for a different, unregistered service with no literal service-name branching', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockMetricsAndAlarms.mockResolvedValue('No metric datapoints in the requested window.');
    mockEcsServiceEvents.mockResolvedValue(
      'Service another-widget-service (cluster hokusai-production): status=ACTIVE'
    );

    const firstIncident = fiveXxClassification.incidents[0]!;
    const otherServiceClassification: ClassificationResult = {
      ...fiveXxClassification,
      incidents: [
        {
          ...firstIncident,
          incident_id: 'mandatory-alb-5xx-another-widget-service-0',
          title: 'ALB 5xx responses for another-widget-service',
          affected_services: ['another-widget-service'],
        },
      ],
    };

    const result = await investigateStage.run(mockInput, mockConfig, otherServiceClassification);

    expect(result.status).toBe('success');
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AWS/ECS',
        metric_name: 'CPUUtilization',
        dimensions: [
          { name: 'ServiceName', value: 'another-widget-service' },
          { name: 'ClusterName', value: 'hokusai-production' },
        ],
      }),
      expect.anything()
    );
    expect(mockCloudTrailLookup).toHaveBeenCalledWith(
      expect.objectContaining({ resource_name: 'another-widget-service' }),
      expect.anything()
    );
  });

  it('degrades gracefully when the ECS deploy/config change-correlation lookup fails, without failing the stage', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockMetricsAndAlarms.mockResolvedValue('No metric datapoints in the requested window.');
    mockEcsServiceEvents.mockResolvedValue(
      'Service data-pipeline-api (cluster hokusai-development): status=ACTIVE'
    );
    mockCloudTrailLookup.mockRejectedValue(new Error('CloudTrail throttled'));

    const result = await investigateStage.run(mockInput, mockConfig, fiveXxClassification);

    expect(result.status).toBe('success');
    expect(mockLoop.mock.calls[0]![0].prompt).toContain(
      'CloudTrail ECS service changes for data-pipeline-api'
    );
    expect(mockLoop.mock.calls[0]![0].prompt).toContain('CloudTrail throttled');
  });

  it('skips ECS causal-evidence follow-up when the service cannot be resolved from ECS service events', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockEcsServiceEvents.mockResolvedValue('No ECS services found matching "data-pipeline-api".');

    const result = await investigateStage.run(mockInput, mockConfig, fiveXxClassification);

    expect(result.status).toBe('success');
    expect(mockCloudTrailLookup).not.toHaveBeenCalled();
    expect(mockMetricsAndAlarms).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'AWS/ECS' }),
      expect.anything()
    );
  });

  it('does not gather ECS resource-saturation or change-correlation evidence for non-application-error findings', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockEcsServiceEvents).not.toHaveBeenCalled();
    expect(mockCloudTrailLookup).not.toHaveBeenCalled();
    expect(mockMetricsAndAlarms).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'AWS/ECS' }),
      expect.anything()
    );
  });

  it('pre-gathers metric discovery, alarm coverage, extended metric history, and a runtime activity sample for observability incidents', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    const observabilityClassification: ClassificationResult = {
      summary: 'Detector liveness missing.',
      overall_severity: 'HIGH',
      report_context: {
        window_start: '2026-06-05T11:35:04.881Z',
        window_end: '2026-06-06T11:35:04.881Z',
      },
      incidents: [
        {
          incident_id: 'mandatory-missing-detector-liveness-deltaone-anomaly-detection-1',
          title: 'No detector liveness datapoints for deltaone-anomaly-detection',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'HIGH',
          confidence: 0.95,
          affected_services: ['deltaone-anomaly-detection'],
          evidence: ['No datapoints received from the detector liveness metric in this window.'],
          signals: {
            alarms: [],
            metrics: ['Detector liveness metric has zero datapoints.'],
            logs: [],
            cloudwatch_metrics: [
              {
                namespace: 'Hokusai/Detectors',
                metric_name: 'DetectorLiveness',
                stat: 'Sum',
                dimensions: [{ name: 'Detector', value: 'deltaone-anomaly-detection' }],
              },
            ],
          },
          suspected_causes: ['Detector runtime or metric publication path broken.'],
          investigation_plan: {
            priority: 2,
            estimated_user_impact: 'SIGNIFICANT',
            first_actions: [],
            questions_to_answer: [],
            suggested_cloudwatch_queries: [],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    const result = await investigateStage.run(
      mockInput,
      mockConfig,
      observabilityClassification
    );

    expect(result.status).toBe('success');

    // Extended history: 14 days before the report window start, hourly period.
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'Hokusai/Detectors',
        metric_name: 'DetectorLiveness',
        period_seconds: 3600,
        start_time: '2026-05-22T11:35:04.881Z',
        end_time: '2026-06-06T11:35:04.881Z',
      }),
      expect.anything()
    );
    expect(mockListMetrics).toHaveBeenCalledWith(
      { search: 'deltaone-anomaly-detection', limit: 100 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockListMetrics).toHaveBeenCalledWith(
      { search: 'deltaone', limit: 100 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockListMetrics).toHaveBeenCalledWith(
      { search: 'liveness', limit: 100 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockListMetrics).toHaveBeenCalledWith(
      { search: 'heartbeat', limit: 100 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockListMetrics).toHaveBeenCalledWith(
      { metric_name: 'DetectorLiveness', limit: 100 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockListMetrics).toHaveBeenCalledWith(
      { metric_name: 'DetectorHeartbeat', limit: 100 },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockFindAlarms).toHaveBeenCalledWith(
      { search: 'deltaone-anomaly-detection' },
      expect.objectContaining({ region: 'us-east-1' })
    );
    expect(mockDiscoverLogGroups).toHaveBeenCalledWith(
      { service_name: 'deltaone-anomaly-detection', limit: 5 },
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/ecs/hokusai-api-development',
        filter_or_query: expect.not.stringContaining('filter'),
        limit: 25,
      }),
      expect.anything()
    );

    const prompt = mockLoop.mock.calls[0]![0].prompt;
    expect(prompt).toContain('expanded liveness metric discovery for deltaone-anomaly-detection');
    expect(prompt).toContain('Requests: search=deltaone-anomaly-detection');
    expect(prompt).toContain('alarm coverage for deltaone-anomaly-detection');
    expect(prompt).toContain('extended 14-day history for Hokusai/Detectors/DetectorLiveness');
    expect(prompt).toContain('recent runtime activity sample');
  });

  it('fetches extended history for liveness metrics recovered from metric discovery', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockListMetrics.mockResolvedValue(
      'Found 4 metric(s):\n' +
        'namespace=Hokusai/Detectors, metric=DetectorLiveness, dimensions=[Detector=deltaone-anomaly-detection]\n' +
        'namespace=Hokusai/Detectors, metric=DetectorHeartbeat, dimensions=[Detector=deltaone-anomaly-detection]\n' +
        'namespace=Hokusai/Detectors, metric=DetectorLiveness, dimensions=[Detector=other-detector]\n' +
        'namespace=AWS/Lambda, metric=Errors, dimensions=[FunctionName=hokusai-deltaone-anomaly-detector-development]'
    );
    const observabilityClassification: ClassificationResult = {
      summary: 'Detector liveness missing.',
      overall_severity: 'HIGH',
      report_context: {
        window_start: '2026-06-12T11:40:38.535Z',
        window_end: '2026-06-13T11:40:38.535Z',
      },
      incidents: [
        {
          incident_id: 'mandatory-missing-detector-liveness-deltaone-anomaly-detection-1',
          title: 'No detector liveness datapoints for deltaone-anomaly-detection',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'HIGH',
          confidence: 0.95,
          affected_services: ['deltaone-anomaly-detection'],
          evidence: ['No datapoints received from the detector liveness metric in this window.'],
          signals: {
            alarms: [],
            metrics: ['Detector liveness metric has zero datapoints.'],
            logs: [],
            cloudwatch_metrics: [],
          },
          suspected_causes: ['Detector runtime or metric publication path broken.'],
          investigation_plan: {
            priority: 1,
            estimated_user_impact: 'SIGNIFICANT',
            first_actions: [],
            questions_to_answer: [],
            suggested_cloudwatch_queries: [],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    const result = await investigateStage.run(
      mockInput,
      mockConfig,
      observabilityClassification
    );

    expect(result.status).toBe('success');
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'Hokusai/Detectors',
        metric_name: 'DetectorLiveness',
        dimensions: [{ name: 'Detector', value: 'deltaone-anomaly-detection' }],
        stat: 'Sum',
        period_seconds: 3600,
        start_time: '2026-05-29T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
      }),
      expect.anything()
    );
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'Hokusai/Detectors',
        metric_name: 'DetectorHeartbeat',
        dimensions: [{ name: 'Detector', value: 'deltaone-anomaly-detection' }],
      }),
      expect.anything()
    );
    expect(mockMetricsAndAlarms).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'Hokusai/Detectors',
        metric_name: 'DetectorLiveness',
        dimensions: [{ name: 'Detector', value: 'other-detector' }],
      }),
      expect.anything()
    );

    const prompt = mockLoop.mock.calls[0]![0].prompt;
    expect(prompt).toContain(
      'discovered liveness metric 14-day history for Hokusai/Detectors/DetectorLiveness'
    );
    expect(prompt).toContain(
      'discovered liveness metric 14-day history for Hokusai/Detectors/DetectorHeartbeat'
    );
  });

  it('pre-gathers Lambda and scheduler root-cause evidence for discovered detector workloads', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockListMetrics.mockResolvedValue(
      'Found 3 metric(s):\n' +
        'namespace=AWS/Lambda, metric=Errors, dimensions=[FunctionName=hokusai-deltaone-anomaly-detector-development]\n' +
        'namespace=AWS/Events, metric=Invocations, dimensions=[RuleName=hokusai-deltaone-anomaly-detector-schedule-development]\n' +
        'namespace=Hokusai/DeltaOneAnomalies, metric=DetectorError, dimensions=[Environment=development]'
    );
    mockQueryLogs.mockImplementation(async (args) => {
      if (
        args.log_group === '/aws/lambda/hokusai-deltaone-anomaly-detector-development' &&
        args.filter_or_query.includes('RPC error')
      ) {
        return (
          'Query returned 1 row(s):\n' +
          'earliest=2026-06-12 13:51:20.000, latest=2026-06-12 14:10:05.000, failures=37, errorCode=-32602, rpcError=RPC error -32602 Invalid params, exceptionType=RuntimeError, errorMessage=RPC error -32602 Invalid params, file=deltaone_detector_lambda.py, function=_rpc_call, @logStream=2026/06/12/[$LATEST]abc'
        );
      }
      if (
        args.log_group === '/aws/lambda/hokusai-deltaone-anomaly-detector-development' &&
        args.filter_or_query.includes('File "')
      ) {
        return (
          'Query returned 1 row(s):\n' +
          'file=deltaone_detector_lambda.py, function=_rpc_call, frames=37, @logStream=2026/06/12/[$LATEST]abc'
        );
      }
      if (
        args.log_group === '/aws/lambda/hokusai-deltaone-anomaly-detector-development' &&
        args.filter_or_query.includes('completedInvocations')
      ) {
        return 'Query returned 1 row(s):\ncompletedInvocations=37, @logStream=2026/06/12/[$LATEST]abc';
      }
      return 'Query returned 1 row(s):\nstatus=401, path=/api/probe, requests=12';
    });
    const observabilityClassification: ClassificationResult = {
      summary: 'Detector liveness missing.',
      overall_severity: 'HIGH',
      report_context: {
        window_start: '2026-06-12T11:40:38.535Z',
        window_end: '2026-06-13T11:40:38.535Z',
      },
      incidents: [
        {
          incident_id: 'mandatory-missing-detector-liveness-deltaone-anomaly-detection-1',
          title: 'No detector liveness datapoints for deltaone-anomaly-detection',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'HIGH',
          confidence: 0.95,
          affected_services: ['deltaone-anomaly-detection'],
          evidence: ['No datapoints received from the detector liveness metric in this window.'],
          signals: {
            alarms: [],
            metrics: ['Detector liveness metric has zero datapoints.'],
            logs: [],
            cloudwatch_metrics: [],
          },
          suspected_causes: ['Detector runtime or metric publication path broken.'],
          investigation_plan: {
            priority: 1,
            estimated_user_impact: 'SIGNIFICANT',
            first_actions: [],
            questions_to_answer: [],
            suggested_cloudwatch_queries: [],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [
        {
          title: 'High number of detector errors in deltaone-anomaly-detection',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'MEDIUM',
          confidence: 0.7,
          affected_services: ['deltaone-anomaly-detection'],
          evidence: ['3923 detector error(s) reported.'],
          reason_not_incident: 'No direct user impact confirmed.',
        },
      ],
    };

    const result = await investigateStage.run(
      mockInput,
      mockConfig,
      observabilityClassification
    );

    expect(result.status).toBe('success');
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AWS/Lambda',
        metric_name: 'Invocations',
        dimensions: [
          { name: 'FunctionName', value: 'hokusai-deltaone-anomaly-detector-development' },
        ],
        stat: 'Sum',
        period_seconds: 3600,
      }),
      expect.anything()
    );
    expect(mockMetricsAndAlarms).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AWS/Lambda',
        metric_name: 'Errors',
        dimensions: [
          { name: 'FunctionName', value: 'hokusai-deltaone-anomaly-detector-development' },
        ],
      }),
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/aws/lambda/hokusai-deltaone-anomaly-detector-development',
        filter_or_query: expect.stringContaining('RPC error'),
        start_time: '2026-06-12T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
        limit: 100,
      }),
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/aws/lambda/hokusai-deltaone-anomaly-detector-development',
        filter_or_query: expect.stringContaining('File "'),
        start_time: '2026-06-12T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
        limit: 50,
      }),
      expect.anything()
    );
    expect(mockQueryLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        log_group: '/aws/lambda/hokusai-deltaone-anomaly-detector-development',
        filter_or_query: expect.stringContaining('completedInvocations'),
        start_time: '2026-06-12T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
        limit: 50,
      }),
      expect.anything()
    );
    expect(mockLambdaConfiguration).toHaveBeenCalledTimes(1);
    expect(mockLambdaConfiguration).toHaveBeenCalledWith(
      {
        function_name: 'hokusai-deltaone-anomaly-detector-development',
        include_environment_keys: true,
      },
      expect.anything()
    );
    expect(mockLambdaDeploymentMetadata).toHaveBeenCalledTimes(1);
    expect(mockLambdaDeploymentProvenance).toHaveBeenCalledTimes(1);
    expect(mockLambdaDeploymentProvenance).toHaveBeenCalledWith(
      {
        function_name: 'hokusai-deltaone-anomaly-detector-development',
        start_time: '2026-06-09T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
      },
      expect.anything()
    );
    expect(mockEventBridgeRule).toHaveBeenCalledWith(
      { rule_name: 'hokusai-deltaone-anomaly-detector-schedule-development' },
      expect.anything()
    );
    expect(mockCloudTrailLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_name: 'hokusai-deltaone-anomaly-detector-development',
        start_time: '2026-06-09T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
      }),
      expect.anything()
    );
    expect(mockCloudTrailLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_name: 'hokusai-deltaone-anomaly-detector-schedule-development',
        start_time: '2026-06-09T11:40:38.535Z',
        end_time: '2026-06-13T11:40:38.535Z',
      }),
      expect.anything()
    );

    const prompt = mockLoop.mock.calls[0]![0].prompt;
    expect(prompt).toContain('Lambda error summary for hokusai-deltaone-anomaly-detector-development');
    expect(prompt).toContain('RPC error -32602 Invalid params');
    expect(prompt).toContain('deltaone_detector_lambda.py');
    expect(prompt).toContain('Lambda completion summary for hokusai-deltaone-anomaly-detector-development');
    expect(prompt).toContain('Lambda configuration for hokusai-deltaone-anomaly-detector-development');
    expect(prompt).toContain('Lambda deployment metadata for hokusai-deltaone-anomaly-detector-development');
    expect(prompt).toContain('Lambda deployment provenance for hokusai-deltaone-anomaly-detector-development');
    expect(prompt).toContain('EventBridge rule hokusai-deltaone-anomaly-detector-schedule-development');
    expect(mockLambdaConfiguration).toHaveBeenCalledTimes(1);
  });

  it('falls back to the report window when no error-metric datapoints localize a spike', async () => {
    mockLoop.mockResolvedValue(loopResult(validInvestigationJson));
    mockMetricsAndAlarms.mockResolvedValue('No metric datapoints in the requested window.');

    const result = await investigateStage.run(mockInput, mockConfig, fiveXxClassification);

    expect(result.status).toBe('success');
    expect(mockAlbAccessLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        load_balancer: 'app/hokusai-reg-api-development/def456',
        lookback_minutes: mockConfig.tools.maxLookbackMinutes,
      }),
      expect.anything()
    );
    expect(mockAlbAccessLogs).toHaveBeenCalledWith(
      expect.not.objectContaining({ start_time: expect.anything() }),
      expect.anything()
    );
  });

  it('strips markdown fences from the response', async () => {
    mockLoop.mockResolvedValue(loopResult('```json\n' + validInvestigationJson + '\n```'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect((result.data as InvestigationResult).overall_assessment).toBe('POSSIBLE_INCIDENT');
  });

  it('filters unresolved evidence requirements by status and draft mitigation need', () => {
    const draft = JSON.parse(investigationJsonWithClosureNeed()) as InvestigationResult;
    const pending = investigateStage.createEvidenceRequirement({
      id: 'incident-1:CUSTOM_METRIC_HISTORY:metric-a',
      type: 'CUSTOM_METRIC_HISTORY',
      status: 'pending',
    });
    const satisfied = investigateStage.createEvidenceRequirement({
      id: 'incident-1:ALARM_COVERAGE:service-a',
      type: 'ALARM_COVERAGE',
      status: 'satisfied',
    });
    const unavailable = investigateStage.createEvidenceRequirement({
      id: 'incident-1:CHANGE_EVENT_DETAILS:function-a',
      type: 'CHANGE_EVENT_DETAILS',
      status: 'unavailable',
    });
    const otherIncident = investigateStage.createEvidenceRequirement({
      id: 'incident-2:DEPLOYMENT_PROVENANCE:function-b',
      incident_id: 'incident-2',
      type: 'DEPLOYMENT_PROVENANCE',
      status: 'pending',
    });

    expect(
      investigateStage.unresolvedRequirementsForDraft(draft, [
        pending,
        satisfied,
        unavailable,
        otherIncident,
      ])
    ).toEqual([pending]);
  });

  it('constructs closure prompts from every structured requirement type', () => {
    const draft = JSON.parse(investigationJsonWithClosureNeed()) as InvestigationResult;
    const requirementTypes: EvidenceRequirementType[] = [
      'CUSTOM_METRIC_HISTORY',
      'FIRST_BAD_LOG_TIMESTAMP',
      'LAMBDA_FAILURE_SUMMARY',
      'CHANGE_EVENT_DETAILS',
      'DEPLOYMENT_PROVENANCE',
      'ALARM_COVERAGE',
    ];
    const requirements = requirementTypes.map((type, index) =>
      investigateStage.createEvidenceRequirement({
        id: `incident-1:${type}:target-${index}`,
        type,
        description: `Requirement ${type}`,
        tool_hint: `Tool hint ${type}`,
      })
    );

    expect(investigateStage.needsRootCauseClosure(draft, requirements)).toBe(true);

    const prompt = investigateStage.buildRootCauseClosurePrompt(
      'original prompt',
      draft,
      requirements,
      3
    );

    expect(prompt).toContain('Unresolved evidence requirements');
    expect(prompt).toContain('use these objects, not recommended_next_investigation_steps prose');
    expect(prompt).toContain('Human-only recommended_next_investigation_steps');
    for (const requirement of requirements) {
      expect(prompt).toContain(requirement.type);
      expect(prompt).toContain(requirement.description);
      expect(prompt).toContain(requirement.tool_hint);
    }
  });

  it('extracts structured draft requirements without using recommendation text', () => {
    const draft = JSON.parse(investigationJsonWithClosureNeed()) as InvestigationResult;
    draft.investigations[0]!.recommended_next_investigation_steps = [
      {
        priority: 1,
        action: 'Review source code manually with the owning team.',
        expected_signal: 'A code-level RPC parameter mismatch.',
      },
    ];

    const requirements = investigateStage.structuredRequirementsFromDraft(draft);

    expect(requirements).toEqual([
      expect.objectContaining({
        incident_id: 'incident-1',
        type: 'CHANGE_EVENT_DETAILS',
        status: 'pending',
      }),
    ]);
  });

  it('does not trigger closure from executable-looking recommendation prose alone', async () => {
    const proseOnlyDraft = JSON.parse(investigationJsonWithClosureNeed()) as InvestigationResult;
    proseOnlyDraft.investigations[0]!.unresolved_evidence_requirements = [];
    proseOnlyDraft.investigations[0]!.recommended_next_investigation_steps = [
      {
        priority: 1,
        action: 'Query CloudTrail and CloudWatch metrics for the detector.',
        expected_signal: 'A dependency or metric change around failure onset.',
      },
    ];
    mockLoop.mockResolvedValue(loopResult(JSON.stringify(proseOnlyDraft)));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(1);
    expect((result.data as InvestigationResult).summary).toBe('Draft needs closure.');
  });

  it('runs one bounded root-cause closure pass when the draft defers executable evidence', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult(investigationJsonWithClosureNeed()))
      .mockResolvedValueOnce(loopResult(closedInvestigationJson));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    expect(mockLoop.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        maxIterations: mockConfig.investigate.closureMaxToolIterations,
        maxToolCalls: mockConfig.investigate.closureMaxToolCalls,
      })
    );
    expect(mockLoop.mock.calls[1]![0].prompt).toContain('Root-Cause Closure Pass');
    expect(mockLoop.mock.calls[1]![0].prompt).toContain('Draft needs closure.');
    expect(mockLoop.mock.calls[1]![0].prompt).toContain('CHANGE_EVENT_DETAILS');
    expect((result.data as InvestigationResult).summary).toBe('Closure evidence gathered.');
  });

  it('does not run repeated closure passes even if closure output still defers executable evidence', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult(investigationJsonWithClosureNeed('Draft needs closure.')))
      .mockResolvedValueOnce(loopResult(investigationJsonWithClosureNeed('Still needs closure.')));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    expect((result.data as InvestigationResult).summary).toBe('Still needs closure.');
  });

  it('skips closure when remaining investigation steps are not tool-executable', async () => {
    const humanOnlyDraft = JSON.parse(investigationJsonWithClosureNeed()) as InvestigationResult;
    humanOnlyDraft.investigations[0]!.unresolved_evidence_requirements = [];
    humanOnlyDraft.investigations[0]!.recommended_next_investigation_steps = [
      {
        priority: 1,
        action: 'Review source code manually with the owning team.',
        expected_signal: 'A code-level RPC parameter mismatch.',
      },
    ];
    mockLoop.mockResolvedValue(loopResult(JSON.stringify(humanOnlyDraft)));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(1);
    expect((result.data as InvestigationResult).summary).toBe('Draft needs closure.');
  });

  it('keeps the first-pass draft when closure returns invalid JSON', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult(investigationJsonWithClosureNeed()))
      .mockResolvedValueOnce(loopResult('not valid json'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    expect((result.data as InvestigationResult).summary).toBe('Draft needs closure.');
  });

  it('skips closure when disabled by config', async () => {
    mockLoop.mockResolvedValue(loopResult(investigationJsonWithClosureNeed()));

    const result = await investigateStage.run(mockInput, {
      ...mockConfig,
      investigate: { ...mockConfig.investigate, closureEnabled: false },
    }, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(1);
    expect((result.data as InvestigationResult).summary).toBe('Draft needs closure.');
  });

  it('repairs once on invalid JSON and succeeds', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult('not valid json'))
      .mockResolvedValueOnce(loopResult(validInvestigationJson));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    // repair turn is invoked with no tools
    expect((mockLoop.mock.calls[1]![0] as { tools: unknown[] }).tools).toEqual([]);
    expect((result.data as InvestigationResult).overall_assessment).toBe('POSSIBLE_INCIDENT');
  });

  it('returns the safe fallback when repair also fails', async () => {
    mockLoop
      .mockResolvedValueOnce(loopResult('still bad'))
      .mockResolvedValueOnce(loopResult('also bad'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('success');
    expect(mockLoop).toHaveBeenCalledTimes(2);
    const data = result.data as InvestigationResult;
    expect(data.overall_assessment).toBe('INSUFFICIENT_EVIDENCE');
    expect(data.summary).toContain('Investigation failed');
  });

  it('returns status error when the tool loop throws', async () => {
    mockLoop.mockRejectedValue(new Error('tool loop timed out'));

    const result = await investigateStage.run(mockInput, mockConfig, classificationWithFinding);

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool loop timed out');
  });
});
