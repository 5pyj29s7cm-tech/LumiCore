import {
  detectRequestedOperationMode,
  normalizeOperationMode,
  type OperationMode,
} from './operation_modes';
import { hasVisionIntent } from './vision_routing';

interface IntentGrammarRule {
  name: string;
  all: RegExp[];
  none?: RegExp[];
}

export type ToolIntentRuleLayer =
  | 'information_guard'
  | 'diagnostic'
  | 'structured_tool'
  | 'legacy_tool_pattern'
  | 'structured_client'
  | 'client_action'
  | 'client_action_only'
  | 'vision'
  | 'mode';

export interface ToolIntentMatchedRule {
  layer: ToolIntentRuleLayer;
  name: string;
}

export interface ToolIntentDecisionTrace {
  text: string;
  source: string;
  operationMode: OperationMode;
  normalized: string;
  allowToolUse: boolean;
  decisionReason: string;
  blockedBy: string[];
  matchedRules: ToolIntentMatchedRule[];
  signals: {
    informationOnlyQuestion: boolean;
    diagnosticOrRepair: boolean;
    explicitToolIntent: boolean;
    clientActionIntent: boolean;
    clientActionOnlyIntent: boolean;
    visionIntent: boolean;
    autonomousTask: boolean;
  };
}

const CLIENT_NAVIGATION_VERBS = /(?:\u6253\u5f00|\u8fdb\u5165|\u53bb|\u770b\u770b|\u5207\u6362|\u5207\u5230|\u6362\u5230|\u542f\u52a8|\u5f00\u542f|\u5f00\u59cb|\u5c55\u5f00|\u9000\u51fa|\u6536\u8d77|\u5173\u95ed|\u5173\u6389|\u56de\u5230|\u8fd4\u56de|\b(?:open|show|enter|switch|start|expand|exit|hide|close|collapse|return|go back)\b)/iu;
const CLIENT_SURFACES = /(?:\u4e2d\u67a2\u4e16\u754c|\u4e2d\u67a2|\u4e16\u754c\u89c6\u56fe|\u4e91\u7aef\u753b\u5e03|\u6280\u80fd\u5927\u5385|\u6280\u80fd|\u6587\u4ef6\u7ba1\u7406\u5668|\u6587\u4ef6\u4e2d\u5fc3|\u6587\u4ef6|\u58c1\u7eb8\u6a21\u5f0f|\u8bbe\u7f6e|\u65e5\u5fd7|\u97f3\u4e50\u4e2d\u5fc3|\u97f3\u4e50|\u77e5\u8bc6\u5e93|\u8ba2\u9605|\u6fc0\u6d3b|\u8d26\u5355|\u684c\u9762\u5c0f\u7ec4\u4ef6|\u5c0f\u7ec4\u4ef6|\u4e3b\u5c4f\u5e55|\u4e3b\u9875|\u9996\u9875|\u804a\u5929|\u804a\u5929\u7a97\u53e3|\u56e2\u961f|\u56e2\u961f\u9762\u677f|\u5de5\u5177|\u5de5\u5177\u9762\u677f|\u5f62\u8c61|\u5934\u50cf\u5de5\u4f5c\u5ba4|\u58f0\u97f3|\u58f0\u97f3\u5de5\u4f5c\u5ba4|\u8bb0\u5fc6\u5934\u50cf|\u7ec4\u7ec7|\u7ec4\u7ec7\u7a7a\u95f4|\u7ec4\u7ec7\u5de5\u4f5c\u533a|\u8ba1\u5212|\u8ba1\u5212\u9762\u677f|\u5de5\u4f5c\u961f\u5217|\u7535\u8111\u9002\u914d\u4e2d\u5fc3|\u8ba1\u7b97\u673a\u9002\u914d\u4e2d\u5fc3|\u8bbe\u5907\u540c\u6b65|\u8bbe\u5907|\u901a\u77e5\u9762\u677f|\u901a\u77e5\u7a97\u53e3|\u63d0\u9192\u9762\u677f|\u63d0\u9192\u7a97\u53e3|\b(?:home|main screen|chat|chat window|nexus|nexus view|cloud canvas|world view|skill center|skills?|file manager|files app|settings|logs?|wallpaper mode|music center|subscription|activation|billing|desktop widget|widget mode|team|tools?|avatar studio|sound studio|memory avatar|organization|org workspace|plans?|planner|work queue|computer adaptation|device sync|devices?|notifications?|notification panel|reminders?|reminder panel)\b)/iu;
const EXTENDED_PERSONAL_CLIENT_SURFACES = /(?:\u4e2a\u4eba\u57df|\u4e2a\u4eba\u5de5\u4f5c\u533a|\u5e94\u7528\u542f\u52a8\u5668|\u5e94\u7528\u641c\u7d22|\u4eba\u683c\u5b9e\u9a8c\u5ba4|\u4eba\u683c|\u7ec8\u7aef|\u4ee4\u724c\u7528\u91cf|\u6a21\u578b\u7528\u91cf|\u4e2a\u4eba\u8d44\u6599|MCP\s*\u8bbe\u7f6e|\u8bed\u97f3\u5de5\u574a|\u58f0\u97f3\u514b\u9686|\u6280\u80fd\u751f\u6210\u5668?|\u667a\u80fd\u4f53\u751f\u6001|\u5e2e\u52a9\u6587\u6863|\u4ea7\u54c1\u6587\u6863|\u521b\u59cb\u4eba\u7a7a\u95f4|GitHub\s*MCP|\b(?:personal workspace|app launcher|spotlight|personality lab|terminal|token dashboard|usage dashboard|profile|mcp settings|voice forge|voice cloning|skill generator|agent ecosystem|documentation|docs|founder workspace|github mcp)\b)/iu;
const ORGANIZATION_WORKSPACE_SURFACES = /(?:\u7ec4\u7ec7\u77e5\u8bc6\u5e93|\u516c\u53f8\s*lumi|\u7ec4\u7ec7\s*lumi|\u6d88\u606f\u63a5\u5165|\u667a\u80fd\u4f53\u6a21\u677f|\u6a21\u677f\u5ba1\u6838|\u6210\u5458\u4e0e\u6743\u9650|\u5ba1\u8ba1\u65e5\u5fd7|\u5f8b\u6240\u5de5\u4f5c\u53f0|\u7a7a\u95f4\u5efa\u7b51\u8bbe\u8ba1|\u54c1\u724c\u521b\u610f\u8bbe\u8ba1|\u7ec4\u7ec7\u8bbe\u7f6e|\u5206\u652f\u8fde\u63a5|\b(?:organization knowledge|company lumi|organization lumi|org lumi|message access|agent templates?|template review|members and permissions|audit log|law firm workspace|spatial and architecture|brand and creative|organization settings|branch connection)\b)/iu;
const EXTERNAL_APP_CONTEXT = /(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u98de\u4e66|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d4f\u89c8\u5668|Chrome|Edge|CAD|AutoCAD|Revit|\b(?:wechat|weixin|wecom|feishu|lark|browser|chrome|edge|autocad|revit)\b)/iu;
const LUMI_CLIENT_CONTEXT = /(?:Lumi|\u5ba2\u6237\u7aef|\u4e2d\u67a2|\u4e16\u754c\u89c6\u56fe|\u4e91\u7aef\u753b\u5e03|\u6280\u80fd\u5927\u5385|\u8fd0\u884c\u65e5\u5fd7|\u8bbe\u7f6e|\u5c0f\u7ec4\u4ef6|\b(?:client|nexus|cloud canvas|world view|skill center|settings|runtime log|widget)\b)/iu;
const SKILL_TERMS = /(?:\u6280\u80fd|\u6280\u80fd\u5927\u5385|\b(?:skill|skills|plugin|mcp)\b)/iu;
const INSTALL_VERBS = /(?:\u5b89\u88c5|\u88c5\u4e0a|\u88c5\u4e00\u4e0b|\binstall\b)/iu;
const DOCUMENT_TERMS = /(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u8fd9\u4efd|\u8fd9\u4e2a|PDF|pdf|DOCX|docx|\b(?:file|document|pdf|docx)\b)/iu;
const READ_VERBS = /(?:\u8bfb|\u8bfb\u53d6|\u6253\u5f00|\u770b\u4e00\u4e0b|\bread\b)/iu;
const SUMMARY_VERBS = /(?:\u603b\u7ed3|\u6458\u8981|\u5f52\u7eb3|\u63d0\u70bc|\u5206\u6790|\b(?:summari[sz]e|extract|analy[sz]e)\b)/iu;
const KNOWLEDGE_BASE_TERMS = /(?:\u77e5\u8bc6\u5e93|\u8d44\u6599\u5e93|\bknowledge base\b)/iu;
const IMPORT_VERBS = /(?:\u5bfc\u5165|\u5b58\u5230|\u8bb0\u5230|\u6536\u5f55|\bimport\b)/iu;
const SEARCH_VERBS = /(?:\u641c\u4e00\u4e0b|\u641c\u4e00\u641c|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u67e5\u4e00\u67e5|\b(?:search|look up|browse|fetch|research)\b)/iu;
const SEARCH_OBJECTS = /(?:\u65b0\u95fb|\u8d44\u6599|\u7f51\u9875|\u7f51\u7ad9|\u4fe1\u606f|\u6765\u6e90|\u5b98\u65b9|\b(?:news|source|official|openai|github|mcp)\b)/iu;
const MARKET_TERMS = /(?:\u770b\u76d8|\u76ef\u76d8|\u884c\u60c5|\u80a1\u7968|\u7f8e\u80a1|\u6e2f\u80a1|\u7092\u80a1|\u80a1\u4ef7|\u6a21\u62df\u76d8|\u4ea4\u6613\u8ba1\u5212|\u81ea\u9009\u80a1|\u80a1\u7968\u6c60|\u76d8\u4e2d\u63d0\u9192|\u4ef7\u683c\u9884\u8b66|\u5f02\u52a8\u76d1\u63a7|\b(?:stock|quote|watchlist|market watch|stock watch|price alert|market alert|paper trade|trading plan)\b)/iu;
const LEGAL_TERMS = /(?:\u6848\u4ef6|\u6848\u53f7|\u8bc1\u636e|\u6750\u6599|\u8d77\u8bc9\u72b6|\u4ee3\u7406\u8bcd|\u8d28\u8bc1|\u6cd5\u9662|\u5f8b\u5e08|\b(?:case|complaint|pleading|evidence|legal)\b)/iu;
const WORK_PRODUCT_VERBS = /(?:\u6574\u7406|\u751f\u6210|\u8d77\u8349|\u64b0\u5199|\u63d0\u70bc|\u5206\u6790|\b(?:draft|generate|prepare|analy[sz]e)\b)/iu;
const MESSAGE_TERMS = /(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u98de\u4e66|\u6d88\u606f|\u5ba2\u6237|\b(?:wechat|wecom|feishu|lark|message|customer)\b)/iu;
const REPLY_VERBS = /(?:\u56de\u4e00\u4e0b|\u56de\u590d|\u56de|\u8349\u7a3f|\b(?:reply|respond|draft)\b)/iu;
const MESSAGE_SEND_VERBS = /(?:\u53d1\u4e00\u4e0b|\u53d1\u4e00\u6761|\u53d1\u7ed9|\u53d1\u9001|\u8f6c\u53d1|\u7c98\u8d34|\u8d34\u5230|\u53d1|\b(?:send|forward|paste)\b)/iu;
const MESSAGE_INQUIRY_VERBS = /(?:\u95ee\u4e00\u4e0b|\u95ee\u95ee|\u8be2\u95ee|\u95ee|\b(?:ask|inquire|check\s+with)\b)/iu;
const GREETING_MESSAGE_TERMS = /(?:\u95ee\u5019\u8bed|\u95ee\u5019|\u5bd2\u6684|\u62db\u547c|\u6d88\u606f|\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u5ba2\u6237|\u8054\u7cfb\u4eba|\u7fa4|\b(?:greeting|message|wechat|wecom|customer|contact|group)\b)/iu;
const DESKTOP_AI_TERMS = /\b(?:workbuddy|work\s*buddy|codex|chatgpt|chatgpt\.com|claude|gemini|deepseek|kimi|doubao|tongyi|qwen|wenxin|ernie|perplexity|cursor|copilot|ollama|lm\s*studio|cherry\s*studio|anythingllm|ai\s*(?:tool|tools|app|apps|agent|agents|assistant|assistants|model|models)|other\s+ai|desktop\s+ai|local\s+ai)\b/i;
const DESKTOP_AI_ACTION_VERBS = /\b(?:ask|query|send|forward|collect|gather|compare|summari[sz]e|bring\s+back|take\s+back|retrieve|paste\s+into|hand\s+off)\b/i;
const DESKTOP_CONTROL_TERMS = /(?:\u7535\u8111|\u684c\u9762|\u5c4f\u5e55|\u7a97\u53e3|\u9f20\u6807|\u952e\u76d8|\b(?:computer|desktop|screen|window|mouse|keyboard)\b)/iu;
const DESKTOP_CONTROL_VERBS = /(?:\u7528|\u4f7f\u7528|\u64cd\u4f5c|\u63a7\u5236|\u63a5\u7ba1|\u70b9\u51fb|\u8f93\u5165|\u6253\u5f00|\u805a\u7126|\b(?:use|operate|control|take\s+over|click|type|open|focus)\b)/iu;
const CONTINUE_VERBS = /(?:\u7ee7\u7eed|\u63a5\u7740|\u5f80\u4e0b|\b(?:continue|resume)\b)/iu;
const TASK_TERMS = /(?:\u4efb\u52a1|\u5ba2\u6237|\u4ea4\u4ed8|\u63a5\u7ba1|\u5de5\u4f5c|\u9879\u76ee|\b(?:task|customer|delivery|takeover|project)\b)/iu;
const CREATE_OR_DRAW_VERBS = /(?:\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u5236\u4f5c|\u505a|\u753b|\u51fa|\b(?:create|generate|draw|make)\b)/iu;
const VISUAL_OUTPUT_TERMS = /(?:\u6d77\u62a5|\u56fe\u7247|\u89c6\u89c9\u56fe|\u54c1\u724c\u56fe|\u5e73\u9762\u56fe|\u56fe\u7eb8|\u8bbe\u8ba1\u56fe|cad|CAD|DXF|dxf|\b(?:poster|image|visual|floor plan|drawing|cad|dxf)\b)/iu;
const WORK_PRODUCT_TERMS = /(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6587\u6863|\u62a5\u544a|\u6c47\u62a5|\u8868\u683c|PPT|ppt|\u5e7b\u706f\u7247|\u4ee3\u7801|\u9879\u76ee|\u5e94\u7528|\u7a0b\u5e8f|\u7f51\u9875|\u7f51\u7ad9|\u94fe\u63a5|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u5de5\u4f5c\u6d41|\u811a\u672c|\u7ec8\u7aef|\u547d\u4ee4|\u4ed3\u5e93|github|\u6570\u636e\u5e93|\u77e5\u8bc6\u5e93|\u6a21\u677f|\u7ec4\u7ec7|\u8bbe\u7f6e|\u8bbe\u5907|\u5c4f\u5e55|\b(?:file|document|report|ppt|presentation|code|project|app|website|workflow|script|repo|database)\b)/iu;

