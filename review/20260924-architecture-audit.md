# LumiCore（D:\lumiOS）内部链路审计报告

审计日期：2026-09-24 · 版本：`3.1.0` · 源码基线：`35760c39764b7aae724184583b7f663bdc6670ec`（已核对：工作区 HEAD 与该提交一致；`git status` 中 864 个 "M" 均为 CRLF 行尾差异，`--ignore-cr-at-eol` 后 `server/` 与 `cognition/` 无实质改动）· 范围：`server/`、`src/`、`shared/`（排除 node_modules、gpt-sovits-src、src-tauri/target、.codex-run 等 vendored/构建目录）

配套阅读：本报告已按《LumiCore 项目描述与代码分区大纲》与《源码逐文件索引》复核；与大纲第 20 节"优先审阅的复杂点"、`shared/technical_architecture.ts` 不变量以及 `review/20260924-task-flow.md` 的对照见第 7 节。

---

## 0. 一页结论

用户反馈的"内部链路相互打架、同一意图被多个路径处理"在代码层面是成立的，而且有明确的结构性根因，不是零散 bug。归纳为五条：

1. **没有统一的执行入口。** README 宣称"个人模式、组织模式和指挥中心共享统一的执行入口"，实际上服务端至少有 7 套各自独立的 turn 管线（`socket/chat.ts`、`socket/task.ts`、`socket/voice.ts`、消息接入 `messaging_routes.ts`、REST `chat_routes.ts`、MCP `lumi_server.ts`、自治 `task_executor.ts`）。它们共用了 `buildLumiExecutionPipeline`、`runWithTools` 等构件，但流水线之前的快速通道、任务关系判定、确认续执行，以及流水线之后的直接执行分支，每个入口都是各自复制的一份，且已明显分叉。大纲第 2 节第 2 条"文字和语音共用执行决策基础，但接入层仍然分别存在"是准确的，本报告量化了分叉的程度。

2. **同一个判断有多份互不一致的实现，并在同一轮里被反复计算。** "确认"至少 7 套正则、"取消"至少 5 套、"纠正"至少 7 个判定器、"复述"4 份、任务关系（`resolveActiveTaskMessageRelation`）在一轮 `agent:chat` 里被算 4~5 次且输入各不相同。更严重的是，有一处把意图判定结果以**文本**形式写进 prompt，下游再用正则从 prompt 文本里把它解析回来作为第二套意图（R3），直接推翻前一套的结论。

3. **任务执行上下文没有一条贯穿的 ID。** `turnId` 一列里混存了至少 6 种不同含义的 ID；幂等键有两套公式无法 join；"任务"有 5 本互不相连的账（前台会话任务、自治任务、工作接管任务、工作流运行、指挥中心计划）；同一份任务状态存 4 份、靠 `updatedAt` 时间戳仲裁。

4. **迟到回执大部分被丢弃。** 只有语音链路有归档路径且只归档不回写；chat / task 在取消快照后完成的工具记录不再持久化；桌面中继在宽限期后收到的真实结果被 `if (settled) return` 静默吞掉，账本里永远是 `outcome_unknown`。这与 `technical_architecture.ts` 不变量 "Task completion is derived from TaskLedger execution evidence" 直接冲突：证据到了，账本却没收。

5. **System prompt 自相矛盾，且预算裁剪会先丢关键执行上下文。** 纯聊天轮次同时收到"Tool access: chat-only"和"tools=available, call the tool in this turn"；人格宪法要求发消息前先确认，运行模式覆盖层却说"without per-tool permission chatter"；身份定义写了 8 遍；预算裁剪按关键词打分，任务状态证据块只得 0~40 分而回复风格块受保护。

这些问题彼此叠加：多入口 → 各自复制判定逻辑 → 判定结果不一致 → 各自写不同账本 → 账本之间只能靠启发式（文本匹配、时间戳、"取最新"）关联 → 最终回复和状态查询读到不同的事实。

**修复不能靠继续加 gate。** 推荐路线是：先冻结新增判定器，把 `execution_pipeline` 已经产出的 `intentTrace` 升级为单一的 `TurnIntentResolution`（一次判定、结构化结果、全链路只读它）；再统一 `ExecutionContext`（requestId 作为唯一根 ID，turnId 只表示一种含义）；然后让 voice / task / messaging 逐个收敛到 chat 主链路上，删除各自的复制品。详见第 6 节。

---

## 1. 审计方法

- 以 `server/runtime/socket.ts` → `registerChatHandler` 为起点，逐行阅读 `agent:chat` 处理器（`chat.ts:753–5130`，`registerChatHandler` 单函数约 4500 行），记录每个意图判定 / 快速通道 / 覆盖层的调用顺序、输入和是否可截断。
- 对照 `socket/voice.ts`（6818 行）、`socket/task.ts`（约 2400 行）、`regions/packs/cn/messaging_routes.ts`、`routes/chat_routes.ts`、`mcp/lumi_server.ts`、`autonomy/task_executor.ts`，逐项比较是否复用同一链路。
- 对任务 / 回执 / 确认 / 中继 / 队列相关的所有持久化与内存结构做清单，绘制 ID 关联图。
- 对前端 `src/components/AgentChatPage.tsx`、`DesktopUI.tsx`、`hooks/useVoiceCall.ts`、`org/CentralLumiChat.tsx` 等检查事件发射与监听重复。
- 报告中的高严重度条目，均由我对源码做了二次抽查核对（见附录 A）。所有文件路径以 `D:\lumiOS\` 为根，行号为基线 `35760c3` 的行号。
- 按大纲第 5 条"功能文件存在不等于产品正在启用"的要求，对每个被指为重复/僵尸的模块都核对了 import 与调用方，而不是仅凭文件名判断。

---

## 2. 架构现状：入口与主链路

### 2.1 入口清单

| 入口 | 事件 / 路由 | 会话 id 来源 | 历史写入 | 复用 chat 主链路？ | 并发锁 |
|---|---|---|---|---|---|
| 文字对话 | socket `agent:chat` / `agent:abort_chat` / `agent:execution_resume`（`chat.ts:753/701/665`） | 客户端 `conversationId`，否则 active 会话；agentId 固定 `lumi`（`chat.ts:848, 899-901`）；可能滚动新会话（`1759-1787`） | `addMessageIdempotent`，channel=`chat`（`1794`） | 本身即主链路 | 模块级 `chatExecutionQueue`，键 `uid:domain:org:source:conversationId`（`246, 967`）；**普通对话轮不申请会话租约**（`3371-3433`） |
| 任务 | socket `agent:task` / `agent:task_cancel`（`task.ts:279/218`） | 客户端 `conversationId`，否则 `getOrCreateActiveConversation(uid, '')`，**agentId 为空串**（`742`） | channel=`task`（`781-796`） | 否，独立 2400 行 | 另一个 `taskExecutionQueue`，键**不含会话**（`138, 190-192`） |
| 语音 | `audio:start/chunk/stop/interrupt/cancel_turn`（`voice.ts:5454-6460`） | **不接受客户端 conversationId**，永远 active 会话（`1833-1839`）；agentId 取客户端 `data.agentId`（`5527, 5543`） | channel=`voice`（`2016-2035`）；sidecar 用非幂等 `addMessage`（`1636-1671`） | 否，独立 6800 行 | 无共享队列；每 socket 一个 session |
| 消息接入（飞书/企微/微信） | `dispatchIncomingMessage → processWithPersonality`（`messaging_routes.ts:1235, 815, 2358`） | 个人微信固定 `lumi`，其余 `lumi:<平台>:<作用域>`（`465-473`）；**每次写入重新解析 active 会话**（`718-724`） | `persistBoundMessagingMessage` | 否 | `messageRouteQueues` 按路由键（`150, 815-825`） |
| REST | `POST /api/chat`、`/api/ai/chat`（`chat_routes.ts:663-664`） | 无会话，用客户端 `messages` | 不写 | 否；BYOK 分支直调 SDK 绕过工具与流水线（`422-466`） | 无 |
| MCP | `lumi_chat` / `lumi_route_task` / `lumi_speak`（`mcp/lumi_server.ts:197, 735, 610`） | 无会话 | 不写；只抽记忆 | 否 | 无 |
| 自治 | `autonomy/task_executor.ts` | 工具上下文带 conversationId 但不写对话（`819`） | 自有账本 | 否 | 只让位给语音（`foreground_activity.ts:47-53`） |
| 调度提醒 | `scheduler.ts:1145-1160` | 写入 `conversationId: ''` 的孤立行（`1149`） | 孤立 interaction | 否 | — |

### 2.2 `agent:chat` 主链路（简化）

```mermaid
flowchart TD
  A[agent:chat 收到] --> B[阶段0: 排队前 16 道关卡<br/>客户端桥/清理提议/runtimeWorkIntent/取消判定/幂等/<br/>resolveActiveTaskMessageRelation ×2/用户自报完成/<br/>resolveAcceptedTurnConfirmation(内部再算1次关系)]
  B -->|可截断 ×8| Z[直接回复]
  B --> C[SerialExecutionQueue.waitForTurn]
  C --> D[阶段1: 拿到执行权后 28 道关卡<br/>关系第3次/复述/重复确认/normalizeActionIntent/<br/>运行时取消直接执行工具/执行事实/记忆+RAG+KB检索/<br/>续接桥(把 followupIntent 写成文本)]
  D --> E[buildLumiExecutionPipeline<br/>内部: 关系可能第5次重算 → turnFlow → <br/>executionDecision(从 prompt 文本正则解析 followupIntent) → <br/>routeToolsForTurn(legacy) → shadowGuard → capabilitySelection → executionPlan → intentTrace]
  E --> F[chat.ts 3330-3352 重算工具策略与投影<br/>(voice/task/messaging 不重算)]
  F --> G{确定性直接执行?<br/>清理提议 / 待确认精确续执行 / 强制恢复调用}
  G -->|是| H[executeToolCall 直接执行] --> I
  G -->|否| I[processInput(结果只落库) → isModelConfigurationReadRequest(可整体替换 messages)]
  I --> J[runConversationTurn 或 runWithTools<br/>adapter 内部: 丢弃模型工具调用换成强制调用 / 重规划 prompt / 确定性补调用]
  J --> K[finalizeLumiResponse]
  K --> L[recoverBlockedExecutionOnce: 第二次 runWithTools]
  L --> M[落库: action_turns / action_tasks / receipts / interactions / 注册表终态]
