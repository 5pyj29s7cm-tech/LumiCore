export interface PendingInterruptedVoiceTurn {
  text: string;
  interruptedAt: number;
}

export type VoiceWorkInterruptionKind =
  | 'cancel_work'
  | 'modify_work'
  | 'progress_query'
  | 'stop_speaking'
  | 'new_work'
  | 'side_chat';

export interface VoiceWorkInterruptionOptions {
  /** Result of the shared, domain-independent tool-intent classifier. */
  hasExplicitToolIntent?: boolean;
}

export interface ActiveVoiceWorkInputDecision {
  kind: VoiceWorkInterruptionKind;
  keepActiveWork: boolean;
  queueIncomingWork: boolean;
  repeatedInstruction: boolean;
}

function voiceInstructionKey(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

const CORRECTION_CONTINUATION_PATTERNS: RegExp[] = [
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  /(?:\u4e0d\u662f|\u4e0d\u5bf9|\u9519\u4e86|\u641e\u9519\u4e86|\u5f04\u9519\u4e86|\u542c\u9519\u4e86|\u8bc6\u522b\u9519\u4e86|\u5bf9\u8c61\u9519\u4e86|\u4eba\u540d\u9519\u4e86|\u540d\u5b57\u9519\u4e86|\u5e94\u8be5\u662f|\u6539\u6210|\u66f4\u6b63\u4e3a|\u6211\u8bf4\u7684\u662f).{0,80}(?:\u4e0d\u662f|\u800c\u662f|\u662f|\u95ee|\u53d1|\u6253\u5f00|\u641c\u7d22|\u8054\u7cfb\u4eba|\u5bf9\u8c61|\u4eba\u540d|\u540d\u5b57)/u,
  // Spoken spelling correction: "the Lu I said is the Lu in mainland, not road".
  /\u6211\u8bf4\u7684.{1,16}\u662f.{0,12}\u7684.{1,2}.{0,12}\u4e0d\u662f.{0,12}\u7684.{1,2}/u,
  /[^\s\uff0c\u3002\uff01\uff1f,.!?]{1,16}\u7684[\u3400-\u9fff]\s*\u4e0d\u662f[^\s\uff0c\u3002\uff01\uff1f,.!?]{1,16}\u7684[\u3400-\u9fff]/u,
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  /^(?:\u4e0d\u662f|\u4e0d\u5bf9|\u9519\u4e86|\u5e94\u8be5\u662f|\u6539\u6210|\u66f4\u6b63\u4e3a|\u6211\u8bf4\u7684\u662f)/u,
  /\b(?:no|not that|wrong|I said|I meant|change (?:it )?to|correct (?:it )?to)\b/i,
];

export function isVoiceCorrectionContinuation(text: string): boolean {
  const normalized = String(text || '').trim();
  return Boolean(normalized) && CORRECTION_CONTINUATION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isVoiceWorkModificationContinuation(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (isVoiceCorrectionContinuation(normalized)) return true;
  return /(?:\u518d|\u987a\u4fbf|\u53e6\u5916|\u8fd8\u8981|\u4e5f|\u540c\u65f6).{0,24}(?:\u52a0|\u8865|\u6539|\u6362|\u5220|\u53bb\u6389|\u4fdd\u7559|\u4fdd\u5b58|\u5bfc\u51fa|\u53d1)|^(?:\u52a0\u4e0a|\u8865\u5145|\u6539\u6210|\u6539\u4e3a|\u6362\u6210|\u53bb\u6389|\u5220\u6389|\u4e0d\u8981|\u522b\u5fd8\u4e86|\u8bb0\u5f97).{1,80}/u.test(normalized)
    || /\b(?:also|and also|while you're at it|add|change|replace|remove|keep|save|export)\b/i.test(normalized);
}

/**
 * Short, context-dependent utterances that continue the work already on the
 * floor. These are turn-taking signals, not application-specific commands.
 */
export function isVoiceTaskContinuation(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized || normalized.length > 96) return false;
  if (isVoiceWorkModificationContinuation(normalized)) return true;
  const compact = normalized
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001\u2026\uFF5E~\u201C\u201D\u2018\u2019]+/gu, '')
    .toLowerCase();
  if (!compact) return false;
  return /^(?:需要|要|同意|确认|可以|行|好|好的|继续|接着|执行|执行任务|继续执行|就这样|就这个|对|是的|yes|ok|okay|confirm|proceed|continue|doit)$/u.test(compact) // i18n-allow: Chinese voice-continuation recognition; not user-visible copy.
    || /^(?:就|已经|现在|目标|联系人|文件|窗口|页面|输入框|按钮).{1,72}(?:在|就在|是|打开|选中|前台|里|上|下)$/u.test(compact) // i18n-allow: Chinese voice-continuation recognition; not user-visible copy.
    || /^(?:打开|完成|做好|处理好|找到|选中|进入|登录)(?:以后|之后|后)(?:直接|再|就|继续)?(?:播放|打开|保存|发送|导出|关闭|点击|输入|继续|执行).{0,48}$/u.test(compact) // i18n-allow: Chinese voice-continuation recognition; not user-visible copy.
    || /^(?:然后|接着|随后|下一步)(?:直接|再|就|继续)?(?:播放|打开|保存|发送|导出|关闭|点击|输入|继续|执行).{0,48}$/u.test(compact); // i18n-allow: Chinese voice-continuation recognition; not user-visible copy.
}

