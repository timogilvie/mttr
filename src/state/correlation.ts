import type {
  ClassificationResult,
  CloudWatchMetricSignal,
  Finding,
  Incident,
  IncidentSignals,
  Severity,
} from '../types.js';
import { normalizeSignalKey } from './signalKey.js';

type ClassificationItem =
  | { kind: 'incident'; item: Incident; index: number }
  | { kind: 'finding'; item: Finding; index: number };

const SEVERITY_RANK: Record<Severity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function metricIdentity(metric: CloudWatchMetricSignal): string {
  const dimensions = metric.dimensions
    .map(({ name, value }) => `${name}=${value}`)
    .sort()
    .join('|');
  return `metric:${metric.namespace}|${metric.metric_name}|${dimensions}`;
}

function signalsFor(item: Incident | Finding): IncidentSignals | undefined {
  return 'signals' in item ? item.signals : undefined;
}

/**
 * Exact, infrastructure-owned identities only. Deliberately do not derive keys from service
 * names, titles, generic signal keys, or LLM duplicate semantics: those are correlation
 * candidates, not proof that two records represent the same monitored condition.
 */
export function exactCloudWatchIdentities(item: Incident | Finding): string[] {
  const identities = new Set<string>();
  const declaredKey = item.signal_key ? normalizeSignalKey(item.signal_key) : '';
  if (declaredKey.startsWith('alarm:')) {
    identities.add(declaredKey);
  }

  const signals = signalsFor(item);
  for (const alarm of signals?.alarms ?? []) {
    const normalized = normalizeSignalKey(`alarm:${alarm}`);
    if (normalized !== '') {
      identities.add(normalized);
    }
  }
  for (const metric of signals?.cloudwatch_metrics ?? []) {
    identities.add(metricIdentity(metric));
  }
  return [...identities].sort();
}

function union(parent: number[], a: number, b: number): void {
  const root = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current] as number] as number;
      current = parent[current] as number;
    }
    return current;
  };
  const rootA = root(a);
  const rootB = root(b);
  if (rootA !== rootB) {
    parent[rootB] = rootA;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function mergeSignals(items: ClassificationItem[]): IncidentSignals {
  const signals = items.flatMap((entry) => {
    const itemSignals = signalsFor(entry.item);
    return itemSignals ? [itemSignals] : [];
  });
  const cloudwatchMetrics = signals.flatMap((value) => value.cloudwatch_metrics ?? []);
  return {
    alarms: unique(signals.flatMap((value) => value.alarms)),
    metrics: unique(signals.flatMap((value) => value.metrics)),
    logs: unique(signals.flatMap((value) => value.logs)),
    ...(cloudwatchMetrics.length > 0 ? { cloudwatch_metrics: cloudwatchMetrics } : {}),
  };
}

function mergeEvidence(canonical: ClassificationItem, members: ClassificationItem[]): string[] {
  const evidence = [...canonical.item.evidence];
  for (const member of members) {
    if (member === canonical) {
      continue;
    }
    evidence.push(`Correlated observation: ${member.item.title}.`);
    evidence.push(...member.item.evidence);
  }
  return unique(evidence);
}

function canonicalMember(members: ClassificationItem[]): ClassificationItem {
  return [...members].sort((a, b) => {
    // Preserve an incident over a finding so the output stays actionable and retains an
    // investigation plan. Within a kind, keep the most severe/highest-confidence item.
    if (a.kind !== b.kind) {
      return a.kind === 'incident' ? -1 : 1;
    }
    const severity = SEVERITY_RANK[b.item.severity] - SEVERITY_RANK[a.item.severity];
    if (severity !== 0) {
      return severity;
    }
    return b.item.confidence - a.item.confidence || a.index - b.index;
  })[0] as ClassificationItem;
}

/**
 * Collapse only records proven to describe the same CloudWatch alarm or the same fully-qualified
 * CloudWatch metric. This happens before Investigate, so one tool budget and one investigation
 * are spent on the shared signal. It intentionally leaves all weaker correlations untouched.
 */
export function collapseExactCloudWatchDuplicates(
  classification: ClassificationResult
): ClassificationResult {
  const items: ClassificationItem[] = [
    ...classification.incidents.map((item, index) => ({ kind: 'incident' as const, item, index })),
    ...classification.findings.map((item, index) => ({
      kind: 'finding' as const,
      item,
      index: classification.incidents.length + index,
    })),
  ];
  const parent = items.map((_, index) => index);
  const firstByIdentity = new Map<string, number>();

  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index] as ClassificationItem;
    for (const identity of exactCloudWatchIdentities(entry.item)) {
      const first = firstByIdentity.get(identity);
      if (first === undefined) {
        firstByIdentity.set(identity, index);
      } else {
        union(parent, first, index);
      }
    }
  }

  const root = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      current = parent[current] as number;
    }
    return current;
  };
  const groups = new Map<number, ClassificationItem[]>();
  for (let index = 0; index < items.length; index += 1) {
    const groupRoot = root(index);
    groups.set(groupRoot, [...(groups.get(groupRoot) ?? []), items[index] as ClassificationItem]);
  }

  const incidents: Incident[] = [];
  const findings: Finding[] = [];
  for (const members of groups.values()) {
    const canonical = canonicalMember(members);
    const affectedServices = unique(members.flatMap((member) => member.item.affected_services));
    const evidence = mergeEvidence(canonical, members);
    if (canonical.kind === 'incident') {
      incidents.push({
        ...canonical.item,
        severity: members.reduce(
          (severity, member) =>
            SEVERITY_RANK[member.item.severity] > SEVERITY_RANK[severity]
              ? member.item.severity
              : severity,
          canonical.item.severity
        ),
        confidence: Math.max(...members.map((member) => member.item.confidence)),
        affected_services: affectedServices,
        evidence,
        signals: mergeSignals(members),
      });
    } else {
      findings.push({ ...canonical.item, affected_services: affectedServices, evidence });
    }
  }

  return { ...classification, incidents, findings };
}