```

一轮里意图相关的决策点合计 40 余处，其中 8 处在排队前可直接回复并 `return`，14 处在排队后可截断。这是"同一意图被多个路径处理"的直接结构基础。

---

## 3. 核心发现

严重度定义：**高** = 会导致错误执行、丢失副作用记录或用户指令被吞；**中** = 行为不一致、状态漂移、可复现的困惑；**低** = 冗余、死代码、维护负担。

### 3.1 同一意图被多个路径处理（意图与路由）

#### R1【高】"停止执行 / 拒绝 / 不同意"被两套取消规则分别判定，取消指令排到正在跑的任务后面

- 规则 A `isConfirmationCancellation`（`tools/pending_confirmation.ts:677-682`）匹配 `不要执行|停止执行|不同意|拒绝|cancel|deny|reject|stop|terminate` 与 `取消|停止|终止`。
- 规则 B `CANCEL_ONLY_RE`（`cognition/task_concurrency.ts:125-126`）只匹配 `(取消|停止|停下|别做了|不要做了|终止)(这个|那个|当前)?(任务|操作|工作)?`。"停止执行""拒绝""不同意"都匹配不上。
- 有请求正在执行时，唯一能立即取消的分支是 `chat.ts:1633` `if (previousSession && activeMessageRelation === 'cancel')`，它只看规则 B。于是"停止执行"会在 `chat.ts:1960` `waitForTurn` 排到正在执行的任务之后，等任务跑完才在 `2688` 按规则 A 处理，此时只能回复"没有待执行操作"。
- 同时 `chat.ts:1843 → action_turn_durability.ts:112-115` 已在排队前清掉了待确认记录：**确认被撤销了，但正在运行的执行没有停**。
- voice 另有第三套 `cancel_work` 正则（`voice_turn_state.ts:86-88`）。

#### R2【高】"确认"至少 7 套正则互不一致，"ok / 行 / 没问题 / 开始吧"让任务关系与待确认记录分叉

| 位置 | 名称 | 差异 |
|---|---|---|
| `pending_confirmation.ts:673` | `isExplicitConfirmationReply` | **不含** ok/okay/行/没问题/就这样/按这个做/开始吧 |
| `task_concurrency.ts:147` | `ACCEPT_ONLY_RE` | **包含**上述全部 + 批准/授权 |
| `task_concurrency.ts:155` | `ORDINARY_ACK_ONLY_RE` | 普通应答 |
| `turn_flow.ts:370` | `explicitContinuationConfirmation` | 含 嗯/行/ok |
| `execution_pipeline.ts:392` | `confirmsBoundGoal` | 含 继续 |
| `execution_decision.ts:231` | `isUnboundTerseContinuation` | 含 可以了/好了 |
| `voice_turn_state.ts:71, 182` | 语音专用 | — |
| `quick_commands.ts:1103` | "好的/ok"直接回 👍 | 仅 voice 旧路径 |

以"ok"为例（任务处于 `waiting_confirmation`）：待确认记录只在 `isExplicitConfirmationReply` 为真时加载（`action_turn_durability.ts:133-136`），所以 `pendingConfirmation` 为 null，`chat.ts:3863` 精确续执行不会走；但 `ACCEPT_ONLY_RE` 判为 `accept`，`chat.ts:3360` `bindsExistingAction` 为真，恢复旧任务进入模型工具循环；模型重新发起同一工具时 `requestToolConfirmation`（`3227-3302`）找不到可消费的确认，**新建一条确认让用户再确认一次**。

#### R3【高】续接桥里的 "- followupIntent: X" 文本变成第二套意图判定，推翻任务关系结论

- `chat.ts:2785 → action_continuation.ts:1469, 1552` 用 `classifyConversationActionFollowupIntent` 把结论以文本写进 prompt 桥接段。
- 下游两处**用正则从 prompt 文本里解析它**并据此改变工具授权：
  - `execution_decision.ts:524-525`：`/Recovered structured action state:[\s\S]{0,500}- followupIntent:\s*status\b/`，命中则 `baseToolPolicy = NO_TOOLS_POLICY`（`548-549`）。
  - `action_continuation.ts:610-617` `isRecoveredCurrentAppEditingContinuation` 解析 `followupIntent: execute`，命中则开放当前应用 UI 控制工具（`execution_decision.ts:408-424`）。
- 流水线的"真实"判定来自 `resolvedTaskRelation`（`task_concurrency.feedbackKind`），判定顺序与前者不同。结果：任务关系判为 execute 也可能被文本里的 status 关掉工具；判为 new_task 也可能被文本里的 execute 打开 UI 工具。
- 此外这段桥用的是 `[...historyItems, ...persistedConversationHistory]`（`2791`），`historyItems` 来自**客户端提交的** history，可被客户端影响。这正是 `review/20260924-task-flow.md` 第 1 条要求"历史提示不能独立授权工具操作"尚未完全落实的地方。

#### R4【高】"后台任务进度"被两种运行时状态判定拆开，可能导致工具全禁

- `task_concurrency.ts:200` 只在 `normalizedIntent.target === 'runtime_work'`（来源是一条很窄的正则 `normalized_action_intent.ts:591`）时当作运行时查询；其他位置全部用更宽的 `classifyRuntimeWorkIntent`（`chat.ts:940`、`execution_decision.ts:396, 526`、`tool_router.ts:909`、`action_contract.ts:1152`、`quick_commands.ts:649`）。
- 冲突链：一句被 `classifyRuntimeWorkIntent` 判为 status 但 `normalizeActionIntent` 没判成 runtime_work 时（如"后台任务进度怎么样"），无绑定任务分支下 `chat.ts:2254` 把 `acceptedFollowupIntent` 覆盖为 `none`；但流水线用的是**未被覆盖的** `taskRelationFollowupIntent`（`execution_pipeline.ts:361`）判为 status，在 `:464` 追加禁用 `'*'`；同时 `tool_router.ts:1300-1316` 已收窄到只剩 `runtime_work_status`。路由想用运行时工具、授权层禁用所有工具，本轮只能走无工具的 `runConversationTurn`（`4363`）。

#### R5【中】任务关系在一轮内被计算 4~5 次，输入各不相同

| 次序 | 位置 | 输入差异 |
|---|---|---|
| 1 | `chat.ts:1324` | 带 activeRequestId、控制目标、提议上下文 |
| 2 | `chat.ts:1619` | 排队末尾的请求 |
| 3 | `chat.ts:2059` | 排队后最新状态，但提议上下文仍是 `927` 排队前算的 |
| 4 | `action_turn_durability.ts:93` | **不带任何选项** |
| 5 | `execution_pipeline.ts:352-356` | 命中文件计划/媒体请求时用 `null` 状态重算 |

第 5 次的后果：流水线判 `actionFollowupIntent='none'`，而 `chat.ts:3360-3409` 仍按第 3 次结果走 `bindsExistingAction`（`forceResume`）。流水线在规划新文件计划，账本却在恢复旧任务。流水线在 `:357-360` 标记的 stale 结果 chat 也没有回读。这与大纲第 6.2 节"已接受的任务关系向下传递，不能各层重新判定并夺取执行权"的设计目标不符。

#### R6【中】客户端界面桥让"未绑定任务的短句继续"保护失效

- `chat.ts:557` `SHORT_CLIENT_CONTINUATION_RE` 包含 继续/好/开始，会生成 "## Internal client-surface continuation context" 并排在 `continuationContext` 最前（`2889`）。
- `execution_decision.ts:221-225` `primaryUserInstruction` 只剥离两种标题，`:231` 用 `$` 结尾正则匹配失败，`unboundTerseContinuation` 为 false，**工具照样开放**，与保护本意（`:653-655`）相反。
- "只取当前轮文本"的剥离函数有 5 份且只认同一个标题：`action_continuation.ts:561`、`current_app_execution.ts:42`、`task_target_anchor.ts:556`、`result_finalizer.ts:1286, 2216`。

#### R7【中】工具策略与投影在流水线和 chat.ts 各算一遍，条件不同

- 流水线：`execution_pipeline.ts:483-487, 517`，以 `trustedActionContinuation` 为条件。
- chat.ts `3330-3352` 重算：条件换成 `executionDecision.resumesPinnedTask === true`（`3343`），并**原地修改** `executionDecision.baseToolPolicy / toolPolicy / maxIterations`（`3337-3339`）。
- `executionRequested` 基于一份投影，`toolSessionActive`（`3353`）基于另一份。voice（`2413-2414`）、task（`1105-1106`）、messaging（`2631-2632`）都直接用流水线结果，**只有 chat 重算**。

#### R8【中】同一意图被确定性执行一次，又被模型轮或恢复轮再执行

- 确认续执行：`chat.ts:3883` 精确执行 → `3959-4039` `confirmedStepNeedsContinuation` 再开 `runAuthorizedTools`。
- 模型轮 + 守卫恢复：`4398 → 4563/4580`，恢复轮拿到相同工具策略、投影和强制调用；只有 `execution_guard_recovery.ts:302` 与 adapter 的按签名去重（`2133-2139, 2312-2317`，仅对强制/补发调用生效）防止重复副作用。
- 运行时强制调用：`adapter.ts:2294-2307` **先调用模型（消耗 token），再把模型的工具调用整体丢弃**换成运行时那条。
- chat 同一轮共有三层重试/重规划：运行时确定性恢复（`3488`）、adapter 内确定性恢复 + `GENERIC_TOOL_REPLAN_PROMPT`（`adapter.ts:2310-2331`）、轮次结束后守卫恢复（`4563`）。这与大纲第 20.9 条"一次用户请求只能共享一份有效等待预算，不能层层加倍"直接相关：`model_turn_state` 共享了时间预算，但没有共享"已经决定过什么"。

#### R9【中】其他重复判定器族

- "复述上一条回复" 4 份：`chat.ts:2147-2198`（先截断）、`exact_correction.ts:93-94`（chat `3134`、voice `3749`）、`action_continuation.ts:1486-1500`、`turn_flow.ts:366, 447`。两者取历史方式不同，可能复述出不同的"上一条"。
- "执行事实问题" chat 判两次（`2485` 带 taskId，`3125` 不带）；voice 顺序不同（`3733` 在"用户说已完成" `3770` 之前，chat 相反）。
- "纠正" 7 个判定器：`normalized_action_intent`、`tool_intent.ts:351`（chat 导入未用）、`task_concurrency.ts:161-164`、`task_capsule`、`action_continuation.ts:1057`、`exact_correction.ts:20`、`voice_turn_state.ts:35-49`。
- "微信发送"参数提取两套：`nl_chainer.ts:374` `buildForegroundWeChatSendArgs`（硬编码"晚安"文案 `363-365`）与 `foreground_messaging_execution.ts:28`，都在 voice 使用。
- 能力元问题快速回复三个入口各不相同：chat `buildOperationModeMetaResponse`（`3120`）、voice `buildCapabilityMetaResponse`（`2361`，含固定自我介绍）、messaging 仅 `isRetiredOperationModeRequest`（`3002`）。"你是谁"在 voice 得到固定文案、在 chat 由模型回答。

#### R10【低】`processInput` 已不执行任何动作，但结果落库，且 voice/task 保留永远走不到的直接执行分支

- `cognition/index.ts:82-93` 固定返回 `responseText: ''`、`directToolExecuted: false`（已核实）；`intent.ts:177-179` 也显式声明 `LEGACY_INTENT_CLASSIFIER_AUTHORITY = 'advisory'`、`legacyIntentCanOwnNaturalLanguageDecision(): false`——设计意图是清楚的，问题在于调用方没有跟着清理。
- 其正则分类结果被写进 `chat.ts:4848` `cognitiveIntent`，与 `normalizedIntent` / `taskRelation` 无任何对齐。
- `voice.ts:4599-4648`、`task.ts:1768-1840` 保留 "Path A 直接执行"终态提交代码，永不执行。

#### R11【低】`isModelConfigurationReadRequest` 整体替换 messages

- `chat.ts:4344-4347` 把 messages 替换成固定系统提示 + 用户原话，丢掉执行边界叠加（`3599`）、待确认提示（`2873`）、语言指令（`3815`）等，工具投影却仍是之前算好的。

### 3.2 任务执行上下文断裂（ID、账本、回执）

#### 3.2.1 结构清单

| # | 结构 | 位置 | 主键 / 关联 ID | 存储 | 生命周期 |
|---|---|---|---|---|---|
| 1 | 请求执行注册表 | `socket/chat_execution_registry.ts:134-135` | `scopeKey + requestId` | 内存；终态落 `chat_execution_terminal_receipts`（`db_layer.ts:759`，直接 SQL） | 终态 30 分钟，重启只恢复终态和取消中 |
| 2 | `SerialExecutionQueue` | chat `chat.ts:246`；task `task.ts:138` | chat 按会话，task 按用户 | 纯内存 | 进程级 |
| 3 | 动作回合 `conversation_action_turns` | `conversation/action_turn_ledger.ts` | `(conversationId, userId, requestId)`，行 id `action_turn_<sha>` | 内存快照 + 100ms 防抖整库落盘 | 租约 TTL 5 分钟 |
| 4 | 任务行 `conversation_action_tasks` | `conversation/action_ledger.ts:30-51` | `taskId`、`activeRequestId`、`rootUserMessageId` | 内存快照 | 终态单调 |
| 5 | `task.context.actionState` | `action_ledger.ts:539-556` | taskId；`receipts` 只留 40 条（`task_execution_ledger.ts:613`） | 任务行 JSON | — |
| 6 | 会话活指针 `actionContinuationState` | `manager.ts:1448-1453, 3691-3696` | taskId、activeRequestId | 内存快照 | 启动清空 pending |
| 7 | 回执明细 `conversation_action_receipts` | `action_ledger.ts:53-68, 1093-1154` | `id, taskId, turnId, requestId, idempotencyKey` | 只追加 | 去重 `taskId+idempotencyKey+toolName+outcome` |
| 8 | 助手消息 `toolCalls` | `interactions` 表 | requestId | 内存快照 | 超 20000 条裁剪 |
| 9 | 待确认动作 | 内存 `pendingById` + `pending_tool_confirmations` 表 | id、taskId、originRequestId | macOS 仅内存（`repo:535-539`） | 10 分钟过期 |
| 10 | 外部提交日志 `external_commit_journal` | `tools/registry.ts:1141-1330` | `executionIdempotencyKey` | SQLite 永久 | 无过期 |
| 11 | 桌面中继 | `socket/desktop_relay.ts:91-92` | `cid = ${source}_${uuid}` | 纯内存 | 30 分钟 |
| 12 | 语音回执收集器 | `socket/voice_execution_receipts.ts:7-76` | requestId | 纯内存 | 单请求 |
| 13 | 工作接管任务 | `work_takeover/tasks.ts:126`（存 settings JSON） | `wt_task_*` | 内存快照 | 最多 500 |
| 14 | 自治任务 `autonomous_tasks` | `autonomy/task_queue.ts:50-98` | 自带 leaseId | 内存快照 | 自有租约 |
| 15 | 指挥中心计划 | `command_center/plans.ts` | `lastRuntimeTaskId → #14` 单向 | 内存快照 | 不随终态回写 |
| 16 | 调度审计行 | `action_ledger.ts:1354-1663` | 伪会话 `scheduler:<id>`，`turnId=requestId=plan.taskId` | 放 #4/#7 | — |
| 17 | 模型路由回执 | `db_layer.ts:728` | requestId、executionSessionId | SQLite | — |

