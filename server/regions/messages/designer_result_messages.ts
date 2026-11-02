export const DESIGNER_RESULT_MESSAGES = {
  zh: {
    created: '项目已创建并激活', projectId: '持久项目 ID', stage: '已核验本地设计阶段', taskId: '任务 ID', file: '已归档文件',
    containerLimit: '本轮只创建项目容器并归档 Brief；未生成 CAD、效果图或 PPT，未发送给客户，未完成专业签认。',
    stageLimit: '此回执核验本地工作流结果；客户外发、专业签认和后续阶段仍须分别完成并取得回执。',
    blocked: '本次设计结果尚未核验。项目容器、状态读取、草稿或历史回执不能代替本次所需的完成证据。',
    partial: '当前设计阶段的回执不能证明整项请求完成。额外的外发或其他阶段要求尚未在本次结果中逐项核验，整项保持未完成。',
  },
  en: {
    created: 'Project created and activated', projectId: 'Persistent project ID', stage: 'Verified local design stage', taskId: 'Task ID', file: 'Archived file',
    containerLimit: 'This turn only created the project container and saved its brief. No CAD, visualization, presentation, customer delivery or professional approval is claimed.',
    stageLimit: 'This receipt verifies the local workflow result. Customer delivery, professional approval and later stages are separate.',
    blocked: 'The requested design result is not verified. A project container, status read, draft or older receipt cannot complete this operation.',
    partial: 'The selected design-stage receipt does not complete the whole request. Additional delivery or stage obligations remain unverified.',
  },
};
