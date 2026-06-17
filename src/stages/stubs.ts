import type { DecisionResult, StageInput, StageResult } from '../types.js';

export async function mitigateStage(
  _input: StageInput,
  _decision?: DecisionResult
): Promise<StageResult> {
  return {
    stage: 'Mitigate',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
    data: { message: 'Mitigate stage is not implemented.' },
  };
}

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
