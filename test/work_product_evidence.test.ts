import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkProductPlan, verifyWorkProduct } from '../server/work_product/supervisor';

describe('work product verification requires observed evidence', () => {
  it('checks the artifact before delivery without waiting for its own final reply', () => {
    const output = path.join(process.env.LUMI_DATA_DIR!, 'pre-delivery.txt');
    fs.writeFileSync(output, 'actual output');
    const plan = createWorkProductPlan({ userId: 'verification-user', task: 'Create a document', persist: false });
    expect(plan.acceptanceCriteria.some(item => item.includes('final answer'))).toBe(false);
    expect(plan.deliveryCriteria?.some(item => item.includes('final answer'))).toBe(true);
    const report = verifyWorkProduct({ userId: 'verification-user', task: plan.task, artifacts: [{ path: output }] });
    expect(report).toMatchObject({ status: 'pass', scope: 'work_product_evidence', taskCompletionOwner: 'shared_execution' });
    expect(verifyWorkProduct({ userId: 'verification-user', task: plan.task }).status).toBe('blocked');
  });
  it.each(['All tests pass', 'tests', 'The client action result is verified'])('does not accept a completion claim: %s', claim => {
    const result = verifyWorkProduct({
      userId: 'verification-user', task: 'Check the work',
      acceptanceCriteria: ['All tests pass', 'The client action result is verified'],
      completedCriteria: [claim],
    });
    expect(result.status).toBe('blocked');
    expect(result.passedCriteria).toEqual([]);
  });

  it('verifies a real artifact and rejects a missing one even when claimed complete', () => {
    const artifactPath = path.join(process.env.LUMI_DATA_DIR!, 'verified-output.txt');
    fs.writeFileSync(artifactPath, 'Observed output');
    const input = {
      userId: 'verification-user', task: 'Create a file',
      acceptanceCriteria: ['The file exists and is readable'],
      completedCriteria: ['The file exists and is readable'],
      artifacts: [{ path: artifactPath, requiredText: ['Observed output'] }],
    };
    expect(verifyWorkProduct(input).status).toBe('pass');
    fs.unlinkSync(artifactPath);
    expect(verifyWorkProduct(input).status).not.toBe('pass');
  });
});
