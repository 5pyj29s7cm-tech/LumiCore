import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getDataDirectory } from '../server/config/data_path';
import { draftContractHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { contractPromptSources, sdkCompletionFixture } from './legal_contract_fixture';
const details = "以下全部为程序验收用虚构条件，不是真实交易：虚构曜辰设备有限公司与虚构澄月咨询有限公司拟开展双向保密合作。双方互负保密义务，合作无偿，不设付款、实物交付验收或担保义务。仅处理双方在合作评估中披露且明确标示的保密资料；公开信息不在范围内。保密期限为签署后两年。具体签署日期、争议解决地点、签章代表和违约损失数额均未确认，必须保持待双方确认。不得自称已签署、已查验主体登记、法条已核验或具备正式使用条件。";
// A deliberately compliant synthetic response, NOT captured upstream JSON.
// The live run retained only the final rendered body; semantic model failures stay separate.
const fixedReply = {
  "complete": true,
  "entries": [
    {
      "sectionId": "主体与角色",
      "sourceIds": [
        "F2"
      ],
      "response": "虚构曜辰设备有限公司与虚构澄月咨询有限公司均可作为信息披露方或接收方，双方互负保密义务；其主体登记未查验。",
      "missing": "签章代表待双方确认。"
    },
    {
      "sectionId": "合同目的与范围",
      "sourceIds": [
        "F2"
      ],
      "response": "仅处理双方在合作评估中披露且明确标示的保密资料；公开信息和未明确标示资料不在本协议保护范围内。",
      "missing": ""
    },
    {
      "sectionId": "双方权利义务",
      "sourceIds": [
        "F2"
      ],
      "response": "双方仅为合作评估目的使用保密资料，不擅向未经许可的第三方披露，并采取合理保密措施；未确认的其他安排不作为已约定。",
      "missing": ""
    },
    {
      "sectionId": "履行与期限",
      "sourceIds": [
        "F2"
      ],
      "response": "保密期限为签署后两年。具体签署日期待双方确认，不以程序创建日期代替；协议尚未实际签署。",
      "missing": "具体签署日期待双方确认。"
    },
    {
      "sectionId": "对价与费用适用性",
      "sourceIds": [
        "F2"
      ],
      "response": "合作无偿，不设付款、实物交付验收或担保义务；无须为本协议约定价款或付款期限。",
      "missing": ""
    },
    {
      "sectionId": "责任、终止与争议处理",
      "sourceIds": [
        "F2"
      ],
      "response": "违约损失数额和争议解决地点待双方确认，未擅选法院、仲裁地或固定赔偿金额；仅列为待确认安排。",
      "missing": "争议解决地点和违约损失数额待双方确认。"
    },
    {
      "sectionId": "签署、生效与待确认事项",
      "sourceIds": [
        "F2"
      ],
      "response": "签署日期、争议解决地点、签章代表和违约损失数额均待双方确认。本稿未经律师核准，不代表已签署、已核验法条或正式可用。",
      "missing": "签署日期、争议解决地点、签章代表和违约损失数额均待双方确认。"
    }
  ]
};
const create = vi.fn(async (request: any) => sdkCompletionFixture(JSON.stringify(fixedReply), 'stop', request.stream));
const userId = 'synthetic-known-contract-terms-owner';
const ledgerSnapshot = () => { const file = path.join(getDataDirectory('org'), 'legal_cases.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
beforeAll(async () => {
  await (await import('../db_layer')).initDatabase();
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-compliant-nda', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
});
it('preserves confirmed gratuitous two-year terms through the actual handler without reclassifying them as missing at the footer', async () => {
  const before = ledgerSnapshot();
  const result = await draftContractHandler({ type: '无偿双向保密协议', details, persistCase: false, caseName: '虚构已知条款页尾验收' }, {
    userId, domain: 'personal', requestId: 'synthetic-known-contract-terms',
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) },
  });
  expect(result).toContain('合作无偿，不设付款、实物交付验收或担保义务');
  expect(result).toContain('保密期限为签署后两年');
  expect(result).not.toContain('价款、期限');
  expect(result).toContain('签署日期、争议解决地点、签章代表和违约损失数额均待双方确认');
  expect(result).toContain('未归档（persistCase=false）');
  expect(ledgerSnapshot()).toBe(before);
  expect(create).toHaveBeenCalledTimes(1);
  const prompt = create.mock.calls[0][0].messages.map((message: any) => String(message.content)).join('\n');
  expect(prompt).toContain('生效条件按已给要求统一写明，不另加不同的签署或签章条件');
});

beforeEach(() => { create.mockClear(); });

it('does not turn empty section gaps into seven generic pending statements through the actual handler', async () => {
  const reply = { ...fixedReply, entries: fixedReply.entries.map(entry => ({ ...entry, missing: '' })) };
  create.mockImplementationOnce(async (request: any) => sdkCompletionFixture(JSON.stringify(reply), 'stop', request.stream));
  const before = ledgerSnapshot();
  const result = await draftContractHandler({ type: '无偿双向保密协议', details, persistCase: false }, {
    userId, domain: 'personal', requestId: 'synthetic-empty-contract-gaps',
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) },
  });
  const body = result.split('## 起草来源')[0];
  expect(body).not.toContain('模型未列其他条件');
  expect(body).not.toContain('待核对：');
  for (const entry of reply.entries) expect(body).toContain(entry.response);
  expect(body).toContain('虚构曜辰设备有限公司与虚构澄月咨询有限公司');
  expect(body).toContain('仅处理双方在合作评估中披露且明确标示的保密资料');
  expect(body).toContain('交易事实与法律仍待核对，不代表正式核验通过');
  expect(result).toContain('未归档（persistCase=false）');
  expect(ledgerSnapshot()).toBe(before);
  expect(create).toHaveBeenCalledTimes(1);
  const input = create.mock.calls[0][0].messages.map((message: any) => String(message.content)).join('\n');
  expect(contractPromptSources(input).find(source => source.id === 'F2')?.quote).toBe(details);
});
it('renders the one actual missing condition once without adding gaps to the other sections', async () => {
  const reply = { ...fixedReply, entries: fixedReply.entries.map((entry, index) => ({ ...entry, missing: index === 0 ? '仅签章代表待双方确认。' : '' })) };
  create.mockImplementationOnce(async (request: any) => sdkCompletionFixture(JSON.stringify(reply), 'stop', request.stream));
  const before = ledgerSnapshot();
  const result = await draftContractHandler({ type: '无偿双向保密协议', details, persistCase: false }, {
    userId, domain: 'personal', requestId: 'synthetic-one-contract-gap',
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) },
  });
  const body = result.split('## 起草来源')[0];
  expect(body.match(/待核对：/g)).toHaveLength(1);
  expect(body).toContain('待核对：仅签章代表待双方确认。');
  expect(body).not.toContain('模型未列其他条件');
  expect(body).toContain('合作无偿，不设付款、实物交付验收或担保义务');
  expect(body).toContain('保密期限为签署后两年');
  expect(body).toContain('具体签署日期待双方确认');
  expect(ledgerSnapshot()).toBe(before);
  expect(create).toHaveBeenCalledTimes(1);
});