大纲第 6.2 节说"需要特别区分任务级、轮次级、动作级记录……不应随意全部合并，也不应让同一范围存在多个互相覆盖的完成判定者"。三级划分本身没问题；问题是三级之间的外键（T1）与同级内的副本（T6）。

#### 3.2.2 ID 关联图

```mermaid
graph LR
  REQ[requestId] -->|scopeKey+requestId| REG[#1 执行注册表]
  REQ -->|队列键| Q[#2 串行队列<br/>chat 按会话 / task 按用户]
  REQ -->|conv+user+requestId| TURN[#3 action_turns]
  TURN -->|taskId 只绑一次| TASK[#4 任务行]
  TURN -->|userMessageId / terminalMessageId| MSG[#8 interactions]
  TASK -->|activeRequestId 仅执行态| REQ
  TASK --> STATE[#5 actionState.receipts ≤40]
  PTR[#6 活指针] -. updatedAt 时间戳仲裁 .-> TASK
  CTX[ToolContext] --> REC[ToolExecutionRecord<br/>id=模型调用id 或 幂等键]
  REC -->|taskId, turnId?, requestId| RCPT[#7 回执明细]
  REC -->|sha name,args| RCPT
  CTX -->|sha user,taskId,actionIntent,name,args| JOUR[#10 外部提交日志]
  RCPT -. 两套幂等键无法 join .- JOUR
  PEND[#9 待确认] -->|taskId, originRequestId| TASK
  DR[#11 桌面中继 cid 随机] -. 与 requestId/taskId 无关联 .- REC
  WT[#13 wt_task_*] -. channel=task 时取最新活跃任务 .- REQ
  AUTO[#14 autonomous_tasks] -. 不写入 #4/#7 .- TASK
  PLAN[#15 plans] -->|单向| AUTO
  WF[workflow run] -. 从回执 result.runId 解析 .- RCPT
```

#### T1【高】`turnId` 一词多义，同一列混存 6 种 ID

| 写入方 | turnId 实际是 | 位置 |
|---|---|---|
| chat/task/voice ToolContext | requestId | `chat.ts:4434`、`task.ts:1560`、`voice.ts:3170` |
| 消息渠道 | 外部消息 id | `messaging_routes.ts:3026` |
| manager 回写回执 | 用户消息 id（record 自带则优先） | `manager.ts:3826, 3864` |
| 任务账本同步 | 用户消息 id | `action_ledger.ts:624` |
| 迟到回执归档 | requestId | `manager.ts:3615, 4111`、`voice.ts:5321` |
| 调度器 | 计划 id | `action_ledger.ts:1455, 1658` |
| 工作接管嵌套 | 父 turnId 或新 `wt_turn_<uuid>` | `work_takeover_tools.ts:1279` |
| 回合账本行 id | `action_turn_<sha>` | `action_turn_ledger.ts:228-234` |

影响：`conversation_action_receipts.turnId` 无法 join 到 `conversation_action_turns.id`；`execution_facts.ts:274, 400-403` 只能靠 `turnId || requestId` 猜测分组，同一回合回执可能被拆两组或不同回合被并一组。

#### T2【高】chat / task 的迟到回执直接丢失

- 取消时终态从 `collectRequestTerminalRecords()` 取一次快照（`chat.ts:5023`，失败路径 `5080`）。快照之后完成的工具记录仍 push 进 `requestToolRecords`（`818-823`），但此后无任何代码再持久化。chat.ts / task.ts 中不存在 `retainLateRecords` 或 `onToolRecord`。
- 对比 voice 有 `collector.retainLateRecords(...)`（`voice.ts:5312-5326`）。
- 影响：取消后才真正执行完的副作用（文件已写、消息已发），账本里没有记录。违反大纲第 6.2 节"不能取消后丢失已完成步骤"。

#### T3【高】桌面中继的迟到结果被静默丢弃，且中继与请求/任务无关联（已核实）

1. 宽限期到时 `pending.reject(...)`（`desktop_relay.ts:563-570`）→ `settled = true`（`589-594`），但 pending 条目仍在 Map 里。
2. 之后原生端返回结果，`handleDesktopRelayResult`（`304-345`）删除 pending、`completed = true`、`completedDesktopRelays.set(cid, { binding, at })`（**只存 binding，不存结果**，`330`），然后调用 `pending.resolve(data.output)` —— 而 resolve 开头 `if (settled) return;`（`578-580`），真实结果被丢弃。
3. 发给桌面端的 payload 只有 `{ correlationId, name, arguments }`（`525`），不带 requestId / taskId。

