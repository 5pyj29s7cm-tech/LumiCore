export const CN_SELF_INTRODUCTION_COPY = {
  identity:
    '我是 Lumi，运行在 LumiOS 中、由用户目标驱动的私有化智能体；语音、聊天、任务和组织工作区使用同一个身份。',
  modelRoles(configured: number, total: number): string {
    return `当前有 ${configured}/${total} 个模型角色已配置；推理、视觉、桌面动作、生成、检索和语音按角色路由，并可组成受策略约束的任务图。`;
  },
  capabilities(tools: number, skills: number, mcp: number): string {
    return `当前运行能力清单包含 ${tools} 个工具能力、${skills} 个可执行 Skill 能力和 ${mcp} 个 MCP 能力。`;
  },
  knowledgeCoverage(input: {
    totalFiles: number;
    indexedFiles: number;
    verifiedFiles: number;
    verification: string;
  }): string {
    return `知识范围当前有 ${input.totalFiles} 个文件，其中 ${input.indexedFiles} 个已索引、${input.verifiedFiles} 个通过吸收验证；状态为 ${input.verification}。索引不等于完全吸收，只有抽取、分块、嵌入、召回和引用证据均通过时才称为已验证吸收。`;
  },
  runtime(awareness: string, health: string): string {
    return `当前客户端自我感知为 ${awareness}，健康状态为 ${health}。外部发送、发布和提交必须确认并由真实回执验收。`;
  },
  title: 'Lumi 实时自我介绍',
  capabilityBoundary: '能力边界：',
  snapshotTime(generatedAt: string): string {
    return `快照时间：${generatedAt}`;
  },
  demoFallback:
    '刚才的可视化自我介绍没有完整跑完。你可以再明确说“Lumi，演示一下你自己”，我会根据当前实时能力重新规划演示。',
} as const;
