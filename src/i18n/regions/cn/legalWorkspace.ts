export const CHINA_LEGAL_WORKSPACE_COPY = {
  caseTitle: (value: string) => `案件：${value}`,
  caseNumber: (value: string) => `案号：${value}`,
  party: (value: string) => `当事人：${value}`,
  cause: (value: string) => `案由：${value}`,
  court: (value: string) => `法院：${value}`,
  judge: (value: string) => `承办法官：${value}`,
  facts: (value: string) => `事实摘要/待补材料：\n${value}`,
  material: (title: string, content: string) => `材料：${title}\n${content}`,
  packetTitle: (value: string) => `${value} 半自动文书包`,
  researchTitle: (value: string) => `${value} 外部检索行动单`,
  strategyTitle: (value: string) => `${value} 诉讼策略分析`,
  verificationTitle: (value: string) => `${value} 引用校验`,
};
