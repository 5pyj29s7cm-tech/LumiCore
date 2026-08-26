export const CN_SYSTEM_EXPLORER_PROMPTS = {
  desktopOrganization: [
    '先告诉我这台电脑现在最值得整理和优化的三件事',
    '帮我盘点桌面、文档和下载目录，但先只给方案不要改文件',
  ],
  officeDocuments: [
    '根据我电脑里的办公软件，告诉我你能替我完成哪些文档和表格工作',
    '帮我把这份材料整理成交付级文档，完成后给我文件和验收结果',
  ],
  communicationWorkflows: [
    '看看我常用的沟通和会议软件，帮我设计一套消息与会议整理流程',
    '下一次会议帮我记录、整理待办，并在发送前让我确认',
  ],
  softwareDevelopment: [
    '审计我当前项目，先汇报风险，再按我确认的范围修复和测试',
    '检查这台电脑的开发环境是否完整，并列出可以自动化的工作流',
  ],
  creativeDesign: [
    '根据我现有的设计软件，给我一条从需求到交付文件的工作流',
    '检查这份设计任务需要哪些软件和素材，缺什么先告诉我',
  ],
  financeAndOperations: [
    '根据现有财务和表格软件，告诉我哪些对账、报表和分析可以半自动化',
  ],
  localAi: [
    '评估这台电脑适合运行哪些本地模型，并给我隐私、速度和质量的取舍',
  ],
  deviceAndVoice: [
    '检查我的麦克风、摄像头和显示设备能支持哪些 Lumi 功能，需要权限时再问我',
  ],
  firstQuestion: '你现在能在这台电脑上帮我做什么？按已经验证、需要配置、暂时不能做三类告诉我。',
} as const;

export const CN_COMMUNICATION_APP_PATTERN = /(?:微信|企业微信|飞书|钉钉|腾讯会议)/i;
export const CN_FINANCE_APP_PATTERN = /(?:用友|金蝶|税友|开票)/i;
