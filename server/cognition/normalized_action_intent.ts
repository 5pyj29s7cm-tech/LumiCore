import { PERSONAL_CLIENT_SURFACES } from '../../shared/client_surfaces';

export type NormalizedActionIntentKind =
  | 'none'
  | 'external_ai_history'
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
  | 'scheduled_task'
  | 'work_task'
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
  /** Exact structured arguments needed by a deterministic native client action. */
  clientActionArguments?: Record<string, unknown>;
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
  /(?:打开|开启|启用|进入|切换到|切到|回到|返回|显示|展开|关闭|收起|open|show|enter|switch|turn\s+on|return|close)/iu;

// Some speech recognizers render “壁纸模式” as “壁纸状态”. A standalone
// imperative using that phrase still means entering Lumi's wallpaper surface;
// an interrogative such as “壁纸状态怎么样” remains a state query.
// i18n-allow: Multilingual client-surface alias recognition; not user-visible copy.
const WALLPAPER_STATE_MUTATION_RE = /^(?:请|麻烦你)?\s*(?:打开|开启|启用|进入|切换到|切到|关闭|退出|收起)\s*(?:Lumi\s*)?(?:壁纸状态|wallpaper\s+state)(?:一下|吧)?[。！!\s]*$/iu;

// A request to hear the adjacent assistant reply again is conversational
// continuity, not execution recovery. In particular, “卡住” describes the
// voice/model delivery here; it must not bind the turn to an older blocked
// work-takeover task.
// i18n-allow: Multilingual adjacent-reply restatement recognition; not user-visible copy.
const IMMEDIATE_ASSISTANT_RESTATEMENT_RE = /^(?:(?:sorry|抱歉|不好意思)[,，。！!\s]*)?(?:(?:(?:你)?(?:刚刚|刚才)(?:你)?|你)[^，,。！？!?\n]{0,24}(?:又)?(?:卡住|卡了|断了|没说完|没听清)(?:了)?[,，。！？!?\s]*)?(?:请)?(?:(?:重新说|重说)(?:一下)?|再说(?:一遍|一次|一下)|重复(?:一遍|一次))[。！？.!?\s]*$|^(?:(?:sorry)[,!.\s]*)?(?:(?:you|that)[^,.!?\n]{0,24}(?:cut\s+out|got\s+stuck|stopped)[,.!?\s]*)?(?:please\s+)?(?:say(?:\s+(?:that|it))?\s+again|repeat(?:\s+(?:that|it))?(?:\s+again)?)[.!?\s]*$/iu;

// Bare “怎么说” is the established voice-friendly request to hear Lumi's
// preceding reply again. Keep this exact so content questions such as
// “这个词/英文怎么说” remain ordinary conversation.
// i18n-allow: Multilingual adjacent-reply restatement recognition; not user-visible copy.
const BARE_ASSISTANT_RESTATEMENT_RE =
  /^(?:(?:你)?(?:刚才|刚刚)\s*)?(?:怎么说|怎麼說)(?:的)?[啊呀吧嘛呢，,。！？?!\s]*$/u;

function escapePattern(value: string): string {
  return value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s_-]*');
}

const REGISTERED_CLIENT_SURFACE_RULES: ReadonlyArray<{ pattern: RegExp; target: string; action: string }> =
  PERSONAL_CLIENT_SURFACES.flatMap(surface => {
    const action = surface.actions[0];
    if (!action) return [];
    const aliases = Array.from(new Set([
      surface.id, surface.label, ...(surface.navigationAliases || []),
    ].map(value => String(value || '').trim()).filter(Boolean)));
    if (!aliases.length) return [];
    return [{ pattern: new RegExp(`(?:${aliases.map(escapePattern).join('|')})`, 'iu'), target: surface.target, action }];
  });

const CLIENT_SURFACE_RULES: ReadonlyArray<{ pattern: RegExp; target: string; action: string }> = [
  { pattern: /(?:自主模式|autonomy|autonomous\s*mode)/iu, target: 'autonomous', action: 'set_client_mode' }, // i18n-allow: Multilingual Lumi mode aliases.
  { pattern: /(?:助理模式|assistant\s*mode)/iu, target: 'assistant', action: 'set_client_mode' }, // i18n-allow: Multilingual Lumi mode aliases.
  { pattern: /(?:聊天模式|chat\s*mode)/iu, target: 'chat', action: 'set_client_mode' }, // i18n-allow: Multilingual Lumi mode aliases.
  { pattern: /(?:会议模式|meeting\s*mode)/iu, target: 'meeting', action: 'set_client_mode' }, // i18n-allow: Multilingual Lumi mode aliases.
  { pattern: /(?:聊天界面|聊天窗口|聊天面板|侧边聊天|side\s*chat|chat\s*(?:window|panel)?)/iu, target: 'chat', action: 'open_chat' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:中枢世界|中枢|世界视图|nexus|world\s*view)/iu, target: 'nexus', action: 'open_nexus' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:技能大厅|技能中心|skill\s*(?:hall|center))/iu, target: 'skills', action: 'open_skills' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:知识库|knowledge\s*base)/iu, target: 'knowledge', action: 'show_knowledge_base' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:运行日志|runtime\s*log)/iu, target: 'runtime-log', action: 'open_computer_adaptation' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:通知中心|通知面板|notification\s*(?:center|panel))/iu, target: 'notifications', action: 'open_notifications' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:提醒面板|提醒中心|reminder\s*(?:center|panel))/iu, target: 'reminders', action: 'open_reminders' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:设置界面|设置页面|客户端设置|settings)/iu, target: 'settings', action: 'open_settings' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:个人主页|个人主界面|个人桌面|主屏幕|主页面|主界面|首页|lumi\s*桌面|home)/iu, target: 'home', action: 'focus_home' }, // i18n-allow: Multilingual Lumi surface aliases.
  { pattern: /(?:壁纸(?:模式|状态)|wallpaper\s*(?:mode|state))/iu, target: 'wallpaper', action: 'set_wallpaper_mode' }, // i18n-allow: Speech alias for Lumi wallpaper mode.
  ...REGISTERED_CLIENT_SURFACE_RULES,
];

