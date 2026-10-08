import { uiMessage } from '../i18n/uiMessages';
import { executionFeedbackCopy } from '../i18n/locales/executionFeedback';
import { isAgentResponseWaitingConfirmation, isAgentResponseTerminalNotice, type AgentResponseDelivery } from './agentResponseDelivery';

export type ChatProgressTone = 'thinking' | 'tool' | 'done' | 'error' | 'confirmation';

export type ChatProgressLine = {
  id: string;
  text: string;
  tone: ChatProgressTone;
  time: number;
};

export type ToolProgressPhase = 'start' | 'result' | 'error';

export type ChatResponseFinalization = Pick<AgentResponseDelivery, 'finalized' | 'blocked' | 'reason' | 'status'>;

export function describeTurnCompletionProgress(
  isZh: boolean,
  finalization?: ChatResponseFinalization | null,
): {
  text: string;
  tone: ChatProgressTone;
} {
  if (finalization && isAgentResponseTerminalNotice(finalization)) {
    const waiting = isAgentResponseWaitingConfirmation(finalization);
    const copy = executionFeedbackCopy(isZh ? 'zh' : 'en');
    return {
      text: waiting
        ? copy.progressConfirmation
        : copy.progressBlocked,
      tone: waiting ? 'confirmation' : 'error',
    };
  }
  // A tool event only proves that a step was attempted. It does not prove the
  // user's task completed. Once the backend finalizer has accepted the answer,
  // describe delivery of that answer rather than inventing a completion claim.
  if (finalization?.finalized) {
    return {
      text: uiMessage('chat-progress.reply-sent.5f1b4522d2', (isZh) ? 'zh' : 'en'),
      tone: 'done',
    };
  }
  return { text: executionFeedbackCopy(isZh ? 'zh' : 'en').progressUnverified, tone: 'tool' };
}

export function describeToolProgress(toolName: string, phase: ToolProgressPhase, isZh: boolean): string {
  const name = String(toolName || '').toLowerCase();

  if (phase === 'error') {
    if (/wechat_send_message/.test(name)) {
      return uiMessage('chat-progress.the-wechat-send-step-failed.d584702c98', (isZh) ? 'zh' : 'en');
    }
    return uiMessage('chat-progress.that-step-hit-a-problem.1fcf172ada', (isZh) ? 'zh' : 'en');
  }

  if (phase === 'result') {
    return uiMessage(
      'chat-progress.tool-returned-result-awaiting-task-verification.4f8d02cb71',
      (isZh) ? 'zh' : 'en',
    );
  }

  if (/wechat_send_message/.test(name)) {
    return uiMessage('chat-progress.i-am-reusing-the-wechat.5ab75dc123', (isZh) ? 'zh' : 'en');
  }
  if (/desktop_mouse_click_at/.test(name)) {
    return uiMessage('chat-progress.the-virtual-cursor-is-clicking.63893e257b', (isZh) ? 'zh' : 'en');
  }
  if (/desktop_open/.test(name)) {
    return uiMessage('chat-progress.i-am-reusing-or-opening.7a0628c750', (isZh) ? 'zh' : 'en');
  }
  if (/(desktop_list_files|list_directory|search_files|grep_files)/.test(name)) {
    return uiMessage('chat-progress.i-am-looking-for-the.38a69ca454', (isZh) ? 'zh' : 'en');
  }
  if (/(audio|speech|voice|transcri|stt)/.test(name)) {
    return uiMessage('chat-progress.i-am-turning-the-audio.aecdea5634', (isZh) ? 'zh' : 'en');
  }
  if (/(extract_document_text|read_docx|read_pdf|pdf_to_text|read_file|ocr_image_file)/.test(name)) {
    return uiMessage('chat-progress.i-am-reading-the-file.685a80ef89', (isZh) ? 'zh' : 'en');
  }
  if (/(create|generate|docx|document|pdf|ppt|sheet|excel|export|write|save)/.test(name)) {
    return uiMessage('chat-progress.i-am-generating-the-file.a9f9906851', (isZh) ? 'zh' : 'en');
  }
  if (/(read|file|path|directory|folder|list)/.test(name)) {
    return uiMessage('chat-progress.i-am-reading-the-relevant.d29593b8b9', (isZh) ? 'zh' : 'en');
  }
  if (/(search|web|fetch|browser|crawl|http)/.test(name)) {
    return uiMessage('chat-progress.i-am-looking-up-and.57eac0c583', (isZh) ? 'zh' : 'en');
  }
  if (/(skill|mcp|npm|github|install|package)/.test(name)) {
    return uiMessage('chat-progress.i-am-working-through-the.688f70fe92', (isZh) ? 'zh' : 'en');
  }
  if (/(desktop|window|app|client|click|type|open)/.test(name)) {
    return uiMessage('chat-progress.i-am-operating-the-client.8d64626082', (isZh) ? 'zh' : 'en');
  }
  if (/(memory|knowledge|index|vector)/.test(name)) {
    return uiMessage('chat-progress.i-am-checking-and-organizing.e7a8670600', (isZh) ? 'zh' : 'en');
  }
  if (/(wechat|message|mail|email|calendar)/.test(name)) {
    return uiMessage('chat-progress.i-am-preparing-the-external.69f666eb98', (isZh) ? 'zh' : 'en');
  }

  return uiMessage('chat-progress.i-am-using-the-needed.eb913b13ab', (isZh) ? 'zh' : 'en');
}
