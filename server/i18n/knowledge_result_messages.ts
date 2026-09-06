export const KNOWLEDGE_RESULT_MESSAGES = {
  zh: {
    empty: '知识库里目前没有文件。',
    summary: (total: number, verified: number, unverified: number, pending: number, partial: number, stale: number, failed: number) =>
      `知识库共有 ${total} 个文件：${verified} 个已验证，${unverified} 个已索引但未验证，${pending} 个待处理，${partial} 个处理不完整，${stale} 个需要更新，${failed} 个处理失败或格式不支持。`,
    complete: '这些文件均已通过资料处理验证。',
    incomplete: '查询已完成；这不代表文件都已完整吸收。',
    more: (count: number) => `另有 ${count} 个文件未在此展开。`,
    statuses: { verified: '已验证', indexed_unverified: '已索引但未验证', pending: '待处理', partial: '处理不完整', stale: '需要更新', failed: '处理失败', unsupported: '格式不支持' },
  },
  en: {
    empty: 'The knowledge base currently contains no files.',
    summary: (total: number, verified: number, unverified: number, pending: number, partial: number, stale: number, failed: number) =>
      `The knowledge base contains ${total} files: ${verified} verified, ${unverified} indexed but unverified, ${pending} pending, ${partial} partially processed, ${stale} needing an update, and ${failed} failed or unsupported.`,
    complete: 'All these files passed knowledge processing verification.',
    incomplete: 'The query is complete; this does not mean every file has been fully absorbed.',
    more: (count: number) => `${count} additional files are not expanded here.`,
    statuses: { verified: 'verified', indexed_unverified: 'indexed but unverified', pending: 'pending', partial: 'partially processed', stale: 'needs an update', failed: 'failed', unsupported: 'unsupported format' },
  },
};
