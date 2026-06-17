import { describe, it, expect } from 'vitest';
import { mitigateStage, restoreStage } from '../stages/stubs.js';
import type { StageInput } from '../types.js';

const mockInput: StageInput = {
  stage: 'Mitigate',
  timestamp: '2026-06-06T12:00:00Z',
};

describe('stage stubs', () => {
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

});
