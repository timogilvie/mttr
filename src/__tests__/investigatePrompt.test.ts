import { describe, it, expect } from 'vitest';
import { buildInvestigatePrompt, PromptBuildError } from '../prompts/investigatePrompt.js';

describe('investigatePrompt', () => {
  const sampleStep1 = JSON.stringify({
    summary: 'No actionable incidents detected.',
    overall_severity: 'NONE',
    incidents: [],
    findings: [
      {
        title: 'High 4xx Error Rate in data-pipeline-api',
        classification: 'AUTH_FAILURE',
        severity: 'MEDIUM',
        confidence: 0.7,
        affected_services: ['data-pipeline-api'],
        evidence: ['60 4xx errors recorded in the ALB metrics.'],
        reason_not_incident: 'No supporting logs or alarms.',
      },
    ],
  });

  it('substitutes the Step 1 JSON', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('data-pipeline-api');
    expect(prompt).toContain('AUTH_FAILURE');
    expect(prompt).toContain(sampleStep1);
  });

  it('leaves no {{STEP_1_JSON}} token', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).not.toContain('{{STEP_1_JSON}}');
  });

  it('rejects empty input', () => {
    expect(() => buildInvestigatePrompt('')).toThrow(PromptBuildError);
  });

  it('rejects whitespace input', () => {
    expect(() => buildInvestigatePrompt('   \n  ')).toThrow(PromptBuildError);
  });

  it('describes the available read-only tools', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('query_logs');
    expect(prompt).toContain('get_metrics_and_alarms');
  });

  it('encodes the output schema enums and mitigation gate', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('overall_assessment');
    expect(prompt).toContain('investigation_status');
    expect(prompt).toContain('requires_more_evidence_before_mitigation');
    expect(prompt).toContain('NO_ACTIONABLE_INCIDENT');
  });

  it('instructs identifier carry-through and finding id synthesis', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('incident_id');
    expect(prompt).toContain('finding-<index>');
  });

  it('instructs anti-fabrication and exact service names', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('Do not fabricate');
    expect(prompt).toContain('Preserve service names exactly');
  });
});