const STRUCTURED_TOOL_INTENT_RULES: IntentGrammarRule[] = [
  { name: 'web-search', all: [SEARCH_VERBS, SEARCH_OBJECTS] },
  { name: 'market-finance', all: [MARKET_TERMS] },
  { name: 'skill-install', all: [SKILL_TERMS, INSTALL_VERBS] },
  { name: 'document-read', all: [DOCUMENT_TERMS, READ_VERBS] },
  { name: 'document-summary', all: [DOCUMENT_TERMS, SUMMARY_VERBS] },
  { name: 'knowledge-import', all: [DOCUMENT_TERMS, KNOWLEDGE_BASE_TERMS, IMPORT_VERBS] },
  { name: 'legal-work-product', all: [LEGAL_TERMS, WORK_PRODUCT_VERBS] },
  { name: 'messaging-reply', all: [MESSAGE_TERMS, REPLY_VERBS] },
  { name: 'messaging-send-or-greeting', all: [MESSAGE_SEND_VERBS, GREETING_MESSAGE_TERMS] },
  { name: 'messaging-inquiry', all: [MESSAGE_TERMS, MESSAGE_INQUIRY_VERBS] },
  { name: 'desktop-ai-collaboration', all: [DESKTOP_AI_TERMS, DESKTOP_AI_ACTION_VERBS] },
  { name: 'desktop-control', all: [DESKTOP_CONTROL_TERMS, DESKTOP_CONTROL_VERBS] },
  { name: 'task-continuation', all: [CONTINUE_VERBS, TASK_TERMS] },
  { name: 'visual-production', all: [CREATE_OR_DRAW_VERBS, VISUAL_OUTPUT_TERMS] },
  { name: 'work-product', all: [WORK_PRODUCT_VERBS, WORK_PRODUCT_TERMS] },
];

