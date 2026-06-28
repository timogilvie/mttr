import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Config } from '../config.js';
import type { AgentState, ObservationReconciliation } from '../state/agentState.js';
import { reconcileObservations } from '../state/agentState.js';
import type { AlertRecordInput, AgentStateRepository } from '../state/repository.js';
import type { PersistedIncidentSnapshot } from '../state/transitions.js';
import {
  transitionFromDecision,
  transitionFromVerification,
} from '../state/transitions.js';
import type {
  ClassificationResult,
  IncidentDecision,
  IncidentVerification,
  Severity,
} from '../types.js';
import { sendSlackAlerts, type SlackFetch } from '../alerts/slack.js';
import { Dashboard } from '../web/dashboard/App.js';
import type { StatusResponse } from '../web/dashboard/statusTypes.js';

function classification(
  severity: Severity,
  evidence: string[],
  incidentId = 'INC-001'
): ClassificationResult {
  return {
    summary: severity === 'NONE' ? 'Healthy.' : 'API errors detected.',
    overall_severity: severity,
    incidents:
      severity === 'NONE'
        ? []
        : [
            {
              incident_id: incidentId,
              title: 'High 4xx',
              classification: 'AUTH_FAILURE',
              severity,
              confidence: 0.85,
              affected_services: ['data-pipeline-api'],
              evidence,
              signals: {
                alarms: ['api-4xx-high'],
                metrics: ['HTTPCode_Target_4XX_Count'],
                logs: ['auth failures'],
              },
              suspected_causes: ['authentication regression'],
              investigation_plan: {
                priority: 1,
                estimated_user_impact: 'PARTIAL',
                first_actions: ['Inspect ALB 4xx log sample'],
                questions_to_answer: ['Are failures current?'],
                suggested_cloudwatch_queries: ['fields @timestamp, @message'],
              },
              recommended_next_stage: 'Investigate',
            },
          ],
    findings: [],
  };
}

function decision(overrides: Partial<IncidentDecision> = {}): IncidentDecision {
  return {
    incident_id: 'INC-001',
    title: 'High 4xx',
    disposition: 'VERIFY',
    next_stage: 'Verify',
    severity: 'MEDIUM',
    affected_services: ['data-pipeline-api'],
    rationale: 'Verify whether the API errors are still active.',
    evidence_to_pass: ['ALB 4xx spike'],
    follow_up_actions: [],
    ...overrides,
  };
}

function verification(
  overrides: Partial<IncidentVerification> = {}
): IncidentVerification {
  return {
    incident_id: 'INC-001',
    title: 'High 4xx',
    status: 'VERIFIED_RECOVERED_TRANSIENT',
    severity: 'HIGH',
    rationale: 'Latest metrics have recovered.',
    checks: [
      {
        tool: 'cloudwatch-metrics',
        target: 'data-pipeline-api',
        status: 'passed',
        evidence: '4xx count returned to baseline',
      },
    ],
    recommended_next_stage: 'None',
    ...overrides,
  };
}

function snapshot(overrides: Partial<PersistedIncidentSnapshot> = {}): PersistedIncidentSnapshot {
  return {
    incidentId: 'INC-001',
    severity: 'MEDIUM',
    state: 'decision',
    currentDisposition: 'VERIFY',
    currentNextStage: 'Verify',
    closedAt: null,
    ...overrides,
  };
}

function config(): Config {
  return {
    openrouter: {
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://openrouter.test/api',
      maxRetries: 1,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    },
    investigate: {
      model: 'test-model',
      modelFallback: 'fallback-model',
      maxToolIterations: 1,
      maxToolCalls: 1,
      closureEnabled: true,
      closureMaxToolIterations: 1,
      closureMaxToolCalls: 1,
      consecutiveFailureLimit: 3,
      llmTimeoutMs: 1000,
    },
    tools: {
      timeoutMs: 1000,
      resultMaxChars: 1000,
      defaultLookbackMinutes: 60,
      maxLookbackMinutes: 1440,
      maxConcurrency: 1,
    },
    healthReport: { s3Uri: 's3://ops/health-report.md' },
    aws: { region: 'us-east-1', maxAttempts: 1 },
    monitoring: { intervalMs: 900000 },
    state: { backend: 'postgres', path: '.mttr-state.json' },
    database: { ssl: true, maxConnections: 2, idleTimeoutMs: 1000 },
    alerts: {
      slack: {
        webhookUrl: 'https://hooks.slack.test/services/secret',
        channel: 'slack',
        timeoutMs: 1000,
      },
    },
    timeouts: { llmMs: 1000, s3Ms: 1000 },
  };
}

