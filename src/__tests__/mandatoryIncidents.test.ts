import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alarmSpecFromSns } from '../report/alarmSpecFromSns.js';
import {
  buildActiveAlarmSpec,
  buildClassificationFromSpecs,
  dedupeMandatorySpecs,
  enforceIncidentSpecs,
  extractActiveAlarmSpecs,
  specDedupeKey,
  type MandatoryIncidentSpec,
} from '../report/mandatoryIncidents.js';
import { canonicalObservationKey } from '../state/agentState.js';
import type { ClassificationResult } from '../types.js';

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.resolve('test/fixtures/sns-cloudwatch-alarm', name), 'utf8')
  ) as unknown;
}

function specFromFixture(name: string): MandatoryIncidentSpec {
  const result = alarmSpecFromSns(loadFixture(name));
  if (!result.ok) {
    throw new Error(`Expected a valid spec for fixture ${name}, got ${result.reason}`);
  }
  return result.spec;
}

describe('dedupeMandatorySpecs', () => {
  it('collapses identical specs (e.g. a coalesced storm for the same alarm) to one', () => {
    const spec = specFromFixture('task-health-alarm.json');

    const deduped = dedupeMandatorySpecs([spec, spec, { ...spec }]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toEqual(spec);
  });

  it('keeps distinct specs for different alarms on the same service', () => {
    const taskHealth = specFromFixture('task-health-alarm.json');
    const highErrorRate = specFromFixture('high-error-rate-alarm.json');

    const deduped = dedupeMandatorySpecs([taskHealth, highErrorRate]);

    expect(deduped).toHaveLength(2);
    expect(specDedupeKey(taskHealth)).not.toBe(specDedupeKey(highErrorRate));
  });

  it('keeps the higher-severity spec when two specs share a dedupe key', () => {
    const base = buildActiveAlarmSpec({ service: 'api', alarmName: 'api-high-error-rate' });
    const critical: MandatoryIncidentSpec = { ...base, severity: 'CRITICAL' };

    const deduped = dedupeMandatorySpecs([base, critical]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('CRITICAL');
  });
});

describe('buildClassificationFromSpecs', () => {
  it('synthesizes a ClassificationResult-shaped payload with one incident per spec', () => {
    const taskHealth = specFromFixture('task-health-alarm.json');
    const highErrorRate = specFromFixture('high-error-rate-alarm.json');

    const result = buildClassificationFromSpecs([taskHealth, highErrorRate]);

    expect(result.incidents).toHaveLength(2);
    expect(result.findings).toHaveLength(0);
    expect(result.overall_severity).toBe('CRITICAL');
    expect(result.summary).toContain('Mandatory incident signals detected');
    expect(result.incidents.map((incident) => incident.title).sort()).toEqual(
      [taskHealth.title, highErrorRate.title].sort()
    );
  });

  it('dedupes duplicate trigger rows for the same alarm into a single incident', () => {
    const spec = specFromFixture('task-health-alarm.json');

    const result = buildClassificationFromSpecs([spec, spec]);

    expect(result.incidents).toHaveLength(1);
  });

  it('produces the same canonical incident identity as the report path for the same alarm signal', () => {
    const alarmSpec = specFromFixture('task-health-alarm.json');
    const reportSpec = extractActiveAlarmSpecs(
      `# Hokusai Service Health Report

## Service Details

### hokusai-auth-development

| Alarm | State |
| --- | --- |
| \`hokusai-auth-development-task-health\` | \`ALARM\` |
`
    )[0];
    expect(reportSpec).toBeDefined();

    const alarmClassification = buildClassificationFromSpecs([alarmSpec]);
    const reportClassification = buildClassificationFromSpecs([reportSpec as MandatoryIncidentSpec]);

    const alarmIncident = alarmClassification.incidents[0];
    const reportIncident = reportClassification.incidents[0];
    expect(alarmIncident).toBeDefined();
    expect(reportIncident).toBeDefined();

    expect(canonicalObservationKey('incident', alarmIncident!)).toBe(
      canonicalObservationKey('incident', reportIncident!)
    );
  });

  it('returns an empty classification for an empty spec list', () => {
    const result = buildClassificationFromSpecs([]);

    expect(result).toEqual<ClassificationResult>({
      summary: '',
      overall_severity: 'NONE',
      incidents: [],
      findings: [],
    });
  });
});

describe('enforceIncidentSpecs', () => {
  it('does not add a duplicate incident when an existing incident already covers the spec', () => {
    const spec = specFromFixture('task-health-alarm.json');
    const existing: ClassificationResult = {
      summary: 'LLM already found it',
      overall_severity: 'HIGH',
      incidents: [
        {
          incident_id: 'INC-1',
          title: 'ECS tasks unhealthy for hokusai-auth-development',
          classification: 'RESOURCE_EXHAUSTION',
          severity: 'HIGH',
          confidence: 0.8,
          affected_services: ['hokusai-auth-development'],
          evidence: [`Alarm ${spec.alarms?.[0]} is firing.`],
          signals: {
            alarms: spec.alarms ?? [],
            metrics: [],
            logs: [],
          },
          suspected_causes: [],
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

    const result = enforceIncidentSpecs(existing, [spec]);

    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]?.incident_id).toBe('INC-1');
  });
});
