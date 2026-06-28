import type { TransitionEvent } from './statusTypes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function evidenceList(event: TransitionEvent, key: string): string[] {
  return stringList(event.evidence?.[key]);
}

export function evidenceText(event: TransitionEvent, key: string): string | null {
  const value = event.evidence?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function transitionType(event: TransitionEvent): string | null {
  return evidenceText(event, 'transition_type');
}

export function semanticSummary(event: TransitionEvent): string[] {
  const semantics = event.evidence?.['semantics'];
  if (!isRecord(semantics)) {
    return [];
  }
  const rows: string[] = [];
  for (const key of ['duplicate_of', 'upstream_of', 'downstream_of']) {
    const value = semantics[key];
    if (typeof value === 'string' && value.trim() !== '') {
      rows.push(`${key}: ${value}`);
    } else if (Array.isArray(value) && value.length > 0) {
      rows.push(`${key}: ${value.join(', ')}`);
    }
  }
  return rows;
}

export function verificationChecks(event: TransitionEvent): Array<Record<string, unknown>> {
  const checks = event.evidence?.['checks'];
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.filter(isRecord);
}
