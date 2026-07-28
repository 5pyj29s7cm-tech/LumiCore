export type NormalizedActionIntentKind =
  | 'none'
  | 'messaging_read'
  | 'messaging_send'
  | 'public_publish'
  | 'external_submit'
  | 'payment'
  | 'signature'
  | 'client_navigation'
  | 'client_state'
  | 'desktop_operation'
  | 'cad_drafting'
  | 'status_query'
  | 'correction_explanation';

export type NormalizedActionOperation =
  | 'read'
  | 'create'
  | 'mutate'
  | 'navigate'
  | 'explain'
  | 'status';

export type NormalizedSideEffectClass = 'none' | 'local_write' | 'external_commit';
export type NormalizedActionRelation = 'new' | 'continue' | 'status' | 'correction' | 'child';

export interface NormalizedActionIntent {
  kind: NormalizedActionIntentKind;
  operation: NormalizedActionOperation;
  subject: string;
  target: string;
  payload: string;
  sideEffectClass: NormalizedSideEffectClass;
  relation: NormalizedActionRelation;
  confidence: number;
  rule: string;
  /** Canonical Lumi client action. Present only for client-native navigation. */
  clientAction?: string;
}

const EMPTY_INTENT: NormalizedActionIntent = {
  kind: 'none',
  operation: 'read',
  subject: '',
  target: '',
  payload: '',
  sideEffectClass: 'none',
  relation: 'new',
  confidence: 0,
  rule: 'none',
};

// i18n-allow: Multilingual client-navigation input recognition; not user-visible copy.
const CLIENT_NAVIGATION_VERB_RE = // i18n-allow: Multilingual client-navigation input recognition; not user-visible copy.
  /(?:打开|进入|切换到|切到|回到|返回|显示|展开|关闭|收起|open|show|enter|switch|return|close)/iu;

const CLIENT_SURFACE_RULES: ReadonlyArray<{ pattern: RegExp; target: string; action: string }> = [
  { pattern: /(?:聊天界面|聊天窗口|聊天面板|侧边聊天|side\s*chat|chat\s*(?:window|panel)?)/iu, target: 'chat', action: 'open_chat' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:中枢世界|中枢|世界视图|nexus|world\s*view)/iu, target: 'nexus', action: 'open_nexus' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:技能大厅|技能中心|skill\s*(?:hall|center))/iu, target: 'skills', action: 'open_skills' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:知识库|knowledge\s*base)/iu, target: 'knowledge', action: 'show_knowledge_base' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:运行日志|runtime\s*log)/iu, target: 'runtime-log', action: 'open_computer_adaptation' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:通知中心|通知面板|notification\s*(?:center|panel))/iu, target: 'notifications', action: 'open_notifications' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:提醒面板|提醒中心|reminder\s*(?:center|panel))/iu, target: 'reminders', action: 'open_reminders' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:设置界面|设置页面|客户端设置|settings)/iu, target: 'settings', action: 'open_settings' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:主屏幕|主页面|首页|lumi\s*桌面|home)/iu, target: 'home', action: 'focus_home' }, // i18n-allow: Multilingual Lumi surface aliases.
];