export function classifyVoiceWorkInterruption(
  text: string,
  options: VoiceWorkInterruptionOptions = {},
): VoiceWorkInterruptionKind {
  const normalized = String(text || '').trim();
  const compact = normalized
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001]+/gu, '')
    .toLowerCase();
  if (
    /(?:\u505c\u6b62\u4efb\u52a1|\u7ec8\u6b62\u4efb\u52a1|\u53d6\u6d88\u4efb\u52a1|\u4e0d\u7528\u505a\u4e86|\u522b\u505a\u4e86|\u4efb\u52a1\u53d6\u6d88)/u.test(compact)
    || /\b(?:stop|cancel|abort|terminate)\s+(?:the\s+)?(?:work|task|job)\b/i.test(normalized)
  ) return 'cancel_work';
  if (
    isVoiceCurrentActivityQuestion(normalized)
    || /^(?:怎么回事|什么情况)[？?。！!\s]*$/u.test(normalized) // i18n-allow: Chinese active-work interruption recognition.
    || /(?:\u8fdb\u5ea6|\u505a\u5230\u54ea|\u5e72\u5230\u54ea|\u5b8c\u6210\u591a\u5c11|\u8fd8\u5728\u505a|\u8fd8\u5728\u5904\u7406)/u.test(normalized)
    // A progress question can itself contain action words such as “执行”. It
    // must win over the generic tool-intent gate below or it will replace the
    // task whose status the user is asking about.
    || /(?:任务|工作|这个|它)?(?:执行|进行|处理|运行|做)(?:的|得)?(?:怎么样|怎样|如何|到哪(?:一步)?|什么状态|还顺利吗|还在继续吗|完了吗|好了没)/u.test(compact) // i18n-allow: Chinese active-work progress recognition.
    || /(?:怎么样|怎样|如何)(?:了|啦)?$/u.test(compact) && /(?:任务|执行|进行|处理|运行|进度)/u.test(compact) // i18n-allow: Chinese active-work progress recognition.
    || /(?:有没有|是否|还在)(?:正常)?(?:执行|进行|处理|运行|继续)(?:这个|该)?(?:任务|工作)?/u.test(compact) // i18n-allow: Chinese active-work progress recognition.
    || /(?:现在|目前)?(?:到哪(?:一步)?|什么状态|什么进度)/u.test(compact) // i18n-allow: Chinese active-work progress recognition.
    || /\b(?:progress|how(?:'s| is) (?:it|the task) going|where are you (?:at|up to))\b/i.test(normalized)
  ) return 'progress_query';
  if (isVoiceTaskContinuation(normalized)) return 'modify_work';
  if (
    /^(?:\u505c|\u505c\u4e0b|\u95ed\u5634|\u522b\u8bf4(?:\u4e86)?|\u4e0d\u8981\u8bf4(?:\u4e86)?|\u5148\u522b\u8bf4(?:\u4e86)?|\u7b49\u4e00\u4e0b|\u7b49\u4e0b|\u6682\u505c|\u597d\u4e86|\u884c\u4e86|\u591f\u4e86|stop|wait|pause|interrupt|holdon|shutup)$/u.test(compact)
    || /(?:\u5148)?(?:\u522b|\u4e0d\u7528)(?:\u518d)?\u8bf4(?:\u4e86)?(?:\u4f60)?(?:\u7ee7\u7eed|\u63a5\u7740)(?:\u505a|\u5904\u7406)/u.test(compact)
  ) return 'stop_speaking';
  if (options.hasExplicitToolIntent === true) return 'new_work';
  return 'side_chat';
}

/**
 * One admission decision for speech received while a task owns the work lane.
 * Repeating the active instruction asks about that same task; a genuinely new
 * action is queued and can never silently replace the running task.
 */
export function classifyActiveVoiceWorkInput(
  activeInstruction: string,
  incomingText: string,
  options: VoiceWorkInterruptionOptions = {},
): ActiveVoiceWorkInputDecision {
  const activeKey = voiceInstructionKey(activeInstruction);
  const incomingKey = voiceInstructionKey(incomingText);
  const repeatedInstruction = Boolean(activeKey && incomingKey && activeKey === incomingKey);
  const kind = repeatedInstruction
    ? 'progress_query'
    : classifyVoiceWorkInterruption(incomingText, options);
  return {
    kind,
    keepActiveWork: kind !== 'cancel_work' && kind !== 'modify_work',
    queueIncomingWork: kind === 'new_work',
    repeatedInstruction,
  };
}

export function isVoiceCurrentActivityQuestion(text: string): boolean {
  const normalized = String(text || '')
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001]+/gu, '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized.length > 40) return false;
  if (
    /^(?:任务|工作|这个任务|这个工作|它)?(?:执行|进行|处理|运行|做)(?:的|得)?(?:怎么样|怎样|如何|到哪(?:一步)?|什么状态|还顺利吗|还在继续吗|完了吗|好了没)(?:了|啦)?$/u.test(normalized) // i18n-allow: Chinese current-activity recognition.
    || /^(?:任务|工作|执行|进行|处理|运行|进度)(?:怎么样|怎样|如何)(?:了|啦)?$/u.test(normalized) // i18n-allow: Chinese current-activity recognition.
    || /^(?:有没有|是否|还在)(?:正常)?(?:执行|进行|处理|运行|继续)(?:这个|该)?(?:任务|工作)?(?:呢|吗)?$/u.test(normalized) // i18n-allow: Chinese current-activity recognition.
    || /^(?:现在|目前)?(?:到哪(?:一步)?|什么状态|什么进度)(?:了|啦|呢)?$/u.test(normalized) // i18n-allow: Chinese current-activity recognition.
  ) return true;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return /^(?:你)?(?:刚才|刚刚|现在)?(?:有|还|是否|是不是)?(?:在)?(?:干嘛|干什么|做什么|忙什么|处理什么|跑什么|弄什么|搞什么|执行|处理|做|运行)(?:这个|那个|刚才的|当前的)?(?:任务|操作|工作)?(?:呢|吗)?$/u.test(normalized)
    // i18n-allow: Chinese current-activity recognition; not user-visible copy.
    || /^(?:你)?(?:刚才|刚刚|现在)?(?:有|还|是否|是不是)?(?:在)?(?:执行|处理|做|运行)什么(?:任务|操作|工作)?(?:呢|吗)?$/u.test(normalized)
    || /^(?:what(?:are|were)youdoing|areyou(?:still)?(?:doing|running|workingon)(?:this|it|thetask)?)$/iu.test(normalized);
}

