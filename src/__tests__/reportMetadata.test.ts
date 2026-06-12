import { describe, expect, it } from 'vitest';
import { enrichReportWithExactWindow, extractReportWindow } from '../report/reportMetadata.js';

describe('reportMetadata', () => {
  it('extracts an exact window from relative window and generated timestamp', () => {
    const report = [
      '# Health Report',
      '',
      '- Window: last 24 hours',
      '- Region: `us-east-1`',
      '- Generated: `2026-06-06T11:35:04.881055+00:00`',
    ].join('\n');

    const window = extractReportWindow(report);

    expect(window).toEqual({
      label:
        'last 24 hours (2026-06-05T11:35:04.881Z to 2026-06-06T11:35:04.881Z)',
      generatedAt: '2026-06-06T11:35:04.881Z',
      startTime: '2026-06-05T11:35:04.881Z',
      endTime: '2026-06-06T11:35:04.881Z',
    });
  });

  it('adds an exact window line to report markdown', () => {
    const report = [
      '# Health Report',
      '',
      '- Window: last 2 hours',
      '- Generated: `2026-06-06T11:35:04Z`',
    ].join('\n');

    expect(enrichReportWithExactWindow(report)).toContain(
      '- Exact window: `2026-06-06T09:35:04.000Z` to `2026-06-06T11:35:04.000Z`'
    );
  });

  it('does not duplicate an existing exact window', () => {
    const report = [
      '# Health Report',
      '',
      '- Window: last 2 hours',
      '- Exact window: `2026-06-06T09:35:04.000Z` to `2026-06-06T11:35:04.000Z`',
      '- Generated: `2026-06-06T11:35:04Z`',
    ].join('\n');

    expect(enrichReportWithExactWindow(report)).toBe(report);
  });
});
