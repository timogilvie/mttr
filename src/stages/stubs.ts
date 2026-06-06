import type { StageInput, StageResult } from '../types.js';

export async function investigateStage(_input: StageInput): Promise<StageResult> {
  return {
    stage: 'Investigate',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
  };
}

export async function mitigateStage(_input: StageInput): Promise<StageResult> {
  return {
    stage: 'Mitigate',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
  };
}

export async function restoreStage(_input: StageInput): Promise<StageResult> {
  return {
    stage: 'Restore',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
  };
}

export async function verifyStage(_input: StageInput): Promise<StageResult> {
  return {
    stage: 'Verify',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
  };
}