const STRUCTURED_CLIENT_ACTION_RULES: IntentGrammarRule[] = [
  { name: 'client-navigation', all: [CLIENT_NAVIGATION_VERBS, CLIENT_SURFACES] },
  { name: 'extended-personal-client-navigation', all: [CLIENT_NAVIGATION_VERBS, EXTENDED_PERSONAL_CLIENT_SURFACES] },
  { name: 'organization-workspace-navigation', all: [CLIENT_NAVIGATION_VERBS, ORGANIZATION_WORKSPACE_SURFACES] },
];

const TOOL_INTENT_PATTERNS: RegExp[] = [
  /(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3).*(?:\u8f6c\u5199|\u8f6c\u6587\u5b57|\u6587\u5b57\u7a3f|\u6587\u4ef6)|(?:\u8f6c\u5199|\u8f6c\u6587\u5b57|\u6587\u5b57\u7a3f).*(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3)|\b(?:audio|voice|recording|memo)\b.*\b(?:transcri|speech\s*to\s*text|text\s*file)\b/i,
  /\b(open|launch|start|run|execute|call\s+(?:a\s+)?tool|use\s+(?:a\s+)?tool|tool\s+call|search|look\s+up|browse|fetch|research|learn|study|integrate|connect|log\s*in|sign\s*in|authenticate|open\s+(?:a\s+)?dashboard|sleep|dream|rest|consolidate\s+(?:memory|memories)|read\s+(?:file|screen|folder|directory)|scan|screenshot|screen\s*shot|click|type|copy|paste|write|save|create|export|delete|remove|install|uninstall|play|pause|resume|download|upload|sync|build|test|commit|push|deploy|cad|dxf|dwg|ifc|bim|revit|dynamo|draft|drawing)\b/i,
  /\b(?:what(?:'s| is)|show|list|check|inspect|scan|read|see)\b.*\b(?:desktop|screen|active window|foreground window|open windows|running processes|background apps|background processes|system state)\b/i,
  /\b(?:law|regulation|policy|statute|case law|patent|copyright|software copyright|intellectual property|standard|specification|paper|literature|doi|arxiv|pubmed|citation|source|official source|verify|valid|effective|prior art|patentability)\b/i,
  /(?:法规|法律|条例|办法|政策|法条|判例|裁判文书|法院|监管|合规|专利|知识产权|软著|软件著作权|著作权|发明人|申请人|审查指南|新颖性|创造性|现有技术|标准|国标|规范|论文|文献|期刊|引用|出处|来源|依据|权威|官方|查证|验证|是否有效|现行有效|沉淀.*知识库|记到知识库|存到知识库|吸收.*资料)/u,
  /(?:\u6848\u4ef6|\u6848\u53f7|\u8bc1\u636e|\u6750\u6599|\u8d77\u8bc9\u72b6|\u4ee3\u7406\u8bcd|\u8d28\u8bc1|\u6cd5\u9662|\u5f8b\u5e08).*(?:\u6574\u7406|\u751f\u6210|\u8d77\u8349|\u64b0\u5199|\u63d0\u70bc|\u5206\u6790)|(?:\u6574\u7406|\u751f\u6210|\u8d77\u8349|\u64b0\u5199|\u63d0\u70bc|\u5206\u6790).*(?:\u6848\u4ef6|\u8bc1\u636e|\u6750\u6599|\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u8d28\u8bc1)/u,
  /(?:桌面上有什么|桌面.*(?:文件|东西|内容|图标|快捷方式)|后台.*(?:运行|进程|软件|程序)|正在运行.*(?:软件|程序|进程|服务)|打开了.*(?:软件|程序|窗口)|当前窗口|前台窗口|活动窗口|系统.*(?:状态|后台)|进程列表|屏幕上有什么|看.*(?:屏幕|桌面|窗口))/u,
  /(?:\u6253\u5f00|\u542f\u52a8|\u5f00\u542f|\u8fd0\u884c|\u6267\u884c|\u8c03\u7528\u5de5\u5177|\u5de5\u5177\u8c03\u7528|\u641c\u7d22|\u627e|\u67e5|\u67e5\u627e|\u5b66|\u5b66\u4e60|\u7814\u7a76|\u8c03\u7814|\u63a5\u5165|\u878d\u5408|\u96c6\u6210|\u7761|\u7761\u89c9|\u4f11\u606f|\u505a\u68a6|\u68a6\u5883|\u68b3\u7406\u8bb0\u5fc6|\u6574\u7406\u8bb0\u5fc6|\u53bb\u5e72\u6d3b|\u5f00\u59cb\u5e72\u6d3b|\u5f00\u59cb\u5904\u7406|\u7ee7\u7eed\u5904\u7406|\u7ee7\u7eed\u505a|\u63a5\u7740\u505a|\u8054\u7f51|\u6d4f\u89c8|\u8bbf\u95ee|\u67e5\u627e\u6587\u4ef6|\u8bfb\u53d6\u6587\u4ef6|\u622a\u56fe|\u622a\u5c4f|\u70b9\u51fb|\u8f93\u5165|\u590d\u5236|\u7c98\u8d34|\u64ad\u653e|\u653e.*(?:\u6b4c|\u97f3\u4e50)|\u6682\u505c\u97f3\u4e50|\u7ee7\u7eed\u64ad\u653e|\u4e0b\u8f7d|\u4e0a\u4f20|\u540c\u6b65|\u5b89\u88c5|\u5378\u8f7d|\u63d0\u4ea4|\u63a8\u9001|\u90e8\u7f72|\u6784\u5efa|\u6d4b\u8bd5)/u,
  /(?:\u641c\u4e00\u4e0b|\u641c\u4e00\u641c|\u5e2e(?:\u6211)?.*\u641c).*(?:\u65b0\u95fb|\u8d44\u6599|\u7f51\u9875|\u7f51\u7ad9|\u4fe1\u606f|\u6765\u6e90|\u5b98\u65b9|\b(?:openai|ai|mcp|github)\b)/iu,
  /(?:\u770b\u76d8|\u76ef\u76d8|\u884c\u60c5|\u80a1\u7968|\u7f8e\u80a1|\u6e2f\u80a1|\u7092\u80a1|\u8d22\u7ecf\u65b0\u95fb|\u6a21\u62df\u76d8|\u4ea4\u6613\u8ba1\u5212|\u628a.*\u6280\u80fd.*(?:\u88c5\u4e0a|\u88c5\u4e00\u4e0b|\u5b89\u88c5)|(?:\u88c5\u4e0a|\u88c5\u4e00\u4e0b|\u5b89\u88c5).*\u6280\u80fd|\u6280\u80fd.*(?:\u88c5\u4e0a|\u88c5\u4e00\u4e0b|\u5b89\u88c5))/u,
  /(?:\u628a|\u5c06)?.*(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599).*(?:\u8bfb|\u8bfb\u53d6|\u770b\u4e00\u4e0b|\u6253\u5f00)/u,
  /(?:\u8bfb|\u8bfb\u53d6|\u770b\u4e00\u4e0b|\u6253\u5f00).*(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u8fd9\u4efd|\u8fd9\u4e2a|PDF|pdf|DOCX|docx)/u,
  /(?:(?:\u628a|\u5c06)?.*(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u8fd9\u4efd|\u8fd9\u4e2a|PDF|pdf|DOCX|docx).*(?:\u603b\u7ed3|\u6458\u8981|\u5f52\u7eb3|\u63d0\u70bc|\u5206\u6790)|(?:\u603b\u7ed3|\u6458\u8981|\u5f52\u7eb3|\u63d0\u70bc|\u5206\u6790).*(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u8fd9\u4efd|\u8fd9\u4e2a|PDF|pdf|DOCX|docx))/u,
  /(?:\u628a|\u5c06)?.*(?:\u8d44\u6599|\u6587\u6863|\u6587\u4ef6|\u8fd9\u4efd|\u8fd9\u4e2a).*(?:\u5bfc\u5165|\u5b58\u5230|\u8bb0\u5230|\u6536\u5f55).*(?:\u77e5\u8bc6\u5e93|\u8d44\u6599\u5e93)/u,
  /(?:(?:\u5e2e\u6211|\u5e2e|\u7ed9|\u628a)?.*(?:\u56de\u4e00\u4e0b|\u56de\u590d|\u56de|\u8349\u7a3f).*(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u98de\u4e66|\u6d88\u606f|\u5ba2\u6237)|(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u98de\u4e66|\u6d88\u606f|\u5ba2\u6237).*(?:\u56de\u590d|\u56de\u4e00\u4e0b|\u56de|\u8349\u7a3f))/u,
  /(?:\u7ee7\u7eed|\u63a5\u7740|\u5f80\u4e0b).*(?:\u4efb\u52a1|\u5ba2\u6237|\u4ea4\u4ed8|\u63a5\u7ba1|\u5de5\u4f5c|\u9879\u76ee)/u,
  /(?:\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u5bfc\u51fa|\u4fdd\u5b58|\u5199\u5165|\u7f16\u8f91|\u4fee\u6539|\u5220\u9664|\u6574\u7406|\u5206\u6790|\u5236\u4f5c|\u505a|\u753b|\u51fa).*(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6587\u6863|\u62a5\u544a|\u6c47\u62a5|\u8868\u683c|PPT|ppt|\u5e7b\u706f\u7247|\u4ee3\u7801|\u9879\u76ee|\u5e94\u7528|\u7a0b\u5e8f|\u7f51\u9875|\u7f51\u7ad9|\u94fe\u63a5|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u5de5\u4f5c\u6d41|\u811a\u672c|\u7ec8\u7aef|\u547d\u4ee4|\u4ed3\u5e93|github|\u6570\u636e\u5e93|\u77e5\u8bc6\u5e93|\u6a21\u677f|\u7ec4\u7ec7|\u8bbe\u7f6e|\u8bbe\u5907|\u5c4f\u5e55|cad|CAD|\u56fe\u7eb8|\u8349\u7a3f\u56fe|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u8bbe\u8ba1\u56fe|\u6d77\u62a5|\u56fe\u7247|\u89c6\u89c9\u56fe|\u54c1\u724c\u56fe)/iu,
  /(?:cad|CAD|Revit|revit|IFC|ifc|BIM|bim|Dynamo|dynamo|\u56fe\u7eb8|\u8349\u7a3f\u56fe|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u8bbe\u8ba1\u56fe).*(?:\u753b|\u51fa|\u751f\u6210|\u8f6c|\u5bfc\u51fa|\u627e|\u641c\u7d22|\u67e5|\u67e5\u627e|\u5b66|\u5b66\u4e60|\u7814\u7a76|\u63a5\u5165|\u878d\u5408|\u96c6\u6210)/u,
];

const AUTONOMOUS_TASK_PATTERNS: RegExp[] = [
  /\b(plan|build|design|draft|prepare|organize|analyze|review|research|implement|refactor|generate|create)\b.*\b(project|report|doc|document|deck|presentation|code|repo|workflow|workspace|team|agent|files?)\b/i,
  /(?:规划|搭建|设计|准备|整理|分析|审查|研究|实现|重构|生成|创建|制作).*(?:项目|报告|文档|方案|代码|仓库|工作流|团队|智能体|文件|资料)/u,
];

const CLIENT_ACTION_INTENT_PATTERNS: RegExp[] = [
  /\b(switch|change|set|enter|open|start|turn\s+on)\b.*\b(chat|assistant|meeting|music|auto(?:nomous)?|auto\s+execute|autonomous)\s+mode\b/i,
  /\b(open|start|show|hide|close|inspect|check)\b.*\b(nexus|nexus\s+view|cloud\s+canvas|world\s+view|client|meeting\s+notes?|music\s+center|mood\s+layer|knowledge\s+base|runtime\s+log|run\s+logs?|logs?|settings|wallpaper\s+mode|organization|org\s+workspace|cloud|files?|skills?|tools?|avatar|sound\s+studio|devices?|sync|kernel|monitor|plan|planner)\b/i,
  /\b(play|put\s+on|listen\s+to)\b.*\b(music|song|playlist|album)\b/i,
  /(?:\u5207\u6362|\u5207\u5230|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u53bb|\u770b\u770b|\u68c0\u67e5|\u67e5|\u6478\u7d22).*(?:\u81ea\u5df1\u7684\u5ba2\u6237\u7aef|\u5ba2\u6237\u7aef|\u4e2d\u67a2\u4e16\u754c|\u4e2d\u67a2|\u4e16\u754c\u89c6\u56fe|\u4e91\u7aef\u753b\u5e03|\u804a\u5929|\u52a9\u624b|\u4f1a\u8bae|\u97f3\u4e50|\u81ea\u52a8\u6267\u884c|\u81ea\u4e3b\u6267\u884c|\u4f1a\u8bae\u6a21\u5f0f|\u97f3\u4e50\u6a21\u5f0f|\u52a9\u624b\u6a21\u5f0f|\u804a\u5929\u6a21\u5f0f|\u6c1b\u56f4\u5c42|\u97f3\u4e50\u4e2d\u5fc3|\u77e5\u8bc6\u5e93|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u8bbe\u7f6e|\u58c1\u7eb8\u6a21\u5f0f|\u7ec4\u7ec7|\u4e91\u7aef|\u6587\u4ef6|\u6587\u4ef6\u7ba1\u7406\u5668|\u6587\u4ef6\u4e2d\u5fc3|\u6280\u80fd|\u6280\u80fd\u5927\u5385|\u5de5\u5177|\u5f62\u8c61|\u58f0\u97f3|\u8bbe\u5907|\u540c\u6b65|\u5185\u6838|\u76d1\u63a7|\u8ba1\u5212|\u56e2\u961f)/u,
  /(?:\u653e|\u64ad\u653e|\u542c).*(?:\u97f3\u4e50|\u6b4c|\u6b4c\u66f2|\u6b4c\u5355|\u4e13\u8f91)/u,
];

const CLIENT_ACTION_ONLY_PATTERNS: RegExp[] = [
  /\b(switch|change|set|enter|open|start|turn\s+on)\b.*\b(chat|assistant|meeting|music|auto(?:nomous)?|auto\s+execute|autonomous)\s+mode\b/i,
  /\b(open|start|show|hide|close|inspect|check)\b.*\b(nexus|nexus\s+view|cloud\s+canvas|world\s+view|client|meeting\s+notes?|music\s+center|mood\s+layer|knowledge\s+base|runtime\s+log|run\s+logs?|logs?|settings|wallpaper\s+mode|organization|org\s+workspace|cloud|skill\s+center|skills?|tools?|avatar|sound\s+studio|devices?|sync|kernel|monitor|plan|planner|file\s+manager|files\s+app)\b/i,
  /\b(play|put\s+on|listen\s+to)\b.*\b(music|song|playlist|album)\b/i,
  /(?:\u5207\u6362|\u5207\u5230|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u53bb|\u770b\u770b|\u68c0\u67e5|\u67e5|\u6478\u7d22).*(?:\u81ea\u5df1\u7684\u5ba2\u6237\u7aef|\u5ba2\u6237\u7aef|\u4e2d\u67a2\u4e16\u754c|\u4e2d\u67a2|\u4e16\u754c\u89c6\u56fe|\u4e91\u7aef\u753b\u5e03|\u804a\u5929|\u52a9\u624b|\u4f1a\u8bae|\u97f3\u4e50|\u81ea\u52a8\u6267\u884c|\u81ea\u4e3b\u6267\u884c|\u4f1a\u8bae\u6a21\u5f0f|\u97f3\u4e50\u6a21\u5f0f|\u52a9\u624b\u6a21\u5f0f|\u804a\u5929\u6a21\u5f0f|\u6c1b\u56f4\u5c42|\u97f3\u4e50\u4e2d\u5fc3|\u77e5\u8bc6\u5e93|\u8fd0\u884c\u65e5\u5fd7|\u65e5\u5fd7|\u8bbe\u7f6e|\u58c1\u7eb8\u6a21\u5f0f|\u7ec4\u7ec7|\u4e91\u7aef|\u6280\u80fd|\u6280\u80fd\u5927\u5385|\u5de5\u5177|\u5f62\u8c61|\u58f0\u97f3|\u8bbe\u5907|\u540c\u6b65|\u5185\u6838|\u76d1\u63a7|\u8ba1\u5212|\u56e2\u961f|\u6587\u4ef6\u7ba1\u7406\u5668|\u6587\u4ef6\u4e2d\u5fc3)/u,
  /(?:\u653e|\u64ad\u653e|\u542c).*(?:\u97f3\u4e50|\u6b4c|\u6b4c\u66f2|\u6b4c\u5355|\u4e13\u8f91)/u,
];

const DIAGNOSTIC_OR_REPAIR_PATTERNS: RegExp[] = [
  /\b(what happened|what went wrong|diagnose|debug|fix|repair|recover|self[-\s]?check|self[-\s]?heal|not working|doesn'?t work|broken|failed|failure|error|crash(?:ed)?|stuck|hang(?:ing)?|blank screen|white screen|no sound|silent|cannot|can'?t)\b/i,
  /\bwhy\b.*\b(not|can'?t|cannot|failed?|failure|error|broken|wrong|crash(?:ed)?|stuck|hang(?:ing)?|blank|silent|doesn'?t\s+work|not\s+working)\b/i,
  /(?:\u4e0d\u4f1a|\u4e0d\u80fd|\u65e0\u6cd5).*(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u6267\u884c|\u5b89\u88c5|\u63a8\u9001|\u90e8\u7f72|\u751f\u6210|\u8bfb|\u8fde\u63a5|\u63a5\u5165|\u767b\u5f55|\u767b\u9646|\u64ad\u653e|\u5b8c\u6210|\u751f\u6548|\u5de5\u4f5c|\u8c03\u7528|\u4f7f\u7528)/u,
  /(?:(?:\u4e3a\u4ec0\u4e48|\u4e3a\u5565).*(?:\u6ca1|\u4e0d|\u65e0\u6cd5|\u5931\u8d25|\u9519|\u62a5\u9519|\u5d29|\u5361|\u95ee\u9898|\u6545\u969c|\u5b8c\u6210|\u751f\u6548|\u6253\u5f00|\u653e\u51fa|\u58f0\u97f3|\u542c\u89c1)|\u600e\u4e48\u56de\u4e8b|\u54ea\u91cc.*(?:\u95ee\u9898|\u574f|\u6ca1\u8dd1\u901a)|\u68c0\u67e5|\u8bca\u65ad|\u6392\u67e5|\u4fee\u590d|\u5904\u7406.*(?:\u95ee\u9898|\u6545\u969c|\u9519\u8bef)|\u81ea\u68c0|\u81ea\u4fee\u590d|\u6062\u590d|\u62a5\u9519|\u9519\u8bef|\u5931\u8d25|\u5d29\u4e86|\u5d29\u6e83|\u5361\u4f4f|\u5361\u6b7b|\u767d\u5c4f|\u6ca1\u53cd\u5e94|\u4e0d\u751f\u6548|\u4e0d\u8d77\u4f5c\u7528|\u6253\u4e0d\u5f00|\u653e\u4e0d\u51fa|\u6ca1\u58f0\u97f3|\u542c\u4e0d\u89c1|\u4e0d\u5bf9|\u6709\u95ee\u9898|\u88ab\u9650\u5236|\u9650\u5236)/u,
  /\b(?:HTTP\s*)?(?:400|404|500)\b/i,
];

function hasExplicitActionRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return /^(?:\u4f60\s*)?(?:\u5e2e\u6211|\u5e2e\u5fd9|\u8bf7(?!\u95ee)|\u7ed9|\u66ff\u6211|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u5373|\u76f4\u63a5|\u628a|\u5c06)/u.test(normalized)
    || /^(?:please\s+)?(?:send|open|read|run|execute|create|generate|download|install|search|find|check)\b/i.test(normalized);
}

/**
 * Questions about Lumi's own immediately preceding behaviour are explanations
 * or corrections, not fresh commands. Keep this narrow so real diagnostics
 * such as "为什么打不开 AutoCAD" can still use observation tools.
 */
export function isUserCorrectionOrExplanationQuestion(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:修复|处理|排查|检查|诊断|重新|重试|再试|fix|repair|diagnose|retry)/iu.test(normalized)) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:打不开|不能打开|没打开|没有打开|无法打开|启动失败|运行失败|failed\s+to\s+(?:open|start|run))/iu.test(normalized)) return false;
  // A foreground messaging instruction may contain a question as the message body.
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:微信|企业微信|wechat|weixin).{0,40}(?:问一下|问问|询问|发给|发送).{0,40}(?:在干嘛|在做什么|忙什么|做什么)/iu.test(normalized)) return false;

  return [
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:你|lumi)[，,\s]*(?:刚才|刚刚|之前|上一轮|上一次)?[^。！？!?\n]{0,24}(?:为什么|怎么|为何|干嘛|做什么|干什么)[^。！？!?\n]{0,60}(?:这么久|这么慢|才回|才回复|打开|启动|运行|执行|操作|做了|干了)/iu,
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:你|lumi)[^。！？!?\n]{0,48}(?:打开|启动|运行|执行|操作)[^。！？!?\n]{0,32}(?:做什么|干什么|干嘛|为什么|怎么回事|干什么用)/iu,
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /(?:刚才|刚刚|之前|上一轮|上一次)[^。！？!?\n]{0,48}(?:为什么|怎么|为何|干嘛|做什么|干什么)[^。！？!?\n]{0,60}(?:打开|启动|运行|执行|操作|回复|回答)/iu,
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /(?:明明|不是)[^。！？!?\n]{0,48}(?:已经|都)?[^。！？!?\n]{0,32}(?:打开|启动|完成|执行)[^。！？!?\n]{0,16}(?:吗|么|呢|[？?])/u,
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:不是[，,\s]*)?(?:我现在)?[^。！？!?\n]{0,40}(?:哪来的|怎么会是|什么微信)[^。！？!?\n]{0,32}(?:微信客户端|微信渠道|渠道|客户端)/u,
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /(?:能不能|能否|可以不可以|可不可以)[^。！？!?\n]{0,16}(?:听见|听到|听清|听得到)[^。！？!?\n]{0,16}(?:我|说话)?/u,
    /\bcan\s+you\s+hear\s+me\b/i,
  ].some(pattern => pattern.test(normalized));
}