function repository(): {
  repo: AgentStateRepository;
  alerts: AlertRecordInput[];
} {
  const dedupeKeys = new Set<string>();
  const alerts: AlertRecordInput[] = [];
  return {
    repo: {
      async load() {
        return { version: 1, observations: {} };
      },
      async save() {
        return;
      },
      async hasAlert(dedupeKey: string) {
        return dedupeKeys.has(dedupeKey);
      },
      async recordAlertSent(alert: AlertRecordInput) {
        dedupeKeys.add(alert.dedupeKey);
        alerts.push(alert);
      },
    },
    alerts,
  };
}

function okFetch(): SlackFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    async text() {
      return 'ok';
    },
  }));
}

function statusResponse(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    status: 'red',
    lastRun: {
      id: 'run-7',
      startedAt: '2026-06-27T18:00:00.000Z',
      finishedAt: '2026-06-27T18:01:00.000Z',
      status: 'success',
      healthReportS3Uri: 's3://ops/health-report.md',
      reportHash: 'hash-7',
      summary: 'High 4xx detected.',
      overallSeverity: 'HIGH',
      errorMessage: null,
    },
    workerHeartbeat: {
      workerId: 'default',
      processName: 'mttr-worker',
      lastSeenAt: new Date().toISOString(),
      metadata: { intervalMs: 900000 },
    },
    stale: { worker: false, report: false },
    openIncidentCounts: { HIGH: 1 },
    openIncidents: [
      {
        incidentId: 'INC-001',
        title: 'High 4xx',
        service: 'data-pipeline-api',
        severity: 'HIGH',
        state: 'decision',
        openedAt: '2026-06-27T18:00:00.000Z',
        closedAt: null,
        currentDisposition: 'MITIGATE',
        currentNextStage: 'Mitigate',
        lastRunId: 'run-7',
      },
    ],
    recentTransitions: [
      {
        id: 'event-7',
        incidentId: 'INC-001',
        runId: 'run-7',
        stage: 'Decide',
        message: 'Ready for mitigation: High 4xx',
        severity: 'HIGH',
        evidence: { transition_type: 'ready_for_mitigation' },
        createdAt: '2026-06-27T18:01:00.000Z',
      },
    ],
    ...overrides,
  };
}

function walk(root: string): string[] {
  const entries = readdirSync(root);
  return entries.flatMap((entry) => {
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return walk(fullPath);
    }
    return fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') ? [fullPath] : [];
  });
}

