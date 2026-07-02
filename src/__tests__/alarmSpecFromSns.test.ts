import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  alarmSpecFromSns,
  meetsAlarmSeverityGate,
  type CloudWatchAlarmPayload,
} from '../report/alarmSpecFromSns.js';
import { extractActiveAlarmSpecs, specDedupeKey } from '../report/mandatoryIncidents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'alarms');

function loadFixture(name: string): CloudWatchAlarmPayload {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8');
  return JSON.parse(raw) as CloudWatchAlarmPayload;
}

function buildReportSection(params: { heading: string; ecsService?: string; alarmName: string }): string {
  const { heading, ecsService, alarmName } = params;
  return [
    `### ${heading}`,
    '',
    ...(ecsService ? [`- ECS service: \`${ecsService}\``] : []),
    '| Alarm | State |',
    '| --- | --- |',
    `| \`${alarmName}\` | \`ALARM\` |`,
  ].join('\n');
}

describe('alarmSpecFromSns', () => {
  it('maps a task-health ALARM payload to a CRITICAL spec matching the report path byte-for-byte', () => {
    const fixture = loadFixture('task-health-alarm');
    const spec = alarmSpecFromSns(fixture);
    expect(spec).not.toBeNull();
    expect(spec?.severity).toBe('CRITICAL');
    expect(spec?.key).toBe('active-alarm-hokusai-auth-development-task-health');
    expect(spec?.affectedService).toBe('hokusai-auth-development');
    expect(spec?.serviceAliases).toEqual([]);

    // Equivalent report: heading equals the resolved service identity exactly
    // (no separate friendly-name/ECS-service split), so the report path
    // resolves the same affectedService with no ECS-service evidence line —
    // the two paths should therefore produce byte-identical specs.
    const report = buildReportSection({
      heading: 'hokusai-auth-development',
      alarmName: 'hokusai-auth-development-task-health',
    });
    const [reportSpec] = extractActiveAlarmSpecs(report);

    expect(spec).toEqual(reportSpec);
  });

  it('dedupes against a report-parsed alarm for the same ECS service even when the report uses a friendly heading', () => {
    const fixture = loadFixture('task-health-alarm');
    const pushSpec = alarmSpecFromSns(fixture);
    expect(pushSpec).not.toBeNull();

    // A realistic report section: friendly service heading ("auth-service")
    // plus an explicit ECS service line naming the same ECS service the SNS
    // alarm's ServiceName dimension names.
    const report = buildReportSection({
      heading: 'auth-service',
      ecsService: 'hokusai-auth-development',
      alarmName: 'hokusai-auth-development-task-health',
    });
    const [reportSpec] = extractActiveAlarmSpecs(report);
    expect(reportSpec).toBeDefined();

    expect(pushSpec?.key).toBe(reportSpec?.key);
    expect(pushSpec?.severity).toBe(reportSpec?.severity);
    expect(specDedupeKey(pushSpec!)).toBe(specDedupeKey(reportSpec!));
  });

  it('maps a generic non-task-health ALARM payload to a HIGH spec matching the report path', () => {
    const fixture = loadFixture('generic-alarm');
    const spec = alarmSpecFromSns(fixture);
    expect(spec).not.toBeNull();
    expect(spec?.severity).toBe('HIGH');
    expect(spec?.key).toBe('active-alarm-hokusai-auth-development-high-error-rate');
    expect(spec?.affectedService).toBe('hokusai-auth-development');

    const report = buildReportSection({
      heading: 'hokusai-auth-development',
      alarmName: 'hokusai-auth-development-high-error-rate',
    });
    const [reportSpec] = extractActiveAlarmSpecs(report);

    expect(spec).toEqual(reportSpec);
    expect(specDedupeKey(spec!)).toBe(specDedupeKey(reportSpec!));
  });

  it('returns null for a non-ALARM (OK) state transition', () => {
    const fixture = loadFixture('ok-state-alarm');
    expect(alarmSpecFromSns(fixture)).toBeNull();
  });

  it('returns null for an INSUFFICIENT_DATA state transition', () => {
    const fixture = loadFixture('task-health-alarm');
    expect(alarmSpecFromSns({ ...fixture, NewStateValue: 'INSUFFICIENT_DATA' })).toBeNull();
  });

  it('returns null for a payload missing the alarm name', () => {
    const fixture = loadFixture('missing-alarm-name');
    expect(alarmSpecFromSns(fixture)).toBeNull();
  });

  it('returns null for a payload with a blank alarm name', () => {
    const fixture = loadFixture('task-health-alarm');
    expect(alarmSpecFromSns({ ...fixture, AlarmName: '   ' })).toBeNull();
  });

  it('falls back to the alarm name as the affected service when no dimensions are present', () => {
    const fixture = loadFixture('no-dimensions-alarm');
    const spec = alarmSpecFromSns(fixture);
    expect(spec).not.toBeNull();
    expect(spec?.affectedService).toBe('hokusai-mlflow-development-service-health');
    expect(spec?.serviceAliases).toEqual([]);
    expect(spec?.severity).toBe('CRITICAL');
  });

  it('produces the same key/severity for identical alarm names regardless of dimension shape', () => {
    const withDimensions = alarmSpecFromSns(loadFixture('task-health-alarm'));
    const withoutDimensions = alarmSpecFromSns({
      ...loadFixture('task-health-alarm'),
      Trigger: { Dimensions: [] },
    });

    expect(withDimensions?.key).toBe(withoutDimensions?.key);
    expect(withDimensions?.severity).toBe(withoutDimensions?.severity);
  });
});

describe('meetsAlarmSeverityGate', () => {
  it('is pure and config-independent, purely ordering the two supplied values', () => {
    expect(meetsAlarmSeverityGate('CRITICAL', 'CRITICAL')).toBe(true);
    expect(meetsAlarmSeverityGate('CRITICAL', 'HIGH')).toBe(true);
    expect(meetsAlarmSeverityGate('HIGH', 'CRITICAL')).toBe(false);
    expect(meetsAlarmSeverityGate('MEDIUM', 'LOW')).toBe(true);
    expect(meetsAlarmSeverityGate('LOW', 'MEDIUM')).toBe(false);
    expect(meetsAlarmSeverityGate('NONE', 'NONE')).toBe(true);
  });

  it('gates a task-health spec at the CRITICAL default but not a generic HIGH spec', () => {
    const critical = alarmSpecFromSns(loadFixture('task-health-alarm'));
    const high = alarmSpecFromSns(loadFixture('generic-alarm'));

    expect(meetsAlarmSeverityGate(critical!.severity, 'CRITICAL')).toBe(true);
    expect(meetsAlarmSeverityGate(high!.severity, 'CRITICAL')).toBe(false);
  });
});
