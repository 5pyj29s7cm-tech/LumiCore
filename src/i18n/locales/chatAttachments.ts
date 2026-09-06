const COPY = {
  zh: {
    processing: '正在上传并读取附件，请稍候再发送。草稿会保留。',
    failed: '以下文件未能附加；已成功的附件会保留。',
    retry: '重试失败文件', dismiss: '暂不附加这些文件',
    retryHelp: '重试只处理失败项，不会重复添加已成功的文件。',
    unknown: '未确认文件处理结果，请重试。',
  },
  en: {
    processing: 'Uploading and reading attachments. Please wait before sending; your draft is kept.',
    failed: 'These files could not be attached. Successful attachments are kept.',
    retry: 'Retry failed files', dismiss: 'Continue without these files',
    retryHelp: 'Retry processes failed items without adding successful files again.',
    unknown: 'The file result could not be confirmed. Please retry.',
  },
};
export function chatAttachmentCopy(isZh: boolean) { return COPY[isZh ? 'zh' : 'en']; }
