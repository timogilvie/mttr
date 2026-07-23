import type { DecisionResult, StageInput, StageResult } from '../types.js';

// Mitigate now has a real implementation in `stages/mitigate.ts` (it produces human-review
// proposals, not actions). Restore stays a stub: it only means something once a proposal has
// actually been applied, which nothing in this pipeline does yet.
export async function restoreStage(
  _input: StageInput,
  _decision?: DecisionResult
): Promise<StageResult> {
  return {
    stage: 'Restore',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
    data: { message: 'Restore stage is not implemented.' },
  };
}
