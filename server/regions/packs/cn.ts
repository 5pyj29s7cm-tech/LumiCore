import type { RegionalCapabilityPack } from '../types';

export const CN_CAPABILITY_PACK: RegionalCapabilityPack = {
  id: 'cn',
  aliases: ['cn', 'china', 'mainland-china'],
  locales: ['zh', 'zh-cn', 'zh-hans'],
  capabilities: [
    'china-legal-casework',
    'china-enterprise-research',
    'china-court-filing-collaboration',
    'feishu',
    'wechat',
    'wecom',
  ],
  legal: {
    externalPlatforms: [
      'People\'s Court Online Service',
      'China Judgments Online',
      'People\'s Courts Case Database',
      'Fachan',
      'Alpha',
      'Qichacha',
      'National Enterprise Credit Information Publicity System',
    ],
    authorityOrder: [
      'Supreme People\'s Court',
      'High People\'s Courts',
      'Intermediate People\'s Courts',
      'Primary People\'s Courts',
    ],
    collaborationBoundary:
      'These platforms depend on user-authorized accounts, subscriptions, captcha or multi-factor checks, and platform risk controls. Treat them as authorized collaboration surfaces: prepare and search, archive the source and result, verify before delivery, and never claim unattended full automation.',
  },
};