影响：回执永远是 `outcome_unknown`；已在桌面执行完成的动作不回填任务，不进回执账本。

#### T4【高】五本任务账互不相连，靠"取最新"启发式绑定

- 自治任务不写对话账本：`task_executor.ts:56` 只 import `sanitizeCapabilityExecutionPlan`，从不写 #4/#7。
- 运行时工作视图漏掉前台任务：`runtime/work_control.ts` 只聚合 `autonomy`（`250`）、`takeover`（`307`）、`workflow`（`371`）；`runtime_work_cancel` 看不到前台会话任务。
- 工作接管回写"取最新活跃任务"：`execution_writeback.ts:195-203` `listWorkTakeoverTasks({ status: 'active', limit: 1 })[0]`，用自己规则推断状态（`278-283, 310-315`），与 #4 回执裁决互不参照。
- 嵌套执行新造 `requestId = wt_request_<uuid>` 和伪会话 `work_takeover:<id>`（`work_takeover_tools.ts:1278-1290`），脱离父请求。
- 工作流运行只能从回执 `result.runId` 解析（`workflows/conversation_binding.ts:24-33`）。
- 指挥中心计划找不到任务时 `candidates[0]` 兜底（`plans.ts:296`）；计划不随任务终态更新。
- 另有三套任务存储并存：settings JSON（工作接管）、`autonomousTasks`、`conversationActionTasks`；`agents/workflows.ts` 与 `workflows/runtime.ts` 双写同一工作流（`agents/workflows.ts:128, 253, 263`）。

#### T5【高，有前提】外部提交幂等键两套公式，且可能跨回合误去重

- 外部提交日志：`sha(userId, taskId, actionIntent, name, args)`（`tools/registry.ts:248-257`）；回执：`sha(name, args)`（`execution_envelope.ts:17-28`）。只有自治链路设置 `context.idempotencyKey`（`task_executor.ts:851-863`），chat/task/voice 均未设置 → #10 与 #7 永远对不上。
- 对话型回合 `durableTaskId` 可能为空（`chat.ts:3472`），`actionIntent` 就是用户原文（`4458`）。同样原文 + 同样参数在以后任一轮再触发外部提交，会命中 `state === 'verified'` 的旧记录直接返回 "deduplicated"（`registry.ts:1250-1269`），实际没发送。日志表无过期（`db_layer.ts:818-829`）。
- **前提待核实**：无 taskId 的回合是否可能执行外部提交（取决于 action contract 是否一定生成 taskId）。

#### T6【中】同一份任务状态存 4 份，靠时间戳仲裁

- #4 行字段、#5 `context.actionState`、#6 活指针、#7 回执明细。
- `hydrateConversationActionState` 比较 `updatedAt` 决定活指针和账本谁权威（`manager.ts:198-217`）。
- 完成度判定 `taskCompletionFromReceipts` 只读被截断到 40 条的 #5（`manager.ts:1907`、`action_ledger.ts:1009`），#7 完整历史不参与；长任务早期验证证据会被挤出。
- 终态行拒绝覆盖时直接 `return task`（`action_ledger.ts:521-526`），活指针可能仍非终态，要等启动修复（`2115-2136`）。

#### T7【中】请求收尾依赖活指针而非回合绑定的 taskId

- `finalizeConversationActionRequestInDb` 只在活指针 `activeRequestId === 本请求` 时收尾任务（`manager.ts:1892-1906`）；`finalizePersistedAssistantActionTurnInDb` 无论如何都把回合标 terminal（`1358-1366`）。活指针被 detach（`3654`）或替换时出现"回合 terminal、任务仍 executing"。
- `persistence_unknown` 收尾要求回合 taskId 与活指针一致（`action_ledger.ts:707-713`），不一致时任务不隔离。缓解：release gate 检查 `taskLeaseSettled`（`manager.ts:2826-2851`）。

#### T8【中】一个请求三套状态机，"完成"含义不同

| 状态机 | "完成"含义 | 位置 |
|---|---|---|
| 执行注册表 | `finalized && !blocked`，回复已送达 | `chat_execution_registry.ts:439-453` |
| 动作回合 | `terminal`，不区分结果 | `action_turn_ledger.ts:301-313` |
| 任务 | 由回执裁决 | — |

保留期不同（30 分钟 vs 永久），持久化方式不同（直接 SQL vs 防抖快照），非严格路径 `persistTerminal` fire-and-forget（`316-322`）。这就是大纲第 20.3 条"执行完成 / 验收完成 / 回复完成是否混用"在代码里的落点。

#### T9【中】语音迟到回执：账本与对话记录各说各的

- 迟到回执写入 #7，但助手消息保留占位 `tool_settlement_unknown`（`voice_execution_receipts.ts:19-24`）；`execution_facts` 只读消息 `toolCalls`，用户问"刚才做了什么"看到失败/未知。
- 归档时因请求已不拥有任务，只审计不裁决（`action_ledger.ts:973-977`）；`archiveBound…` 跳过无 taskId 记录（`877-879`）。
- quarantine 会清空 `assistant.toolCalls = []`（`manager.ts:1248`），#7 仍保留。

#### T10【低~中】其他启发式关联

根消息按目标文本精确匹配优先于显式候选 id（`action_ledger.ts:409-415`）；历史任务按文本打分（`1746-1791`）；无归属回执视为属于当前任务并盖上 taskId（`receipt_ownership.ts:42-48`、`manager.ts:3823-3828`）；回执距用户消息超 30 分钟不再推进状态（`manager.ts:3796-3802`）；无 id 时按 `name+result+error` 去重（`chat.ts:4716-4728`）；`record.id` 含义不定（`execution_engine.ts:606`）；`interactionId` 是随机 UUID 却用于 token 记账与工作接管回合 id（`task.ts:1009`、`chat.ts:2976`）；信封状态靠正则匹配 error 文本（`execution_envelope.ts:136-145`）。

#### 3.2.3 生命周期缺口

1. **重启后遗留的 `accepted` 回合永不收尾**：启动只在找到助手消息或会话已关闭时收尾（`manager.ts:3203-3237`），其余释放回 `accepted`（`action_turn_ledger.ts:284-299`），随后被当作"竞争中活跃回合"阻止配对裁决（`action_ledger.ts:951-956`），状态查询视为执行中（`1888`）。
2. **注册表非终态记录重启即丢**：重连后 `agent:task_cancel` 得到 "Active task not found"（`task.ts:240-248`），持久账本对应回合仍 leased/accepted。
3. **桌面中继安全围栏重启即失效**（`desktop_relay.ts:420-424` 仅内存）。
4. **待确认静默过期**（10 分钟），任务保持 `waiting_confirmation` 到下一轮或重启（`action_ledger.ts:2207-2209`）；macOS 上确认仅内存。
5. **断连处理不一致**：语音 `stopVoiceCall`（`voice.ts:6804-6817`），前端重连重发 `audio:start` → 服务端 `commitActiveVoiceCancellation`（`5496-5497`），网络抖动即取消语音任务；chat/task 无 disconnect 处理；桌面中继 `cancelOnRequestSocketDisconnect` 默认 false。
6. **消息裁剪造成悬空引用**（`db_layer.ts:1671-1686`）→ 收敛时判 `persistence_unknown`（`manager.ts:2886-2914`）。
7. **两种持久化节奏混用**（直接 SQL vs 100ms 防抖快照）无顺序保证。`review/20260924-task-flow.md` 第 6 条已开始做增量持久化，但 #1/#9/#10 直接 SQL 与 #3/#4/#7 快照之间仍没有屏障。
8. **chat 与 task 执行上下文不同**：chat 作用域含 conversationId 且 `requireConversation: true`（`chat.ts:958-965`），task 不含（`task.ts:234-239`）；task 无 conversationId 时取最近活跃会话（`manager.ts:406-420`），早退路径再取一次可能拿到不同会话（`task.ts:430-436` vs `742`）；两者同时操作同一会话只能靠 `leased` 检查互斥（`manager.ts:1040-1045`），后到方直接被拒为 busy 而非排队；task 终态回执记在 conversationId 为空的作用域，删会话时不清理（`chat_execution_registry.ts:378-393`）。

### 3.3 多入口不共享上下文

#### E1【高】各入口独立队列，同一会话可并发执行；chat 普通轮不受会话租约约束

- chat 队列键含 source（`chat.ts:967`）；task 另一队列（`task.ts:138`）；voice 不进任何共享队列（`voice.ts:1895-1901`）；messaging `messageRouteQueues`（`messaging_routes.ts:150`）。
- chat 只在 `taskLedgerRequired || pendingConfirmation || structuredMediaRequest` 时调用 `prepareConversationActionExecution`（`3371-3376, 3433`），否则 `{ state: null, kind: 'conversation' }`；voice/task 几乎总申请租约（`voice.ts:2429`、`task.ts:1120`）。
- 后果：语音/微信任务执行期间，文字对话普通消息照样并发跑并交错写入同一 `lumi` 会话；反过来语音/微信撞上 chat 持有的租约时被直接拒绝："上一条任务仍在收尾…没有开始执行"（`voice_fast_path_messages.ts:224`），**用户指令被丢弃而不是排队**。

#### E2【高】任务入口 agentId 为空串，与 chat/voice 落到不同 active 会话

- task：`getOrCreateActiveConversation(uid, '', …)`（`task.ts:742`，已核实）；chat：`memoryAvatar?.id || 'lumi'`（`chat.ts:848`，已核实）；active 会话按 agentId 精确匹配（`manager.ts:414`）。
- task 早退写入固定回 `''` 会话（`task.ts:430-436`），本轮用户消息却写在 `convForHistory`（`739-743`）；状态查询同样取 `''` 会话（`563-565`）。
- 前端唯一发 `agent:task` 的 `ChatPanel.tsx:487` 没有任何地方挂载 → 这是前端已弃用、服务端仍暴露的旁路。大纲第 5 节仍把 `ChatPanel.tsx` 列在"对话与历史"分区，建议同步更新。

