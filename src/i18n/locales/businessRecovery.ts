export const businessRecoveryCopy = (lang: string) => lang === 'en' ? {
  saveDraft: 'Save draft to this account', loadDraft: 'Restore saved draft', saved: 'Draft saved', noDraft: 'No saved draft', archives: 'Load archived diagnoses', restoreArchive: 'Restore archive input',
  history: 'Saved tasks', load: 'Load saved tasks', retry: 'Retry loading', empty: 'No saved tasks in the recent task window.',
  bounded: 'Tasks are paged within the current account and workspace. Restoring only reads existing records; it does not repeat execution.', more: 'Load more saved tasks',
  restore: 'View saved result', artifacts: 'Verified files', download: 'Download verified workbook',
  evidence: 'Saved structured evidence', pending: 'Waiting for actual output. Process steps are instructions, not live platform data.',
  scope: 'Local analysis and review drafts. Platform publishing, customer-service execution and accounting-system changes require a separate supported connection and authorization.',
  retryCancel: 'Retry server cancellation', cancelPending: 'Cancellation requested; waiting for the server result.', cancelUnknown: 'The server did not confirm cancellation. Retry cancellation or refresh the saved task to check its state.',
} : {
  saveDraft: '保存草稿到当前账号', loadDraft: '恢复已保存草稿', saved: '草稿已保存', noDraft: '没有已保存草稿', archives: '读取已归档诊断', restoreArchive: '恢复归档输入',
  history: '已保存任务', load: '读取历史任务', retry: '重新读取', empty: '近期任务范围内没有匹配记录。',
  bounded: '按当前账号及业务主体分页读取任务。恢复只读取已有记录，不会重复执行。', more: '读取更多已保存任务',
  restore: '查看已保存结果', artifacts: '已核验文件', download: '下载已核验工作簿',
  evidence: '已保存的结构化证据', pending: '等待实际结果。流程步骤是操作说明，不是平台实时数据。',
  scope: '支持本地分析和待审草稿；平台发布、客服执行及账务系统变更需要另行支持的连接和授权。',
  retryCancel: '重试后台取消', cancelPending: '已请求取消，正在等待后台结果。', cancelUnknown: '后台尚未确认取消，可重试取消或重新读取已保存任务以核对状态。',
};
