function splitLines(value?: string): string[] {
  return String(value || '')
    .split(/\r?\n|;|\uFF1B/)
    .map(line => line.trim())
    .filter(Boolean);
}

function scoreSignal(text: string, signal: RegExp, points: number): number {
  return signal.test(text) ? points : 0;
}

const LEAD_SIGNALS = {
  budget: /\bbudget\b|quotation|quote|price|procurement|purchase|\u9884\u7B97|\u62A5\u4EF7|\u4EF7\u683C|\u91C7\u8D2D|\u91D1\u989D/i,
  timing: /timeline|deadline|this\s+week|next\s+week|this\s+month|next\s+month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\u672C\u5468|\u4E0B\u5468|\u672C\u6708|\u4E0B\u6708|\u5C3D\u5FEB|\u4E0A\u7EBF|\u4EA4\u4ED8|\u622A\u6B62|\u5468[\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u65E5\u5929]/i,
  decisionMaker: /decision(?:\s+maker)?|approver|boss|owner|founder|director|stakeholder|\u51B3\u7B56\u4EBA|\u51B3\u7B56\u8005|\u8001\u677F|\u8D1F\u8D23\u4EBA|\u521B\u59CB\u4EBA|\u603B\u76D1|\u5BA1\u6279\u4EBA|\u62CD\u677F/i,
  pain: /\bpain\b|problem|blocked|bottleneck|efficiency|urgent|need(?:s|ed)?|\u75DB\u70B9|\u95EE\u9898|\u5361\u4F4F|\u6548\u7387|\u6025\u9700|\u9700\u6C42|\u73B0\u72B6/i,
  comparison: /competitor|alternative|comparison|compare|\u66FF\u4EE3|\u7ADE\u54C1|\u5BF9\u6BD4|\u6BD4\u8F83/i,
  buyingIntent: /demo|trial|pilot|proposal|contract|purchase\s+order|quotation|quote|\u8BD5\u7528|\u6F14\u793A|\u5F00\u901A|\u65B9\u6848|\u5408\u540C|\u62A5\u4EF7\u5355|\u91C7\u8D2D\u5355|\u7ACB\u9879/i,
  demoIntent: /demo|trial|pilot|\u8BD5\u7528|\u6F14\u793A|\u5F00\u901A/i,
};

export function scoreLead(args: {
  leadText?: string;
  product?: string;
}) {
  const text = String(args.leadText || '').trim();
  const score =
    scoreSignal(text, LEAD_SIGNALS.budget, 20) +
    scoreSignal(text, LEAD_SIGNALS.timing, 20) +
    scoreSignal(text, LEAD_SIGNALS.decisionMaker, 20) +
    scoreSignal(text, LEAD_SIGNALS.pain, 15) +
    scoreSignal(text, LEAD_SIGNALS.comparison, 10) +
    scoreSignal(text, LEAD_SIGNALS.buyingIntent, 15);
  const capped = Math.min(score, 100);
  const signals = {
    budget: LEAD_SIGNALS.budget.test(text),
    timing: LEAD_SIGNALS.timing.test(text),
    decisionMaker: LEAD_SIGNALS.decisionMaker.test(text),
    pain: LEAD_SIGNALS.pain.test(text),
    comparison: LEAD_SIGNALS.comparison.test(text),
    buyingIntent: LEAD_SIGNALS.buyingIntent.test(text),
    demoIntent: LEAD_SIGNALS.demoIntent.test(text),
  };
  const evidence = Object.entries(signals)
    .filter(([, matched]) => matched)
    .map(([name]) => name);
  const missingQualifications = ['budget', 'timing', 'decisionMaker', 'pain']
    .filter(name => !signals[name as keyof typeof signals]);

  return {
    product: args.product || '',
    score: capped,
    grade: capped >= 75 ? 'hot' : capped >= 45 ? 'warm' : 'cold',
    inputGrounded: true,
    signals,
    evidence,
    missingQualifications,
    nextBestAction: capped >= 75
      ? 'Schedule a decision-focused call and confirm budget, authority, timeline, scope, and success criteria.'
      : capped >= 45
        ? 'Send relevant proof and ask for the highest-value missing qualification.'
        : 'Do not assume readiness. Gather missing qualification facts before advancing the opportunity.',
  };
}

export function draftFollowUp(args: {
  customerName?: string;
  context?: string;
  goal?: string;
  tone?: 'warm' | 'direct' | 'consultative';
}) {
  const context = String(args.context || '').trim();
  const goal = String(args.goal || '').trim();
  const name = String(args.customerName || '').trim();
  const tone = args.tone || 'consultative';
  const missingInputs = [!context ? 'context' : '', !goal ? 'goal' : ''].filter(Boolean);
  if (!context) {
    return {
      tone,
      message: '',
      draftOnly: true,
      completionEligible: false,
      missingInputs,
      checklist: ['Provide the actual conversation or account context before drafting a customer message.'],
    };
  }

  const salutation = name ? `Hi ${name},` : 'Hello,';
  const opener = tone === 'direct'
    ? `${salutation} following up on our discussion.`
    : tone === 'warm'
      ? `${salutation} thank you for the conversation. I wanted to follow up on the points we discussed.`
      : `${salutation} I reviewed our discussion and would like to confirm a practical next step.`;

  return {
    tone,
    message: [
      opener,
      context,
      `Proposed next step: ${goal || 'confirm the remaining priorities, owner, and target date'}.`,
      'Please let me know whether this reflects your priorities or what should be adjusted.',
    ].join('\n\n'),
    draftOnly: true,
    completionEligible: false,
    sourceContextIncluded: true,
    missingInputs,
    checklist: [
      'Verify names, dates, commercial terms, and commitments against the source conversation.',
      'Ask for one clear next step.',
      'Do not send until the recipient and final wording are confirmed by the active workflow.',
    ],
  };
}