#### E3【高】个人微信与桌面共用 `lumi` 会话，但消息侧每次写入重新解析会话

- `messaging_routes.ts:466-467` 个人微信 agentId 固定 `lumi`；`persistBoundMessagingMessage` 每次 `getOrCreateActiveConversation`（`721`），终态回复同（`2657, 700-708`）。期间桌面 chat/voice 可能滚动（`manager.ts:717-744`）或用户 `POST /conversations/new`。
- 后果：微信用户消息与助手回复可能写进两条不同会话；执行流程在 `2379-2396` 取到的会话对象写入时不复用。

#### E4【高】MCP `lumi_chat` 广播的 `agent:*` 事件无 requestId/source/conversationId

- `lumi_server.ts:210, 251-256, 404-411`；房间 `user:${uid}:personal`。
- 桌面端 `acceptsForegroundEvent` 对无 requestId 事件直接放行（`DesktopUI.tsx:3498-3501`）→ MCP 设备对话会改写桌面前台工作流状态，与正在进行的 chat/voice 互相覆盖。MCP 轮次不读不写会话历史。

#### E5【中】作用域解析两种语义 + abort 第三种写法

- `resolveSocketScope` 成员失效退回 personal（`socket/scope.ts:57-71`），`resolveAuthorizedSocketScope` 返回 null（`19-25`）。chat/conversations 用后者，voice/focus/scene/device 用前者。`agent:abort_chat` 直接由 token 拼作用域（`chat.ts:712-713`），并用客户端 conversationId 拼 sessionKey（`714-734`），新会话第一条消息或刚滚动的会话中止时返回 "Execution controller is unavailable"（`736-737`）。

#### E6【中】voice 服务端接受任意 agentId，chat 强制 `lumi`

- `voice.ts:5527, 5543`；前端普通通话把 personality 当 agentId 传（`DesktopUI.tsx:2441`），唤醒词路径写死 `lumi`（`2625`）。`activePersonality` 目前恒为 `'lumi'`（`1502` 只有声明无 setter），一旦可切换语音就会写入另一条会话。

#### E7【中】指挥中心显示会话与语音写入会话可能不同

- voice 从不带 conversationId（`1833-1839`），一轮中途多次重新解析 active 会话写标题/话题（`4960-4969, 4987-4996, 4041, 4635`），消息本体却写在 `conversationTurn.conversation.id`（`2019`）。

#### E8【中】事件广播范围不一致

- chat/task 向整个用户房间广播（`chat.ts:1088, 1172`；`task.ts:325, 619`）；voice 只发给发起 socket（`voice.ts:1936, 2961`）。其他窗口/设备感知不到语音轮次。

#### E9【中】前台微信收发只有 voice 走确定性通道

- `foreground_messaging_execution.ts:106-110` 注释称 chat 和 voice 都经过此处，实际只有 `voice.ts:4400, 4494` 调用。同一句"给某人发微信"，语音走确定性工具 + 绑定校验，chat 走模型工具循环。

#### E10【中】主动建议上下文无作用域且只有 voice 消费

- `recentProactiveByUser` 按 userId 存（`proactive_triggers.ts:52-53`），无 domain 字段；事件只发 personal 房间（`58`）而工作模式 socket 只在 org 房间（`runtime/socket.ts:194-199`）；voice 在工作作用域也注入（`voice.ts:1977-1985`）；chat 不引用。个人剪贴板/窗口上下文可能进入工作模式语音 prompt——这触及大纲第 1 节"个人域 / 组织域不是两套可以任意混用上下文的账号空间"。

#### E11【中】REST 行业工作流绑定 `lumi` 会话 taskId 执行工具但不申请租约（`chat_routes.ts:385, 481-489`）；自治任务只让位给语音（`foreground_activity.ts:47-53`）。

#### E12【低】其他

- voice sidecar 是同一会话第二写入方，非幂等（`voice.ts:1636-1671`）。
- `chat:conversations` 不按 agentId 过滤（`conversations.ts:15-20`），任务 `''` 会话、群聊会话、分身会话混在一起。
- 调度器提醒写入 `conversationId: ''` 孤立行（`scheduler.ts:1149`）。
- 组织模式多入口：`CentralLumiChat` source `org-chat` 不带 conversationId（`746-757`）；指挥中心 source `command-center-chat`（`AgentChatPage.tsx:557`）；`DesignHub` 走无状态 `POST /api/chat`（`232-237`）。source 不同 → sessionKey 不同 → 同一会话不互相串行。
- 客户端 history 参与 chat 上下文（`chat.ts:2791, 775`），voice/task 只用服务端历史。

#### 前端事件监听

- `agent:response` 被 8 处监听（`AgentChatPage.tsx:2457, 3234`、`DesktopUI.tsx:3728`、`useVoiceCall.ts:1285`、`CentralLumiChat.tsx:646`、`useMemoryAvatarConversation.ts:119`、`ChatPanel.tsx:388`、`HolographicOverlay.tsx:65`），后两者是未挂载的死代码。过滤规则各异，`DesktopUI` 对无 requestId 事件一律放行、不同 requestId 的 `thinking` 会抢占前台（`3516-3518`）。
- 同一句语音转写前端派发两次 `isFinal`（`useVoiceCall.ts:729-739` 与 `1003-1023`），靠 1.5 秒小写文本去重兜底（`AgentChatPage.tsx:714-720`）—— 显示层重复，不重复提交后端。
- `chat:conversation_updated` 多方监听、重载条件各异：AgentChatPage 要求 `agentId === agentId`（`2399`）且对话进行中跳过（`2426`），因此任务入口写入永不显示；CentralLumiChat 写死 `domain=work`（`615, 631`）；messaging 发出的不带 requestId/originSocketId（`runtime/messaging.ts:76-80`）。
- 前端没有全局共享 conversationId：指挥中心 `attachmentConversationIdRef`（`AgentChatPage.tsx:3254`），voice hook 不持有，CentralLumiChat 自己维护（`616`）且发送时不传。
- **未发现**同一句语音同时以 `audio:*` 和 `agent:chat` 提交的路径。

### 3.4 Prompt 组装重叠与矛盾

`agent:chat` 每轮拼接 26 段（详细清单见附录 B）。主要矛盾：

#### P1【高】纯聊天轮次同时收到三种互相矛盾的工具指令（已核实）

- `turn_flow.ts:462-471`：chat/voice 属于交互通道，普通对话 `modelToolAccess` 也是 `'manifest'`。
- `execution_decision.ts:535-539` `allowToolUse = ... (flow.allowToolUseForTurn || flow.modelToolAccess === 'manifest' || runtimeWorkIntent !== 'none')` → true；该覆盖层 `chat.ts:3599` 总是插入，含 `tools=available` 与 "Call the actual read/open/review tool in this turn"（`636`）。
- `buildInteractionModeOverlay` 注入 `operation_modes.ts:31` "Use tools, browser control… as needed without per-tool permission chatter"。
- 同轮 turnFlow 覆盖层（`turn_flow.ts:140-145`，条件 `!flow.allowToolUseForTurn`）却写 "Tool access: chat-only… Do not force a task/tool path"。
- 实际工具并未下发（`toolSessionActive` 要求 `executionRequested`，`chat.ts:3353`），走无工具 `runConversationTurn`。模型被同时告知"有工具、现在调"和"没有工具"。
- voice 同类：`voice.ts:2702` "This turn is conversational. Do not call tools" 与 `2695` 追加的 "Use tools… as needed"，两段都叫 `## Interaction Mode`。

#### P2【高】确认边界：宪法与运行模式、运行时行为相反

- 要求先确认：`constitution.ts:45, 63`；`external_apps/adapters.ts:35` "Sending messages must stay user-confirmed."
- 说不必确认：`operation_modes.ts:31` "without per-tool permission chatter"；`:35` "Ordinary user-requested messages… can proceed without a separate tool popup"；`self_model.ts:2141` `externalAppAutomationGate=removed`。
- 运行时 `canAutoApproveAction`（`action_constitution.ts:255-277`）只拦高风险/社交内容提交/通用外部提交，其余自动放行 → 宪法文本与实际行为不一致。

#### P3【高】"谁来规划"三种说法同时进入工具轮

`tool_planning.ts:82` "You are the planner"；`capability_execution_plan.ts:610` "Semantic planning owns intent, decomposition, and capability selection"；`capability_selection.ts:733` "The model owns the final respond-versus-act decision… hints only"。

#### P4【高】两套任务账本同时进入 prompt，续接绑定规则冲突

工作接管续接覆盖层（`continuity.ts:322`）把"继续这个任务/下一步/做完了吗"绑到最新工作接管任务；会话动作账本经 `resolveActiveTaskMessageRelation` + TaskCapsuleV1（`execution_pipeline.ts:352-365`）绑同样短语；`capability_context.ts:148-154` 又声明这些候选"未绑定，不得转移属性"。

#### P5【中】重复与冲突（摘要）

- 身份定义 8 处：`engine.ts:21-27`、`constitution.ts:21-28`、`operating_kernel.ts:30-34`、`turn_dispatch.ts:67`、`turn_flow.ts:144`、`capability_context.ts:194`、`operation_modes.ts:29`、`self_model.ts:2003`。
- "没有可选模式"（5 处）与 `mode=assistant->assistant` 字段（3 处）同时出现；`buildModeOverlay` 再注入一种"风格模式"。
- 回合顺序说明 4 份不一致：`operating_kernel.ts:35-45`、`turn_flow.ts:174-186`、`capability_context.ts:207`、`turn_dispatch.ts:43-60`。
- 详略冲突：人格/情绪侧 detailed（`engine.ts:15, 221`；`state.ts:265`）vs `reply_style.ts:11`、`modes.ts:51`、`operating_kernel.ts:34` concise。
- voice 回复长度两套：`reply_style.ts:10` "under 20 Chinese characters" vs `voice.ts:1039` "2-6 Chinese characters"。
- 工具调用上限三种数字：人格 35（`registry.ts:100` 经 `engine.ts:395-397`）、adapter 硬上限 8/次 24/轮（`adapter.ts:175-176, 2020`）、核心模式 80（`operation_modes.ts:43`）。
- 视觉路由点名工具可能不在当轮声明（`vision_routing.ts:35-40` vs `execution_decision.ts:637`）。
- 法律入口 prompt 在 messaging 注入两次（`messaging_routes.ts:2604-2611` 与经 `execution_decision.ts:658-666` 的 `2859`）。
- 远程受限会话仍追加职业与联系人上下文（`chat.ts:2958, 2966` 不检查执行边界）；`REMOTE_RESTRICTED_PROMPT_OVERLAY` 重复一次（`remote_policy.ts:72` 与 `94-96`）。
- 语言指令两次（`engine.ts:335` 与 `chat.ts:3815`）。

