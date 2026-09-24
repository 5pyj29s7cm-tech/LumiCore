import type { LLMConfig } from './adapter';

/** Only controls optional reasoning effort, never routing or execution authority. */
export function resolveConversationModelConfig(text: string, config: LLMConfig): LLMConfig {
  if (config.thinkingMode !== undefined || !['relay', 'deepseek'].includes(config.provider)) return config;
  const current = String(text || '').trim();
  if (!current || current.length > 240) return config;
  // i18n-allow: Input recognition only. Ambiguous or analytical turns retain the configured reasoning.
  if (/分析|推理|计算|证明|比较|策略|诊断|合同|案件|法律|医疗|药物|投资|股票|自杀|自残|代码|附件|https?:|[A-Za-z]:[\\/]|\b(?:analy[sz]e|reason|calculate|prove|compare|diagnos|legal|medical|invest|suicid|code|attachment)\b/iu.test(current)) return config;
  // i18n-allow: Conservative social-chat recognition; this helper is called only after the no-tool boundary.
  const social = /^(?:你好|嗨|早上好|晚上好|谢谢|晚安|再见|hello|hi|thanks|good night)[。！!?？.\s]*$/iu.test(current)
    || /陪我(?:聊|说说话)|聊聊天|闲聊|安慰我|\b(?:keep me company|comfort me|small talk)\b/iu.test(current);
  return social ? { ...config, thinkingMode: 'disabled' } : config;
}
