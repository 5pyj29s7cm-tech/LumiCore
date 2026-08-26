import { describe, expect, it } from 'vitest';
import {
  buildDeterministicLocalArtifactPlan,
  hasUnresolvedDependencyPlaceholder,
  mergeResolvedDependentArgs,
} from '../server/agents/nl_chainer';

describe('NL chainer dependency binding', () => {
  it('replaces dependent content while preserving the planned destination', () => {
    const planned = {
      path: 'C:\\Users\\test-user\\Documents\\report.md',
      content: '\uff08\u6839\u636e\u6e90\u6587\u4ef6\u5185\u5bb9\u586b\u5199\uff09',
    };
    const resolved = mergeResolvedDependentArgs(
      planned,
      {
        path: 'C:\\Users\\test-user\\Documents\\wrong.md',
        content: '# \u9a8c\u6536\u62a5\u544a\n\n\u9a8c\u6536\u4ee3\u53f7\uff1a\u9752\u7a79-17',
        unexpected: 'discard me',
      },
      ['path', 'content'],
    );

    expect(resolved.path).toBe(planned.path);
    expect(resolved.content).toContain('\u9a8c\u6536\u4ee3\u53f7\uff1a\u9752\u7a79-17');
    expect(resolved).not.toHaveProperty('unexpected');
    expect(hasUnresolvedDependencyPlaceholder(resolved)).toBe(false);
  });

  it.each([
    { content: '\uff08\u6839\u636e\u6e90\u6587\u4ef6\u5185\u5bb9\u586b\u5199\uff09' },
    { body: '\u5f85\u8865\u5145' },
    { text: '{{previousOutput}}' },
    { markdown: 'TODO' },
  ])('detects unresolved dependency placeholders: %j', args => {
    expect(hasUnresolvedDependencyPlaceholder(args)).toBe(true);
  });

  it('builds a fixed read, write, readback plan for a source-grounded local artifact', () => {
    const source = 'C:\\Users\\test-user\\Documents\\source.txt';
    const target = 'C:\\Users\\test-user\\Documents\\report.md';
    const plan = buildDeterministicLocalArtifactPlan(
      `\u8bf7\u5148\u8bfb\u53d6 ${source}\uff0c\u4ee5\u6e90\u6587\u4ef6\u771f\u5b9e\u5185\u5bb9\u4e3a\u552f\u4e00\u6765\u6e90\uff0c\u5728 ${target} \u521b\u5efa\u62a5\u544a\uff0c\u5199\u5165\u540e\u91cd\u65b0\u8bfb\u53d6\u3002`,
      [{ name: 'read_file' }, { name: 'write_file' }],
    );

    expect(plan?.steps.map(step => step.toolName)).toEqual(['read_file', 'write_file', 'read_file']);
    expect(plan?.steps[0].toolArgs.path).toBe(source);
    expect(plan?.steps[1].toolArgs.path).toBe(target);
    expect(plan?.steps[1].dependsOnOutput).toBeTruthy();
    expect(plan?.steps[2].toolArgs.path).toBe(target);
  });
});
