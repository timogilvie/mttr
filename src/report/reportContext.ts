import type { ReportContext } from '../types.js';

const WINDOW_LINE_RE = /^-\s*Window:\s*(.+)$/im;
const GENERATED_LINE_RE = /^-\s*Generated:\s*`?([^`\n]+)`?\s*$/im;
const RELATIVE_WINDOW_RE = /^last\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i;
const EXPLICIT_WINDOW_RE =
  /`?(\d{4}-\d{2}-\d{2}T[^\s`]+)`?\s+(?:to|through|-)\s+`?(\d{4}-\d{2}-\d{2}T[^\s`]+)`?/i;

function normalizeIsoTimestamp(raw: string): string | undefined {
  const trimmed = raw.trim();
  const normalized = trimmed.replace(
    /(\.\d{3})\d+(Z|[+-]\d{2}:?\d{2})$/,
    '$1$2'
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function relativeWindowStart(windowLabel: string, generatedAt: string): string | undefined {
  const match = windowLabel.trim().match(RELATIVE_WINDOW_RE);
  if (!match || !match[1] || !match[2]) {
    return undefined;
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const unit = match[2].toLowerCase();
  const minutes =
    unit.startsWith('minute') ? amount : unit.startsWith('hour') ? amount * 60 : amount * 1440;
  return new Date(new Date(generatedAt).getTime() - minutes * 60 * 1000).toISOString();
}

export function parseReportContext(report: string): ReportContext | undefined {
  const windowLabel = report.match(WINDOW_LINE_RE)?.[1]?.trim();
  const generatedAtRaw = report.match(GENERATED_LINE_RE)?.[1];
  const generatedAt = generatedAtRaw ? normalizeIsoTimestamp(generatedAtRaw) : undefined;

  const explicitWindow = windowLabel?.match(EXPLICIT_WINDOW_RE);
  const explicitStart = explicitWindow?.[1] ? normalizeIsoTimestamp(explicitWindow[1]) : undefined;
  const explicitEnd = explicitWindow?.[2] ? normalizeIsoTimestamp(explicitWindow[2]) : undefined;

  const windowEnd = explicitEnd ?? generatedAt;
  const windowStart =
    explicitStart ?? (windowLabel && generatedAt ? relativeWindowStart(windowLabel, generatedAt) : undefined);

  if (!windowLabel && !generatedAt && !windowStart && !windowEnd) {
    return undefined;
  }

  return {
    ...(windowLabel ? { window_label: windowLabel } : {}),
    ...(generatedAt ? { generated_at: generatedAt } : {}),
    ...(windowStart ? { window_start: windowStart } : {}),
    ...(windowEnd ? { window_end: windowEnd } : {}),
  };
}
