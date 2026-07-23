import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ClassificationResult, Finding, Incident, Severity } from '../types.js';
import { deriveSignalKey } from './signalKey.js';

type ObservationType = 'incident' | 'finding';
type ObservationStatus = 'active' | 'resolved';

export interface ReportState {
  s3Uri: string;
  fingerprint: string;
  processedAt: string;
}

export interface ObservationState {
  key: string;
  type: ObservationType;
  title: string;
  classification: string;
  affectedServices: string[];
  severity: Severity;
  confidence: number;
  signature: string;
  status: ObservationStatus;
  firstSeen: string;
  lastSeen: string;
  lastChangedAt: string;
  occurrences: number;
  resolvedAt?: string;
}

export interface AgentState {
  version: 1;
  lastReport?: ReportState;
  observations: Record<string, ObservationState>;
}

export interface ObservationReconciliation {
  newObservations: ObservationState[];
  changedObservations: ObservationState[];
  recurringObservations: ObservationState[];
  resolvedObservations: ObservationState[];
  shouldInvestigate: boolean;
}

interface CurrentObservation {
  key: string;
  type: ObservationType;
  title: string;
  classification: string;
  affectedServices: string[];
  severity: Severity;
  confidence: number;
  signature: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function emptyAgentState(): AgentState {
  return { version: 1, observations: {} };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeServices(services: string[]): string[] {
  return [...services].map(normalizeText).sort();
}

/**
 * Identity for an observation across reports.
 *
 * Prefers the signal key (`state/signalKey.ts`) — a name for the monitored signal rather than for
 * this occurrence of it. That deliberately drops `type`, `title` and `classification` from the
 * hash: the same condition must keep one identity when the model rewords the title, re-grades an
 * incident as a finding, or picks a different taxonomy bucket.
 *
 * Falls back to the legacy title hash when neither an alarm nor a declared `signal_key` is
 * available, so a Classify response that omits the field degrades to the previous behaviour
 * instead of collapsing unrelated observations together.
 */
export function canonicalObservationKey(type: ObservationType, item: Incident | Finding): string {
  const signalKey = deriveSignalKey(item);
  if (signalKey) {
    return stableHash({ version: 2, signalKey: signalKey.key });
  }

  return stableHash({
    type,
    title: normalizeText(item.title),
    classification: item.classification,
    affectedServices: normalizeServices(item.affected_services),
  });
}

function observationSignature(type: ObservationType, item: Incident | Finding): string {
  const incidentFields =
    type === 'incident'
      ? {
          signals: (item as Incident).signals,
          suspectedCauses: (item as Incident).suspected_causes,
          investigationPlan: (item as Incident).investigation_plan,
        }
      : {};

  return stableHash({
    type,
    title: item.title,
    classification: item.classification,
    affectedServices: item.affected_services,
    severity: item.severity,
    confidence: item.confidence,
    evidence: item.evidence,
    ...incidentFields,
  });
}

function toCurrentObservation(type: ObservationType, item: Incident | Finding): CurrentObservation {
  return {
    key: canonicalObservationKey(type, item),
    type,
    title: item.title,
    classification: item.classification,
    affectedServices: item.affected_services,
    severity: item.severity,
    confidence: item.confidence,
    signature: observationSignature(type, item),
  };
}

function currentObservations(classification: ClassificationResult): CurrentObservation[] {
  return [
    ...classification.incidents.map((incident) => toCurrentObservation('incident', incident)),
    ...classification.findings.map((finding) => toCurrentObservation('finding', finding)),
  ];
}

function freshObservation(current: CurrentObservation, now: string): ObservationState {
  return {
    ...current,
    status: 'active',
    firstSeen: now,
    lastSeen: now,
    lastChangedAt: now,
    occurrences: 1,
  };
}

export function hashReportContent(report: string): string {
  return createHash('sha256').update(report).digest('hex');
}

export async function loadAgentState(path: string): Promise<AgentState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as AgentState;
    if (parsed.version !== 1 || typeof parsed.observations !== 'object') {
      return emptyAgentState();
    }
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return emptyAgentState();
    }
    console.warn(
      `[State] Could not read ${path}; starting with empty state: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return emptyAgentState();
  }
}

export async function saveAgentState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function hasProcessedReport(
  state: AgentState,
  s3Uri: string,
  fingerprint: string
): boolean {
  return state.lastReport?.s3Uri === s3Uri && state.lastReport.fingerprint === fingerprint;
}

export function recordProcessedReport(
  state: AgentState,
  s3Uri: string,
  fingerprint: string,
  now: string
): void {
  state.lastReport = { s3Uri, fingerprint, processedAt: now };
}

export interface ReconcileOptions {
  /**
   * When true, the classification is a partial snapshot (e.g. an alarm-triggered batch that
   * synthesizes incidents only for the alarms in flight). Active observations whose keys aren't
   * in the current classification are left as-is instead of being auto-marked 'resolved'. Only
   * the complete-report path may pass `false` (the default).
   */
  partial?: boolean;
}

export function reconcileObservations(
  state: AgentState,
  classification: ClassificationResult,
  now: string,
  options: ReconcileOptions = {}
): ObservationReconciliation {
  const { partial = false } = options;
  const newObservations: ObservationState[] = [];
  const changedObservations: ObservationState[] = [];
  const recurringObservations: ObservationState[] = [];
  const resolvedObservations: ObservationState[] = [];
  const seenKeys = new Set<string>();

  for (const current of currentObservations(classification)) {
    seenKeys.add(current.key);
    const previous = state.observations[current.key];

    if (!previous || previous.status === 'resolved') {
      const next = freshObservation(current, now);
      state.observations[current.key] = next;
      newObservations.push(next);
      continue;
    }

    const severityEscalated = SEVERITY_RANK[current.severity] > SEVERITY_RANK[previous.severity];
    const materiallyChanged = previous.signature !== current.signature || severityEscalated;
    const next: ObservationState = {
      ...previous,
      ...current,
      status: 'active',
      firstSeen: previous.firstSeen,
      lastSeen: now,
      lastChangedAt: materiallyChanged ? now : previous.lastChangedAt,
      occurrences: previous.occurrences + 1,
    };

    state.observations[current.key] = next;

    if (materiallyChanged) {
      changedObservations.push(next);
    } else {
      recurringObservations.push(next);
    }
  }

  if (!partial) {
    for (const previous of Object.values(state.observations)) {
      if (previous.status === 'active' && !seenKeys.has(previous.key)) {
        const resolved: ObservationState = {
          ...previous,
          status: 'resolved',
          resolvedAt: now,
          lastChangedAt: now,
        };
        state.observations[previous.key] = resolved;
        resolvedObservations.push(resolved);
      }
    }
  }

  return {
    newObservations,
    changedObservations,
    recurringObservations,
    resolvedObservations,
    shouldInvestigate: newObservations.length > 0 || changedObservations.length > 0,
  };
}
