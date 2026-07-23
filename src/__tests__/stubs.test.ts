import { describe, it, expect } from 'vitest';
import { restoreStage } from '../stages/stubs.js';
import type { StageInput } from '../types.js';

const mockInput: StageInput = {
  stage: 'Restore',
  timestamp: '2026-06-06T12:00:00Z',
};

describe('stage stubs', () => {
  it('Restore returns not_implemented', async () => {
    const result = await restoreStage(mockInput);

    expect(result.stage).toBe('Restore');
    expect(result.status).toBe('not_implemented');
  });
});