function currentTurnText(value: string): string {
  return String(value || '')
    .split(/\n## (?:Recent action continuation context|Exact Pending Action Confirmation)\b/i, 1)[0]
    .trim();
}

function trimSlot(value: string): string {
  return String(value || '')
    .replace(/^[\s“”‘’「」『』"']+|[\s“”‘’「」『』"'，。！？!?：:；;、]+$/gu, '')
    .trim();
}

function correctionOrExplanation(text: string): NormalizedActionIntent | null {
  // i18n-allow: Chinese correction/authorization input recognition; not user-visible copy.
  const negativeAuthorization = // i18n-allow: Chinese correction/authorization input recognition; not user-visible copy.
    /(?:我|我们)?(?:没有|没|并没有|从没)(?:让|叫|要求|授权|同意)你.{0,80}(?:打开|发送|执行|操作|创建|删除)|(?:不是|并不是)(?:让|叫|要)你.{0,80}(?:打开|发送|执行|操作|创建|删除)/u;
  // i18n-allow: Chinese complaint input recognition; not user-visible copy.
  const actionComplaint = // i18n-allow: Chinese complaint input recognition; not user-visible copy.
    /(?:你|lumi).{0,24}(?:刚才|刚刚|之前|上一轮)?[^。！？!?\n]{0,24}(?:打开|发送|发|执行|操作|做|画)[^。！？!?\n]{0,36}(?:什么东西|什么玩意|什么文件|什么内容|干什么|做什么|为什么|怎么回事)/iu;
  // i18n-allow: Chinese terse-complaint input recognition; not user-visible copy.
  const terseComplaint = // i18n-allow: Chinese terse-complaint input recognition; not user-visible copy.
    /^(?:(?:我操|卧槽|靠|妈的|搞什么|什么鬼)[，,\s]*)?(?:你)?(?:刚才|刚刚|之前)?[^。！？!?\n]{0,20}(?:打开|发送|执行|操作|做|画)了?[^。！？!?\n]{0,28}(?:什么|啥)[^。！？!?\n]*[啊呀呢吧。！？!?]*$/iu;
  if (!negativeAuthorization.test(text) && !actionComplaint.test(text) && !terseComplaint.test(text)) return null;
  return {
    kind: 'correction_explanation',
    operation: 'explain',
    subject: 'lumi',
    target: 'previous_action',
    payload: text,
    sideEffectClass: 'none',
    relation: 'correction',
    confidence: 0.99,
    rule: 'correction-before-action',
  };
}

function statusQuery(text: string): NormalizedActionIntent | null {
  // i18n-allow: Chinese client-state input recognition; not user-visible copy.
  const clientState = /(?:检查|查看|告诉我|现在).{0,18}(?:你的|lumi\s*的)?(?:模式|模态|运行模式|模)状态|(?:你现在|当前).{0,12}(?:是什么|什么)?模式/iu;
  if (clientState.test(text)) {
    return {
      kind: 'client_state',
      operation: 'read',
      subject: 'lumi',
      target: 'client_state',
      payload: '',
      sideEffectClass: 'none',
      relation: 'status',
      confidence: 0.96,
      rule: 'client-state-query',
    };
  }

  // i18n-allow: Chinese task-status input recognition; not user-visible copy.
  const explicitTaskStatus = // i18n-allow: Chinese task-status input recognition; not user-visible copy.
    /(?:(?:Auto\s*CAD|CAD|图|图纸|平面图|任务|这个|那个).{0,30}(?:画完|做完|完成|执行完|结束)(?:了)?(?:吗|没有|没|了没)|(?:Auto\s*CAD|CAD|任务).{0,30}(?:进度|状态|到哪|怎么样|什么情况)|(?:画|做|执行).{0,12}(?:完了吗|好了没|到哪了))/iu;
  if (!explicitTaskStatus.test(text)) return null;
  const target = /Auto\s*CAD|\bCAD\b/iu.test(text) ? 'AutoCAD' : /(?:图纸|平面图|图)/u.test(text) ? 'drawing' : 'recent_task'; // i18n-allow: Chinese task target input recognition.
  return {
    kind: 'status_query',
    operation: 'status',
    subject: 'lumi',
    target,
    payload: '',
    sideEffectClass: 'none',
    relation: 'status',
    confidence: 0.97,
    rule: 'task-status-before-action',
  };
}

function clientNavigation(text: string): NormalizedActionIntent | null {
  if (!CLIENT_NAVIGATION_VERB_RE.test(text)) return null;
  const surface = CLIENT_SURFACE_RULES.find(candidate => candidate.pattern.test(text));
  if (!surface) return null;
  return {
    kind: 'client_navigation',
    operation: 'navigate',
    subject: 'lumi',
    target: surface.target,
    payload: '',
    sideEffectClass: 'none',
    relation: 'new',
    confidence: 0.99,
    rule: `client-surface:${surface.target}`,
    clientAction: surface.action,
  };
}

function inboundMessageRead(text: string): NormalizedActionIntent | null {
  const inboundPatterns = [ // i18n-allow: Chinese inbound-message semantic-role recognition; not user-visible copy.
    /^(?!(?:看|查|读|告诉我))([^\s，。！？!?]{1,24}?)\s*(?:最近|刚刚|刚才)?\s*给我发(?:了)?(?:的)?(?:什么|哪些)?\s*(?:消息|内容|微信)/u, // i18n-allow: Chinese inbound-message semantic-role recognition.
    /(?:看(?:一下|看)?|查(?:一下|看)?|读(?:一下|取)?|告诉我)?\s*([^\s，。！？!?]{1,24}?)(?:最近|刚刚|刚才)?\s*给我发(?:了)?(?:的)?(?:什么|哪些)?\s*(?:消息|内容|微信)?/u, // i18n-allow: Chinese inbound-message semantic-role recognition.
    /(?:看(?:一下|看)?|查(?:一下|看)?|读(?:一下|取)?|告诉我)\s*([^\s，。！？!?]{1,24}?)(?:最近)?(?:发来|发给我)的?(?:消息|内容)/u, // i18n-allow: Chinese inbound-message semantic-role recognition.
    /(?:read|check|show|summari[sz]e).{0,30}(?:messages?|chat).{0,20}from\s+([\p{L}\p{N}_.'-]{1,40})/iu,
  ];
  for (const pattern of inboundPatterns) {
    const match = text.match(pattern);
    const target = trimSlot(match?.[1] || '');
    if (!target || /^(?:我|我们|你|lumi)$/iu.test(target)) continue; // i18n-allow: Chinese pronoun input recognition.
    return {
      kind: 'messaging_read',
      operation: 'read',
      subject: target,
      target,
      payload: '',
      sideEffectClass: 'none',
      relation: 'new',
      confidence: 0.99,
      rule: 'messaging-inbound-role',
    };
  }

  // i18n-allow: Chinese messaging-read input recognition; not user-visible copy.
  const generalRead = // i18n-allow: Chinese messaging-read input recognition; not user-visible copy.
    /(?:微信|wechat|weixin|聊天记录|聊天内容|消息).{0,40}(?:看看|查看|看一下|读取|读|最近|记录|总结)|(?:看看|查看|看一下|读取|读|最近|总结).{0,40}(?:微信|wechat|weixin|聊天记录|聊天内容|消息)/iu;
  if (!generalRead.test(text) || /(?:发给|发送给|帮我发|替我发|直接发|send\s+to)/iu.test(text)) return null; // i18n-allow: Chinese outbound-message exclusion.
  return {
    kind: 'messaging_read',
    operation: 'read',
    subject: '',
    target: '',
    payload: '',
    sideEffectClass: 'none',
    relation: 'new',
    confidence: 0.88,
    rule: 'messaging-read',
  };
}

function outgoingMessageSend(text: string): NormalizedActionIntent | null {
  // i18n-allow: Chinese negative-send input recognition; not user-visible copy.
  if (/(?:不要|别|无需|不用).{0,12}(?:发|发送|回复)|(?:没有|没|并未).{0,30}(?:让我|叫我|让你).{0,20}(?:发|发送|回复)/u.test(text)) return null;
  const patterns = [ // i18n-allow: Chinese outbound-message semantic-role recognition; not user-visible copy.
    /(?:发|发送|回复)给\s*([^\s，。！？!?：:；;、「」『』“”"']{1,32})\s*[「『“"']([\s\S]{1,1000}?)[」』”"']/u, // i18n-allow: Chinese outbound-message semantic-role recognition.
    /(?:我|帮我|替我|麻烦你|请你|你)?\s*给\s*([^\s，。！？!?：:；;、]{1,32})\s*(?:发|发送|回复|说|告诉)\s*([\s\S]{1,1000})/u, // i18n-allow: Chinese outbound-message semantic-role recognition.
    /(?:我|帮我|替我|麻烦你|请你|你)?\s*(?:发|发送|回复)给\s*([^\s，。！？!?：:；;、]{1,32})\s*([\s\S]{1,1000})/u, // i18n-allow: Chinese outbound-message semantic-role recognition.
    /(?:微信\s*)?(?:问一下|问问|询问)\s*([^\s，。！？!?：:；;、]{1,32})\s*([\s\S]{1,1000})/u, // i18n-allow: Chinese outbound-message semantic-role recognition.
    /(?:send\s+(?:a\s+message\s+)?(?:to\s+)?|message\s+|reply\s+to\s+)(?!(?:has|have|had|is|was|were|contains?|includes?|with|body|content|attachment|file|text)\b)([\p{L}\p{N}_.'-]{1,40})\s*:?\s*([\s\S]{1,1000})/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const target = trimSlot(match?.[1] || '');
    const payload = trimSlot(match?.[2] || '');
    if (!target || !payload || /^(?:我|我们)$/u.test(target)) continue; // i18n-allow: Chinese pronoun input recognition.
    return {
      kind: 'messaging_send',
      operation: 'mutate',
      subject: 'user',
      target,
      payload,
      sideEffectClass: 'external_commit',
      relation: 'new',
      confidence: 0.97,
      rule: 'messaging-outbound-role',
    };
  }
  return null;
}

function genericExternalCommit(text: string): NormalizedActionIntent | null {
  // Explicit negation and retrospective/explanatory language must never be
  // promoted into an external mutation merely because it contains an action
  // verb.
  // i18n-allow: Chinese external-commit negation and retrospective input recognition.
  if (/(?:不要|别|无需|不用|取消|没有|并未|没让你|为什么|怎么会|刚才|之前).{0,30}(?:发布|提交|付款|支付|签署|签字|上传|post|publish|submit|pay|sign)/iu.test(text)) return null;

  // i18n-allow: Chinese payment semantic-role input recognition.
  const payment = text.match(/(?:付款|支付|转账|打款|pay|transfer)\s*(?:给|to)?\s*([^，。！？!?\n]{1,80})/iu);
  if (payment) {
    return {
      kind: 'payment', operation: 'mutate', subject: 'user',
      target: trimSlot(payment[1]), payload: text,
      sideEffectClass: 'external_commit', relation: 'new', confidence: 0.94,
      rule: 'explicit-payment-commit',
    };
  }

  // i18n-allow: Chinese signature semantic-role input recognition.
  const signature = text.match(/(?:签署|签字|盖章|sign)\s*(?:这份|这个|the)?\s*([^，。！？!?\n]{1,120})/iu);
  if (signature) {
    return {
      kind: 'signature', operation: 'mutate', subject: 'user',
      target: trimSlot(signature[1]), payload: text,
      sideEffectClass: 'external_commit', relation: 'new', confidence: 0.93,
      rule: 'explicit-signature-commit',
    };
  }

  // i18n-allow: Chinese publication semantic-role input recognition.
  const publish = text.match(/(?:发布|发帖|公开发表|上线|publish|post)\s*(?:到|至|on|to)?\s*([^，。！？!?\n]{1,160})/iu);
  if (publish) {
    return {
      kind: 'public_publish', operation: 'mutate', subject: 'user',
      target: trimSlot(publish[1]), payload: text,
      sideEffectClass: 'external_commit', relation: 'new', confidence: 0.9,
      rule: 'explicit-publication-commit',
    };
  }

  // i18n-allow: Chinese submission semantic-role input recognition.
  const submission = text.match(/(?:提交|上传|递交|submit|upload)\s*(?:到|至|给|to)?\s*([^，。！？!?\n]{1,160})/iu);
  if (submission) {
    return {
      kind: 'external_submit', operation: 'mutate', subject: 'user',
      target: trimSlot(submission[1]), payload: text,
      sideEffectClass: 'external_commit', relation: 'new', confidence: 0.88,
      rule: 'explicit-submission-commit',
    };
  }
  return null;
}

function localDesktopOperation(text: string): NormalizedActionIntent | null {
  // Client surfaces and external commits have already won the priority race.
  // This rule requires an explicit local action plus a concrete target; a lone
  // action-shaped word is never enough to create executable work.
  const match = text.match(
    // i18n-allow: Chinese local desktop semantic-role input recognition.
    /(?:^|[，。！？!?\s])(?:请|请你|帮我|麻烦你|给我)?\s*(打开|启动|运行|切换到|聚焦|最大化|最小化|还原|关闭|open|launch|start|focus|maximi[sz]e|minimi[sz]e|restore|close)\s*(?:程序|应用|软件|窗口|app|application)?\s*([^，。！？!?\n]{1,120})/iu,
  );
  if (!match) return null;
  const verb = trimSlot(match[1]);
  const target = trimSlot(match[2]);
  if (!target || /^(?:什么|啥|哪个|why|what|which)$/iu.test(target)) return null; // i18n-allow: Chinese interrogative input recognition.
  return {
    kind: 'desktop_operation',
    operation: /^(?:打开|启动|运行|切换到|聚焦|open|launch|start|focus)$/iu.test(verb) // i18n-allow: Chinese desktop navigation verb recognition.
      ? 'navigate'
      : 'mutate',
    subject: 'user',
    target,
    payload: '',
    sideEffectClass: 'none',
    relation: 'new',
    confidence: 0.88,
    rule: 'explicit-local-desktop-operation',
  };
}

export function normalizeActionIntent(value: string): NormalizedActionIntent {
  const text = currentTurnText(value);
  if (!text) return { ...EMPTY_INTENT };

  // Order is a safety invariant. Later action-shaped words cannot override a
  // correction, status query, client-native route, or inbound read.
  const priority = [
    correctionOrExplanation(text),
    statusQuery(text),
    clientNavigation(text),
    inboundMessageRead(text),
    outgoingMessageSend(text),
    genericExternalCommit(text),
    localDesktopOperation(text),
  ].find(Boolean);
  if (priority) return priority;

  if (/(?:画完|完成).{0,16}(?:之后|以后|后).{0,24}(?:设计方案|方案)|(?:再|接着).{0,16}(?:出|做|生成).{0,12}(?:设计方案|方案)/u.test(text)) { // i18n-allow: Chinese CAD child-task input recognition.
    return {
      kind: 'cad_drafting',
      operation: 'create',
      subject: 'user',
      target: /Auto\s*CAD|\bCAD\b/iu.test(text) ? 'AutoCAD' : 'recent_drawing',
      payload: text,
      sideEffectClass: 'local_write',
      relation: 'child',
      confidence: 0.9,
      rule: 'cad-child-deliverable',
    };
  }
  if (/(?:Auto\s*CAD|\bCAD\b|图纸|平面图).{0,40}(?:画|绘制|生成|修改)|(?:画|绘制|生成|修改).{0,40}(?:Auto\s*CAD|\bCAD\b|图纸|平面图)/iu.test(text)) { // i18n-allow: Chinese CAD task input recognition.
    return {
      kind: 'cad_drafting',
      operation: 'create',
      subject: 'user',
      target: /Auto\s*CAD|\bCAD\b/iu.test(text) ? 'AutoCAD' : 'drawing',
      payload: text,
      sideEffectClass: 'local_write',
      relation: 'new',
      confidence: 0.86,
      rule: 'cad-drafting',
    };
  }

  return { ...EMPTY_INTENT };
}

export function isNonExecutingNormalizedIntent(intent: NormalizedActionIntent): boolean {
  return intent.kind === 'correction_explanation' || intent.kind === 'status_query';
}
