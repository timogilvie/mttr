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

    expect(prompt).toContain('discover_log_groups');
    expect(prompt).toContain('query_logs');
    expect(prompt).toContain('get_metrics_and_alarms');
    expect(prompt).toContain('list_metrics');
    expect(prompt).toContain('find_alarms');
    expect(prompt).toContain('get_deployment_provenance');
  });

  it('requires tool attempts before declaring INSUFFICIENT_EVIDENCE', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('Do NOT return investigation_status INSUFFICIENT_EVIDENCE');
    expect(prompt).toContain('tool budget remaining');
    expect(prompt).toContain('unresolved_evidence_requirements');
    expect(prompt).toContain('Keep human-only work in recommended_next_investigation_steps');
  });

  it('instructs active drill-down for missing-metric observability incidents', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('missing or zero-datapoint metric');
    expect(prompt).toContain('Use list_metrics to recover the exact metric namespace');
    expect(prompt).toContain('metric-emission failure');
  });

  it('instructs use of the structured report window for tool evidence', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('report_context.window_start');
    expect(prompt).toContain('start_time/end_time');
    expect(prompt).toContain('Do not replace the report window');
  });

  it('instructs active log drill-down for high 4xx auth findings', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('high 4xx rate or AUTH_FAILURE');
    expect(prompt).toContain('break down 4xx responses by status code');
    expect(prompt).toContain('unauthorized');
    expect(prompt).toContain('forbidden');
  });

  it('encodes the output schema enums and mitigation gate', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('overall_assessment');
    expect(prompt).toContain('investigation_status');
    expect(prompt).toContain('semantics');
    expect(prompt).toContain('CONFIRMED_CUSTOMER_IMPACT');
    expect(prompt).toContain('DUPLICATE_EVIDENCE');
    expect(prompt).toContain('observability_reliability');
    expect(prompt).toContain('requires_more_evidence_before_mitigation');
    expect(prompt).toContain('NO_ACTIONABLE_INCIDENT');
  });

  it('instructs the model to distrust missing-data alarms without corroboration', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('treats missing data as breaching');
    expect(prompt).toContain('UNRELIABLE or PARTIAL');
    expect(prompt).toContain('not by itself confirmed customer impact');
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