#### P6【中】重复检索

- 同一轮查记忆库三次：`queryMemoriesVector`（`chat.ts:2599`）+ `retrieveChunks` 内部再调（`agents/rag.ts:300`），且对 conversationAgentId 和 `'lumi'` 各跑一次（`2622-2638`）。
- 时空上下文每轮 `queryMemories({limit:100})` 全量扫描只为统计地点（`time/spatiotemporal.ts:185`）。
- 历史以四种形式重复注入：持久化历史（`4313`）、会话摘要（`2848`）、话题（`2855`）、续接桥内嵌最近 4 条用户 + 3 条助手消息（`action_continuation.ts:1513-1520, 1563-1566`）、失败解释读 24 条（`3210`）。
- 附件不可信内容进入记忆/RAG/KB/联系人检索查询文本（`chat.ts:777` 拼接后在 `2601, 2626, 2645, 2969` 作为查询）。

#### P7【中】预算裁剪先丢关键执行上下文

`request_context_budget.ts`：默认 24k token；工具声明最多 min(9000, 38%)；system 按 `\n\n` 切块打分（TaskCapsule 10000、关键词 1000、首块 500、末块 400、有标题 40），≥400 受保护。

- 当轮事实证据块（`chat.ts:3216-3221`）、运行时能力上下文（`capability_context.ts:192-208`）、能力选择建议（`capability_selection.ts:713-735`）不含关键词，只得 0~40 分，**先被裁掉**；回复风格（"Never reveal…"）和宪法（含 "confirmation"）受保护。
- `chat.ts:3814` 注释要求语言指令放最后，但 `selfAwareness` 在 `4340` 又拼到末尾，拿走"末块 +400"保护。
- 人格 prompt 用 `'\n'` 拼接（`engine.ts:400`）整体成首块，超预算时 `compactSystemBlock` 只保留前 8 个关键词窗口（`164-186`），末尾的记忆、RAG、时空上下文先丢。
- 多条 system 时按"剩余÷剩余条数"分配（`562-567`），主 prompt 只拿到 1/2~1/3。
- 职业覆盖层与话题上下文追加无 `\n\n`（`2857, 2961`），并入前一块继承其分数。

#### P8 各入口 prompt 组装已分叉

| 入口 | 与 chat 差异 |
|---|---|
| voice（`voice.ts:2742` 单行拼装） | 记忆用关键词检索无人格偏置（`2190`）；不传情绪（`2352-2359`）；有工具时 `mode:'task'`（`2348`）；无职业/联系人/事实证据/第二次语言指令/selfAwareness；有预模型确定性快路径（`2361-2394, 4262-4287`），chat 明确不做（`chat.ts:4269`） |
| task（`task.ts:1301-1364`） | 无 RAG 与知识库；人格 prompt 不传 userText（`1036-1043`）；无 `buildInteractionModeOverlay`；续接桥放 user 消息（`1008, 1369`），chat 放 system |
| messaging（`messaging_routes.ts:2557-2886`） | 执行计划构建两次（`2511` 临时 + `2613` 正式）；法律入口重复；运行内核 channel 固定 `'chat'`（`2875`） |

### 3.5 legacy / 僵尸代码仍在主链路

| # | 证据 | 位置 |
|---|---|---|
| L1 | legacy 路由仍是主路由：`const legacyExecution = buildLumiExecutionDecision(...)` 直接成为 execution | `execution_pipeline.ts:432, 450-466`；`routing_shadow_guard.ts:62` |
| L2 | prompt 同时声明 "Do not retry through a legacy… path" / "Never fall back to a legacy route" | `routing_shadow_guard.ts:161`；`capability_execution_plan.ts:615` |
| L3 | `processInput` 每轮执行旧正则分类，仅用于日志和 `cognitiveIntent`；`intent.ts:177` 已自我标注 advisory | `chat.ts:4285, 4288, 4848` |
| L4 | `LEGACY_DIRECT_EXECUTION_ENABLED = false` 死开关，导致 `matchQuickCommand` 永不执行 | `legacy_route_policy.ts:6`；`voice.ts:2143` |
| L5 | `keyboard_press` 以 legacy 能力注册为 safe，与 `desktop_keyboard_press` 并存 | `input_tools.ts:376-392, 184` |
| L6 | voice 技能工作流分支不可达（voice `workflowRouting='model_hint'`） | `turn_flow.ts:479-484`；`voice.ts:4084-4088` |
| L7 | `runNLChainer` / `shouldChainTask` 无调用方 | `nl_chainer.ts:670, 870` |
| L8 | `shouldRunVisibleActionPreflight` 恒 false 无调用方 | `chat.ts:624-631` |
| L9 | 未使用导入 `isPriorTurnToolReceiptQuestion`、`isUserCorrectionOrExplanationQuestion`（已核实） | `chat.ts:172, 181` |
| L10 | `routingText`、`turnSurface` 算出未用；`if (!responseText)` 恒真 | `chat.ts:2882, 2936, 4256/4305` |
| L11 | `cognition/fallback.ts` `generateFallback/isLLMDown` 无使用方；`handleLLMFailure` 忽略传入 intent | `cognition/index.ts:19, 101-115` |
| L12 | 旧模式值仍贯穿主链路并写进 3 段 prompt（大纲第 18 节已确认 `operation_modes` 为兼容代码） | `operation_modes.ts:47-51`；`chat.ts:2803-2809`；`turn_flow.ts:424-426` |
| L13 | `LEGACY_ADAPTER_IDS` 旧适配器投影 + 写死回退清单 | `external_apps/adapters.ts:14-19, 21+, 58-62` |
| L14 | `ChatPanel.tsx`、`HolographicOverlay.tsx` 未挂载但监听 `agent:response` 并可发 `agent:task` | `src/components/ChatPanel.tsx:388, 487` |
| L15 | i18n 双轨：`server/i18n/*` 与 `regions/packs/cn/*_messages.ts`；`CN_TASK_EXECUTION_MESSAGES` 定义在 `voice_fast_path_messages.ts:191` 却被 chat/task/messaging 使用；核心路由直接 import CN 包绕过区域抽象（大纲第 20.6 条所指） | `tool_router.ts:1`；`execution_pipeline.ts:2` |

规模：server 下 "legacy / deprecated / compat / retired / one-release" 共 215 处，分布在 102 个文件。

**按大纲标注为实验、不计入缺陷的项**：Laya shadow（`execution_pipeline.ts:559-566` `observeLayaDecision` 单向观察，注释明确不能改变计划/权限/回执；与 `docs/local-laya-shadow.md` 一致）；`capability_rollout.ts` 的 `LUMI_CAPABILITY_ROLLOUT_STAGE` 分级放行（默认 `external_commit` 即全开，仅 `capability_execution_plan.ts:566` 使用）。两者都是旁路，本报告未将其列为冲突源。

---

## 4. 各入口对照总表

| 维度 | chat | voice | task | messaging | REST | MCP |
|---|---|---|---|---|---|---|
| `buildLumiExecutionPipeline` | 是，传 taskRelation + 持久化历史 | 是，不传 taskRelation（内部重算） | 是，不传 | 是，**构建两次** | 是；BYOK 分支绕过 | 否 |
| 任务关系来源 | `resolveActiveTaskMessageRelation` ×4 + 流水线 | 流水线 + `classifyActiveVoiceWorkInput` | 旧版 `classifyActiveTaskMessage`（`566`） | `classifyConversationActionFollowupIntent` | 无 | 无 |
| `resolveAcceptedTurnConfirmation` | 是 | 是 | 是 | 是 | 否 | 否 |
| 待确认精确续执行 | 确定性 | 确定性 | 确定性 | **无**（靠模型重发） | 无 | 无 |
| 复述/重复确认/清理复查/清理提议 | 全有 | 无专门分支 | 无 | 无 | 无 | 无 |
| 执行事实/精确纠正 | 有，在"自报完成"后 | 有，在"自报完成"**前** | 无 | 无 | 无 | 无 |
| 快捷/确定性命令 | **无** | 6 个构造器 + 死开关 quick_commands | 无 | onMessage 回调 + 法律/组织命令 + 会议 client_action | 无 | 无 |
| 前台微信确定性 | **不调用** | 调用 | 无 | 无 | 无 | 无 |
| `processInput` | 仅记录 | 有不可达直接执行 | 有不可达直接执行 | 不调用 | 不调用 | 不调用 |
| 无工具模型调用 | `runConversationTurn` | `runConversationTurn` | `runWithTools` | `makeLLMCall` 直调 | SDK 直调 | `runWithTools` |
| 守卫恢复 | 有 | 有 | 有 | refinalize | 有 | — |
| 策略与投影 | **chat 内重算** | 用流水线 | 用流水线 | 用流水线 | 用流水线 | — |
| 会话租约 | 仅任务型轮 | 几乎总是 | 总是 | 绑定用户时 | 无 | 无 |
| 写对话历史 | 是 | 是 | 是（`''` agentId） | 是（每次重解析会话） | 否 | 否 |

---

## 5. 根因分析