export function handleObjection(args: {
  objection?: string;
  product?: string;
  customerContext?: string;
}) {
  const objection = String(args.objection || '').trim();
  const type = /price|expensive|cost|\u9884\u7B97|\u8D35|\u4EF7\u683C|\u6210\u672C/i.test(objection)
    ? 'price'
    : /time|busy|later|\u6CA1\u65F6\u95F4|\u4EE5\u540E|\u7A0D\u540E|\u5FD9/i.test(objection)
      ? 'timing'
      : /trust|risk|safe|stable|\u4FE1\u4EFB|\u5B89\u5168|\u7A33\u5B9A|\u98CE\u9669/i.test(objection)
        ? 'trust'
        : /competitor|already|alternative|\u5DF2\u6709|\u7ADE\u54C1|\u66FF\u4EE3/i.test(objection)
          ? 'competition'
          : 'general';

  const responseMap: Record<string, string> = {
    price: 'Acknowledge budget pressure, clarify the value driver, and compare the cost of inaction with the smallest useful scope.',
    timing: 'Acknowledge timing, identify what must happen before evaluation, and offer a low-effort next step.',
    trust: 'Acknowledge the risk, provide verifiable proof and safeguards, and suggest a reversible pilot.',
    competition: 'Acknowledge the existing option, identify what is working or missing, and compare only relevant criteria.',
    general: 'Acknowledge the concern, ask one clarifying question, and connect the answer to the customer goal.',
  };

  return {
    product: args.product || '',
    objectionType: type,
    customerContext: args.customerContext || '',
    responseFrame: responseMap[type],
    suggestedReply: objection
      ? `I understand your concern about "${objection}". ${responseMap[type]} Would it help if we agree on one success metric and one small next step?`
      : '',
    draftOnly: true,
    completionEligible: false,
    missingInputs: objection ? [] : ['objection'],
  };
}

export function reviewCustomerHealth(args: {
  customerText?: string;
}) {
  const lines = splitLines(args.customerText);
  const rows = lines.map((line, index) => {
    let score = 50;
    if (/renew|expansion|active|positive|\u597D\u8BC4|\u7EED\u8D39|\u589E\u8D2D|\u6D3B\u8DC3/i.test(line)) score += 25;
    if (/ticket|complaint|bug|delay|\u6295\u8BC9|\u5DE5\u5355|\u6545\u969C|\u5EF6\u671F/i.test(line)) score -= 20;
    if (/inactive|churn|cancel|silent|\u6C89\u9ED8|\u6D41\u5931|\u53D6\u6D88/i.test(line)) score -= 30;
    if (/decision|budget|owner|\u51B3\u7B56|\u9884\u7B97|\u8D1F\u8D23\u4EBA/i.test(line)) score += 10;
    score = Math.max(0, Math.min(100, score));
    return {
      customer: line.split(/:|\uFF1A|-|,|\uFF0C/)[0]?.trim() || `customer-${index + 1}`,
      score,
      status: score >= 75 ? 'healthy' : score >= 45 ? 'watch' : 'at_risk',
      notes: line,
    };
  });

  return {
    inputGrounded: true,
    rows,
    atRiskCustomers: rows.filter(row => row.status === 'at_risk').map(row => row.customer),
    nextActions: [
      'Confirm business outcome, usage, open issues, and renewal timeline.',
      'For at-risk accounts, assign one owner and one recovery action.',
      'Separate product issues, service issues, and procurement or budget issues.',
    ],
  };
}

export function triageSupportTickets(args: {
  ticketText?: string;
}) {
  const tickets = splitLines(args.ticketText).map((line, index) => {
    const severity = /down|blocked|cannot\s+use|unavailable|crash|\u65E0\u6CD5\u4F7F\u7528|\u5B95\u673A|\u963B\u585E|\u4E25\u91CD|\u5D29\u6E83|\u4E0D\u53EF\u7528/i.test(line)
      ? 'high'
      : /bug|error|delay|\u62A5\u9519|\u5F02\u5E38|\u5EF6\u671F|\u5EF6\u8FDF/i.test(line)
        ? 'medium'
        : 'low';
    const category = /billing|invoice|payment|\u8D26\u5355|\u53D1\u7968|\u4ED8\u6B3E|\u652F\u4ED8/i.test(line)
      ? 'billing'
      : /login|password|auth|permission|\u767B\u5F55|\u5BC6\u7801|\u6743\u9650|\u8BA4\u8BC1|\u9A8C\u8BC1\u7801/i.test(line)
        ? 'account'
        : /bug|error|crash|fault|\u62A5\u9519|\u6545\u969C|\u5F02\u5E38|\u5D29\u6E83/i.test(line)
          ? 'technical'
          : 'request';
    return {
      id: index + 1,
      severity,
      category,
      ticket: line,
      suggestedFirstReply: severity === 'high'
        ? 'We received this and are treating it as urgent. Please share the impact scope, screenshots or logs, and the exact time if available.'
        : 'Thanks for the details. We will check this and follow up with the next step or clarification shortly.',
    };
  });

  return {
    inputGrounded: true,
    tickets,
    highPriorityCount: tickets.filter(ticket => ticket.severity === 'high').length,
    routingSummary: tickets.reduce<Record<string, number>>((acc, ticket) => {
      acc[ticket.category] = (acc[ticket.category] || 0) + 1;
      return acc;
    }, {}),
  };
}
