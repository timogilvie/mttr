import type { Severity } from '../types.js';
import {
  buildActiveAlarmSpec,
  maxSeverity,
  type MandatoryIncidentSpec,
} from './mandatoryIncidents.js';

/**
 * A CloudWatch alarm state-change notification, in the shape SNS delivers it
 * (the JSON-decoded `Message` field of the SNS envelope, not the envelope
 * itself). Only the fields this mapper reads are typed; everything else on a
 * real payload is ignored. `Trigger.Dimensions` entries use lowercase
 * `name`/`value` keys — this is an AWS quirk specific to that one field, while
 * every other field on the payload is PascalCase.
 */
export interface CloudWatchAlarmDimension {
  name: string;
  value: string;
}

export interface CloudWatchAlarmTrigger {
  MetricName?: string;
  Namespace?: string;
  Dimensions?: CloudWatchAlarmDimension[];
}

export interface CloudWatchAlarmPayload {
  AlarmName?: string;
  AlarmArn?: string;
  NewStateValue?: string;
  OldStateValue?: string;
  StateChangeTime?: string;
  Trigger?: CloudWatchAlarmTrigger;
}

const ACTIONABLE_STATE = 'ALARM';

function findDimensionValue(
  dimensions: CloudWatchAlarmDimension[],
  name: string
): string | undefined {
  const match = dimensions.find(
    (dimension) => dimension.name?.toLowerCase() === name.toLowerCase()
  );
  const value = match?.value?.trim();
  return value ? value : undefined;
}

/**
 * Resolves the affected-service identity from alarm dimensions, mirroring the
 * report path's `ecsService ?? service` fallback. An SNS alarm has no
 * report-heading "friendly name" to fall back to, so `service` and
 * `ecsService` are the same resolved value whenever one is found — this keeps
 * `serviceAliases` empty (matching the report path when both names agree) and
 * gives `affectedService` a value `specDedupeKey` can match against a
 * report-parsed spec for the same ECS service.
 *
 * Fallback order when no `ServiceName` dimension is present: the first
 * dimension's value, then the alarm name itself. This is a documented,
 * deterministic choice (not a guess at the "true" service name) so that an
 * alarm with unresolvable dimensions still produces a spec instead of being
 * dropped.
 */
function resolveAffectedService(
  alarmName: string,
  dimensions: CloudWatchAlarmDimension[]
): { service: string; ecsService?: string } {
  const ecsService = findDimensionValue(dimensions, 'ServiceName');
  if (ecsService) {
    return { service: ecsService, ecsService };
  }

  const fallbackDimension = dimensions.find((dimension) => dimension.value?.trim())?.value.trim();
  if (fallbackDimension) {
    return { service: fallbackDimension };
  }

  return { service: alarmName };
}

/**
 * Pure mapper: an already-parsed CloudWatch alarm payload → the same
 * incident-spec shape `extractActiveAlarmSpecs` produces from report
 * markdown. No I/O; returns `null` for non-`ALARM` states or incomplete
 * payloads instead of throwing, so a malformed or benign (OK/
 * INSUFFICIENT_DATA) notification is simply not actionable.
 */
export function alarmSpecFromSns(alarm: CloudWatchAlarmPayload): MandatoryIncidentSpec | null {
  const alarmName = alarm.AlarmName?.trim();
  if (!alarmName) {
    return null;
  }

  if (alarm.NewStateValue !== ACTIONABLE_STATE) {
    return null;
  }

  const dimensions = alarm.Trigger?.Dimensions ?? [];
  const { service, ecsService } = resolveAffectedService(alarmName, dimensions);

  return buildActiveAlarmSpec({ alarmName, service, ...(ecsService ? { ecsService } : {}) });
}

/**
 * Pure severity gate: does `severity` meet or exceed `minSeverity`? Config
 * reads (e.g. `ALARM_TRIGGER_MIN_SEVERITY`) stay outside this module — the
 * caller supplies the threshold, this only orders the two values.
 */
export function meetsAlarmSeverityGate(severity: Severity, minSeverity: Severity): boolean {
  return maxSeverity(severity, minSeverity) === severity;
}