**根因一：没有"一次判定、结构化结果、全链路只读"的意图解析层。** 每个需要知道"用户这句话是什么"的地方都自己写一条正则或调用一个分类器，于是判定器随功能增长（确认 7 套、取消 5 套、纠正 7 套），每个的覆盖面稍有不同，同一句话在不同位置得到不同答案。R3 是这个根因的极端形式——判定结果被序列化进 prompt 再被正则解析回来。值得注意的是 `execution_pipeline.ts:545` 已经产出一个结构化的 `intentTrace`（`intent_trace.ts`，含 `normalizedActionIntent`、`toolGate`、`matched.*`、`matchedRules`、`blockedBy`），但它目前只是诊断记录，没有任何调用方把它当作决策输入。

**根因二：入口是复制出来的，不是组合出来的。** voice / task / messaging 最初都是从 chat 复制一份再改，之后各自演化。`foreground_messaging_execution.ts:106-110` 那条"chat 和 voice 都经过这里"的注释与实际不符，正是复制后分叉的典型痕迹。每个入口独立的串行队列（E1）和独立的 agentId 约定（E2、E6）是同一根因。

**根因三：ID 语义没有被定义为契约。** `turnId`、`interactionId`、`record.id`、`correlationId` 的含义取决于写入方，`ToolContext` 没有强类型区分"请求 id / 回合 id / 任务 id / 工具调用 id"。账本之间因此只能靠文本匹配、时间戳、"取最新"关联。`technical_architecture.ts` 的五条不变量里没有一条关于执行上下文 ID，建议补上。

**根因四：新能力通过"再加一段 prompt / 再加一个 gate"接入，旧的不删。** 215 处 legacy 标记、`legacyExecution` 仍为主路由、8 处身份定义、26 段 system prompt，都是这个模式的产物。prompt 预算裁剪机制（P7）在这种增长方式下反而会优先牺牲最有价值的执行上下文。

---

## 6. 修复建议与路线图

### 阶段 0（立即，1~2 天）：止血，不改架构

1. **修 T3**：`desktop_relay.ts` 在 `handleDesktopRelayResult` 中即使 `settled`，也把 `data.output / data.error` 写入 `completedDesktopRelays` 并触发一次迟到回执归档（复用 voice 的 `retainLateRecords` 路径），payload 补 `requestId / taskId`。
2. **修 T2**：chat.ts / task.ts 在 `requestToolRecords` 上挂 `onToolRecord`，快照之后到达的记录调用同一归档函数。
3. **修 R1**：让 `chat.ts:1633` 的立即取消分支同时接受 `isConfirmationCancellation`；或更简单地把规则 A 的词表并入 `CANCEL_ONLY_RE`。
4. **修 P1**：`execution_decision.ts:535` 去掉 `modelToolAccess === 'manifest'` 对 `allowToolUse` 的贡献，或让 turnFlow "chat-only" 覆盖层与 `allowToolUse` 用同一布尔；`buildInteractionModeOverlay` 仅在 `toolSessionActive` 时插入。
5. **修 E4**：MCP 广播补 `requestId`、`source: 'mcp'`；`DesktopUI.acceptsForegroundEvent` 对无 requestId 事件改为拒绝。
6. 删除 L7、L8、L9、L10、L14 等确认无引用的死代码；`processInput` 从 chat/voice/task 移除（`cognitiveIntent` 字段改写 `normalizedIntent.kind`）。

### 阶段 1（2~4 周）：单一意图解析层

7. 以 `intent_trace.ts` 的 `LumiIntentTrace` 为基础扩展为 `TurnIntentResolution`，一次性产出结构化结果：`{ relation, followupIntent, cancellation, confirmation, correction, restatement, runtimeWork, statusQuery, ... }`，每个字段有且只有一个来源。把 R1、R2、R4、R9 列出的所有正则合并进去，删除原位置的实现，全链路（chat / voice / task / messaging / execution_pipeline / execution_decision / tool_router / action_turn_durability）只读这个对象。
8. **禁止把意图写进 prompt 再解析回来**：`execution_decision.ts:524-525` 与 `action_continuation.ts:610-617` 改为读 `TurnIntentResolution.followupIntent`；续接桥文本只保留给模型看的说明。
9. `resolveActiveTaskMessageRelation` 在一轮只算一次（排队后、拿到最新任务状态时），排队前阶段只允许读"是否取消 / 是否幂等重放"两个字段。
10. 删除 chat.ts `3330-3352` 的策略/投影重算，与其他入口一致使用流水线结果；如需边界过滤，放进 `buildLumiExecutionPipeline` 内部。

### 阶段 2（4~8 周）：统一执行上下文与 ID 契约

11. 定义 `ExecutionContext` 强类型：`requestId`（根 id，客户端可选提供、服务端保证唯一）、`turnRowId`（`action_turn_<sha>`）、`taskId`、`toolCallId`、`conversationId`、`executionSessionId`。`ToolContext.turnId` 收敛为唯一含义（建议 = requestId），messaging 的 `msg.messageId`、调度器的 `plan.taskId` 分别用 `externalMessageId`、`scheduleId` 字段承载。为 `conversation_action_receipts.turnId` 做一次迁移脚本按写入方回填。把这条 ID 契约加入 `technical_architecture.ts` 的 `invariants`。
12. 统一幂等键：`executionIdempotencyKey` 由 `ExecutionContext` 统一生成并同时写入 #7 与 #10，chat/task/voice 补设 `context.idempotencyKey`；外部提交日志加 `taskId IS NULL` 时的过期窗口，避免 T5 跨回合误去重。
13. 收敛"任务状态四份副本"：以 #4 任务行为唯一权威，#5 `actionState` 改为派生视图，#6 活指针只存 `taskId` 不再复制状态；完成度判定读 #7 全量而非截断的 40 条。
14. 迟到回执统一入口 `archiveLateReceipt(ctx, record)`：写 #7、更新 #4 状态、回填助手消息 `toolCalls` 占位（解决 T9），chat/task/voice/desktop_relay 都调它。
15. 五本任务账的关系显式化：自治任务与工作接管任务创建时在 #4 建一条 `kind: 'autonomy' | 'takeover'` 的影子行（或反过来让 `work_control` 聚合 #4），删除 `execution_writeback.ts:195` 的"取最新活跃任务"与 `plans.ts:296` 的 `candidates[0]` 兜底。
16. 启动修复：把重启后遗留的 `accepted` 回合收敛为 `persistence_unknown`；待确认过期时同步把任务从 `waiting_confirmation` 改为 `blocked`。

### 阶段 3（8~12 周）：入口收敛

17. 抽出 `runLumiTurn(entry: EntryDescriptor, ctx: ExecutionContext, input)` 作为唯一 turn 执行函数（以 chat.ts 为基础拆分为 pre-queue / resolve / assemble / execute / finalize 五个模块，每个 ≤ 500 行）。voice、task、messaging、REST、MCP 逐个改为构造 `EntryDescriptor` 后调用它；入口特有逻辑（语音 STT/TTS、消息平台绑定校验）留在入口层。这与大纲第 2 节"不能另起一套语音任务执行器"一致——不是新建，而是把已有的 5 套合成 1 套。
18. 统一会话定位：所有入口通过 `resolveConversationForEntry(uid, scope, entry, clientConversationId?)` 获取会话，task 的 `''` agentId、voice 的"永远 active"、messaging 的"每次重解析"都并入这一个函数；`SerialExecutionQueue` 改为按 `uid:domain:orgId:conversationId` 分队（去掉 source），跨入口串行。
19. 会话租约与队列合并：普通对话轮也进入同一队列（可以不申请任务租约，但必须串行），撞锁时排队而不是回复"没有开始执行"。
20. 删除 `agent:task` 事件与 `socket/task.ts`（前端已无挂载方），或改为 `agent:chat` 的一个 `mode` 参数。

### 阶段 4（持续）：prompt 与 legacy 治理

21. 建立 prompt 段清单（附录 B 为起点），每段声明 owner、插入条件、与哪些段互斥；身份、回合顺序、确认边界各只允许一处定义。宪法与 `operation_modes.ts` 的确认边界以 `canAutoApproveAction` 的实际行为为准统一措辞。
22. 预算裁剪改为按段的显式优先级（`priority` 字段）而非关键词打分；执行证据、任务状态、待确认段固定为最高优先级。
23. 收集 `routing_shadow_guard` 两周的 legacy vs normalized 比对数据，选定一条为主路由，删除另一条及影子闸门。
24. i18n 收敛为一套（建议保留 `regions/packs`，`server/i18n` 内容迁入），核心 cognition 模块不得直接 import 区域包。

### 验收指标建议

- 每轮 `agent:chat` 中意图判定函数调用次数 ≤ 3（当前 40+）。
- `conversation_action_receipts.turnId` 100% 可 join 到 `conversation_action_turns`。
- 桌面中继 / 取消后迟到回执在账本中的 `outcome_unknown` 占比接近 0。
- 任一入口发出的确认/取消短句，在其他入口得到相同判定（以 R1/R2 表格中的短句集做回归用例，加入 `test/turn_continuation_authority.test.ts` 或新建 `intent_resolution_parity.test.ts`）。
- 纯对话轮次 system prompt 中不再同时出现 "chat-only" 与 "tools=available"。
- server 下 legacy 标记数从 215 降至 < 50。

---

## 7. 与大纲、架构不变量及既有审查记录的对照

### 7.1 对大纲第 20 节"优先审阅的复杂点"的逐条回应

