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
});
