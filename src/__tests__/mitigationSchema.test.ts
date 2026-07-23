import { describe, expect, it } from 'vitest';
import { parseMitigationProposal } from '../validation/mitigationSchema.js';
import type { MitigationProposal } from '../types.js';

function valid(): MitigationProposal {
  return {
    incident_id: 'INC-1',
    title: 'High detector errors',
    action: 'Rotate the credential.',
    action_kind: 'credential_rotation',
    target: { kind: 'lambda_function', identifier: 'hokusai-detector' },
    addresses_cause: 'Downstream auth failure.',
    cause_confidence: 0.86,
    evidence_refs: ['403 errors.'],
    proposal_confidence: 'high',
    evidence_gaps: [],
    preconditions: [],
    rollback_plan: [],
    blast_radius: 'x',
    reversibility: 'manual',
    success_signal: { description: 'x', checks: [] },
    requires_human_approval: true,
  };
}

describe('mitigation proposal schema', () => {
  it('parses a well-formed proposal', () => {
    expect(parseMitigationProposal(valid())).not.toBeNull();
  });

  it('rejects a stored proposal that claims it does not need approval', () => {
    expect(parseMitigationProposal({ ...valid(), requires_human_approval: false })).toBeNull();
  });

  it('rejects an unknown action kind rather than rendering it', () => {
    expect(parseMitigationProposal({ ...valid(), action_kind: 'delete_everything' })).toBeNull();
  });

  it('rejects a malformed row', () => {
    expect(parseMitigationProposal(null)).toBeNull();
    expect(parseMitigationProposal({ incident_id: 'INC-1' })).toBeNull();
  });
});