| 大纲条目 | 本报告结论 | 对应发现 |
|---|---|---|
| 20.1 传输层是否仍承担重复决策 | **是**。chat 单轮 40+ 决策点，其中 22 处可截断；voice/task/messaging 各有自己的前置快速通道和后置直接执行 | R5、R7、R8、第 4 节对照表 |
| 20.2 决策信息是否只有一个有效来源 | **否**。`task_concurrency` 的关系被 `turn_flow`（文本正则）、`execution_pipeline`（第 5 次重算）、chat 自身（覆盖 `acceptedFollowupIntent`）多次改写 | R3、R4、R5 |
| 20.3 执行完成 / 验收完成 / 回复完成是否混用 | **混用**。三套状态机对"完成"定义不同，且回合可 terminal 而任务仍 executing | T7、T8 |
| 20.4 前端大壳生命周期 | 部分覆盖：`agent:response` 8 处监听、`chat:conversation_updated` 重载条件不一致、无全局 conversationId | 3.3 前端事件监听 |
| 20.5 原生壳边界 | 未覆盖（本次范围为 server/src；`src-tauri` 未审计） | — |
| 20.6 业务入口与区域实现是否重复 | 核心 cognition 直接 import CN 包绕过区域抽象；i18n 双轨 | L15 |
| 20.7 长期记忆是否受污染 | 部分覆盖：附件不可信内容进入记忆/RAG 检索查询文本 | P6 |
| 20.8 资料显示是否跨权限边界 | 未覆盖 | — |
| 20.9 模型调用预算与多次恢复 | 时间预算已共享（`model_turn_state`），但"已决定过什么"未共享，导致三层重试；adapter 先调模型再丢弃其工具调用 | R8 |
| 20.10 产品文案是否夸大 | README "共享统一的执行入口"、"文字对话与语音状态共享同一会话上下文" 与代码不符 | E1、E2、E7、第 4 节 |

### 7.2 对 `shared/technical_architecture.ts` 五条不变量的检验

| 不变量 | 状态 |
|---|---|
| CapabilityManifest 是工具身份/路由/权限的唯一运行时来源 | 大体成立，但 `external_apps/adapters.ts` 保留写死回退清单（L13），`vision_routing` 点名工具可能不在当轮声明（P5） |
| Windows/macOS 相同能力 ID | 未在本次范围内验证 |
| client_surfaces 是客户端界面唯一注册表 | 未验证 |
| **任务完成只由 TaskLedger 执行证据与验证推导** | **部分失效**：证据到达但账本不收（T2、T3）；完成度只看截断的 40 条（T6）；`execution_facts` 读消息而非账本（T9） |
| 用户数据在专用目录 | 未验证 |

建议新增第六条不变量："每个执行请求有且只有一个 requestId 作为根 ID；turnId / taskId / toolCallId 各自只有一种含义并可回溯到该 requestId。"

### 7.3 与 `review/20260924-task-flow.md` 的关系

该审查记录的 6 条修复方向与本报告是同一问题域的上下游：它修的是"已复现的分歧和延迟"，本报告列的是"结构上仍会再次产生分歧的地方"。具体对应：

- 其第 1 条"服务端接受的任务关系向后传递；历史提示不能独立授权工具操作" → 本报告 R3、R5、R6 显示仍有三处从 prompt 文本/客户端 history 反向推导授权。
- 其第 2 条"文字与语音消费相同的接续判断" → 第 4 节对照表显示 voice 仍有自己的 `classifyActiveVoiceWorkInput` 与 6 个确定性构造器。
- 其第 5 条"一次请求共享模型等待预算" → R8：预算共享了，决策没共享。
- 其第 6 条"增量持久化" → 3.2.3 第 7 条：直接 SQL 与快照之间仍无顺序屏障。
- 其"尚未覆盖"明确说没有做语音实机和全部入口验收 → 本报告 E 系列正是这些入口之间的差异。

该记录报告 6507 项测试全部通过。这与本报告的发现不矛盾：现有测试主要在单一入口内验证单一路径，跨入口一致性（同一句话在 chat/voice/messaging 得到同样判定）和迟到回执归档没有对应用例，建议按第 6 节验收指标补充。

---

## 附录 A：本次二次核实记录

| 条目 | 核实方式 | 结果 |
|---|---|---|
| 基线 | `git rev-parse HEAD`；`git diff --ignore-cr-at-eol --ignore-all-space -- server/socket/chat.ts server/cognition` | HEAD = `35760c3`；实质 diff 为 0 行 |
| R1 | 读取 `pending_confirmation.ts:673-682`、`task_concurrency.ts:125-126`、`chat.ts:1631-1641` | 两套正则词表确实不同；1633 只看 `activeMessageRelation === 'cancel'` |
| R3 | 读取 `execution_decision.ts:522-551` | `statusOnlyContinuation` 确为对 `routeText` 的正则匹配并导致 `NO_TOOLS_POLICY` |
| R7 | 读取 `chat.ts:3324-3354` | 确认原地修改 `executionDecision.baseToolPolicy/toolPolicy/maxIterations` 并重算投影 |
| R10 | 读取 `cognition/index.ts:64-94`、Grep `intent.ts:177-179` | `processInput` 固定返回空回复；`LEGACY_INTENT_CLASSIFIER_AUTHORITY = 'advisory'` |
| T3 | 读取 `desktop_relay.ts:304-345, 558-603` | `reject` 置 `settled=true`；迟到 `handleDesktopRelayResult` 仅存 binding，`resolve` 被 `if (settled) return` 吞掉 |
| E2 | Grep `task.ts` / `chat.ts` | `task.ts:564, 742` 用 `''`；`chat.ts:848` 用 `'lumi'` |
| P1 | 读取 `turn_flow.ts:139-150`、`operation_modes.ts:26-38` | "Tool access: chat-only" 与 "Use tools… without per-tool permission chatter" 同时存在 |
| L9 | Grep `chat.ts` | 两个符号仅出现在 import 行 |
| 实验项 | 读取 `capability_rollout.ts` 全文、`execution_pipeline.ts:540-581` | rollout 默认全开；Laya 观察单向、不影响决策 |

**未核实 / 有前提的条目**：T5 的误去重依赖"无 taskId 回合能执行外部提交"，需确认 action contract 行为；R2/R4 的具体触发依赖 `classifyConversationActionFollowupIntent` 与 `normalizeActionIntent` 对特定句子的判定，建议用真实语料回放验证；`src-tauri`（大纲 20.5）与资料权限边界（20.8）不在本次范围内。

## 附录 B：`agent:chat` system prompt 组装顺序（26 段）

| # | 片段 | 构建 | 插入（chat.ts） | 约大小 | 条件 |
|---|---|---|---|---|---|
| 1 | 人格 prompt（身份、锚点、宪法、成长、预设、边界、向量语气、语言指令①、情绪、记忆、RAG、感知、时空、桌面上下文） | `personality/engine.ts:237-401` | `2826-2846` | 5–10KB + 记忆/RAG | 远程受限整段替换 |
| 2 | 会话摘要 | `manager.ts:4573` | `2847-2852` | 可变 | 有会话 |
| 3 | 话题上下文（无 `\n\n`） | `manager.ts:4668` | `2854-2859` | 0.3KB | 有会话 |
| 4 | 会话风格覆盖层 | `engine.ts:436` | `2862-2867` | 0.2KB | 有 conversationMode |
| 5 | 回复风格 | `reply_style.ts:8-24` | `2868` | 1.3KB | 总是 |
| 6 | 附件规则 | 内联 | `2870` | 0.6KB | 非远程受限 |
| 7 | 待确认 prompt | `1852` | `2872` | 可变 | 有待确认 |
| 8 | 客户端界面续接桥 | `chat.ts:610-622` | `2875` | 0.6KB | 客户端界面请求 |
| 9 | 动作续接桥 + 任务关系 + TaskCapsuleV1 | `action_continuation.ts:1548+` | `2785-2802, 2878` | 1–4KB | 引用/续接型 |
| 10 | 统一分发覆盖层 | `turn_dispatch.ts:63-74` | `2938` | 0.7KB | 非远程受限 |
| 11 | 轮次流程覆盖层（含工作接管续接） | `turn_flow.ts:139-195, 551-563` | `2939` | 2–5KB | 非远程受限 |
| 12 | 运行时能力上下文 | `capability_context.ts:172-209` | `2941-2950` | 2–4KB | executionRequested |
| 13 | 公司知识库 | `org/kb.ts:528` | `2953-2955` | 3 片段 | work 域 |
| 14 | 职业覆盖层（无 `\n\n`，不检查边界） | `professions.ts:112-129` | `2958-2963` | 0.4KB | personal |
| 15 | 联系人上下文（不检查边界） | `contacts/context.ts:5-17` | `2966-2974` | 可变 | personal 且提到联系人 |
| 16 | 当轮事实证据 | `chat.ts:518-555, 3200-3214` | `3215-3222` | 可变 | 状态/失败询问 |
| 17 | 客户端自我模型 | `self_model.ts:2043` | `3551-3553` | 1.5KB / 很大 | 需执行 prompt 或概念问题 |
| 18 | 交互模式覆盖层 | `turn_flow.ts:567-589` | `3593-3595` | 2.4KB | 非远程受限（不看工具） |
| 19 | 工作界面路由 | `work_surface.ts` | `3596-3598` | 可变 | 需执行 |
| 20 | 执行决策覆盖层 | `execution_decision.ts:633-670` | `3599-3602` | 1–4KB | **总是** |
| 21 | 能力选择 + 执行计划 | `capability_selection.ts:713-735`；`capability_execution_plan.ts:600-617` | `3603-3605` | 2–4KB | 需执行 |
| 22 | 桌面执行稳定性 | `desktop_execution_stability.ts:134-165` | `3606-3608` | 3.5KB | 桌面执行 |
| 23 | 视觉路由 | `vision_routing.ts:25-43` | `3609-3615` | 1.3KB | 视觉意图 |
| 24 | 运行内核 | `operating_kernel.ts:25-47` | `3616-3621` | 2.7KB | 需执行 |
| 25 | 语言指令② | `utils/language.ts:61-70` | `3815` | 0.5KB | 总是 |
| 26 | 模型自我认知（拼到末尾） | `vision_routing.ts:45-74` | `4338-4340` | 0.3–1KB | 正常路径 |
| — | 持久化历史 ≤6000 token | `getMessagesByTokenBudget` | `4313-4341` | — | — |
| — | 工具循环追加：安全策略 + 规划 prompt + 文件引用/产物进度 | `adapter.ts:2010-2041, 2151-2156` | 工具循环 | ~1KB | 工具会话 |
| — | 每候选模型一段执行说明 | `llm/dispatch.ts:63-80` | 调度 | 0.5KB/候选 | — |
