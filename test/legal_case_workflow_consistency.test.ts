import { describe, expect, it } from 'vitest';
import { evaluateLegalCaseWorkflow } from '../shared/legal_case_workflow';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';

describe('legal case workflow consistency', () => {
  it('derives a stable workflow from persisted case evidence', () => {
    const workflow = evaluateLegalCaseWorkflow({
      party: '甲公司',
      notes: '案件事实：甲公司已经交付货物，乙公司逾期未支付货款。',
      materials: [
        {
          type: 'evidence',
          title: '证据目录',
          content: '营业执照；授权委托书；合同原件。证明目的：证明双方合同关系及履行事实。',
        },
        {
          type: 'note',
          title: '法律分析三段论',
          content: '大前提、小前提、涵摄结论。',
        },
        {
          type: 'contract',
          title: '合同审查报告',
          content: '现行有效法律硬门槛：通过\n来源登记表\n正式交付包已生成',
        },
      ],
    });

    expect(workflow.steps.find(step => step.key === 'identity')?.state).toBe('manual');
    expect(workflow.steps.find(step => step.key === 'facts')?.state).toBe('done');
    expect(workflow.steps.find(step => step.key === 'evidence')?.state).toBe('manual');
    expect(workflow.steps.find(step => step.key === 'reasoning')?.state).toBe('ready');
    expect(workflow.steps.find(step => step.key === 'reasoning')?.summary).toBe('尚未形成完整法律分析底稿');
    expect(workflow.steps.find(step => step.key === 'current-law')?.state).not.toBe('done');
    expect(workflow.steps.find(step => step.key === 'drafts')?.state).not.toBe('done');
    expect(workflow.steps.find(step => step.key === 'delivery')?.state).not.toBe('done');
    expect(workflow.readyForFormalDelivery).toBe(false);
  });

  it('does not infer source evidence or completed identity from a generated checklist', () => {
    const workflow = evaluateLegalCaseWorkflow({ title: 'Synthetic case', party: '甲公司 / 乙公司',
      notes: '【材料归档】文书包包含身份证、营业执照、付款事实和证据目录',
      materials: [{ id: 'generated', source: 'tool', type: 'evidence', title: '待补证清单',
        content: '缺身份证和营业执照；付款事实待核验；证据目录、原件尚未提供。' }] });
    expect(workflow.steps.find(step => step.key === 'identity')?.state).toBe('ready');
    expect(workflow.steps.find(step => step.key === 'facts')?.state).not.toBe('done');
    expect(workflow.steps.find(step => step.key === 'evidence')?.state).toBe('ready');
    expect(workflow.readyForFormalDelivery).toBe(false);
  });

  it('lets a blocking authority override otherwise completed work products', () => {
    const workflow = evaluateLegalCaseWorkflow({
      party: '乙公司',
      notes: '完整案件事实和时间线已经整理。',
      materials: [{
        type: 'contract',
        title: '合同审查报告',
        content: '正式交付包已生成\n现行有效法律硬门槛：未通过\n引用法条已废止',
      }],
    }, { currentLawGate: 'blocked' });

    expect(workflow.steps.find(step => step.key === 'current-law')?.state).toBe('blocked');
    expect(workflow.steps.find(step => step.key === 'delivery')?.state).toBe('blocked');
    expect(workflow.nextStep?.key).toBe('current-law');
    expect(workflow.readyForFormalDelivery).toBe(false);
  });

  it('keeps the server adapter on the shared evaluator', async () => {
    const LegalCases = await import('../server/org/legal_cases');
    const input = {
      party: '申请人',
      notes: '已经形成案件事实时间线、付款和履行情况。',
      materials: [{
        id: 'mat-1',
        type: 'evidence' as const,
        title: '证据目录',
        content: '身份证、授权委托书、证明目的、原件页码。',
        source: 'manual' as const,
        createdBy: 'test',
        createdAt: new Date().toISOString(),
      }],
    };

    expect(LegalCases.evaluateCaseWorkflow(input)).toEqual(evaluateLegalCaseWorkflow(input));
  });

  it('uses the latest verified check, expires it, and does not treat a research plan as retrieved sources', () => {
    const input = { title: 'test', materials: [{ id: 'draft', source: 'tool', type: 'pleading', content: '旧失败：正式交付包未生成。已废止。外部检索行动单：人民法院案例库。' }] };
    const basis = legalCaseSourceFingerprint(input);
    const runs = [{ tool: 'legal_finalize_delivery_package', ok: true, status: 'generated', basis, checkedAt: new Date().toISOString(), materialIds: ['draft'], artifacts: ['file.docx'], currentLawGate: 'passed' as const, reasoningLinked: true },
      { tool: 'legal_finalize_delivery_package', ok: false, status: 'blocked', basis, checkedAt: new Date().toISOString(), materialIds: [], artifacts: [], currentLawGate: 'blocked' as const }];
    const evaluated = evaluateLegalCaseWorkflow({ ...input, workflowRuns: runs });
    expect(evaluated.steps.find(s => s.key === 'current-law')?.state).toBe('done');
    expect(evaluated.steps.find(s => s.key === 'sources')?.state).not.toBe('done');
    expect(evaluateLegalCaseWorkflow({ ...input, workflowRuns: [{ ...runs[0], checkedAt: '2000-01-01' }] }).steps.find(s => s.key === 'current-law')?.state).not.toBe('done');
  });
});
