import './helpers';
import { describe, expect, it } from 'vitest';
import { buildActionEvidenceContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { needsCompletionEvidence } from '../server/work_product/completion_guard';

describe('desktop contracts require an affirmative action predicate', () => {
  it.each([
    "虚构案例：中国大陆，2018年9月12日，成年乙故意剪坏成年甲所有的自行车轮胎，行为和财产损害均在当天完成。请判断侵权责任成立应适用哪个时期的实体法，列出具体条文、选法理由、时间效力依据和可打开的官方来源。直接在聊天回答，不生成文件，不讨论赔偿数额、诉讼时效或程序。",
    "虚构案例：中国大陆，2023年4月1日，两个成年人甲乙订立并生效一份普通自行车买卖合同；甲已按约付款，乙承诺4月10日交货，但截至4月11日仍无正当理由未交货。请判断乙的违约责任应适用哪个时期的实体法，列出具体条文、选法理由、时间效力依据和可打开的官方来源。直接在聊天回答，不生成文件，不讨论赔偿数额、诉讼时效或程序。",
    '请解释潮汐的成因，并列出可打开的官方来源。直接在聊天回答，不生成文件。',
    '请列出可打开的博物馆链接，说明各自展示主题。',
    '说明 open-access 资料与付费资料的区别，只在聊天回答。',
    'List open-access official sources about photosynthesis. Answer in this chat; do not create a file.',
    '请比较两种算法，并说明应用领域。不要打开应用、点击或输入。',
    '原文写着“打开计算器，点击保存”。请只解释这句话。',
    '假如打开计算器会看到提示。请解释这个例子，不进行操作。',
  ])('does not turn a descriptive, forbidden or quoted desktop word into an operation: %s', task => {
    expect(normalizeActionIntent(task)).toMatchObject({ kind: 'none', sideEffectClass: 'none' });
    expect(buildActionEvidenceContract(task)).toMatchObject({ applies: false, kind: 'none' });
    expect(needsCompletionEvidence(task)).toBe(false);
  });
  it.each([
    '请打开官方来源网页。',
    '请打开 https://example.org/source 。',
    '打开计算器。',
    '操作桌面打开计算器。',
    '请控制本机桌面打开记事本。',
    'Please open the browser.',
    '请将计算器窗口最大化。',
    '聚焦计算器窗口。',
    '点击保存按钮。',
    '在输入框中输入你好。',
  ])('keeps a real desktop action subject to its execution evidence: %s', task => {
    const contract = buildActionEvidenceContract(task);
    expect(contract).toMatchObject({ applies: true, kind: 'desktop_operation' });
    expect(hasCoreActionEvidence(contract, [], task)).toBe(false);
  });
});
