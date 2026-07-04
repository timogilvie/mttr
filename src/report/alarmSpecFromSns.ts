import type { Severity } from '../types.js';
import {
  buildActiveAlarmSpec,
  SEVERITY_ORDER,
  specDedupeKey,
  type MandatoryIncidentSpec,
} from './mandatoryIncidents.js';

export interface SnsCloudWatchAlarmDimension {
  name: string;
  value: string;
}

export interface SnsCloudWatchAlarmTrigger {
  MetricName?: string | undefined;
  Namespace?: string | undefined;
  Dimensions?: SnsCloudWatchAlarmDimension[] | undefined;
}

export interface SnsCloudWatchAlarmMessage {
  AlarmName: string;
  NewStateValue: string;
  NewStateReason?: string | undefined;
  StateChangeTime?: string | undefined;
  Region?: string | undefined;
  AWSAccountId?: string | undefined;
  Trigger: SnsCloudWatchAlarmTrigger;
}

export type AlarmSpecFromSnsInvalidReason =
  | 'invalid-payload'
  | 'missing-alarm-name'
  | 'missing-trigger'
  | 'missing-service-identity'
  | 'not-active';

export interface AlarmSpecFromSnsSuccess {
  ok: true;
  spec: MandatoryIncidentSpec;
  severity: Severity;
  dedupeKey: string;
  gated?: boolean | undefined;
}

export interface AlarmSpecFromSnsFailure {
  ok: false;
  reason: AlarmSpecFromSnsInvalidReason;
}

export type AlarmSpecFromSnsResult = AlarmSpecFromSnsSuccess | AlarmSpecFromSnsFailure;

export interface AlarmIdentityFromSnsSuccess {
  ok: true;
  severity: Severity;
  dedupeKey: string;
  gated?: boolean | undefined;
}

export type AlarmIdentityFromSnsResult =
  | AlarmIdentityFromSnsSuccess
  | AlarmSpecFromSnsFailure;

export interface AlarmSpecFromSnsOptions {
  minSeverity?: Severity | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readDimensions(value: unknown): SnsCloudWatchAlarmDimension[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const dimensions = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = readTrimmedString(entry['name'] ?? entry['Name']);
    const dimensionValue = readTrimmedString(entry['value'] ?? entry['Value']);
    return name && dimensionValue ? [{ name, value: dimensionValue }] : [];
  });

  return dimensions.length > 0 ? dimensions : undefined;
}

function deriveServiceIdentity(
  alarmName: string,
  dimensions: SnsCloudWatchAlarmDimension[] | undefined
): string | undefined {
  const dimensionCandidates = ['ServiceName', 'service', 'Service', 'ECSServiceName', 'TargetGroup'];

  for (const candidate of dimensionCandidates) {
    const match = dimensions?.find((dimension) => dimension.name === candidate)?.value;
    if (match) {
      return match;
    }
  }

  const inferredFromName = alarmName.match(/^([a-z0-9][a-z0-9-]*?)-(?:task-health|service-health|high-error-rate|running-tasks-low|unhealthy-(?:targets|hosts)|excessive-task-stops|redis-degradation)$/i)?.[1];
  return inferredFromName?.toLowerCase();
}

export function passesAlarmTriggerGate(severity: Severity, minSeverity: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minSeverity);
}

export function alarmSpecFromSns(
  payload: unknown,
  options: AlarmSpecFromSnsOptions = {}
): AlarmSpecFromSnsResult {
  const identity = alarmIdentityFromSns(payload, options);
  if (!identity.ok) {
    return identity;
  }
  if (!isRecord(payload) || readTrimmedString(payload['NewStateValue']) !== 'ALARM') {
    return { ok: false, reason: 'not-active' };
  }

  const alarmName = readTrimmedString(payload['AlarmName']) as string;
  const dimensions = readDimensions((payload['Trigger'] as Record<string, unknown>)['Dimensions']);
  const service = deriveServiceIdentity(alarmName, dimensions) as string;
  const spec = buildActiveAlarmSpec({ service, alarmName });
  return {
    ok: true,
    spec,
    severity: identity.severity,
    dedupeKey: identity.dedupeKey,
    ...(identity.gated === undefined ? {} : { gated: identity.gated }),
  };
}

export function alarmIdentityFromSns(
  payload: unknown,
  options: AlarmSpecFromSnsOptions = {}
): AlarmIdentityFromSnsResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'invalid-payload' };
  }

  const alarmName = readTrimmedString(payload['AlarmName']);
  if (!alarmName) {
    return { ok: false, reason: 'missing-alarm-name' };
  }

  if (!isRecord(payload['Trigger'])) {
    return { ok: false, reason: 'missing-trigger' };
  }

  const dimensions = readDimensions(payload['Trigger']['Dimensions']);
  const service = deriveServiceIdentity(alarmName, dimensions);
  if (!service) {
    return { ok: false, reason: 'missing-service-identity' };
  }

  const spec = buildActiveAlarmSpec({ service, alarmName });
  const severity = spec.severity;
  const result: AlarmIdentityFromSnsSuccess = {
    ok: true,
    severity,
    dedupeKey: specDedupeKey(spec),
  };

  if (options.minSeverity) {
    result.gated = !passesAlarmTriggerGate(severity, options.minSeverity);
  }

  return result;
}
