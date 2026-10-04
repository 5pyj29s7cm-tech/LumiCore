import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { executeEcommerceCustomerServiceDrafts } from '../server/industry/ecommerce_customer_service_drafts';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

const prompt = '内容与客服实机验收：仅使用以下已脱敏事实，不发送消息、不发布内容、不退款、不承诺赔偿。客户代号=C-***17；订单代号=O-***88；商品=DESK-01桌面收纳架；客户问题=收到后发现尺寸放不下，询问能否退款并补偿运费；店铺规则=签收7天内、未安装且包装完整可申请退货，运费承担需人工审核；品牌语气=简洁、诚恳、不承诺未批准结果。请分类工单、验证规则和隐私、生成客服回复草稿与一条不含承诺的FAQ内容草稿，列出风险、升级条件、持久任务编号和审批边界。';

describe('masked ecommerce customer-service drafts', () => {
  const generate = (issue: string, tone = '简洁') => executeEcommerceCustomerServiceDrafts({
    userId: 'audit-draft-user', domain: 'personal', requestId: 'draft-'+Math.random(),
    source: 'test', actionIntent: '客户代号=C-***17；订单代号=O-***88；商品=收纳架；客户问题='+issue+'；店铺规则=依凭证人工核验；品牌语气='+tone,
  } as any);
  it.each([
    ['需要开票', '开票咨询'], ['物流没有更新', '物流咨询'], ['商品破损', '质量问题'],
    ['想申请退款', '退款退货咨询'], ['尺寸放不下', '尺寸不适配'], ['问个未知情况', '未分类'],
  ])('classifies %s without inventing another issue', (issue, label) => {
    const receipt = generate(issue);
    expect(receipt.snapshot.classification).toContain(label);
    expect(receipt.message).toContain(label);
    if (label !== '尺寸不适配') expect(receipt.snapshot.classification).not.toContain('尺寸不适配');
  });
  it('redacts detected identifiers across persisted inputs and all generated fields', () => {
    const receipt=generate('联系13800000000，邮箱person@example.invalid，订单号：123456789012345678；地址：某某路123号');
    const result=JSON.stringify(receipt);
    for (const personal of ['13800000000','person@example.invalid','123456789012345678','某某路123号']) expect(result).not.toContain(personal);
    expect(receipt.privacyVerified).toBe(false);
    expect(receipt.snapshot.privacyReview).toMatchObject({uncheckedFields:['free_text_semantic_identity']});
    const task=getIndustryWorkflowTask({userId:'audit-draft-user',domain:'personal',orgId:''},receipt.taskId);
    expect(JSON.stringify(task)).not.toContain('13800000000');
  });
  it('applies the requested tone to the reply rather than just echoing a setting', () => {
    const formal=generate('需要开票','正式').snapshot.replyDraft;
    const warm=generate('需要开票','亲切').snapshot.replyDraft;
    expect(formal).toContain('尊敬的客户'); expect(warm).toContain('感谢您');
    expect(formal).not.toBe(warm);
  });


  it('persists conditional, privacy-safe drafts without an external action', () => {
    const userId = `customer_service_${Date.now()}`;
    const receipt = executeEcommerceCustomerServiceDrafts({
      userId,
      domain: 'personal',
      requestId: `customer_service_request_${Date.now()}`,
      conversationId: '',
      taskId: '',
      source: 'test',
      actionIntent: prompt,
    } as any);

    expect(receipt).toMatchObject({
      ok: true,
      status: 'verified',
      persisted: true,
      sourceBound: true,
      externalMutation: false,
      draftOnly: true,
      privacyVerified: false,
      snapshot: {
        customerAlias: 'C-***17',
        orderAlias: 'O-***88',
        product: 'DESK-01桌面收纳架',
      },
    });
    expect(receipt.message).toContain('客服回复草稿（未发送）');
    expect(receipt.message).toContain('FAQ 内容草稿（未发布）');
    expect(receipt.message).toContain('运费由谁承担以及是否补偿，均需人工审核');
    expect(receipt.message).toContain('无法预先承诺结果');
    expect(receipt.message).toContain('不要在公开渠道发送姓名、电话、详细地址');
    expect(receipt.message).toContain('本轮未执行上述任何动作');
    expect(receipt.message).not.toContain('已退款');
    expect(receipt.message).not.toContain('保证补偿');

    const task = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId);
    expect(task?.status).toBe('delivered');
    expect(task?.metadata?.workTakeoverVerification?.passed).toBe(true);
  });
});
