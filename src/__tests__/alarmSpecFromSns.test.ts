import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alarmSpecFromSns, passesAlarmTriggerGate } from '../report/alarmSpecFromSns.js';
import { extractActiveAlarmSpecs, specDedupeKey } from '../report/mandatoryIncidents.js';

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.resolve('test/fixtures/sns-cloudwatch-alarm', name), 'utf8')
  ) as unknown;
}

function reportForAlarm(service: string, alarmName: string): string {
  return `# Hokusai Service Health Report

## Service Details

### ${service}

| Alarm | State |
| --- | --- |
| \`${alarmName}\` | \`ALARM\` |
`;
}

function expectSuccess(result: ReturnType<typeof alarmSpecFromSns>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.reason}`);
  }
  return result;
}

function expectSingleReportSpec(service: string, alarmName: string) {
  const reportSpec = extractActiveAlarmSpecs(reportForAlarm(service, alarmName))[0];
  expect(reportSpec).toBeDefined();
  if (!reportSpec) {
    throw new Error(`Expected report spec for ${alarmName}`);
  }
  return reportSpec;
}

describe('alarmSpecFromSns', () => {
  it('matches the report-path spec and dedupe key for a task-health alarm', () => {
    const payload = loadFixture('task-health-alarm.json');
    const result = expectSuccess(alarmSpecFromSns(payload));
    const reportSpec = expectSingleReportSpec(
      'hokusai-auth-development',
      'hokusai-auth-development-task-health'
    );
    expect(result.spec).toEqual(reportSpec);
    expect(result.dedupeKey).toBe(specDedupeKey(reportSpec));
    expect(result.severity).toBe(reportSpec.severity);
    expect(result.severity).toBe('CRITICAL');
  });

  it('matches the report-path spec and dedupe key for a non-task alarm', () => {
    const payload = loadFixture('high-error-rate-alarm.json');
    const result = expectSuccess(alarmSpecFromSns(payload));
    const reportSpec = expectSingleReportSpec(
      'hokusai-auth-development',
      'hokusai-auth-development-high-error-rate'
    );
    expect(result.spec).toEqual(reportSpec);
    expect(result.dedupeKey).toBe(specDedupeKey(reportSpec));
    expect(result.severity).toBe(reportSpec.severity);
    expect(result.severity).toBe('HIGH');
  });

  it('applies the severity gate consistently', () => {
    const taskHealthPayload = loadFixture('task-health-alarm.json');
    const highErrorPayload = loadFixture('high-error-rate-alarm.json');

    expect(passesAlarmTriggerGate('CRITICAL', 'CRITICAL')).toBe(true);
    expect(passesAlarmTriggerGate('HIGH', 'CRITICAL')).toBe(false);
    expect(passesAlarmTriggerGate('HIGH', 'HIGH')).toBe(true);

    const gatedCritical = expectSuccess(
      alarmSpecFromSns(taskHealthPayload, { minSeverity: 'CRITICAL' })
    );
    const gatedHigh = expectSuccess(
      alarmSpecFromSns(highErrorPayload, { minSeverity: 'CRITICAL' })
    );

    expect(gatedCritical.gated).toBe(false);
    expect(gatedHigh.gated).toBe(true);
  });

  it('returns not-active for non-ALARM states', () => {
    expect(alarmSpecFromSns(loadFixture('ok-transition.json'))).toEqual({
      ok: false,
      reason: 'not-active',
    });
  });

  it('returns a typed failure for malformed payloads', () => {
    expect(alarmSpecFromSns(loadFixture('missing-trigger.json'))).toEqual({
      ok: false,
      reason: 'missing-trigger',
    });
    expect(alarmSpecFromSns('not-an-object')).toEqual({
      ok: false,
      reason: 'invalid-payload',
    });
    expect(alarmSpecFromSns(loadFixture('non-alarm-message.json'))).toEqual({
      ok: false,
      reason: 'missing-alarm-name',
    });
  });

  it('keeps extra unknown fields from affecting the spec', () => {
    const payload = loadFixture('task-health-alarm.json') as Record<string, unknown>;
    const enriched = {
      ...payload,
      ExtraField: 'ignored',
      Trigger: {
        ...(payload['Trigger'] as Record<string, unknown>),
        ExtraNestedField: 'ignored',
      },
    };

    const base = expectSuccess(alarmSpecFromSns(payload));
    const withExtras = expectSuccess(alarmSpecFromSns(enriched));

    expect(withExtras.spec).toEqual(base.spec);
    expect(withExtras.dedupeKey).toBe(base.dedupeKey);
  });
});