function currentTurnText(value: string): string {
  return String(value || '')
    .split(/\n## (?:Recent action continuation context|Exact Pending Action Confirmation)\b/i, 1)[0]
    .trim();
}

export function isImmediateAssistantRestatementRequest(value: string): boolean {
  const text = currentTurnText(value).replace(/\s+/gu, ' ').trim().slice(0, 180);
  return Boolean(
    text
    && (
      IMMEDIATE_ASSISTANT_RESTATEMENT_RE.test(text)
      || BARE_ASSISTANT_RESTATEMENT_RE.test(text)
    ),
  );
}

function trimSlot(value: string): string {
  return String(value || '')
    .replace(/^[\s“”‘’「」『』"']+|[\s“”‘’「」『』"'，。！？!?：:；;、]+$/gu, '')
    .trim();
}

const ARTIFACT_FILE_EXTENSION_RE = /\.(?:txt|md|csv|json|docx?|xlsx?|pptx?|pdf)\b/iu;

function explicitArtifactPath(text: string): string {
  const absolute = text.match(
    /([A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:txt|md|csv|json|docx?|xlsx?|pptx?|pdf))(?=$|[\s.,，。;；:：!！?？)）\]}'"])/iu,
  )?.[1];
  if (absolute) return trimSlot(absolute);
  return trimSlot(
    text.match(/([^\s\\/:*?"<>|\r\n]{1,160}\.(?:txt|md|csv|json|docx?|xlsx?|pptx?|pdf))\b/iu)?.[1] || '',
  );
}

function hasAffirmativeArtifactCreationAction(text: string): boolean {
  // Remove only clauses that negate the file mutation itself. A boundary such
  // as "Do not report task status" must not erase a preceding affirmative
  // write instruction.
  // i18n-allow: Reviewed Chinese artifact-action input recognition; not user-visible copy.
  const positiveChinese = text
    .replace(
      // i18n-allow: Reviewed Chinese artifact-action input recognition; not user-visible copy.
      /(?:不要|别|无需|不用|禁止|请勿|勿).{0,16}(?:创建|新建|生成|写入|保存)[^，,。！？!?；;\n]*/gu,
      ' ',
    )
    // Status interrogatives mention the historical verb but do not authorize
    // another write (for example, "是否写入后回读").
    // i18n-allow: Reviewed Chinese artifact-status input recognition; not user-visible copy.
    .replace(/(?:是否|有没有|有没|能否).{0,16}(?:已经)?(?:创建|新建|生成|写入|保存)[^，,。！？!?；;\n]*/gu, ' ')
    // i18n-allow: Reviewed Chinese artifact-status input recognition; not user-visible copy.
    .replace(/(?:创建|新建|生成|写入|保存)(?:了|过)?(?:吗|没有|没|了没)[^，,。！？!?；;\n]*/gu, ' ');
  // i18n-allow: Reviewed Chinese artifact-action input recognition; not user-visible copy.
  if (/(?:创建|新建|生成|写入)/u.test(positiveChinese)) return true;

  // i18n-allow: English artifact-creation input recognition; not user-visible copy.
  const clauseImperative =
    /(?:^|[\[\]{}()!?.,;:\n]\s*)(?:(?:please|now|then|next|you\s+must|you\s+should|must|should)\s+)*(?:create|write|generate|save)\b/iu;
  // "Start a separate task by creating <path>" is an action contract, not a
  // request to launch an application named "a separate task".
  const startByCreating =
    /\b(?:start|begin)\b[^.!?;\n]{0,120}\bby\s+creat(?:e|ing)\b/iu;
  const requiredWriteTool =
    /\b(?:must|should|need\s+to|required\s+to)\s+(?:call|use)\s+write_file\b/iu;
  return clauseImperative.test(text) || startByCreating.test(text) || requiredWriteTool.test(text);
}

function explicitArtifactCreationIntent(text: string): NormalizedActionIntent | null {
  const target = explicitArtifactPath(text);
  if (!target || !ARTIFACT_FILE_EXTENSION_RE.test(target) || !hasAffirmativeArtifactCreationAction(text)) {
    return null;
  }
  return {
    kind: 'desktop_operation',
    operation: 'create',
    subject: 'user',
    target,
    payload: text,
    sideEffectClass: 'local_write',
    relation: 'new',
    confidence: 0.99,
    rule: 'explicit-artifact-create',
  };
}

function explicitLocalArtifactReadIntent(text: string): NormalizedActionIntent | null {
  const target = explicitArtifactPath(text);
  if (!target) return null;
  const targetIndex = text.indexOf(target);
  const actionPrefix = targetIndex >= 0 ? text.slice(0, targetIndex).trim() : '';
  // This owns only an explicit fresh command. “继续分析” and a path supplied
  // by itself remain eligible to fill the target slot of an unfinished task.
  // i18n-allow: Multilingual local-artifact read recognition; not user-visible copy.
  if (!/^(?:(?:请|麻烦你|现在|直接)\s*)*(?:分析|读取|查看|审查|检查|总结)(?:一下)?\s*$|^(?:(?:please|now|directly)\s+)*(?:analy[sz]e|read|inspect|review|check|summari[sz]e)(?:\s+the)?\s*$/iu.test(actionPrefix)) {
    return null;
  }
  return {
    kind: 'desktop_operation',
    operation: 'read',
    subject: 'user',
    target,
    payload: text,
    sideEffectClass: 'none',
    relation: 'new',
    confidence: 0.98,
    rule: 'explicit-local-artifact-read',
  };
}

export function isExplicitArtifactCreationText(text: string): boolean {
  return Boolean(explicitArtifactCreationIntent(currentTurnText(String(text || ''))));
}

export function isExternalCommitConfirmationOnlyRequest(text: string): boolean {
  const value = String(text || '');
  const asksForConfirmation = /(?:真正发送前|发送之前|发送前).{0,24}(?:确认|同意|批准)|(?:只到|停在|保持在).{0,16}(?:等待确认|待确认)|\bbefore\s+(?:actually\s+)?sending\b.{0,32}\b(?:confirm|approval)\b/iu.test(value);
  const forbidsCurrentCommit = /(?:现在|当前|这一轮)?(?:只到|停在).{0,20}(?:等待确认|待确认)|(?:不要|别|禁止).{0,16}(?:真正)?(?:发送|发出|提交|发布)|\b(?:do\s+not|don't|never)\b.{0,40}\b(?:send|submit|publish)\b/iu.test(value);
  return asksForConfirmation && forbidsCurrentCommit;
}

function correctionOrExplanation(text: string): NormalizedActionIntent | null {
  // A time-bounded activity question is a status lookup, even though phrases
  // such as "做了什么" are superficially similar to an action complaint. i18n-allow: Reviewed input recognition.
  if (/(?:昨天|今天|这两天|最近|从.{0,12}到.{0,12}|到现在|截至现在).{0,40}(?:做了|干了|执行了|处理了|完成了).{0,20}(?:什么|哪些|多少)/u.test(text)) return null;
  // i18n-allow: Chinese correction/authorization input recognition; not user-visible copy.
  const negativeAuthorization = // i18n-allow: Chinese correction/authorization input recognition; not user-visible copy.
    /(?:我|我们)?(?:没有|没|并没有|从没)(?:让|叫|要求|授权|同意)你.{0,80}(?:打开|发送|执行|操作|创建|删除)|(?:不是|并不是)(?:让|叫|要)你.{0,80}(?:打开|发送|执行|操作|创建|删除)/u;
  // i18n-allow: Multilingual authorization objections and retrospective challenges; not user-visible copy.
  const authorizationOrExecutionObjection =
    /(?:谁|哪个人|是谁)(?:让|叫|允许|授权|批准)你|未经(?:我|我们)?(?:的)?(?:允许|授权|同意|批准)|(?:你)?(?:没有|无|没)(?:这个)?权限|(?:我|我们)?什么时候(?:允许|授权|同意|让)你|凭什么(?:打开|发送|执行|操作|创建|删除)?|为什么不(?:先)?(?:问|确认|征得)|(?:你|lumi).{0,24}(?:刚才|刚刚|之前|上一轮)[^。！？!?\n]{0,48}(?:打开|发送|执行|操作|创建|删除)[^。！？!?\n]{0,36}(?:干什么|为什么|凭什么|怎么回事)|\bwho\s+(?:asked|told|authorized|allowed|gave)\s+you\b|\bwithout\s+(?:my|our)\s+(?:permission|authorization|approval)\b|\byou\s+(?:(?:do|did)\s+not|don['\u2019]?t|didn['\u2019]?t)\s+have\s+(?:my\s+)?permission\b|\bwhy\s+(?:didn['\u2019]?t\s+you|did\s+you\s+not)\s+(?:ask|confirm)\b|\bwhy\s+did\s+(?:you|lumi)\s+(?:just\s+)?(?:open|send|run|execute|create|delete)\b/iu;
  // i18n-allow: Chinese complaint input recognition; not user-visible copy.
  const actionComplaint = // i18n-allow: Chinese complaint input recognition; not user-visible copy.
    /(?:你|lumi).{0,24}(?:刚才|刚刚|之前|上一轮)[^。！？!?\n]{0,24}(?:打开|发送|发|执行|操作|做|画)(?:了)?[^。！？!?\n]{0,36}(?:什么东西|什么玩意|什么文件|什么内容|干什么|做什么|为什么|怎么回事)/iu;
  // i18n-allow: Chinese terse-complaint input recognition; not user-visible copy.
  const terseComplaint = // i18n-allow: Chinese terse-complaint input recognition; not user-visible copy.
    /^(?:(?:我操|卧槽|靠|妈的|搞什么|什么鬼)[，,\s]*)?(?:你|lumi)[^。！？!?\n]{0,20}(?:打开|发送|执行|操作|做|画)了[^。！？!?\n]{0,28}(?:什么|啥|为什么|怎么回事)[^。！？!?\n]*[啊呀呢吧。！？!?]*$/iu;
  // A user can correct task identity while quoting the wrongly selected old
  // action. Quoted verbs remain evidence about the previous turn and must not
  // become a fresh command.
  const taskIdentityCorrection = // i18n-allow: Chinese correction input recognition; not user-visible copy.
    /(?:不对|错了|搞错了|误判|误识别|答非所问).{0,180}(?:(?:我)?(?:刚才|刚刚|上一条).{0,100}(?:新(?:的)?|任务|指令|要求).{0,100}(?:你却|却|但你|而你).{0,80}(?:回答|执行|调用).{0,80}(?:旧|之前|上一)|误判|误识别|答非所问)/u;
  // A plain retrospective receipt question is not a complaint. Let the
  // status lane answer it from the durable ledger, while preserving explicit
  // authorization objections and corrections about the selected task.
  if (
    isRecentActionReceiptQuery(text)
    && !negativeAuthorization.test(text)
    && !authorizationOrExecutionObjection.test(text)
    && !taskIdentityCorrection.test(text)
  ) return null;
  if (
    !negativeAuthorization.test(text)
    && !authorizationOrExecutionObjection.test(text)
    && !actionComplaint.test(text)
    && !terseComplaint.test(text)
    && !taskIdentityCorrection.test(text)
  ) return null;
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

export type NormalizedIntentRuntimeRole = 'advisory' | 'native_client_event';
export type NormalizedIntentOrigin =
  | 'natural_language'
  | 'structured_client_event'
  | 'model_selected_capability';

/**
 * Normalized intent is a planning hint, not a natural-language executor.
 * Merely recognizing a registered client surface in user text never upgrades
 * the text into a native event. Deterministic ownership is reserved for a
 * structured client event; model-selected capabilities execute through the
 * shared tool loop and therefore remain advisory here.
 */
export function getNormalizedIntentRuntimeRole(
  intent: NormalizedActionIntent,
  origin: NormalizedIntentOrigin = 'natural_language',
): NormalizedIntentRuntimeRole {
  return origin === 'structured_client_event'
    && intent.kind === 'client_navigation'
    && Boolean(intent.clientAction)
    ? 'native_client_event'
    : 'advisory';
}

const MIXED_STATUS_SIGNAL_RE =
  /(?:\u72b6\u6001|\u8fdb\u5ea6|\u7ed3\u679c|(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c|\u597d)(?:\u4e86)?(?:\u5417|\u6ca1|\u4e86\u6ca1)|\u662f\u5426.{0,16}(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c)|(?:\u6ca1\u6709|\u6ca1|\u672a|\u5c1a\u672a)(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c)|\b(?:status|progress|result)\b|\b(?:is|was|has)\b.{0,24}\b(?:done|complete|completed|finished|successful)\b|\bwhether\b.{0,24}\b(?:done|complete|completed|finished)\b)/iu;

const CN_MIXED_STATUS_EXECUTION_RE =
  /(?:\u5982\u679c|\u82e5|\u8981\u662f|\u5047\u5982).{0,18}(?:\u6ca1\u6709|\u6ca1|\u672a|\u5c1a\u672a)(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c|\u6210\u529f)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:(?:\u5c31|\u5219|\u90a3\u5c31|\u8bf7|\u9a6c\u4e0a|\u7acb\u5373|\u73b0\u5728)\s*)?(?:\u7ee7\u7eed|\u63a5\u7740|\u6062\u590d|\u91cd\u8bd5|\u518d\u8bd5|\u91cd\u65b0\u6267\u884c|\u6267\u884c|\u5904\u7406|\u63a8\u8fdb|\u5b8c\u6210|\u505a\u5b8c)|(?:\u6ca1\u6709|\u6ca1|\u672a|\u5c1a\u672a)(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c|\u6210\u529f)[^\u3002\uff01\uff1f.!?\n]{0,12}(?:\u5c31|\u5219|\u90a3\u5c31|\u8bf7|\u9a6c\u4e0a|\u7acb\u5373|\u73b0\u5728)\s*(?:\u7ee7\u7eed|\u63a5\u7740|\u6062\u590d|\u91cd\u8bd5|\u518d\u8bd5|\u91cd\u65b0\u6267\u884c|\u6267\u884c|\u5904\u7406|\u63a8\u8fdb|\u5b8c\u6210|\u505a\u5b8c)|[\uff1f?\uff1b;\u3002]\s*(?:(?:\u8bf7|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u5373|\u7136\u540e|\u90a3\u5c31|\u5c31)\s*)?(?:\u7ee7\u7eed|\u63a5\u7740|\u6062\u590d|\u91cd\u8bd5|\u518d\u8bd5|\u91cd\u65b0\u6267\u884c|\u6267\u884c|\u5904\u7406|\u63a8\u8fdb)(?:\u5b83|\u8fd9\u4e2a|\u90a3\u4e2a|\u4efb\u52a1)?/u;

const EN_MIXED_STATUS_EXECUTION_RE =
  /\bif\s+(?:(?:not|unfinished|incomplete)\b|(?:(?:it|this|that|the\s+task)\s+)?(?:is|was|has\s+been)?\s*(?:not|isn['\u2019]?t|wasn['\u2019]?t|hasn['\u2019]?t)\s+(?:done|complete|completed|finished|successful)\b)[^.!?;\n]{0,28}\b(?:continue|resume|retry|re-?try|execute|run|finish|complete|proceed)\b|[?;.!]\s*(?:(?:if\s+(?:not|unfinished|incomplete)|then|please|now)\s*[,;:]?\s*)*(?:continue|resume|retry|re-?try|execute|run|finish|complete|proceed)\b/iu;

const RECENT_ACTION_RECEIPT_QUERY_RE =
  /(?:\u4f60|lumi)?\s*(?:\u521a\u624d|\u521a\u521a|\u4e0a\u4e00\u8f6e|\u4e0a\u6b21).{0,48}(?:\u505a|\u6253\u5f00|\u6267\u884c|\u53d1\u9001|\u521b\u5efa|\u64cd\u4f5c)(?:\u4e86)?.{0,36}(?:\u4ec0\u4e48|\u54ea\u4e2a|\u54ea\u4e9b|\u6210\u529f|\u5b8c\u6210|\u8bc1\u636e|\u56de\u6267)|\bwhat\s+did\s+(?:you|lumi)\s+(?:just\s+)?(?:do|open|run|send|create)\b|\bdid\s+(?:you|lumi)\s+(?:just\s+)?(?:open|run|send|create).{0,120}\bsuccessfully\b|\bwhat\s+evidence\b.{0,48}\b(?:succeed|succeeded|success|complete|completed)\b/iu;

/**
 * A narrow, read-only query for the immediately preceding turn's persisted
 * tool receipts. Keep this separate from generic task status so Chat can
 * answer it locally without exposing the model to a tool manifest.
 */
export function isPriorTurnToolReceiptQuestion(text: string): boolean {
  const value = currentTurnText(String(text || '')).replace(/\s+/gu, ' ').trim();
  if (!value) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const positiveToolText = value
    .replace(
      /(?:不要|别|无需|不需要|不用|禁止|请勿|勿|不)\s*(?:再|继续|再次)?\s*(?:调用|使用|执行|启动)?\s*(?:(?:任何|这些|外部|新(?:的)?|其他|其它)\s*){0,3}(?:工具|插件|技能|脚本)(?!(?:说明|介绍|解释|清单|列表|文档))/giu, // i18n-allow: Chinese negated tool-instruction recognition; not user-visible copy.
      ' ',
    )
    .replace(
      /\b(?:do\s+not|don't|without)\s+(?:call(?:ing)?|use|using|run(?:ning)?|execute|executing)?\s*(?:any\s+)?(?:tools?|plugins?|skills?|scripts?)\b/giu,
      ' ',
    );
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const priorTurn = /(?:上一轮|上一回合|上一次|上次|刚才|刚刚|前一轮)|\b(?:previous|prior|last)\s+(?:turn|request|message)\b|\bjust\b/iu.test(value);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const toolReceipt = /(?:(?:调用|执行|使用|跑).{0,12}(?:工具|插件|技能)|(?:工具名|工具调用|工具回执|执行回执|已保存的回执|持久化回执))|\b(?:call|use|run|execute)(?:d|ing)?\s+(?:(?:any|a|the)\s+)?tools?\b|\btool\s+(?:name|call|receipt|result)\b/iu.test(positiveToolText);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const asksFact = /(?:是否|有没有|有没|真的|究竟|到底|哪(?:个|些)|什么|成功|失败|结果|回执|告诉|说明)|\b(?:did|was|were|which|what|success|succeed(?:ed)?|fail(?:ed|ure)?|result|receipt)\b/iu.test(value);
  return priorTurn && toolReceipt && asksFact;
}

export function isRecentActionReceiptQuery(text: string): boolean {
  return isPriorTurnToolReceiptQuestion(text) || RECENT_ACTION_RECEIPT_QUERY_RE.test(text);
}

const CN_INDEPENDENT_ACTION_AFTER_STATUS_RE =
  /(?:[\uff1f?\uff1b;\uff0c,\u3002.!\u2026\n]\s*(?:(?:\u7136\u540e|\u73b0\u5728|\u63a5\u7740|\u4e0b\u4e00\u6b65|\u53e6\u5916|\u5e76(?:\u4e14)?|\u518d)\s*)?|(?:\u7136\u540e|\u73b0\u5728|\u63a5\u7740|\u4e0b\u4e00\u6b65|\u53e6\u5916|\u5e76(?:\u4e14)?|\u518d)\s*)(?!(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u5fc5|\u53ea|\u4ec5))(?:(?:\u8bf7|\u9a6c\u4e0a|\u7acb\u5373)\s*)?(?:\u6253\u5f00|\u542f\u52a8|\u65b0\u5efa|\u521b\u5efa|\u4fdd\u5b58|\u5199\u5165|\u53d1\u9001|\u5173\u95ed|\u5220\u9664|\u4fee\u6539|\u5bfc\u51fa|\u4e0a\u4f20|\u4e0b\u8f7d|\u5b89\u88c5|\u7ee7\u7eed|\u6062\u590d|\u91cd\u8bd5|\u6267\u884c|\u5904\u7406|\u8c03\u7528|\u4f7f\u7528|\u68c0\u67e5|\u6838\u5b9e|\u6838\u9a8c)/u;

const EN_INDEPENDENT_ACTION_AFTER_STATUS_RE =
  /(?:[?;.!,\u2026\n]\s*(?:(?:then|now|next|also|and|please)\s*[,;:]?\s*)*|\b(?:(?:and\s+)?(?:then|now|next|also)|and)\b\s*)(?!(?:do\s+not|don['\u2019]?t|never|only|just\s+(?:answer|report))\b)(?:open|launch|start|create|save|write|send|close|delete|modify|update|export|upload|download|install|continue|resume|retry|re-?try|execute|run|finish|complete|proceed|call|use|check|verify|inspect)\b/iu;

const EN_TRAILING_ACTION_QUESTION_RE =
  /\b(?:open|launch|start|create|save|write|send|close|delete|modify|update|export|upload|download|install|continue|resume|retry|re-?try|execute|run|finish|complete|proceed|call|use|check|verify|inspect)\b[^.!?;\n]{0,64}\?\s*$/iu;

const CN_TRAILING_ACTION_QUESTION_RE =
  /(?:\u6253\u5f00|\u542f\u52a8|\u65b0\u5efa|\u521b\u5efa|\u4fdd\u5b58|\u5199\u5165|\u53d1\u9001|\u5173\u95ed|\u5220\u9664|\u4fee\u6539|\u5bfc\u51fa|\u4e0a\u4f20|\u4e0b\u8f7d|\u5b89\u88c5|\u7ee7\u7eed|\u6062\u590d|\u91cd\u8bd5|\u6267\u884c|\u5904\u7406|\u8c03\u7528|\u4f7f\u7528|\u68c0\u67e5|\u6838\u5b9e|\u6838\u9a8c)[^\u3002\uff01!\uff1b;\n]{0,64}(?:(?:\u4e86|\u8fc7)?\u5417|\u4e86\u6ca1|\u6ca1\u6709?|\u5462|\u662f\u5426|\u662f\u4e0d\u662f)[\uff1f?]?\s*$/u;

/**
 * A status question is not status-only when the same turn also contains an
 * independent, affirmative instruction to resume the work. Keeping this
 * predicate next to normalized intent priority prevents an interrogative
 * first clause from suppressing the executable second clause.
 */
export function hasMixedStatusExecutionIntent(value: string): boolean {
  const text = currentTurnText(value).replace(/\s+/gu, ' ').trim();
  if (!text) return false;
  const hasTaskStatusSignal = MIXED_STATUS_SIGNAL_RE.test(text);
  const hasRecentActionStatusSignal = isRecentActionReceiptQuery(text);
  if (!hasTaskStatusSignal && !hasRecentActionStatusSignal) return false;
  const chineseExecutionQuestion = /(?:\u7ee7\u7eed(?:\u6267\u884c|\u5904\u7406|\u63a8\u8fdb|\u5b8c\u6210)?|\u63a5\u7740(?:\u6267\u884c|\u5904\u7406|\u63a8\u8fdb|\u505a)?|\u6062\u590d(?:\u6267\u884c|\u4efb\u52a1)?|\u91cd\u8bd5|\u518d\u8bd5|\u91cd\u65b0\u6267\u884c|\u6267\u884c|\u5904\u7406|\u63a8\u8fdb)(?:\u5b83|\u8fd9\u4e2a|\u90a3\u4e2a|\u4efb\u52a1)?(?:\u4e86)?(?:(?:\u5417|\u6ca1|\u6ca1\u6709|\u5462)[\uff1f?]?|[\uff1f?])\s*$/u.test(text);
  const englishExecutionQuestion = /\b(?:continue|resume|retry|re-?try|execute|run|finish|complete|proceed)(?:\s+(?:executing|execution|running|working\s+on|with)(?:\s+(?:it|this|that|the\s+task))?)?\s*\?\s*$/iu.test(text)
    || EN_TRAILING_ACTION_QUESTION_RE.test(text);
  const chineseIndependentAction = CN_INDEPENDENT_ACTION_AFTER_STATUS_RE.test(text)
    && !CN_TRAILING_ACTION_QUESTION_RE.test(text);
  const englishIndependentAction = EN_INDEPENDENT_ACTION_AFTER_STATUS_RE.test(text)
    && !EN_TRAILING_ACTION_QUESTION_RE.test(text);
  return (CN_MIXED_STATUS_EXECUTION_RE.test(text) && !chineseExecutionQuestion)
    || (EN_MIXED_STATUS_EXECUTION_RE.test(text) && !englishExecutionQuestion)
    || (hasRecentActionStatusSignal && chineseIndependentAction)
    || (hasRecentActionStatusSignal && englishIndependentAction);
}

function statusQuery(text: string): NormalizedActionIntent | null {
  // A concrete new write owns the turn even when a separate scope fence uses
  // a status noun. Retrospective/status-only forms are excluded by the strict
  // affirmative artifact-action recognizer.
  if (explicitArtifactCreationIntent(text)) return null;
  if (hasMixedStatusExecutionIntent(text)) return null;
  if (WALLPAPER_STATE_MUTATION_RE.test(text)) return null;
  // Reporting the id/status after creating a specifically described new task
  // is part of that creation contract, not a query about an older task.
  if (persistentWorkTaskCreation(text)) return null;
  // i18n-allow: Chinese task-status control recognition; not user-visible copy.
  if (/^(?:你|lumi)?\s*(?:现在|当前)?\s*(?:在)?\s*(?:干嘛|干啥|做什么|搞什么|忙什么)[啊呀吧嘛呢，,。！？?!\s]*$/iu.test(text)) {
    return {
      kind: 'status_query',
      operation: 'status',
      subject: 'lumi',
      target: 'recent_task',
      payload: '',
      sideEffectClass: 'none',
      relation: 'status',
      confidence: 0.99,
      rule: 'active-task-status-control',
    };
  }
  const namedArtifact = text.match(/([^\s\\/:*?"<>|\r\n]{1,160}\.(?:txt|md|docx?|xlsx?|pptx?|pdf|csv))\b/iu)?.[1]?.trim();
  const asksNamedArtifactStatus = Boolean(
    namedArtifact
    && /(?:\u6587\u4ef6|\u4ea7\u7269|\u4efb\u52a1).{0,24}(?:\u73b0\u5728)?(?:\u662f\u4ec0\u4e48|\u4ec0\u4e48|\u5565)\u72b6\u6001|\u662f\u5426(?:\u5df2\u7ecf)?(?:\u5199\u5165|\u56de\u8bfb).{0,12}[\uff1f?]|\u6700\u7ec8\u72b6\u6001|\b(?:what\s+is|final)\b.{0,24}\bstatus\b|\bwas\b.{0,32}\b(?:written|read\s*back)\b/iu.test(text)
  );
  if (namedArtifact && asksNamedArtifactStatus) {
    return {
      kind: 'status_query',
      operation: 'status',
      subject: 'lumi',
      target: namedArtifact,
      payload: '',
      sideEffectClass: 'none',
      relation: 'status',
      confidence: 0.99,
      rule: 'named-artifact-status-before-action',
    };
  }

  // The wallpaper speech alias owns its state question before the generic
  // “打开 <desktop target> 状态” matcher. Other registered surfaces retain the
  // established receipt/status priority below.
  const wallpaperSurfaceStatus = !isExplicitArtifactCreationText(text)
    && /(?:壁纸(?:模式|状态)|wallpaper\s*(?:mode|state))/iu.test(text) // i18n-allow: Reviewed wallpaper state-query recognition.
    && /(?:进度|状态|结果呢|做到哪|到哪了|怎么样|做完了吗|完成了吗|好了吗|了吗|了没|是否)/u.test(text); // i18n-allow: Reviewed wallpaper state-query recognition.
  if (wallpaperSurfaceStatus) {
    return {
      kind: 'status_query', operation: 'status', subject: 'lumi', target: 'wallpaper',
      payload: '', sideEffectClass: 'none', relation: 'status', confidence: 0.97,
      rule: 'registered-client-surface-status',
    };
  }

  // A status question can name an exact desktop target while still containing
  // an action verb, for example "打开 Windows 计算器的任务最终状态是什么".
  // Preserve that target so the persistent ledger does not fall back to the
  // most recently updated (and possibly unrelated) task.
  const namedDesktopStatus = text.match(
    /(?:\u6253\u5f00|\u542f\u52a8)\s*([^\u3002\uff01\uff1f?\n]{1,80}?)(?:\u7684)?(?:\u4efb\u52a1)?(?:\u6700\u7ec8)?(?:\u72b6\u6001|\u7ed3\u679c)(?:\u662f\u4ec0\u4e48|\u5982\u4f55|\u600e\u4e48\u6837|\u4e3a)?/iu,
  )?.[1]?.trim();
  if (namedDesktopStatus) {
    return {
      kind: 'status_query',
      operation: 'status',
      subject: 'lumi',
      target: namedDesktopStatus,
      payload: '',
      sideEffectClass: 'none',
      relation: 'status',
      confidence: 0.99,
      rule: 'named-desktop-status-before-action',
    };
  }

  // A retrospective question about the immediately preceding action is a
  // receipt/status lookup. Action verbs inside the question must never be
  // reinterpreted as a fresh desktop or external mutation.
  // i18n-allow: Multilingual recent-action receipt recognition; not user-visible copy.
  if (isRecentActionReceiptQuery(text)) {
    return {
      kind: 'status_query',
      operation: 'status',
      subject: 'lumi',
      target: 'previous_action',
      payload: '',
      sideEffectClass: 'none',
      relation: 'status',
      confidence: 0.99,
      rule: 'recent-action-receipt-before-action',
    };
  }

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

  // A new artifact instruction may contain literal field values such as
  // "状态：..." or text mentioning a Lumi surface. Those nouns do not make
  // the turn a status follow-up; the explicit create/write action wins.
  if (isExplicitArtifactCreationText(text)) return null;

  const registeredSurfaceStatus =
    /(?:进度|状态|结果呢|做到哪|到哪了|怎么样|做完了吗|完成了吗|好了吗)/u.test(text) // i18n-allow: Reviewed Chinese status-follow-up input recognition.
      ? CLIENT_SURFACE_RULES.find(candidate => candidate.pattern.test(text))
      : undefined;
  if (registeredSurfaceStatus) {
    return {
      kind: 'status_query', operation: 'status', subject: 'lumi', target: registeredSurfaceStatus.target,
      payload: '', sideEffectClass: 'none', relation: 'status', confidence: 0.97,
      rule: 'registered-client-surface-status',
    };
  }

  // i18n-allow: Chinese activity-history status recognition; not user-visible copy.
  const activityHistory = /(?:昨天|今天|这两天|最近|从.{0,12}到.{0,12}|到现在|截至现在).{0,40}(?:做了|干了|执行了|处理了|完成了).{0,20}(?:什么|哪些|多少)/u;
  if (activityHistory.test(text)) {
    return {
      kind: 'status_query',
      operation: 'status',
      subject: 'lumi',
      target: 'activity_history',
      payload: text,
      sideEffectClass: 'none',
      relation: 'status',
      confidence: 0.97,
      rule: 'activity-history-status-before-action',
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
  const surface = CLIENT_SURFACE_RULES.find(candidate => {
    const match = text.match(candidate.pattern);
    if (!match || match.index == null) return false;
    // The navigation verb must govern the client-surface noun. A capability
    // phrase such as "use desktop tools to open Notepad" contains both words,
    // but `open` comes after `tools` and targets Notepad, not Lumi's tools page.
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    const sameClausePrefix = prefix.split(/[\uff0c,\u3002\uff01\uff1f!?\uff1b;\n]/u).pop() || '';
    return CLIENT_NAVIGATION_VERB_RE.test(sameClausePrefix);
  });
  if (!surface) return null;
  // i18n-allow: Multilingual wallpaper close-action recognition; not user-visible copy.
  const clientActionArguments = surface.action === 'set_wallpaper_mode'
    ? { enabled: !/(?:关闭|退出|收起|close|exit|turn\s+off)/iu.test(text) }
    : undefined;
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
    clientActionArguments,
  };
}

function externalAiHistoryRead(text: string): NormalizedActionIntent | null {
  // This is a distinct read lane. It must win before generic messaging so an
  // authorized ChatGPT/Claude history request can never become a WeChat read.
  // i18n-allow: Multilingual external-AI history input recognition; not user-visible copy.
  const providerMatch = text.match(/\b(ChatGPT|Claude|Gemini|DeepSeek|Kimi|Perplexity|Copilot|Cursor|Ollama|LM\s*Studio)\b/iu);
  // i18n-allow: Multilingual external-AI target input recognition; not user-visible copy.
  const hasExternalAiTarget = Boolean(providerMatch)
    || /\b(?:external\s+AI|AI\s+(?:assistant|agent|app|chat))\b|外部\s*AI|AI\s*(?:助手|智能体|客户端|应用)/iu.test(text); // i18n-allow: Multilingual external-AI target input recognition.
  // i18n-allow: Multilingual external-AI history action input recognition; not user-visible copy.
  const hasHistoryAction = /(?:聊天(?:历史|记录|内容)|对话(?:历史|记录|内容)|历史(?:消息|会话)|(?:同步|导入|归档|授权|注册|添加|撤销|读取|查看|搜索|查询|总结).{0,40}(?:聊天|对话|历史|内容|来源)|(?:聊天|对话|历史).{0,40}(?:同步|导入|归档|授权|注册|读取|查看|搜索|查询|总结)|\b(?:chat|conversation|message)\s+(?:history|content|archive|source)\b|\b(?:sync|import|archive|authorize|register|revoke|read|view|search|query)\b.{0,48}\b(?:chat|conversation|message)\s+(?:history|content|archive|source)\b)/iu.test(text);
  // A fresh prompt to another model belongs to the collaboration lane, even
  // when the requested prompt happens to mention history or conversations.
  // i18n-allow: Multilingual external-AI submission exclusion; not user-visible copy.
  const explicitNewSubmission = /(?:发给|发送给|交给|问问|询问|提问|让.{0,20}(?:回答|处理))|\b(?:ask|send\s+to|delegate|submit|prompt)\b/iu.test(text);
  if (!hasExternalAiTarget || !hasHistoryAction || explicitNewSubmission) return null;

  return {
    kind: 'external_ai_history',
    operation: 'read',
    subject: 'user',
    target: providerMatch?.[1]?.replace(/\s+/g, ' ').trim() || 'external_ai',
    payload: text,
    sideEffectClass: 'none',
    relation: 'new',
    confidence: 0.96,
    rule: 'external-ai-history-read',
  };
}

function inboundMessageRead(text: string): NormalizedActionIntent | null {
  if (isExplicitArtifactCreationText(text)) return null;
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
  if (isExplicitArtifactCreationText(text)) return null;
  const confirmationOnly = isExternalCommitConfirmationOnlyRequest(text);
  // i18n-allow: Chinese negative-send input recognition; not user-visible copy.
  if (!confirmationOnly && /(?:不要|别|无需|不用).{0,12}(?:发|发送|回复)|(?:没有|没|并未).{0,30}(?:让我|叫我|让你).{0,20}(?:发|发送|回复)/u.test(text)) return null;
  const patterns = [ // i18n-allow: Chinese outbound-message semantic-role recognition; not user-visible copy.
    /(?:请)?(?:准备)?给(?:测试联系人)?\s*[「『“"']([^」』”"']{1,32})[」』”"']\s*(?:发送消息|发消息|发)\s*[「『“"']([\s\S]{1,1000}?)[」』”"']/u, // i18n-allow: confirmation-only outbound-message semantic-role recognition.
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
  const forbidsInstrumentedAction = /(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u7528).{0,20}(?:\u4f7f\u7528|\u8c03\u7528)|\b(?:do\s+not|don['\u2019]?t|without)\s+(?:use|using|call(?:ing)?)\b/iu.test(text);
  const instrumented = forbidsInstrumentedAction ? null : text.match(
    // i18n-allow: Tool-as-instrument phrasing; the target belongs to the action after the tool noun.
    /(?:\u4f7f\u7528|\u8c03\u7528).{0,24}?(?:\u5de5\u5177|\u6280\u80fd).{0,8}?(\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u5207\u6362\u5230|\u805a\u7126|\u6700\u5927\u5316|\u6700\u5c0f\u5316|\u8fd8\u539f|\u5173\u95ed)\s*(?:\u7a0b\u5e8f|\u5e94\u7528|\u8f6f\u4ef6|\u7a97\u53e3)?\s*([^\uff0c,\u3002\uff01\uff1f!?\uff1b;\n]{1,120})|\b(?:use|using|call(?:ing)?)\b.{0,30}?\b(?:tools?|skills?)\b\s+(?:to\s+)?\b(open|launch|start|focus|maximi[sz]e|minimi[sz]e|restore|close)\b\s*(?:app|application)?\s*([^,.!?;\n]{1,120})/iu,
  );
  const direct = text.match(
    // i18n-allow: Chinese local desktop semantic-role input recognition.
    /(?:^|[，。！？!?：:；;\s])(?:现在\s*)?(?:请|请你|帮我|麻烦你|给我)?\s*(打开|启动|运行|切换到|聚焦|最大化|最小化|还原|关闭|\b(?:open|launch|start|focus|maximi[sz]e|minimi[sz]e|restore|close)\b)\s*(?:程序|应用|软件|窗口|app|application)?\s*([^，。！？!?；;\n]{1,120})/iu,
  );
  if (!instrumented && !direct) return null;
  const verb = trimSlot(instrumented?.[1] || instrumented?.[3] || direct?.[1] || '');
  const target = trimSlot(instrumented?.[2] || instrumented?.[4] || direct?.[2] || '');
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

function persistentWorkTaskCreation(text: string): NormalizedActionIntent | null {
  const createsTask = /(?:\u521b\u5efa|\u65b0\u5efa|\u5efa\u7acb)\s*(?:\u4e00\u4e2a|\u4e00\u9879)?[^\u3002\uff01\uff1f?\n]{0,28}(?:\u6301\u4e45\u4efb\u52a1|\u957f\u671f\u4efb\u52a1|\u5de5\u4f5c\u63a5\u7ba1\u4efb\u52a1|\u5de5\u4f5c\u4efb\u52a1)|\b(?:create|start)\b.{0,36}\b(?:persistent|long[-\s]?running|work[-\s]?takeover)\s+task\b/iu.test(text);
  if (!createsTask) return null;
  const title = text.match(/(?:\u6807\u9898|\u4efb\u52a1\u540d|task\s+name|title)\s*[\uff1a:=\u4e3a]?\s*[\u201c"']([^\u201d"'\r\n]{1,120})[\u201d"']/iu)?.[1]?.trim()
    || text.match(/(?:\u6807\u9898|\u4efb\u52a1\u540d|task\s+name|title)\s*[\uff1a:=\u4e3a]\s*([^\uff0c,\u3002\uff01\uff1f?\r\n]{1,120})/iu)?.[1]?.trim()
    || 'persistent_work_task';
  return {
    kind: 'work_task',
    operation: 'create',
    subject: 'user',
    target: title,
    payload: text,
    sideEffectClass: 'local_write',
    relation: 'new',
    confidence: 0.98,
    rule: 'explicit-persistent-work-task-create',
  };
}

export function normalizeActionIntent(value: string): NormalizedActionIntent {
  const text = currentTurnText(value);
  if (!text) return { ...EMPTY_INTENT };
  const artifactCreation = explicitArtifactCreationIntent(text);
  const artifactRead = explicitLocalArtifactReadIntent(text);
  const explicitArtifactCreation = Boolean(artifactCreation);

  // Order is a safety invariant. Later action-shaped words cannot override a
  // correction, status query, client-native route, external-AI read, or
  // inbound message read.
  const priority = [
    correctionOrExplanation(text),
    statusQuery(text),
    persistentWorkTaskCreation(text),
    artifactCreation,
    artifactRead,
    explicitArtifactCreation ? null : clientNavigation(text),
    explicitArtifactCreation ? null : externalAiHistoryRead(text),
    explicitArtifactCreation ? null : inboundMessageRead(text),
    explicitArtifactCreation ? null : outgoingMessageSend(text),
    explicitArtifactCreation ? null : genericExternalCommit(text),
    explicitArtifactCreation ? null : localDesktopOperation(text),
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