export function isInformationOnlyQuestion(text: string): boolean {
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  if (/(?:我问你)?(?:刚刚|刚才|之前|上一轮|上一次).{0,80}(?:干了什么|做了什么|操作了什么|打开.{0,24}干了什么|为什么.{0,40}(?:打开|操作|执行|回复))/u.test(text)) return true;
  if (/^(?:为什么|为何|怎么).{0,80}(?:没有|没|未能|不能).{0,40}(?:打开|启动|运行|执行|发送)/u.test(text)) return true; // i18n-allow: input recognition
  if (isUserCorrectionOrExplanationQuestion(text)) return true;
  if (isDiagnosticOrRepairRequest(text)) return false;
  if (hasExplicitActionRequest(text)) return false;
  if (
    CLIENT_NAVIGATION_VERBS.test(text) &&
    (CLIENT_SURFACES.test(text) || EXTENDED_PERSONAL_CLIENT_SURFACES.test(text) || ORGANIZATION_WORKSPACE_SURFACES.test(text))
  ) return false;
  return [
    /(?:^|\s)(?:why\b)|(?:\u4e3a\u4ec0\u4e48|\u4e3a\u5565|\u4e3a\u4f55)/iu,
    /(?:\u662f\u4ec0\u4e48|\u4ec0\u4e48\u610f\u601d|\u600e\u4e48\u7406\u89e3|\u600e\u4e48\u7528|\u5982\u4f55\u4f7f\u7528|\u4f7f\u7528\u65b9\u6cd5|\u6709\u4ec0\u4e48\u533a\u522b|\u53ef\u4ee5\u7528\u5417|\u80fd\u7528\u5417|\u80fd\u4e0d\u80fd\u7528|\u4e5f\u80fd\u7528\u5417|\u80fd\u4e0d\u80fd\u8bf4\u660e|\u4f1a\u4e0d\u4f1a|\u6709\u98ce\u9669|\u5b89\u5168\u5417|\u662f\u4e0d\u662f)(?:.*[\uff1f?]|\s*)$/u,
    /(?:\u53ef\u4ee5|\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u80fd\u4e0d\u80fd|\u662f\u5426\u53ef\u4ee5|\u662f\u5426\u80fd|\u4f1a\u4e0d\u4f1a).{0,48}(?:\u53d1\u9001|\u53d1|\u8f6c\u53d1|\u4f20\u8f93|\u4f20|\u5206\u4eab|\u4e0b\u8f7d|\u5bfc\u51fa|\u8fdb\u5165|\u8bbf\u95ee|\u8fde\u63a5|\u63a5\u5165).{0,48}(?:\u5417|\u4e48|\u561b|\u5462|[\uff1f?])$/u,
    /\b(?:can|could|would)\s+(?:you|lumi|it)\b[^?]{0,160}\?|\b(?:is\s+it\s+possible|are\s+you\s+able)\b[^?]{0,160}\??$/i,
  ].some((pattern) => pattern.test(text));
}

