import { normalizeOperationMode } from './operation_modes';
import { hasVisionIntent } from './vision_routing';

const TOOL_INTENT_PATTERNS: RegExp[] = [
  /(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3).*(?:\u8f6c\u5199|\u8f6c\u6587\u5b57|\u6587\u5b57\u7a3f|\u6587\u4ef6)|(?:\u8f6c\u5199|\u8f6c\u6587\u5b57|\u6587\u5b57\u7a3f).*(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3)|\b(?:audio|voice|recording|memo)\b.*\b(?:transcri|speech\s*to\s*text|text\s*file)\b/i,
  /\b(open|launch|start|run|execute|call\s+(?:a\s+)?tool|use\s+(?:a\s+)?tool|tool\s+call|search|look\s+up|browse|fetch|research|learn|study|integrate|connect|log\s*in|sign\s*in|authenticate|open\s+(?:a\s+)?dashboard|sleep|dream|rest|consolidate\s+(?:memory|memories)|read\s+(?:file|screen|folder|directory)|scan|screenshot|screen\s*shot|click|type|copy|paste|write|save|create|export|delete|remove|install|uninstall|play|pause|resume|download|upload|sync|build|test|commit|push|deploy|cad|dxf|dwg|ifc|bim|revit|dynamo|draft|drawing)\b/i,
  /\b(?:what(?:'s| is)|show|list|check|inspect|scan|read|see)\b.*\b(?:desktop|screen|active window|foreground window|open windows|running processes|background apps|background processes|system state)\b/i,
  /\b(?:law|regulation|policy|statute|case law|patent|copyright|software copyright|intellectual property|standard|specification|paper|literature|doi|arxiv|pubmed|citation|source|official source|verify|valid|effective|prior art|patentability)\b/i,
  /(?:法规|法律|条例|办法|政策|法条|判例|裁判文书|法院|监管|合规|专利|知识产权|软著|软件著作权|著作权|发明人|申请人|审查指南|新颖性|创造性|现有技术|标准|国标|规范|论文|文献|期刊|引用|出处|来源|依据|权威|官方|查证|验证|是否有效|现行有效|沉淀.*知识库|记到知识库|存到知识库|吸收.*资料)/u,
  /(?:桌面上有什么|桌面.*(?:文件|东西|内容|图标|快捷方式)|后台.*(?:运行|进程|软件|程序)|正在运行.*(?:软件|程序|进程|服务)|打开了.*(?:软件|程序|窗口)|当前窗口|前台窗口|活动窗口|系统.*(?:状态|后台)|进程列表|屏幕上有什么|看.*(?:屏幕|桌面|窗口))/u,
  /(?:\u6253\u5f00|\u542f\u52a8|\u5f00\u542f|\u8fd0\u884c|\u6267\u884c|\u8c03\u7528\u5de5\u5177|\u5de5\u5177\u8c03\u7528|\u641c\u7d22|\u627e|\u67e5|\u67e5\u627e|\u5b66|\u5b66\u4e60|\u7814\u7a76|\u8c03\u7814|\u63a5\u5165|\u878d\u5408|\u96c6\u6210|\u7761|\u7761\u89c9|\u4f11\u606f|\u505a\u68a6|\u68a6\u5883|\u68b3\u7406\u8bb0\u5fc6|\u6574\u7406\u8bb0\u5fc6|\u53bb\u5e72\u6d3b|\u5f00\u59cb\u5e72\u6d3b|\u5f00\u59cb\u5904\u7406|\u7ee7\u7eed\u5904\u7406|\u7ee7\u7eed\u505a|\u63a5\u7740\u505a|\u8054\u7f51|\u6d4f\u89c8|\u8bbf\u95ee|\u67e5\u627e\u6587\u4ef6|\u8bfb\u53d6\u6587\u4ef6|\u622a\u56fe|\u622a\u5c4f|\u70b9\u51fb|\u8f93\u5165|\u590d\u5236|\u7c98\u8d34|\u64ad\u653e|\u653e.*(?:\u6b4c|\u97f3\u4e50)|\u6682\u505c\u97f3\u4e50|\u7ee7\u7eed\u64ad\u653e|\u4e0b\u8f7d|\u4e0a\u4f20|\u540c\u6b65|\u5b89\u88c5|\u5378\u8f7d|\u63d0\u4ea4|\u63a8\u9001|\u90e8\u7f72|\u6784\u5efa|\u6d4b\u8bd5)/u,
  /(?:\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u5bfc\u51fa|\u4fdd\u5b58|\u5199\u5165|\u7f16\u8f91|\u4fee\u6539|\u5220\u9664|\u6574\u7406|\u5206\u6790|\u753b|\u51fa).*(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6587\u6863|\u62a5\u544a|\u8868\u683c|\u4ee3\u7801|\u9879\u76ee|\u5e94\u7528|\u7a0b\u5e8f|\u7f51\u9875|\u7f51\u7ad9|\u94fe\u63a5|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u5de5\u4f5c\u6d41|\u811a\u672c|\u7ec8\u7aef|\u547d\u4ee4|\u4ed3\u5e93|github|\u6570\u636e\u5e93|\u77e5\u8bc6\u5e93|\u6a21\u677f|\u7ec4\u7ec7|\u8bbe\u7f6e|\u8bbe\u5907|\u5c4f\u5e55|cad|CAD|\u56fe\u7eb8|\u8349\u7a3f\u56fe|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u8bbe\u8ba1\u56fe)/iu,
  /(?:cad|CAD|Revit|revit|IFC|ifc|BIM|bim|Dynamo|dynamo|\u56fe\u7eb8|\u8349\u7a3f\u56fe|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u8bbe\u8ba1\u56fe).*(?:\u753b|\u51fa|\u751f\u6210|\u8f6c|\u5bfc\u51fa|\u627e|\u641c\u7d22|\u67e5|\u67e5\u627e|\u5b66|\u5b66\u4e60|\u7814\u7a76|\u63a5\u5165|\u878d\u5408|\u96c6\u6210)/u,
];

const AUTONOMOUS_TASK_PATTERNS: RegExp[] = [
  /\b(plan|build|design|draft|prepare|organize|analyze|review|research|implement|refactor|generate|create)\b.*\b(project|report|doc|document|deck|presentation|code|repo|workflow|workspace|team|agent|files?)\b/i,
  /(?:规划|搭建|设计|准备|整理|分析|审查|研究|实现|重构|生成|创建|制作).*(?:项目|报告|文档|方案|代码|仓库|工作流|团队|智能体|文件|资料)/u,
];

const CLIENT_ACTION_INTENT_PATTERNS: RegExp[] = [
  /\b(switch|change|set|enter|open|start|turn\s+on)\b.*\b(chat|assistant|meeting|music|auto(?:nomous)?|auto\s+execute|autonomous)\s+mode\b/i,
  /\b(open|start|show|hide|close)\b.*\b(meeting\s+notes?|music\s+center|mood\s+layer|knowledge\s+base|runtime\s+log|run\s+logs?|logs?|settings|wallpaper\s+mode|organization|org\s+workspace|cloud|files?|skills?|tools?|avatar|sound\s+studio|devices?|sync|kernel|monitor|plan|planner)\b/i,
  /\b(play|put\s+on|listen\s+to)\b.*\b(music|song|playlist|album)\b/i,
  /(?:\u5207\u6362|\u5207\u5230|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8).*(?:\u804a\u5929|\u52a9\u624b|\u4f1a\u8bae|\u97f3\u4e50|\u81ea\u52a8\u6267\u884c|\u81ea\u4e3b\u6267\u884c|\u4f1a\u8bae\u6a21\u5f0f|\u97f3\u4e50\u6a21\u5f0f|\u52a9\u624b\u6a21\u5f0f|\u804a\u5929\u6a21\u5f0f|\u6c1b\u56f4\u5c42|\u97f3\u4e50\u4e2d\u5fc3|\u77e5\u8bc6\u5e93|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u8bbe\u7f6e|\u58c1\u7eb8\u6a21\u5f0f|\u7ec4\u7ec7|\u4e91\u7aef|\u6587\u4ef6|\u6280\u80fd|\u5de5\u5177|\u5f62\u8c61|\u58f0\u97f3|\u8bbe\u5907|\u540c\u6b65|\u5185\u6838|\u76d1\u63a7|\u8ba1\u5212|\u56e2\u961f)/u,
  /(?:\u653e|\u64ad\u653e|\u542c).*(?:\u97f3\u4e50|\u6b4c|\u6b4c\u66f2|\u6b4c\u5355|\u4e13\u8f91)/u,
];

const CLIENT_ACTION_ONLY_PATTERNS: RegExp[] = [
  /\b(switch|change|set|enter|open|start|turn\s+on)\b.*\b(chat|assistant|meeting|music|auto(?:nomous)?|auto\s+execute|autonomous)\s+mode\b/i,
  /\b(open|start|show|hide|close)\b.*\b(meeting\s+notes?|music\s+center|mood\s+layer|knowledge\s+base|runtime\s+log|run\s+logs?|logs?|settings|wallpaper\s+mode|organization|org\s+workspace|cloud|skill\s+center|skills?|tools?|avatar|sound\s+studio|devices?|sync|kernel|monitor|plan|planner|file\s+manager|files\s+app)\b/i,
  /\b(play|put\s+on|listen\s+to)\b.*\b(music|song|playlist|album)\b/i,
  /(?:\u5207\u6362|\u5207\u5230|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8).*(?:\u804a\u5929|\u52a9\u624b|\u4f1a\u8bae|\u97f3\u4e50|\u81ea\u52a8\u6267\u884c|\u81ea\u4e3b\u6267\u884c|\u4f1a\u8bae\u6a21\u5f0f|\u97f3\u4e50\u6a21\u5f0f|\u52a9\u624b\u6a21\u5f0f|\u804a\u5929\u6a21\u5f0f|\u6c1b\u56f4\u5c42|\u97f3\u4e50\u4e2d\u5fc3|\u77e5\u8bc6\u5e93|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u8bbe\u7f6e|\u58c1\u7eb8\u6a21\u5f0f|\u7ec4\u7ec7|\u4e91\u7aef|\u6280\u80fd|\u5de5\u5177|\u5f62\u8c61|\u58f0\u97f3|\u8bbe\u5907|\u540c\u6b65|\u5185\u6838|\u76d1\u63a7|\u8ba1\u5212|\u56e2\u961f|\u6587\u4ef6\u7ba1\u7406\u5668|\u6587\u4ef6\u4e2d\u5fc3)/u,
  /(?:\u653e|\u64ad\u653e|\u542c).*(?:\u97f3\u4e50|\u6b4c|\u6b4c\u66f2|\u6b4c\u5355|\u4e13\u8f91)/u,
];

const DIAGNOSTIC_OR_REPAIR_PATTERNS: RegExp[] = [
  /\b(why|what happened|what went wrong|diagnose|debug|fix|repair|recover|self[-\s]?check|self[-\s]?heal|not working|doesn'?t work|broken|failed|failure|error|crash(?:ed)?|stuck|hang(?:ing)?|blank screen|white screen|no sound|silent|cannot|can'?t)\b/i,
  /(?:\u4e3a\u4ec0\u4e48|\u600e\u4e48\u56de\u4e8b|\u54ea\u91cc.*(?:\u95ee\u9898|\u574f|\u6ca1\u8dd1\u901a)|\u68c0\u67e5|\u8bca\u65ad|\u6392\u67e5|\u4fee\u590d|\u5904\u7406.*(?:\u95ee\u9898|\u6545\u969c|\u9519\u8bef)|\u81ea\u68c0|\u81ea\u4fee\u590d|\u6062\u590d|\u62a5\u9519|\u9519\u8bef|\u5931\u8d25|\u5d29\u4e86|\u5d29\u6e83|\u5361\u4f4f|\u5361\u6b7b|\u767d\u5c4f|\u6ca1\u53cd\u5e94|\u4e0d\u751f\u6548|\u4e0d\u8d77\u4f5c\u7528|\u6253\u4e0d\u5f00|\u653e\u4e0d\u51fa|\u6ca1\u58f0\u97f3|\u542c\u4e0d\u89c1|\u4e0d\u4f1a|\u4e0d\u80fd|\u4e0d\u5bf9|\u6709\u95ee\u9898|\u88ab\u9650\u5236|\u9650\u5236|404|400|500)/u,
];

export function hasExplicitToolIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasClientActionIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return CLIENT_ACTION_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasClientActionOnlyIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return CLIENT_ACTION_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isDiagnosticOrRepairRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return DIAGNOSTIC_OR_REPAIR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldAllowToolUseForTurn(text: string, source?: string, operationMode?: string): boolean {
  const mode = normalizeOperationMode(operationMode);
  if (isDiagnosticOrRepairRequest(text)) return true;
  if (mode === 'chat') return hasClientActionIntent(text) || hasExplicitToolIntent(text) || hasVisionIntent(text);
  if (mode === 'meeting') return hasClientActionIntent(text);
  if (hasVisionIntent(text)) return true;
  if (mode === 'autonomous' && AUTONOMOUS_TASK_PATTERNS.some((pattern) => pattern.test(text.trim()))) return true;
  if (hasExplicitToolIntent(text)) return true;
  return false;
}

export function shouldExposeAgentWork(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    /\b(team|teammate|sub-?agent|worker agent|multi-?agent|orchestrator|orchestration|delegate|assign|crew)\b/i,
    /(?:\u56e2\u961f|\u5b50\s*agent|\u5b50\u667a\u80fd\u4f53|\u591a\s*agent|\u591a\u667a\u80fd\u4f53|\u7ec4\u5efa|\u7ec4\u961f|\u7f16\u6392|\u5206\u6d3e|\u5206\u914d|\u4ea4\u7ed9.*(?:\u5904\u7406|\u505a)|\u8c03\u5ea6|\u7ec4\u4ef6\u56e2\u961f)/u,
  ].some((pattern) => pattern.test(normalized));
}
