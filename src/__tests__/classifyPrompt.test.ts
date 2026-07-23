import { describe, it, expect } from 'vitest';
import { buildClassifyPrompt, PromptBuildError } from '../prompts/classifyPrompt.js';

describe('classifyPrompt', () => {
  const sampleReport = '# Test Report\n\nSome content';

  it('substitutes the report', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).toContain('# Test Report');
    expect(prompt).toContain('Some content');
  });

  it('leaves no {{HEALTH_REPORT}} token', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).not.toContain('{{HEALTH_REPORT}}');
  });

  it('rejects empty input', () => {
    expect(() => buildClassifyPrompt('')).toThrow(PromptBuildError);
  });

  it('rejects whitespace input', () => {
    expect(() => buildClassifyPrompt('   \n  ')).toThrow(PromptBuildError);
  });

  it('asks for a stable signal key on both incidents and findings', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).toContain('## **Signal Keys**');
    expect(prompt).toContain('alarm:<exact-alarm-name>');
    expect(prompt).toContain('The same underlying condition MUST produce the same signal_key');
    // Once in the incident output schema, once in the finding output schema.
    expect(prompt.match(/"signal_key": ""/g)).toHaveLength(2);
  });

  it('forbids magnitude words inside a signal key', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).toContain('Never include magnitudes, counts, dates, or severity words.');
  });

  it('includes classification taxonomy', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).toContain('DEPLOYMENT_REGRESSION');
    expect(prompt).toContain('RESOURCE_EXHAUSTION');
    expect(prompt).toContain('AUTH_FAILURE');
  });

  it('includes severity definitions', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).toContain('NONE:');
    expect(prompt).toContain('LOW:');
    expect(prompt).toContain('MEDIUM:');
    expect(prompt).toContain('HIGH:');
    expect(prompt).toContain('CRITICAL:');
  });

  it('requires hard health signals to be classified as incidents', () => {
    const prompt = buildClassifyPrompt(sampleReport);

    expect(prompt).toContain('Any alarm listed in ALARM state is an actionable incident');
    expect(prompt).toContain('Any non-zero ALB 5xx count is an actionable incident');
    expect(prompt).toContain('zero liveness datapoints is not');
  });
});