function matchesIntentGrammar(text: string, rules: IntentGrammarRule[]): boolean {
  return rules.some((rule) => {
    if (rule.none?.some((pattern) => pattern.test(text))) return false;
    return rule.all.every((pattern) => pattern.test(text));
  });
}

function matchIntentGrammarRuleNames(text: string, rules: IntentGrammarRule[]): string[] {
  return rules
    .filter((rule) => {
      if (rule.none?.some((pattern) => pattern.test(text))) return false;
      return rule.all.every((pattern) => pattern.test(text));
    })
    .map((rule) => rule.name);
}

function matchPatternRuleNames(text: string, patterns: RegExp[], prefix: string): string[] {
  return patterns
    .map((pattern, index) => pattern.test(text) ? `${prefix}-${index + 1}` : '')
    .filter(Boolean);
}

function pushRule(out: ToolIntentMatchedRule[], layer: ToolIntentRuleLayer, name: string): void {
  if (!name) return;
  if (out.some((rule) => rule.layer === layer && rule.name === name)) return;
  out.push({ layer, name });
}

export function hasExplicitToolIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (isInformationOnlyQuestion(normalized)) return false;
  if (matchesIntentGrammar(normalized, STRUCTURED_TOOL_INTENT_RULES)) return true;
  return TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasClientActionIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (isInformationOnlyQuestion(normalized)) return false;
  if (detectRequestedOperationMode(normalized)) return true;
  if (EXTERNAL_APP_CONTEXT.test(normalized) && !LUMI_CLIENT_CONTEXT.test(normalized) && !ORGANIZATION_WORKSPACE_SURFACES.test(normalized)) return false;
  if (matchesIntentGrammar(normalized, STRUCTURED_CLIENT_ACTION_RULES)) return true;
  return CLIENT_ACTION_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasClientActionOnlyIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (isInformationOnlyQuestion(normalized)) return false;
  if (detectRequestedOperationMode(normalized)) return true;
  if (EXTERNAL_APP_CONTEXT.test(normalized) && !LUMI_CLIENT_CONTEXT.test(normalized) && !ORGANIZATION_WORKSPACE_SURFACES.test(normalized)) return false;
  if (matchesIntentGrammar(normalized, STRUCTURED_CLIENT_ACTION_RULES)) return true;
  return CLIENT_ACTION_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isDiagnosticOrRepairRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return DIAGNOSTIC_OR_REPAIR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldAllowToolUseForTurn(text: string, source?: string, operationMode?: string): boolean {
  const mode = normalizeOperationMode(operationMode);
  if (mode === 'chat') return hasClientActionIntent(text);
  if (isDiagnosticOrRepairRequest(text)) return true;
  if (mode === 'meeting') return hasClientActionIntent(text);
  if (hasVisionIntent(text)) return true;
  if (mode === 'autonomous' && AUTONOMOUS_TASK_PATTERNS.some((pattern) => pattern.test(text.trim()))) return true;
  if (hasExplicitToolIntent(text)) return true;
  return false;
}

