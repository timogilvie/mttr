import { describe, expect, it } from 'vitest';
import { parseReportContext } from '../report/reportContext.js';

describe('parseReportContext', () => {
  it('derives an absolute window from relative label and generated timestamp', () => {
    const context = parseReportContext(`# Hokusai Service Health Report

- Window: last 24 hours
- Region: \`us-east-1\`
- Generated: \`2026-06-06T11:35:04.881055+00:00\`
`);

    expect(context).toEqual({
      window_label: 'last 24 hours',
      generated_at: '2026-06-06T11:35:04.881Z',
      window_start: '2026-06-05T11:35:04.881Z',
      window_end: '2026-06-06T11:35:04.881Z',
    });
  });

  it('uses explicit ISO window bounds when present', () => {
    const context = parseReportContext(`# Report

- Window: \`2026-06-06T10:00:00Z\` to \`2026-06-06T11:00:00Z\`
- Generated: \`2026-06-06T11:05:00Z\`
`);

    expect(context?.window_start).toBe('2026-06-06T10:00:00.000Z');
    expect(context?.window_end).toBe('2026-06-06T11:00:00.000Z');
    expect(context?.generated_at).toBe('2026-06-06T11:05:00.000Z');
  });

  it('returns undefined when no context is available', () => {
    expect(parseReportContext('# Report')).toBeUndefined();
  });
});
