export interface ReportWindow {
  label: string;
  generatedAt?: string | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
}

const GENERATED_RE = /^-\s*Generated:\s*`?([^`\n]+)`?/im;
const WINDOW_RE = /^-\s*Window:\s*(.+)$/im;
const EXACT_WINDOW_RE = /^-\s*Exact window:\s*`?([^`\n]+?)`?\s+to\s+`?([^`\n]+?)`?\s*$/im;

function parseIso(value: string): Date | null {
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeWindowStart(label: string, end: Date): Date | null {
  const normalized = label.trim().toLowerCase();
  const match = normalized.match(/^last\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = match[2];
  const millis =
    unit.startsWith('minute') ? amount * 60 * 1000 :
    unit.startsWith('hour') ? amount * 60 * 60 * 1000 :
    amount * 24 * 60 * 60 * 1000;

  return new Date(end.getTime() - millis);
}

export function extractReportWindow(report: string): ReportWindow | null {
  const exact = report.match(EXACT_WINDOW_RE);
  if (exact?.[1] && exact[2]) {
    const start = parseIso(exact[1]);
    const end = parseIso(exact[2]);
    if (start && end && start < end) {
      return {
        label: `${start.toISOString()} to ${end.toISOString()}`,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      };
    }
  }

  const windowLabel = report.match(WINDOW_RE)?.[1]?.trim();
  const generatedRaw = report.match(GENERATED_RE)?.[1]?.trim();
  if (!windowLabel) {
    return null;
  }

  const generated = generatedRaw ? parseIso(generatedRaw) : null;
  const start = generated ? relativeWindowStart(windowLabel, generated) : null;

  if (generated && start) {
    return {
      label: `${windowLabel} (${start.toISOString()} to ${generated.toISOString()})`,
      generatedAt: generated.toISOString(),
      startTime: start.toISOString(),
      endTime: generated.toISOString(),
    };
  }

  return {
    label: windowLabel,
    generatedAt: generated?.toISOString(),
  };
}

export function enrichReportWithExactWindow(report: string): string {
  if (EXACT_WINDOW_RE.test(report)) {
    return report;
  }

  const window = extractReportWindow(report);
  if (!window?.startTime || !window.endTime) {
    return report;
  }

  const match = report.match(WINDOW_RE);
  if (!match || match.index === undefined) {
    return report;
  }

  const lineEnd = report.indexOf('\n', match.index);
  const insertAt = lineEnd === -1 ? report.length : lineEnd;
  const exactLine = `\n- Exact window: \`${window.startTime}\` to \`${window.endTime}\``;
  return `${report.slice(0, insertAt)}${exactLine}${report.slice(insertAt)}`;
}
