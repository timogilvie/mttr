import { describe, it, expect } from 'vitest';
import {
  investigateStage,
  mitigateStage,
  restoreStage,
  verifyStage,
} from '../stages/stubs.js';
import type { StageInput } from '../types.js';

const mockInput: StageInput = {
  stage: 'Investigate',
  timestamp: '2026-06-06T12:00:00Z',
};

describe('stage stubs', () => {
  it('Investigate returns not_implemented', async () => {
    const result = await investigateStage(mockInput);

    expect(result.stage).toBe('Investigate');
    expect(result.status).toBe('not_implemented');
  });

  it('Mitigate returns not_implemented', async () => {
    const result = await mitigateStage(mockInput);

    expect(result.stage).toBe('Mitigate');
    expect(result.status).toBe('not_implemented');
  });

  it('Restore returns not_implemented', async () => {
    const result = await restoreStage(mockInput);

    expect(result.stage).toBe('Restore');
    expect(result.status).toBe('not_implemented');
  });

  it('Verify returns not_implemented', async () => {
    const result = await verifyStage(mockInput);

    expect(result.stage).toBe('Verify');
    expect(result.status).toBe('not_implemented');
  });
});
