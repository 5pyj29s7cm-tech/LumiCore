import './helpers';
import { describe, expect, it } from 'vitest';
import { resolveWorkflowValue, validateWorkflowSteps } from '../server/workflows/runtime';

describe('workflow reference encoding at save and execution boundaries', () => {
  it.each(['{$inputRef:"inputs.sourcePath"}', '{"$stepOutputRef":"step_1"}', ' { "$secretRef": "inputs.key" }'])('rejects a reference saved as literal text: %s', value => {
    expect(() => validateWorkflowSteps([{ stepId: 'step_1', capabilityId: 'read_file', argumentsTemplate: { path: value } }])).toThrow('JSON objects');
    expect(() => resolveWorkflowValue({ path: value }, { sourcePath: 'C:/orders.csv' })).toThrow('JSON objects');
  });
  it('preserves actual nested references and ordinary text mentioning the notation', () => {
    const steps = validateWorkflowSteps([
      { stepId: 'step_1', capabilityId: 'read_file', argumentsTemplate: { path: { $inputRef: 'inputs.sourcePath' } } },
      { stepId: 'step_2', capabilityId: 'calculator', dependsOn: ['step_1'], argumentsTemplate: { csvText: { $stepOutputRef: 'step_1' } } },
    ]);
    expect(resolveWorkflowValue(steps[0].argumentsTemplate, { sourcePath: 'C:/orders.csv' })).toEqual({ path: 'C:/orders.csv' });
    const text = 'Documentation: {"$inputRef":"inputs.name"}';
    expect(resolveWorkflowValue(text, {})).toBe(text);
  });
});
