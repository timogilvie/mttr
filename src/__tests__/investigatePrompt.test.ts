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

  it('instructs the causal-evidence pivot for confirmed application errors', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('Causal-Evidence Pivot');
    expect(prompt).toContain('symptom confirmation');
    expect(prompt).toContain('CONFIRMED_INCIDENT');
    expect(prompt).toContain('causal_evidence.performed=true');
  });

  it('lists all seven causal-evidence categories', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('Failure concentration');
    expect(prompt).toContain('First-bad timestamp');
    expect(prompt).toContain('Adjacent error logs');
    expect(prompt).toContain('Deployment / config / runtime change correlation');
    expect(prompt).toContain('Task health');
    expect(prompt).toContain('Resource saturation');
    expect(prompt).toContain('Dependency health');
  });

  it('emphasizes generic, non-service-specific target resolution', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('This playbook is generic');
    expect(prompt).toContain('never only to a specific named service');
  });

  it('describes graceful degradation for missing or failed causal evidence', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('causal_evidence.missing');
    expect(prompt).toContain('never a reason to fail the investigation');
  });

  it('instructs the priority rule for next_highest_value_query', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('next_highest_value_query');
    expect(prompt).toContain(
      'dependency health, change/deploy correlation, first-bad timestamp, task health, resource saturation, failure concentration, adjacent logs'
    );
    expect(prompt).toContain('still non-empty');
  });

  it('instructs mitigation_confidence and confidence_justification', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('mitigation_confidence');
    expect(prompt).toContain('confidence_justification');
    expect(prompt).toContain('mitigation_confidence=high requires a corroborated causal chain');
  });

  it('encodes causal_evidence and mitigation fields in the output schema', () => {
    const prompt = buildInvestigatePrompt(sampleStep1);

    expect(prompt).toContain('"causal_evidence"');
    expect(prompt).toContain('"failure_concentration"');
    expect(prompt).toContain('"change_correlation"');
    expect(prompt).toContain('"task_health"');
    expect(prompt).toContain('"resource_saturation"');
    expect(prompt).toContain('"dependency_health"');
    expect(prompt).toContain('"next_highest_value_query"');
    expect(prompt).toContain('"mitigation_confidence": "high | medium | low"');
  });
});
