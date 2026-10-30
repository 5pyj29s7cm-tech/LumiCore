const COPY = {
  en: {
    account: 'Account profile',
    paymentsUnavailable: 'Payments and withdrawals are not connected.',
    balanceDetail: 'Balance recorded for this account. No payout or compute-reward service is available here.',
    notCollected: 'Not collected',
  },
  zh: {
    account: '账号资料',
    paymentsUnavailable: '尚未接入充值与提现服务。',
    balanceDetail: '此处显示账号记录的余额；本页未接入提现或算力收益服务。',
    notCollected: '未采集',
  },
};
export const profileAvailabilityCopy = (locale: 'zh' | 'en') => COPY[locale];
