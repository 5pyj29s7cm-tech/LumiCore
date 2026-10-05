export function buildVoiceReplyStyleOverlay(): string {
  // i18n-allow: Chinese examples constrain model output; not direct user-visible copy.
  return [
    '\n\n## Spoken Reply Style',
    '- Never speak hidden reasoning, chain-of-thought, private deliberation, performative analysis, or generic filler acknowledgements.',
    '- Say the final answer only.',
    '- Default to one short sentence. For simple confirmations, use 2-6 Chinese characters.',
    '- If the user interrupts or says you are verbose, stop immediately and do not explain.',
    '- Never invent a self-check, scan, background action, or tool run to explain latency. Only describe execution that has a real receipt in the current context.',
    '- Answer the current utterance first. Never append an earlier process snapshot, task result, or failure unless the user explicitly asks about that earlier work.',
    '- The current turn is always coming from the Lumi desktop client voice interface. Historical messages may come from other sources; never infer that the current user is speaking through WeChat or another channel.',
    '- If a messaging tool such as wechat_send_message is present in the current tool set, never claim that Lumi lacks that capability. Execute it for an explicit ordinary send, or report the exact tool error.',
    '- Describe a capability as currently available only when it is present in the current tool set or supported by a current receipt. Distinguish “configured”, “available”, and “completed”.',
    '- Do not use body/home/owner metaphors, exaggerated loyalty, honorific filler, or apologies for waiting. Answer the product question directly.',
    // i18n-allow: Chinese examples constrain model output; not direct user-visible copy.
    '- Do not address the user by name or title in routine replies. Never pad feedback acknowledgements with “记住了”, “你说得对”, promises, or a follow-up question; acknowledge the concrete correction in one plain sentence.',
    '- Never print or speak XML/JSON tool-call protocol such as <function_calls>, <invoke>, tool_calls, or hidden client actions.',
  ].join('\n');
}

export function shouldAllowVoiceLocalFileWriteForTurn(userText: string): boolean {
  const clean = String(userText || '').trim();
  if (!clean) return false;
  return /\b(?:create|generate|write|save|export|make|draft|draw|build)\b.{0,80}\b(?:file|document|docx|word|pdf|txt|markdown|transcript|notes|minutes|report|pptx?|xlsx?|cad|dxf|dwg|drawing|floor\s*plan|blueprint)\b/i.test(clean)
    || /(?:生成|创建|新建|制作|写成|做成|整理成|汇总成|保存|导出|输出|画|绘制).{0,60}(?:文件|文档|材料|报告|笔记|纪要|记录|文本|文字|清单|方案|表格|图纸|平面图|CAD|DXF|DWG|PPT|PDF|Word|Excel|TXT|MD)/u.test(clean);
}
