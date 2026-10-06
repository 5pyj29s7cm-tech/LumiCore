export const CN_ACTION_LEDGER_MESSAGES = {
  targetSection: (section: string) => `目标分区：${section}`,
  verificationEvidence: (evidence: string[]) => `验证依据：${evidence.join('、')}`,
};
