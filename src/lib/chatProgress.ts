export type ChatProgressTone = 'thinking' | 'tool' | 'done' | 'error' | 'confirmation';

export type ChatProgressLine = {
  id: string;
  text: string;
  tone: ChatProgressTone;
  time: number;
};

export type ToolProgressPhase = 'start' | 'result' | 'error';

const VISIBLE_TOOL_EVIDENCE_RE =
  /\b(?:file|document|docx|pdf|attachment|desktop|screen|open|read|review|inspect|analy[sz]e|contract|agreement|transcribe|audio)\b|(?:文件|文档|资料|附件|合同|协议|打开|读取|查看|看看|审查|分析|检查|桌面|屏幕|录音|音频|转写|生成|保存|导出)/iu;

export function needsVisibleToolEvidence(text: string, hasAttachments = false): boolean {
  if (hasAttachments) return true;
  return VISIBLE_TOOL_EVIDENCE_RE.test(String(text || ''));
}

export function describeTurnCompletionProgress(isZh: boolean, usedTool: boolean, needsEvidence: boolean): {
  text: string;
  tone: ChatProgressTone;
} {
  if (usedTool) {
    return {
      text: isZh ? '处理完成，我把结果整理好了。' : 'Done. I have put the result together.',
      tone: 'done',
    };
  }
  if (needsEvidence) {
    return {
      text: isZh ? '未检测到实际工具执行，这次只是文字回复。' : 'No actual tool execution was detected; this was only a text reply.',
      tone: 'error',
    };
  }
  return {
    text: isZh ? '已回复。' : 'Reply sent.',
    tone: 'done',
  };
}

export function describeToolProgress(toolName: string, phase: ToolProgressPhase, isZh: boolean): string {
  const name = String(toolName || '').toLowerCase();

  if (phase === 'error') {
    if (/wechat_send_message/.test(name)) {
      return isZh
        ? '\u5fae\u4fe1\u53d1\u9001\u8fd9\u4e00\u6b65\u5931\u8d25\u4e86\uff0c\u6211\u6b63\u5728\u663e\u793a\u539f\u56e0\u3002'
        : 'The WeChat send step failed. I am showing the reason.';
    }
    return isZh
      ? '这一步遇到问题了，我在整理原因和下一步处理方式。'
      : 'That step hit a problem. I am checking the cause and next move.';
  }

  if (phase === 'result') {
    if (/wechat_send_message/.test(name)) {
      return isZh
        ? '\u5fae\u4fe1\u524d\u53f0\u53d1\u9001\u52a8\u4f5c\u5df2\u6267\u884c\uff0c\u6211\u6b63\u5728\u786e\u8ba4\u72b6\u6001\u3002'
        : 'The foreground WeChat send action ran. I am checking the state.';
    }
    if (/(desktop_list_files|list_directory|search_files|grep_files)/.test(name)) {
      return isZh ? '我已经查过相关位置，正在判断能不能直接读取。' : 'I have checked the relevant location and am deciding whether I can read it directly.';
    }
    if (/(audio|speech|voice|transcri|stt)/.test(name)) {
      return isZh ? '录音已经转成文字，我继续整理内容。' : 'The audio is transcribed. I am organizing the content now.';
    }
    if (/(extract_document_text|read_docx|read_pdf|pdf_to_text|read_file|ocr_image_file)/.test(name)) {
      return isZh ? '文件内容已经读到，我正在整理结果。' : 'I have read the file content and am organizing the result.';
    }
    if (/(create|generate|docx|document|pdf|ppt|sheet|excel|export|write|save)/.test(name)) {
      return isZh ? '文件已经生成，我继续确认结果。' : 'The file is generated. I am checking the result.';
    }
    return isZh ? '这一步完成了，我继续整理结果。' : 'That step is done. I am putting the result together.';
  }

  if (/wechat_send_message/.test(name)) {
    return isZh
      ? '\u6211\u5728\u590d\u7528\u5fae\u4fe1\u7a97\u53e3\uff0c\u5e76\u7528\u865a\u62df\u5149\u6807\u53d1\u9001\u6d88\u606f\u3002'
      : 'I am reusing the WeChat window and sending with the virtual cursor path.';
  }
  if (/desktop_mouse_click_at/.test(name)) {
    return isZh
      ? '\u865a\u62df\u5149\u6807\u6b63\u5728\u70b9\u51fb\u76ee\u6807\u4f4d\u7f6e\u3002'
      : 'The virtual cursor is clicking the target position.';
  }
  if (/desktop_open/.test(name)) {
    return isZh
      ? '\u6211\u5728\u590d\u7528\u6216\u6253\u5f00\u76ee\u6807\u5e94\u7528\u3002'
      : 'I am reusing or opening the target app.';
  }
  if (/(desktop_list_files|list_directory|search_files|grep_files)/.test(name)) {
    return isZh ? '我在查找这一步需要的文件或位置。' : 'I am looking for the file or location this needs.';
  }
  if (/(audio|speech|voice|transcri|stt)/.test(name)) {
    return isZh ? '我在把录音转成文字。' : 'I am turning the audio into text.';
  }
  if (/(extract_document_text|read_docx|read_pdf|pdf_to_text|read_file|ocr_image_file)/.test(name)) {
    return isZh ? '我在读取文件内容。' : 'I am reading the file content.';
  }
  if (/(create|generate|docx|document|pdf|ppt|sheet|excel|export|write|save)/.test(name)) {
    return isZh ? '我在生成需要的文件。' : 'I am generating the file you need.';
  }
  if (/(read|file|path|directory|folder|list)/.test(name)) {
    return isZh ? '我在读取相关文件内容。' : 'I am reading the relevant files.';
  }
  if (/(search|web|fetch|browser|crawl|http)/.test(name)) {
    return isZh ? '我在查找并读取资料。' : 'I am looking up and reading the source material.';
  }
  if (/(skill|mcp|npm|github|install|package)/.test(name)) {
    return isZh ? '我在处理技能或 MCP 的安装链路。' : 'I am working through the skill or MCP install path.';
  }
  if (/(desktop|window|app|client|click|type|open)/.test(name)) {
    return isZh ? '我在操作客户端界面。' : 'I am operating the client interface.';
  }
  if (/(memory|knowledge|index|vector)/.test(name)) {
    return isZh ? '我在检索和整理知识库内容。' : 'I am checking and organizing knowledge base content.';
  }
  if (/(wechat|message|mail|email|calendar)/.test(name)) {
    return isZh ? '我在准备外部应用相关操作。' : 'I am preparing the external app action.';
  }

  return isZh ? '我在调用需要的工具处理这一步。' : 'I am using the needed tool for this step.';
}