export function isVoiceFiller(text: string): boolean {
  const compact = String(text || '')
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\uFF5E~\u2026\u3001]+/gu, '')
    .trim();
  if (!compact || compact.length > 24) return false;
  // Keep greetings/attention words such as "hello" out of this set. Repeated
  // hesitation sounds must not cancel a task that is already executing.
  return /^[\u55ef\u554a\u54e6\u5443\u54fc\u5509\u5440\u8bf6\u5514\u5636\u5567\u54ce\u54df\u561b\u54c7\u5566\u561e]+$/u.test(compact);
}

export function isSpeechClearlyDirectedAwayFromLumi(text: string): boolean {
  const compact = String(text || '').replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001]+/gu, '');
  if (!compact) return false;
  const mentionsTalkingToAssistant = /(?:\u5728\u8ddf|\u6b63\u5728\u8ddf|\u5728\u548c|\u6b63\u5728\u548c).{0,12}(?:AI|\u4eba\u5de5\u667a\u80fd|\u673a\u5668\u4eba|Lumi|\u9732\u7c73|\u7490\u7c73).{0,8}\u8bf4\u8bdd/i.test(compact);
  const tellsOtherPersonToWait = /\u4f60(?:\u4eec)?(?:\u5148)?(?:\u7b49\u4e00\u4e0b|\u7b49\u4f1a|\u7a0d\u7b49|\u522b\u8bf4\u8bdd|\u4e0d\u8981\u8bf4\u8bdd)/u.test(compact);
  return mentionsTalkingToAssistant && tellsOtherPersonToWait;
}

