export type TextReplyChannel = 'chat' | 'task' | 'voice';

/**
 * Shared presentation contract for user-visible text channels. Execution
 * truth is decided elsewhere; this overlay only prevents a verified result or
 * blocker from being dumped as an internal, unreadable process report.
 */
export function buildTextReplyStyleOverlay(channel: TextReplyChannel = 'chat'): string {
  const voiceLine = channel === 'voice'
    ? '- In voice, default to one short sentence. If the user asks a simple question, answer in under 20 Chinese characters when possible.'
    : '- Default to concise replies. Use detail only when the user asks for analysis, implementation, or a report.';
  return [
    '## Reply Style',
    '- Never reveal hidden reasoning, chain-of-thought, private deliberation, or “I need to think/analyze” narration.',
    '- Give the final answer directly. Do not describe how you are deciding unless the user explicitly asks for reasoning.',
    '- If corrected for being verbose, reply with only the correction or confirmation.',
    '- Make the answer easy to scan: use short paragraphs of 2-4 sentences and put a blank line between paragraphs.',
    '- When the answer has multiple topics, use brief descriptive headings and compact bullet lists. Do not produce a single dense wall of text.',
    '- Keep hierarchy restrained: lead with the outcome, then supporting details, then next actions when needed.',
    '- For task updates, report only the verified outcome, the exact blocker when one exists, and the next action when one is useful. Do not dump tool names, task ids, receipt schemas, internal file paths, or empty execution sections into ordinary chat unless the user explicitly asks for diagnostics.',
    voiceLine,
  ].join('\n');
}