describe('production readiness', () => {
  it('covers the server monitor MVP lifecycle from report classification to dashboard display', async () => {
    const state: AgentState = { version: 1, observations: {} };

    const healthy = reconcileObservations(
      state,
      classification('NONE', []),
      '2026-06-27T17:45:00.000Z'
    );
    expect(healthy).toMatchObject({
      newObservations: [],
      changedObservations: [],
      recurringObservations: [],
      resolvedObservations: [],
      shouldInvestigate: false,
    } satisfies ObservationReconciliation);

    const firstIncident = reconcileObservations(
      state,
      classification('MEDIUM', ['ALB 4xx spike']),
      '2026-06-27T18:00:00.000Z'
    );
    expect(firstIncident.newObservations).toHaveLength(1);
    expect(firstIncident.shouldInvestigate).toBe(true);

    const recurringUnchanged = reconcileObservations(
      state,
      classification('MEDIUM', ['ALB 4xx spike']),
      '2026-06-27T18:15:00.000Z'
    );
    expect(recurringUnchanged.recurringObservations).toHaveLength(1);
    expect(recurringUnchanged.shouldInvestigate).toBe(false);

    const escalated = reconcileObservations(
      state,
      classification('HIGH', ['ALB 4xx spike', 'Customer auth failures increased']),
      '2026-06-27T18:30:00.000Z'
    );
    expect(escalated.changedObservations).toHaveLength(1);
    expect(escalated.shouldInvestigate).toBe(true);

    const newTransition = transitionFromDecision(undefined, decision());
    const repeatTransition = transitionFromDecision(snapshot(), decision());
    const severityTransition = transitionFromDecision(
      snapshot({ severity: 'MEDIUM' }),
      decision({ severity: 'HIGH' })
    );
    const mitigationTransition = transitionFromDecision(
      snapshot({ severity: 'HIGH' }),
      decision({ disposition: 'MITIGATE', next_stage: 'Mitigate', severity: 'HIGH' })
    );
    const recoveredTransition = transitionFromVerification(
      snapshot({ severity: 'HIGH', state: 'verification' }),
      verification()
    );

    expect([
      newTransition.transitionType,
      repeatTransition.transitionType,
      severityTransition.transitionType,
      mitigationTransition.transitionType,
      recoveredTransition.transitionType,
    ]).toEqual([
      'new_incident',
      'unchanged',
      'severity_increased',
      'ready_for_mitigation',
      'recovered',
    ]);

    const { repo, alerts } = repository();
    const fetchImpl = okFetch();
    const alertResults = await sendSlackAlerts(
      config(),
      repo,
      'run-7',
      [
        newTransition,
        repeatTransition,
        severityTransition,
        mitigationTransition,
        recoveredTransition,
      ],
      fetchImpl
    );
    const secondPass = await sendSlackAlerts(config(), repo, 'run-8', [newTransition], fetchImpl);

    expect(alertResults.map((result) => result.status)).toEqual([
      'sent',
      'skipped',
      'sent',
      'sent',
      'sent',
    ]);
    expect(secondPass[0]?.status).toBe('deduped');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(alerts).toHaveLength(4);

    const failedRunStatus = statusResponse({
      status: 'yellow',
      lastRun: {
        id: 'run-8',
        startedAt: '2026-06-27T18:45:00.000Z',
        finishedAt: '2026-06-27T18:45:30.000Z',
        status: 'error',
        healthReportS3Uri: 's3://ops/health-report.md',
        reportHash: null,
        summary: 'Run failed before classification.',
        overallSeverity: null,
        errorMessage: 'S3 access denied',
      },
    });
    const html = renderToStaticMarkup(<Dashboard status={failedRunStatus} />);

    expect(html).toContain('Yellow');
    expect(html).toContain('High 4xx');
    expect(html).toContain('Ready for mitigation');
    expect(html).toContain('error');
  });

  it('keeps AWS tool usage inside the read-only command boundary', () => {
    const sourceFiles = ['src/tools', 'src/report', 'src/stages'].flatMap(walk);
    const commandNames = sourceFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/new\s+([A-Za-z]+Command)\s*\(/g)].flatMap((match) =>
        match[1] ? [match[1]] : []
      );
    });
    const allowedPrefixes = [
      'BatchGet',
      'Describe',
      'Get',
      'List',
      'Lookup',
      'StartQuery',
      'StopQuery',
    ];
    const forbidden = commandNames.filter(
      (name) => !allowedPrefixes.some((prefix) => name.startsWith(prefix))
    );

    expect(forbidden).toEqual([]);
    expect(commandNames).toContain('StartQueryCommand');
    expect(commandNames).toContain('StopQueryCommand');
  });

  it('documents the release checks needed before enabling continuous monitoring', () => {
    const checklist = readFileSync('docs/release-checklist.md', 'utf8');

    for (const required of [
      'Healthy report',
      'New incident',
      'Recurring unchanged incident',
      'Severity escalation',
      'Ready for mitigation',
      'Recovered or closed',
      'Failed run',
      'Read-Only Boundary',
      'Rollback',
    ]) {
      expect(checklist).toContain(required);
    }
  });
});
