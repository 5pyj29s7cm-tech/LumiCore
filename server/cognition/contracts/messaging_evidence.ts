import type { ToolExecutionRecord } from "../../tools/types";
import { parseRecordJson, recordText } from "../action_contract_support";
import { extractPrimaryTaskText } from "../action_request";

function normalizeFileReference(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,10}$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function hasRequestedMessagingFileEvidence(record: ToolExecutionRecord, taskText: string): boolean {
  if (record.error || record.name !== 'wechat_send_file') return false;
  const payload = parseRecordJson(record);
  const sent = payload?.sent === true
    || /"sent"\s*:\s*true|sent:\s*true/i.test(String(record.result || ''));
  if (!sent) return false;

  const rawPath = String(
    payload?.fileName
    || payload?.filePath
    || record.arguments?.filePath
    || '',
  ).trim();
  const fileName = rawPath.split(/[\\/]/).pop() || '';
  if (!fileName) return false;

  const primaryTask = extractPrimaryTaskText(taskText);
  const normalizedTask = normalizeFileReference(primaryTask);
  const normalizedFile = normalizeFileReference(fileName);
  const namesRequestedFile = normalizedFile.length >= 2 && normalizedTask.includes(normalizedFile);
  const explicitFileTransfer = /(?:\u6587\u4ef6|\u6587\u6863|\u9644\u4ef6|\u6750\u6599|\u56fe\u7eb8|\u7167\u7247|\u56fe\u7247|\u89c6\u9891\u6587\u4ef6|\u97f3\u9891\u6587\u4ef6|file|document|attachment|photo|image|video\s+file|audio\s+file|\.(?:docx?|pdf|xlsx?|pptx?|txt|md|zip|rar|7z|png|jpe?g|gif|mp4|mov|mp3|wav)\b)/iu.test(primaryTask);
  const contextualFileTransfer = /(?:\u628a|\u5c06)(?:\u5b83|\u8fd9\u4e2a|\u90a3\u4e2a|\u8fd9\u4efd|\u90a3\u4efd|\u4e0a\u9762\u7684|\u521a\u624d\u7684).{0,16}(?:\u53d1|\u4f20|\u8f6c\u53d1)|\b(?:send|forward|transfer)\s+(?:it|that|this)\b/iu.test(primaryTask);
  return namesRequestedFile || explicitFileTransfer || contextualFileTransfer;
}

export function hasPublicPostEvidence(records: ToolExecutionRecord[]): boolean {
  const explicitReceipt = records.some(record =>
    /(?:publish|post|comment|submit|listing)/i.test(record.name)
      && /"(?:published|posted|submitted|commented|success)"\s*:\s*true|"status"\s*:\s*"(?:published|posted|submitted|success|completed)"/i.test(record.result)
  );
  if (explicitReceipt) return true;

  const commitIndex = records.findIndex(record => {
    if (!/(?:playwright_browser_click|desktop_ui_(?:click|invoke)|computer_use|mouse_click)/i.test(record.name)) return false;
    return /(?:\u53d1\u5e03|\u8bc4\u8bba|\u6295\u7a3f|\u4e0a\u67b6|\u63d0\u4ea4|publish|post|comment|submit|list(?:ing)?)/iu.test(recordText(record));
  });
  if (commitIndex < 0) return false;
  return records.slice(commitIndex + 1).some(record =>
    /(?:snapshot|evaluate|ui_snapshot|ocr|capture_screen)/i.test(record.name)
      && /(?:\u53d1\u5e03\u6210\u529f|\u8bc4\u8bba\u6210\u529f|\u63d0\u4ea4\u6210\u529f|\u5df2\u53d1\u5e03|\u5df2\u4e0a\u67b6|published|posted|submitted|comment\s+(?:is\s+)?visible|success(?:fully)?)/iu.test(record.result)
  );
}
