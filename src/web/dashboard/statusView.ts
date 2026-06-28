import type { DashboardStatus, StatusResponse } from './statusTypes.js';

export interface DashboardState {
  label: string;
  tone: DashboardStatus | 'stale';
  detail: string;
}

function formatRelative(value: string | null, nowMs = Date.now()): string {
  if (!value) {
    return 'never';
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }
  const deltaMs = Math.max(0, nowMs - timestamp);
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function summarizeStatus(status: StatusResponse): DashboardState {
  if (status.stale.worker || status.stale.report) {
    const staleParts = [
      status.stale.worker ? 'worker heartbeat' : null,
      status.stale.report ? 'report run' : null,
    ].filter(Boolean);
    return {
      label: 'Stale',
      tone: 'stale',
      detail: `${staleParts.join(' and ')} outside expected cadence`,
    };
  }

  if (status.status === 'red') {
    return {
      label: 'Red',
      tone: 'red',
      detail: `${status.openIncidents.length} open incident(s) need attention`,
    };
  }

  if (status.status === 'yellow') {
    return {
      label: 'Yellow',
      tone: 'yellow',
      detail: `${status.openIncidents.length} lower-severity issue(s) open`,
    };
  }

  return {
    label: 'Green',
    tone: 'green',
    detail: 'No open incidents',
  };
}

export function formatAge(value: string | null, nowMs = Date.now()): string {
  return formatRelative(value, nowMs);
}

export function severityTotal(status: StatusResponse): number {
  return Object.values(status.openIncidentCounts).reduce((sum, count) => sum + (count ?? 0), 0);
}