export function traceToolIntentDecision(text: string, source?: string, operationMode?: string): ToolIntentDecisionTrace {
  const normalized = text.trim();
  const mode = normalizeOperationMode(operationMode);
  const requestedMode = normalized ? detectRequestedOperationMode(normalized) : null;
  const matchedRules: ToolIntentMatchedRule[] = [];
  pushRule(matchedRules, 'mode', `operation-mode:${mode}`);
  if (requestedMode) pushRule(matchedRules, 'client_action', `operation-mode-request:${requestedMode}`);

  const informationOnlyQuestion = normalized ? isInformationOnlyQuestion(normalized) : false;
  const diagnosticRules = normalized ? matchPatternRuleNames(normalized, DIAGNOSTIC_OR_REPAIR_PATTERNS, 'diagnostic-pattern') : [];
  const diagnosticOrRepair = diagnosticRules.length > 0;
  const structuredToolRules = !informationOnlyQuestion && normalized
    ? matchIntentGrammarRuleNames(normalized, STRUCTURED_TOOL_INTENT_RULES)
    : [];
  const legacyToolRules = !informationOnlyQuestion && normalized
    ? matchPatternRuleNames(normalized, TOOL_INTENT_PATTERNS, 'tool-pattern')
    : [];
  const structuredClientRules = !informationOnlyQuestion && normalized
    ? matchIntentGrammarRuleNames(normalized, STRUCTURED_CLIENT_ACTION_RULES)
    : [];
  const clientActionRules = !informationOnlyQuestion && normalized
    ? matchPatternRuleNames(normalized, CLIENT_ACTION_INTENT_PATTERNS, 'client-action-pattern')
    : [];
  const clientActionOnlyRules = !informationOnlyQuestion && normalized
    ? matchPatternRuleNames(normalized, CLIENT_ACTION_ONLY_PATTERNS, 'client-action-only-pattern')
    : [];
  const autonomousTaskRules = mode === 'autonomous' && normalized
    ? matchPatternRuleNames(normalized, AUTONOMOUS_TASK_PATTERNS, 'autonomous-task-pattern')
    : [];
  const visionIntent = normalized ? hasVisionIntent(normalized) : false;

  if (informationOnlyQuestion) pushRule(matchedRules, 'information_guard', 'information-only-question');
  for (const name of diagnosticRules) pushRule(matchedRules, 'diagnostic', name);
  for (const name of structuredToolRules) pushRule(matchedRules, 'structured_tool', name);
  for (const name of legacyToolRules) pushRule(matchedRules, 'legacy_tool_pattern', name);
  for (const name of structuredClientRules) pushRule(matchedRules, 'structured_client', name);
  for (const name of clientActionRules) pushRule(matchedRules, 'client_action', name);
  for (const name of clientActionOnlyRules) pushRule(matchedRules, 'client_action_only', name);
  for (const name of autonomousTaskRules) pushRule(matchedRules, 'mode', name);
  if (visionIntent) pushRule(matchedRules, 'vision', 'vision-intent');

  const explicitToolIntent = structuredToolRules.length > 0 || legacyToolRules.length > 0;
  const clientActionIntent = Boolean(requestedMode) || structuredClientRules.length > 0 || clientActionRules.length > 0;
  const clientActionOnlyIntent = Boolean(requestedMode) || structuredClientRules.length > 0 || clientActionOnlyRules.length > 0;
  const autonomousTask = autonomousTaskRules.length > 0;

  let allowToolUse = false;
  let decisionReason = 'no action signal matched';
  if (!normalized) {
    decisionReason = 'empty turn';
  } else if (mode === 'chat') {
    allowToolUse = clientActionIntent;
    decisionReason = allowToolUse
      ? 'chat mode client-control signal matched'
      : 'chat mode is pure conversation unless the user controls Lumi client mode';
  } else if (diagnosticOrRepair) {
    allowToolUse = true;
    decisionReason = 'diagnostic or repair wording enables self-inspection tools';
  } else if (mode === 'meeting') {
    allowToolUse = clientActionIntent;
    decisionReason = allowToolUse
      ? 'meeting mode allows client control action'
      : 'meeting mode only allows client control action';
  } else if (visionIntent) {
    allowToolUse = true;
    decisionReason = 'vision wording asks Lumi to inspect visible content';
  } else if (mode === 'autonomous' && autonomousTask) {
    allowToolUse = true;
    decisionReason = 'autonomous mode task pattern matched';
  } else if (explicitToolIntent) {
    allowToolUse = true;
    decisionReason = 'explicit tool or work action matched';
  }

  const blockedBy: string[] = [];
  if (!allowToolUse) {
    if (!normalized) blockedBy.push('empty-text');
    if (informationOnlyQuestion) blockedBy.push('information-only-question');
    if (mode === 'meeting' && !clientActionIntent) blockedBy.push('meeting-mode-client-actions-only');
    if (mode === 'chat' && !clientActionIntent) {
      blockedBy.push('chat-mode-conversation-only');
    }
    if (!blockedBy.length) blockedBy.push('no-tool-intent');
  }

  return {
    text,
    source: source || '',
    operationMode: mode,
    normalized,
    allowToolUse,
    decisionReason,
    blockedBy,
    matchedRules,
    signals: {
      informationOnlyQuestion,
      diagnosticOrRepair,
      explicitToolIntent,
      clientActionIntent,
      clientActionOnlyIntent,
      visionIntent,
      autonomousTask,
    },
  };
}

export function shouldExposeAgentWork(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    /\b(team|teammate|sub-?agent|worker agent|multi-?agent|orchestrator|orchestration|delegate|assign|crew)\b/i,
    /(?:\u56e2\u961f|\u5b50\s*agent|\u5b50\u667a\u80fd\u4f53|\u591a\s*agent|\u591a\u667a\u80fd\u4f53|\u7ec4\u5efa|\u7ec4\u961f|\u7f16\u6392|\u5206\u6d3e|\u5206\u914d|\u4ea4\u7ed9.*(?:\u5904\u7406|\u505a)|\u8c03\u5ea6|\u7ec4\u4ef6\u56e2\u961f)/u,
  ].some((pattern) => pattern.test(normalized));
}
