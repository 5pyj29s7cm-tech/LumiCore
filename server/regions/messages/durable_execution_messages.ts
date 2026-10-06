export const CN_DURABLE_EXECUTION_MESSAGES = {
  modelFailure:
    '本轮没有生成可靠回复，也没有据此执行新操作。请直接重试当前消息。',
  capabilityCandidatePersistenceLabel: '候选记录持久化',
  capabilityCandidatePersistenceDetail:
    '候选已记录，但数据库写入不构成能力验证；必须经过真实实验和终态回执后才能晋级为可复用能力。',
  noExecutableToolResult:
    '这轮处理没有拿到可执行的工具结果，不能确认完成。恢复时必须保留当前目标并重新规划可用能力或声明式替代路径，不能让你重复已经提供的信息。',
  verifiedStatus: '已验证',
  unverifiedStatus: '未验证',
  recoveryBudgetExhausted:
    '这轮工具执行与自动恢复预算已经用尽，当前任务仍未通过最终验真。',
  resumeFromVerifiedArtifacts:
    '恢复执行时必须从这些已验证结果继续，优先改走声明式替代能力或独立验真工具，不能重复已完成步骤。',
  resumeWithoutVerifiedArtifacts:
    '这轮没有检测到可验证产物；恢复执行时必须保留现有回执并重新规划声明式替代能力或验真工具，不能把失败说明当成完成。',
  terminalVerificationPassed: '已通过终态核验',
  verifiedCheckpointHeading: '已核验的执行结果：',
  verifiedCheckpointContinuation: '当前进度与回执仍可用于继续后续步骤。',
} as const;
