

export const ENGLISH_SHORT_CONTINUATION_RE =
  /^(?:(?:continue|resume|proceed)(?: this| that| it| the task)?|next(?: step)?|run it|execute it|start it|try again|retry|draw it|open it|save it|export it|send it|submit it|do it|(?:continue|run|execute|handle|do)(?: this| that| it| the task)? in (?:the )?background)[.!?]*$/i;

export const ENGLISH_REFERENTIAL_ACTION_RE =
  /(?:according to|based on|use)(?: what is| what's)? (?:inside|above|before|previous|earlier)|(?:run|execute|open|process|draw|save|export|send|submit|continue) (?:it|that|this|the previous one)/i;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const CURRENT_APP_EDIT_RE =
  /(?:在|到|往)?\s*(?:这里面|这里|里面|这个软件里|这个应用里|当前软件里|当前应用里|当前窗口里|刚打开的里面|刚才打开的里面|刚打开的软件里|刚才打开的软件里).{0,96}(?:新建|创建|写|写入|输入|填写|编辑|粘贴|保存)|\b(?:create|write|type|paste|edit|save)\b.{0,80}\b(?:in|inside)\b.{0,32}\b(?:here|this|that|the current|the opened)\b.{0,16}\b(?:app|application|document|window)?\b|\b(?:in|inside)\b.{0,32}\b(?:this|that|the current|the opened)\b.{0,16}\b(?:app|application|document|window)\b.{0,80}\b(?:create|write|type|paste|edit|save)\b/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.

export const CURRENT_APP_WINDOW_ACTION_RE =
  /(?:\u6700\u5927\u5316|\u6700\u5c0f\u5316|\u8fd8\u539f\u7a97\u53e3|\u6062\u590d\u7a97\u53e3|\u6536\u5230\u4efb\u52a1\u680f|\u94fa\u6ee1\u5c4f\u5e55)|\b(?:maximi[sz]e|minimi[sz]e|restore)\b.{0,12}\b(?:it|that|this|window|app|application)?\b/iu;

export const CURRENT_APP_DOCUMENT_CREATE_RE =
  /^(?:\u65b0\u5efa|\u521b\u5efa)(?:(?:\u4e00\u4e2a|\u4e00\u4efd|\u4e00\u9875|\u6211\u7684|\u65b0\u7684?)\s*)?(?:\u7a7a\u767d)?(?:Word|WPS)?(?:\u6587\u6863|\u9875\u9762|\u8868\u683c|\u6f14\u793a\u6587\u7a3f)|^(?:new|create)(?:\s+(?:a|my|the))?\s+(?:blank\s+)?(?:document|page|workbook|presentation)$/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const CONCRETE_LOCAL_SOURCE_RE =
  /(?:[A-Za-z]:[\\/]|(?:桌面上?|本地|下载|文档|图片|图纸|文件夹).{0,24}(?:叫|名为|名称是|里的|中的).{1,36}|(?:named|called)\s+.{1,48}\s+(?:file|image|drawing|folder))/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const EXPLICIT_ACTION_TARGET_RE =
  /(?:打开|启动|运行|读取|查看|画|绘制|保存|导出|发送|提交|放到|导入|写入|\b(?:open|launch|run|read|inspect|draw|draft|save|export|send|submit|import|write)\b).{0,96}(?:AutoCAD|CAD|微信|WeChat|浏览器|browser|网站|文件|图片|图纸|文件夹)/iu;

export function explicitDurableTaskReference(text: string): boolean {
  // i18n-allow: Reviewed multilingual durable-task reference recognition; not user-visible copy.
  return /(?:这个|那个|之前|昨天|上次|上一个|上个|未完成|原来|原|刚才).{0,12}(?:任务|工作|操作)|(?:任务|工作).{0,12}(?:继续|执行|状态|进度)|AutoCAD|\bCAD\b|图纸|平面图|WPS|Word|Excel|PowerPoint|微信|WeChat/iu.test(text);
}

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const STATUS_FOLLOWUP_RE =
  /^(?:在执行吗|有没有在执行(?:(?:这个|那个)?任务)?|执行了吗|做了吗|完成了吗|好了没|结果呢|怎么样了|怎么还没|为什么(?:会)?失败|怎么(?:会)?失败|失败(?:在)?哪里|(?:我问你)?(?:你)?为什么(?:没(?:有)?(?:完成|执行)|不(?:去)?执行)(?:[，,。！？?!\s]*(?:你)?为什么不(?:去)?执行)?|我刚刚给你了什么任务|我刚才给你的任务是什么|你在搞什么|你在干嘛|你在干啥|回答我)[啊呀吧嘛呢，,。！？?!]*$/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const CN_SHORT_EXECUTION_CONTINUATION_RE =
  /^(?:确认(?:了|执行)?|确定(?:了)?|允许|同意|继续|继续执行|接着做|执行|开始|开始执行|重试|再试|再来一次|建立|创建|打开|保存|发送|提交|就这么做|按这个做|做吧|弄吧)[。！？.!?]*$/u;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.

export const ENGLISH_STATUS_FOLLOWUP_RE =
  /^(?:are you (?:doing|running) it|did you do it|is it (?:done|running)|what(?:'s| is) the result|why (?:didn'?t|haven'?t) you|what was my task)[.!?]*$/i;

export const MIXED_STATUS_QUESTION_RE =
  /(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c)(?:\u4e86)?(?:\u5417|\u6ca1|\u4e86\u6ca1).*[\uff1f?].*(?:\u7ee7\u7eed|\u63a5\u7740|\u6062\u590d|\u91cd\u8bd5|\u6267\u884c|\u63a8\u8fdb)(?:\u6267\u884c|\u5904\u7406|\u4efb\u52a1)?(?:\u4e86)?(?:\u5417|\u6ca1|\u6ca1\u6709|\u5462)?[\uff1f?]\s*$|\b(?:is|was|has)\b.{0,28}\b(?:done|complete|completed|finished)\b.*\?\s*(?:(?:are|did|will)\s+you\s+)?(?:continue|continuing|resume|retry|execute|executing|run|running)(?:\s+(?:it|this|that|the\s+task|executing))?\s*\?\s*$/iu;

// A short failure question becomes task status only while a durable task is
// unfinished. The state check prevents stale completed work from hijacking
// an unrelated conversational question.
// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const AMBIGUOUS_UNFINISHED_TASK_STATUS_RE =
  /^(?:(?:现在|目前)?(?:任务)?(?:进度(?:怎么样|如何)|(?:做|执行|进行|处理)(?:得)?怎么样|(?:做|执行|进行|处理)到哪(?:一步|里))了?|怎么回事|什么情况|出什么问题了|哪里(?:出|有)问题了|卡在哪(?:里)?|为什么(?:停了|没继续|没完成|没做完)|what happened|what went wrong|where (?:is|was) it blocked)[啊呀吧嘛呢，,。！？?!\s]*$/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// A terse negative observation such as "还没播放" is not merely a request to
// read status. While the matching durable task is unfinished it corrects the
// result of that same action and authorizes another attempt under the existing
// task id. Matching the verb back to the original goal prevents an unrelated
// blocked task from capturing the utterance.
export const NEGATIVE_RESULT_CORRECTION_RE = /^(?:(?:(?:\u8fd8|\u4ecd\u7136|\u4f9d\u7136|\u8fd8\u662f)\s*)?\u6ca1(?:\u6709)?|\u5e76\u672a|\u672a\u80fd)\s*(?:\u6210\u529f\s*)?(\u64ad\u653e|\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u4fdd\u5b58|\u521b\u5efa|\u751f\u6210|\u5199\u5165|\u53d1\u9001|\u5173\u95ed|\u5220\u9664)(?:\u51fa\u6765|\u6210\u529f|\u5b8c\u6210)?[\u3002\uff01!\s]*$|^(?:it\s+)?(?:still\s+)?(?:hasn['\u2019]?t|isn['\u2019]?t|didn['\u2019]?t|not)\s+(play(?:ing|ed)?|open(?:ing|ed)?|start(?:ing|ed)?|run(?:ning)?|sav(?:e|ed|ing)|creat(?:e|ed|ing)|generat(?:e|ed|ing)|writ(?:e|ten|ing)|send(?:ing)?|sent|clos(?:e|ed|ing)|delet(?:e|ed|ing))[.!\s]*$/iu;

// A user may satisfy the exact condition Lumi just asked for outside the
// client (for example by foregrounding WPS), then report only that readiness
// fact. These acknowledgements are executable continuation only while the
// durable task is blocked; without that state they remain ordinary dialogue.
// i18n-allow: Multilingual blocked-task readiness acknowledgement recognition; not user-visible copy.
export const BLOCKED_TASK_READINESS_RE =
  /^(?:(?:(?:已经|已|现在|刚才|刚刚)\s*)?(?:把|将)?(?:它|这个|那个|文件|文档|窗口|应用|软件)?\s*(?:切换|切|换|放|调)\s*(?:到|至)?\s*(?:前台|当前窗口)(?:了)?|(?:已经|已|现在)\s*(?:打开|开启)(?:了|好了)?|(?:已经)?\s*(?:准备好|准备就绪)(?:了)?|(?:it(?:'s| is)\s+)?(?:in (?:the )?foreground|open|ready)(?:\s+now)?|ready\s+to\s+continue)[\s啊呀啦吧呢，,。！!]*$/iu;

// A bare acknowledgement is ambiguous by itself. It becomes executable only
// when the exact blocked task's last assistant state explicitly asked the
// user to prepare/foreground something and report back. This keeps “可以” from
// becoming a new durable task while preventing it from authorizing an
// unrelated or reconstructed confirmation boundary.
export const BARE_BLOCKED_TASK_READINESS_RE =
  // i18n-allow: Reviewed multilingual readiness acknowledgement recognition; not user-visible copy.
  /^(?:可以|可以了|行|好|好了|已好|就绪|ok(?:ay)?|done|ready)[\s啊呀啦吧呢，,。！!]*$/iu;

export const ASSISTANT_REQUESTED_READINESS_RE =
  // i18n-allow: Reviewed multilingual assistant readiness-request recognition; not user-visible copy.
  /(?:请|麻烦|一旦|当|等|完成后|准备好后|切到前台后)[^。！？.!?\n]{0,120}(?:告诉我|跟我说|说一声|回复我|回我|通知我)|(?:请|麻烦)[^。！？.!?\n]{0,120}(?:切到|切换到|打开|前台|准备好|发给我)|\b(?:tell|let)\s+me\s+(?:know|when|once)\b[^.!?\n]{0,80}\b(?:ready|foreground|open|done)\b|\b(?:please\s+)?(?:put|bring|switch|open)\b[^.!?\n]{0,80}\b(?:foreground|open|ready)\b|\b(?:reply|say)\b[^.!?\n]{0,80}\b(?:ready|foreground|open|done)\b/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
export const STATUS_RESULT_DEMAND_RE =
  /^(?:\u6211\u8ba9\u4f60(?:\u5e2e\u6211)?(?:\u770b(?:\u4e0b|\u4e00\u4e0b|\u770b)?|\u67e5(?:\u4e0b|\u4e00\u4e0b)?).{0,16}\u684c\u9762(?:\u4e0a)?.{0,16}(?:\u591a\u5c11|\u51e0\u4e2a)(?:\u4e2a)?(?:\u8f6f\u4ef6|\u5e94\u7528).{0,20}(?:\u4f60\u5012\u662f)?(?:\u8ddf\u6211|\u7ed9\u6211)?\u8bf4(?:\u5440|\u554a|\u561b)?)[\u554a\u5440\u5427\u561b\u5462\uff0c,\u3002\uff01\uff1f?!]*$/iu;

export function currentTurnText(text: string): string {
  return String(text || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
}
