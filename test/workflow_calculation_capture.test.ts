import { describe, expect, it } from 'vitest';
import { workflowTransformationBlocker } from '../server/skills/worklog';
describe('calculation workflow capture', () => {
  const reader = { name: 'read_file', operation: 'observe', args: { path: { $inputRef: 'inputs.sourcePath' } } };
  it('rejects the old read-then-write pattern with a fixed previous total', () => {
    expect(workflowTransformationBlocker('calculate order total', [reader,
      { name: 'write_file', operation: 'create', args: { content: 'total,72' } },
    ], true)).toMatch(/input-dependent calculation/);
  });
  it('accepts an executable calculation bound to fresh input, while rejecting embedded previous data', () => {
    const calculation = { name: 'code_execution', operation: 'test', args: { code: 'input.quantity * input.price', input: { $stepOutputRef: 'step_1' } } };
    expect(workflowTransformationBlocker('calculate order total', [reader, calculation], true)).toBeNull();
    expect(workflowTransformationBlocker('calculate order total', [reader,
      { ...calculation, args: { code: '4 * 18' } },
    ], true)).toMatch(/input-dependent calculation/);
    expect(workflowTransformationBlocker('calculate order total', [reader,
      { name: 'mcp_calculator_calculate_csv', operation: 'observe', args: { csvText: { $stepOutputRef: 'step_1' } } },
    ], true)).toBeNull();
  });
});