export function isVoiceReferentialFollowup(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 18) return false;
  const compact = raw
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001\u2026\uFF5E~\u201C\u201D\u2018\u2019]/gu, '')
    .toLowerCase();
  if (!compact) return false;
  if (/(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u53d1\u9001|\u53d1\u7ed9|\u95ee\u4e00\u4e0b|\u8be2\u95ee|\u641c\u7d22|\u67e5\u627e|\u77e5\u8bc6\u5e93|\u6587\u4ef6|\u5fae\u4fe1|\u4e0d\u662f|\u9519\u4e86|\u6211\u8bf4\u7684|\u6211\u8ba9\u4f60)/u.test(compact)) return false;
  return /^(?:\u55ef|\u54e6|\u597d|\u597d\u7684|\u53ef\u4ee5|\u884c|\u6765\u5427|\u5f00\u59cb|\u7ee7\u7eed|\u63a5\u7740|\u987a\u7740|\u90a3\u4e2a|\u8fd9\u4e2a|\u5c31\u8fd9\u4e2a|\u5bf9|yes|ok|okay|go|continue|doit)$/u.test(compact);
}

export function mergeInterruptedVoiceTurn(
  pending: PendingInterruptedVoiceTurn | null | undefined,
  currentText: string,
  now = Date.now(),
  maxAgeMs = 30_000,
): { routingText: string; usedInterruptedTurn: boolean } {
  const current = String(currentText || '').trim();
  const prior = String(pending?.text || '').trim();
  const ageMs = pending ? now - pending.interruptedAt : Number.POSITIVE_INFINITY;
  const canUsePrior = Boolean(
    prior
    && current
    && Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs <= maxAgeMs
    && isVoiceTaskContinuation(current),
  );
  if (!canUsePrior) return { routingText: current, usedInterruptedTurn: false };
  return {
    routingText: `${prior}\n\nUser correction to the interrupted request: ${current}`,
    usedInterruptedTurn: true,
  };
}
