# LumiCore 全仓分区审计与精简路线

日期：2026-09-29。范围：`D:/lumiOS` 当前工作区；版本 3.1.0；HEAD `35760c39764b7aae724184583b7f663bdc6670ec`。**审计包含尚未提交的清理和修复，不能仅检出 HEAD 重现本报告。**

## 结论

目前最值得精简的不是文件数量，而是仍在运行的重复决策和重复恢复。公共执行流程已经存在，但渠道入口仍保留各自的重判、工具策略加工、恢复预算和对话记忆流程。继续只删未使用变量，能减行数，却不能解决这部分行为差异。

本轮完成全仓结构扫描、按产品功能分区的关键链路核对，以及三个隔离探针。**没有修改业务代码，没有删除现用功能，没有重启、提交或推送。** 本报告用于决定后续删哪里、合并哪里、保留哪里。

- 业务源码、样式与脚本：**1,086 个文件 / 371,039 行**；测试：158,516 行；合计 529,555 行。含空白和注释，不含依赖、构建物、模型和用户数据。
- 第一方 JS/TS 依赖扫描：**1063 个文件、77 个路径分区**，附表逐区列出；另审阅 Rust 原生边界、Python/PowerShell 辅助入口和 CI/打包配置。
- 依赖图发现 **2 组环**：13 个文件的大环，以及 provider/dispatch 的动态导入环。已经剔除编译后消失的纯类型引用；环包含动态 import，**不等于已复现启动死锁**。
- 优先事项是 A01–A05；A06–A12 是结构、容量、展示或验证方面的优化。没有把每个“大文件”“多本账”直接判成缺陷。

## 审计范围与证据强度

| 层级 | 本轮实际做了什么 | 不能据此宣称什么 |
|---|---|---|
| 全仓扫描 | 文件、导入、类型擦除后的依赖环、函数长度、直接测试关联、现有未使用诊断 | 每个函数、每个分支都逐行人工审过 |
| 分区审阅 | 入口→执行/服务→数据/回执→界面交付的关键控制点，见分区表 | 所有注册工具均已实机验收 |
| 隔离复现 | 当前源码的确认/取消规则；假网络天气缓存；模拟消息限流桶 | 真实官网 API 延迟、实际聊天窗口表现 |
| 已有验证 | 9/28 当前源代码基线的回归与构建记录 | 本轮重新完整执行了一次测试，或自动测试等于用户体验 |

没有读取实际 API 密钥、聊天正文或业务数据库；没有访问外部账号。官网展示站仓库、四个子程序的独立仓库及合作团队 API 后端不在这次本仓审计内。当前依赖的在线漏洞通告、Mac 真机、真实麦克风、公屏、WPS、汽水音乐、剪映和律师平台本轮未重测。

源码证据指纹：`338227999f2537550a4b15036dcf2d766048ec05410b62485adeb5e6bae2ebd9`。算法和逐文件散列保存在[审计证据](20260929-project-audit-evidence.json)，供下一轮辨认代码是否改变。

## 优先问题及可执行的精简方向

### A01 · P1 · 任务控制与待确认操作的词义不一致【隔离复现】

[server/cognition/task_concurrency.ts:125](../server/cognition/task_concurrency.ts#L125)、[server/cognition/task_concurrency.ts:147](../server/cognition/task_concurrency.ts#L147) 与 [server/tools/pending_confirmation.ts:673](../server/tools/pending_confirmation.ts#L673)、[server/tools/pending_confirmation.ts:677](../server/tools/pending_confirmation.ts#L677) 使用不同的词表。

| 输入 | 待确认取消 | 活跃任务取消 | 待确认同意 | 活跃任务接受 |
|---|---:|---:|---:|---:|
| 停止执行 | 是 | 否 | 否 | 否 |
| 拒绝 | 是 | 否 | 否 | 否 |
| 不同意 | 是 | 否 | 否 | 否 |
| 不要执行 | 是 | 否 | 否 | 否 |
| 取消 | 是 | 是 | 否 | 否 |
| 停止 | 是 | 是 | 否 | 否 |
| ok | 否 | 否 | 否 | 是 |
| okay | 否 | 否 | 否 | 是 |
| 行 | 否 | 否 | 否 | 是 |
| 没问题 | 否 | 否 | 否 | 是 |
| 开始吧 | 否 | 否 | 否 | 是 |
| 确认 | 否 | 否 | 是 | 是 |
| 好的 | 否 | 否 | 是 | 是 |

影响链路：[server/socket/chat.ts:1625](../server/socket/chat.ts#L1625) 决定是否立即取消；[server/socket/action_turn_durability.ts:133](../server/socket/action_turn_durability.ts#L133) 又用另一判断决定是否读取待确认动作。因此“停止执行”可能未进入即时取消分支，“ok”可能已被绑定到旧任务却没取到批准记录。函数差异已复现；整轮排队/再确认现象仍需端到端验证。

**删/合并方向：**复用现有任务控制解析结果，删除消费端重复的确认、取消词表；保留 taskId、revision、确切目标和待确认动作的一次性校验。不要把任意“好的”都当作全局授权。

**验收：**同一词集覆盖 chat/voice/task/消息入口；活跃任务、等待确认、已结束、过期目标四种状态；取消不等前一任务完成，重复确认不重复副作用。

### A02 · P1 · Task 恢复轮重新获得模型等待预算【源码确认】

文字入口创建并传递同一份 `ModelTurnState`：[server/socket/chat.ts:861](../server/socket/chat.ts#L861)；语音入口也有：[server/socket/voice.ts:1864](../server/socket/voice.ts#L1864)。

但 [server/socket/task.ts:1054](../server/socket/task.ts#L1054) 没有这一状态，首次工具轮和恢复轮分别调用 `runWithTools`（[server/socket/task.ts:1779](../server/socket/task.ts#L1779)、[server/socket/task.ts:1918](../server/socket/task.ts#L1918)）。适配器在 [server/llm/adapter.ts:1665](../server/llm/adapter.ts#L1665) 为未传状态的调用重新创建它。

**影响：**同一个任务请求的累计模型等待和失败候选记录跨恢复轮丢失，可能重新等一遍或再次试本轮已经失败的线路。不是说所有慢回复都由此造成，也没有测出本次实际损失多少秒。

**删/合并方向：**由请求拥有现有预算对象，初次执行、确认后的续执行、守卫恢复共同消费；删掉恢复时重置预算的行为。同样核对 MCP 的再次调用，避免各入口分别复制预算实现。

**验收：**假 provider + 可控时钟，首轮耗尽预算后恢复不得获得完整新预算；失败候选不重复试；用户新请求有新预算，取消仍及时终止。

### A03 · P1 · 结构化任务关系之外，提示文字仍参与工具决策【源码确认】

[server/cognition/execution_decision.ts:524](../server/cognition/execution_decision.ts#L524) 从 `Recovered structured action state / followupIntent: status` 文本决定禁用工具；[server/cognition/action_continuation.ts:614](../server/cognition/action_continuation.ts#L614) 仍从恢复文字识别当前应用继续执行。[server/cognition/turn_flow.ts:349](../server/cognition/turn_flow.ts#L349) 有结构化值优先，但仍保留文字兜底。

**影响：**任务关系已经是结构化结果，后续还有文字解释可以影响执行，存在同一轮两份结论不一致的路径。此处未声称已实现权限绕过。

**删/合并方向：**先补齐现有结构化输入的调用方，再删解析 prompt 的控制分支。提示文字只解释已经接受的状态；不能用格式化历史文本重新授予执行权。

**验收：**改变提示格式、历史中混入相同标题、status/execute 相反文字，都不改变已接受任务关系与权限；当前指令的明确拒绝仍有效。

### A04 · P1 · 公共执行流程之后，聊天入口又加工策略与投影【源码确认】

[server/cognition/execution_pipeline.ts:484](../server/cognition/execution_pipeline.ts#L484) 和紧随其后的投影生成已有公共结果；[server/socket/chat.ts:3317](../server/socket/chat.ts#L3317) 再次计算，随后修改 executionDecision 的 baseToolPolicy/toolPolicy/maxIterations，再按另一条件计算 pinnedTools 和投影。安全边界收窄有必要，**不能直接删这段而扩大远程权限**。

此外 pipeline 在接受明确文件计划/结构化媒体任务时重算任务关系（[server/cognition/execution_pipeline.ts:352](../server/cognition/execution_pipeline.ts#L352)），但 chat 的续接账本仍读取入口的 `resolvedTaskRelation`（[server/socket/chat.ts:3347](../server/socket/chat.ts#L3347)）。这是需要统一结果来源的结构，具体错绑要用冲突样例复验。

**删/合并方向：**把入口安全上限作为现有 pipeline 的输入，一次生成可见工具、可执行工具和实际投影；消费端使用同一接受后的任务关系。删除二次重判和重复构造，不创建第二套“统一引擎”。

**验收：**同一输入在各入口得到一致的能力计划；远程入口仍不能获得本机权限；改数量/换目标/新媒体任务不串到旧任务。

### A05 · P1 · 对外 MCP 聊天仍是独立执行和记忆通道【源码确认】

[server/mcp/lumi_server.ts:183](../server/mcp/lumi_server.ts#L183) 自己组装人格/记忆 prompt，直接进入 `runWithTools`；该调用上下文没有 requestId、conversationId、taskId。与六处使用公共 pipeline 的入口相比，它没有同样的会话绑定和任务续接。远程权限限制已经存在，不能报告成“无鉴权”。

[server/mcp/lumi_server.ts:389](../server/mcp/lumi_server.ts#L389) 广播通用 agent 事件却不带上述标识；[server/runtime/mcp_server.ts:40](../server/runtime/mcp_server.ts#L40) 只补广播房间，不补事件标识。前端是否丢弃或误接取决于当时监听器状态，本轮未做真实多客户端复现。

记忆仍走 [server/mcp/lumi_server.ts:299](../server/mcp/lumi_server.ts#L299) + addMemory，而 chat/voice 使用 `persistTurnMemory` 的用户原文证据、修改/忘记与持久回执。不能仅因两个入口都“有记忆”就认定语义已统一。

**删/合并方向：**MCP 保留身份认证、远程权限和协议适配；复用现有会话、执行与记忆入口，删除自己的业务编排。若某设备确需无状态请求，明确作为无状态调用，避免伪装为当前桌面聊天事件。

**验收：**同用户两个会话同时请求不串结果；MCP 追问明确绑定；记忆纠正/忘记与文字一致；远程调用不能借收敛获得本地桌面或凭据权限。

### A06 · P2 · 数据层反向依赖上层业务，形成 13 文件环【结构确认】

例：db_layer → completion_feedback → execution_guard_recovery → action_contract → tool_intent → vision_routing → vision_preferences → db_layer。入口证据：[db_layer.ts:21](../db_layer.ts#L21)、[server/cognition/user_output_protection.ts:3](../server/cognition/user_output_protection.ts#L3)、[server/cognition/vision_routing.ts:1](../server/cognition/vision_routing.ts#L1)。完整边清单在证据 JSON。

另有 providers → 动态 dispatch → providers 的环；动态导入降低了同步初始化风险，不应只按环数量宣称崩溃。

**删/合并方向：**持久化只保留格式与安全清洗，删除它对规划/模型选择的依赖；优先复用现有底层回执字段和纯校验，减少上层推导，避免新建大量转发文件。

**验收：**数据库冷启动、关闭重开、坏回执清洗、日志脱敏不退化；数据层不再回调模型配置/行动规划；不能通过删除清洗绕过环。

### A07 · P2 · 多本任务账不是全部重复，但投影与身份仍需逐一归属【优化候选】

当前同时有 action_turns、action_tasks、action_receipts、会话活指针、autonomous_tasks、工作接管、指挥中心计划、工作流 run。分别记录回合、任务、动作、计划不是错误。task 入口仍使用 `turnId: requestId`（[server/socket/task.ts:1570](../server/socket/task.ts#L1570)）；[server/cognition/task_execution_ledger.ts:625](../server/cognition/task_execution_ledger.ts#L625) 留下的是任务上下文内的最近回执摘要，不应误当成全部持久证据被删。

**删/合并方向：**先列每个字段的唯一写入者与身份映射，保留完整动作回执作为事实来源，删除同一范围可从它重建的副本和“取最近任务”的猜测。不要一刀切合并全部表。

**验收：**任务超过 40 次工具调用、切会话、重启、取消后迟到回执、并发消息、确认后续做都能归属到确切任务。旧报告关于迟到回执的结论已有修复，见后文。

### A08 · P2 · 日常问候辅助代码有固定城市和错误缓存【隔离复现 + 源码确认】

[server/scheduler.ts:2443](../server/scheduler.ts#L2443) 对每个用户调用无参数天气简报；[server/services/weather.ts:9](../server/services/weather.ts#L9) 默认为北京，缓存只有一份，不含城市。隔离假网络先查北京再查上海，第二次仍返回北京，网络仅调用一次。当前定时入口本来就没传用户城市，不声称线上已发生跨城市查询串用。

该 fetch 没有显式超时/取消和 HTTP 状态检查；getTimeGreeting 使用服务器本地时间，项目另有按用户时区的 server/time/utils.ts。

**删/合并方向：**收敛重复时间判断；没有已确认城市时不编造本地天气。若保留天气，使用按城市的有界缓存及既有超时机制，不再维护独立无界等待。

**验收：**两城市、两时区、HTTP 500、网络悬挂；单用户失败不阻塞后续用户简报。

### A09 · P2 · 消息入口限流桶没有生产淘汰【隔离复现】

[server/messaging/ingress_policy.ts:18](../server/messaging/ingress_policy.ts#L18) 按平台/聊天/用户保存桶，过期只在相同 key 再次出现时重置；唯一 clear 是测试函数。隔离加入 1,000 个不同聊天 key，一天后另一个 key 到来仍保留 1,001 项。

**影响：**接入聊天标识持续增长时，进程内存随历史标识增长；不是说普通单用户立即 OOM。

**删/合并方向：**删除过期桶并设总量上限，优先复用已有有界缓存思想，不再新增一套限流服务。运行时 sceneStore 也只有测试清空，应同批核对生命周期，暂未做其容量复现。

**验收：**大量不同标识后过期可回收，活跃用户仍受限流；清理不跨 scope、不卡主循环。

### A10 · P2 · 归档和数据库仍有随数据量增长的同步工作【性能候选，未压测】

[server/files/generated_archive.ts:27](../server/files/generated_archive.ts#L27) 同步读完整 JSON 索引；saveIndex 同步 stringify/write/fsync；归档循环每个新产物写整份索引。[db_layer.ts:2528](../db_layer.ts#L2528) 已改成变化表持久化、热点行差量，不应继续用旧结论说“每次全表重写”；但表快照的构造、序列化比较仍需测大数据规模。

**删/合并方向：**减少同轮重复扫描和重复落盘，优先批量登记已有产物；只有剖析证实瓶颈后再调整存储，不新增第二套资料库。保留临时文件、哈希、权限复核和原子替换。

**验收：**用独立测试数据测 1千/1万/更大条数的事件循环延迟、归档耗时、flush P95；故障后不可出现“文件有了但索引承诺没兑现”或误把输入文件当产物。

### A11 · P2 · 前端大容器和多套形象路径仍是现用代码【结构确认】

DesktopUI 主函数 4,966 行，AgentChatPage 4,764 行；这是源码范围长度，不是复杂度分数。其状态监听、进度、会话恢复和展示容易互相牵连。

数字人还有 human3d/lumi3d/lumi2d/lumivrm 分支（[src/components/MemoryAvatarStage.tsx:253](../src/components/MemoryAvatarStage.tsx#L253)）；[src/components/MemoryAvatarProfile.tsx:221](../src/components/MemoryAvatarProfile.tsx#L221) 仍暴露旧风格选择。它们是可到达的功能/兼容路径，不能作为“没有 import 的僵尸代码”直接清除。lumivrm 已映射到平面表现，不等于旧模型二进制仍被加载。

**删/合并方向：**先取消确定废弃的产品路径并迁移旧设置，再删对应组件、资源和翻译；聊天界面先减冗余状态、重复监听和重复投影，再考虑是否需要拆分。不以新增 hooks/转发文件凑“优化”。

**验收：**切会话、重连、进度取消、附件预览、缩放/移动端、数字人旧配置打开；保留现用 2D/云端形象及 WebGL 失败提示。

### A12 · P2 · 测试数量门槛与分区行为覆盖不匹配【源码确认】

[scripts/check-vitest-count.mjs:5](../scripts/check-vitest-count.mjs#L5) 默认最低 **1,562 项**，当前基线 **6,473 项**；没有外部覆盖时，大幅漏收测试仍可能通过数量检查。CI 文件未在该步骤设置更高阈值。

扫描到 156 个“读源码 + contains/match”候选测试文件；其中可能同时有行为测试，不表示这 156 个都无效。10 个路径分区没有直接测试导入，名单见附表；也不等于无间接测试。上轮唯一失败就是删除过期提示段后留下的源码字符串断言，证明它可能阻碍删冗余而没有验证实际行为。

**删/合并方向：**删掉只锁死旧代码文字/文件结构且无行为价值的断言，保留权限与证据约束；对 A01–A05 补状态转换和多入口一致性用例，合并重复样例。测试清单变更要有删除理由，不能仅降低总数门槛。

**验收：**故意漏收一个关键分区能被发现；同一语义在多渠道有参数化行为用例；已删实现的孤立测试不再要求旧文件存在。

## 20 个功能分区的审阅结果

下表是关键入口和控制点审阅，不是宣称该分区所有源码逐行审完。全部 77 个路径分区的数量和测试关联见[分区矩阵](20260929-project-audit-areas.md)。

| 功能分区 | 本轮核对到的主链及边界 | 精简判断 / 后续验证 |
|---|---|---|
| 1. 启动、配置、退出保存 | launcher → runtime/server_entry → server/bootstrap；shutdown 先停接入、等工作、保存；Rust 退出屏障 | 保留数据根租约、关机保存及失败不退出；优化重点 A06/A10，不能删为普通进程 kill |
| 2. 桌面、Dock、个性化、移动端 | DesktopUI / AppContext / entries / MobilePlatform；共享导航契约和延迟加载 | A11；只删确认废弃入口，已删写入但不显示的状态不再重报；移动端构建不等于手机触摸验收 |
| 3. 文字聊天与连续上下文 | AgentChatPage → socket/chat → pipeline → adapter → finalizer → durable terminal | A01/A03/A04；保留服务器历史、附件归属、进度与恢复；实机重点“改数量、继续、停止” |
| 4. 语音、唤醒、主动问候、提醒、会议 | useVoiceCall → STT → voice → TTS；声纹/麦克风 lease；scheduler→已落盘提醒→声音派发 | A01/A08；音频播放与任务成功是不同证据，不能合并为一个 completed；需真麦克风/音响验收 |
| 5. 意图、路由、工具策略、结果判断 | turn_flow / normalized_action_intent / execution_pipeline / execution_decision / result_finalizer | A03/A04；删重复决策消费者，不删安全检查。Laya 当前仅影子观测，返回 controlsExecution:false，不能用来宣称主决策已改由 Laya 执行 |
| 6. 任务、工作接管、自主与调度 | action ledger / task queue / command_center plans / work_takeover / workflow runtime | A02/A07；计划、任务、动作不同层要保留；后台让位逻辑目前以实时语音为主要输入，文字同时执行竞争仍需专项 |
| 7. 模型、官方 API、本地模型与隐私 | user/model preferences → dispatch/providers；官方多模态统一 relay；embedding 独立能力配置；strict 要求本机 endpoint | A02；已见预算/健康/失败候选共享机制但入口不齐。保留模型身份回执、版本校验和本地端点约束；未验证账号今日额度/延迟 |
| 8. 工具、桌面、网页登录、外部 CLI | registry → execution_engine → native UI/relay；scope+lease+取消；CLI runId/会话/目录；登录资料加密 | 保留精确目标、幂等、迟到回执和未知提交态；本轮静态边界核对不代表网易云/WPS/网页登录通过 |
| 9. 技能大厅、生成、登记复用、MCP、扩展 | generated_history 只读展示 → generator/authoring → 注册/运行；workflow definition/run/revision；签名扩展元数据 | A05/A07；草稿、安装、启用、可用、执行成功不可压成单一状态；重复请求和换输入复用需保留行为测试 |
| 10. 长期记忆、人格、自学习 | persistTurnMemory 用户原文证据 → store/firewall/provenance；人格 evolution；梦境整理 | 主链已有明确来源和范围限制；A05 补齐 MCP。保留“修改/忘记”及拒绝记忆，不把归纳整理说成训练基础模型 |
| 11. 知识库、检索与跨模型引用 | files/knowledge manifest → memory/org KB 索引 → embedding namespace/hash → RAG/rerank | 模型切换已有向量身份隔离，不能删；A10。旧向量不可混用；图片、PDF、加密文件、缺索引/失败重试要单独验收 |
| 12. 文件导入、聊天预览、跨会话存档 | scope 文件端点 → generated_archive → artifact card / generatedLibrary / fileResource | 已有路径 realpath、所有权、去重和产物登记；A10/A11。存在、正确、归档、前端可打开四步分别验证 |
| 13. 图片和视频生成 | MediaGenerationStudio → 结构化媒体请求 → image/video tools → official API → archive | 结构化媒体有直接受控执行路径，不能一概说先绕一轮模型；保留预览/归档、任务轮询取消；未调用真实生成服务 |
| 14. 聊天唱歌视频 | ChatSongWorkbench → 对白/歌曲版本/逐句 timing → chat_song_render → ffmpeg/ffprobe → archive | 已有 3:4 横条、输入快照、版本冲突和音视频验证；本地合成与控制汽水音乐是不同步骤，不能用模板导出冒充全流程自动制作 |
| 15. 数字人、记忆领地、直播 | avatar store/conversation → 本地/云形象；live_routes 的公开资料 prompt 无私人工具；公屏裁剪与有限重试 | A11；形象选择仍多支。公开资料与私密记忆应继续隔离；捕获丢失、停止/重试、双屏切换要实机验收 |
| 16. 经营、社媒、电商、财税 | BusinessWorkbench 社媒默认页，commerce/finance 延迟加载；workspace → industry task → 工作产品 | 原专用模块并未全死，部分产物是本地分析/草稿、不是已发布/已经营。保留业务校验，删壳层重复导航和重复任务解释 |
| 17. 律师、案件与法律资料 | LegalHub/cases → CN legal tools → 权威来源刷新/效力门槛/交付检查 → org KB | 大文件仍现用；不能删法条来源、失效与未知状态门槛。代码有19项相关能力不等于19项需求全交付；本轮未在线确认所有引用现行有效 |
| 18. 组织、团队、飞书/微信/企业微信 | membership/resource ACL → messaging ingress/journal/turn authorization → 区域处理 → scoped delivery；branch sync 批次去重 | A05/A09；保留成员变更后的重新授权、附件范围和交付记录；远程与本机执行上限不同，不能为了统一删除 |
| 19. 设备、LAP、场景、CAD/设计 | native identity/device registry → LAP scope/revocation；scene snapshot；CAD geometry/hash/visual receipt → 专业软件适配 | 保留原生身份和图纸质量验证；全息、旧外观等需产品退役决定，不能只因没有直测就删；未做实际 CAD 软件验收 |
| 20. 安全边界、监控、打包、测试 | 统一 auth、socket scope、127.0.0.1 默认绑定、生产 dist 静态目录；CI、打包 smoke、latency ring buffer | A06/A12；大脚本含验收设施，不是业务僵尸。此仓静态目录核对不能替代官网独立仓库检查；未运行本轮在线漏洞审计 |

## 旧审计结论如何处理

保留原始 [9/24 内部链路报告](20260924-architecture-audit.md)，不修改原文。以下是当前核对状态，不把历史问题直接复印成今天的故障。

| 旧编号/主题 | 本轮状态 | 依据与处理 |
|---|---|---|
| R1 / R2 取消与确认词表 | 仍存在 | A01 已用当前函数隔离复现 |
| R3 prompt 反向控制意图 | 仍有对应代码 | A03；不等同已复现权限突破 |
| R5 / R7 多次任务关系/策略计算 | 仍有结构重叠 | A04；安全上限收窄不能直接删除 |
| R8 重复恢复/模型后强制工具 | 部分仍在 | adapter 的普通 runtimeRecovery 仍可能先调模型再替换调用；结构化媒体和文件回读已有直达分支。A02先补预算；进一步优化要保留工具证据和确认 |
| R10 / L3 旧 processInput | 已移除旧实现 | 当前 cognition/index.ts 已不在工作树；不得再报成现用问题 |
| T2 / T3 / T9 迟到回执丢失 | 已有明显修复，旧结论不能照搬 | desktop_relay 有 onLateResult/persistLateResult 与持久化后 ACK；前台 release/finalization 有专门回归。极端组合仍按 A07 验收 |
| T1 / T4–T8 多账/身份/终态 | 部分收敛，不能总判已修或全坏 | 保留 A07 的身份与唯一写入者核对，不盲目合表 |
| E4 MCP 缺事件身份 | 仍存在 | A05，广播已按用户/工作域限制，但事件缺 request/conversation/source |
| E10 无来源主动上下文 | 旧分支已删除 | 不再存在 proactive_triggers.ts；现用主动语音/提醒有独立路径 |
| E11 后台只感知语音让位 | 机制仍偏语音 | foreground_activity.ts；文字并发效果本轮未复现，不能直接宣称所有抢占失败 |
| L7、L8、L9、L14 等旧函数/导入/未挂载页 | 多项已清理 | 以前清理报告留存，不能以旧路径生成新删单 |
| L12 模式、L15 区域包依赖 | 兼容/耦合仍需审慎收敛 | 旧模式值不再等于多套授权；CN 文案/识别抽象不能连带删掉法律和区域业务 |
| 其他 R4/R6/R9/R11、E/P 细项 | 未逐条完成原场景复现 | 本轮按新控制点审阅，既不标记全部解决，也不把原故障未经复核升格为当前确认缺陷 |

## 精简执行顺序与完成标准

| 批次 | 范围 | 减负目标 | 完成条件 |
|---|---|---|---|
| 1 | A01、A02 | 先去掉不一致词表和重置预算的行为 | 取消/确认状态矩阵与恢复累计预算通过，现有边界回归不退化 |
| 2 | A03、A04 | 同一请求只消费一份接受后的任务关系、策略和投影 | 六入口对照 + 远程上限 + 连续改任务；再删旧消费者 |
| 3 | A05 | 删除 MCP 私有业务编排，保留协议适配 | 会话/事件/记忆一致、并发不串、远程仍受限 |
| 4 | A06、A07 | 去掉数据层反向依赖和可重建副本 | 身份映射、重启、迟到回执、>40动作不丢证据 |
| 5 | A08、A09、A10 | 去掉错误的共享缓存、过期状态和重复 I/O | 隔离行为测试 + 大数据量测量，保留持久化保障 |
| 6 | A11、A12 | 退役废弃 UI/展示支路，合并重复状态和结构断言 | 现用界面实机验收、历史配置迁移、测试清单可解释 |

每批单独记录删除依据、实际源码净变化和验收证据。优先在已有文件/模块上收敛；如果为修复必须增加少量代码，明确必要性，并在整批删除被替代实现。**不以拆文件、增加转发层或单纯缩短格式作为代码优化成绩。** 不预先承诺可删行数：没有调用链证明的估算会诱导误删。

可直接删除的条件：生产调用/配置/原生桥/动态技能入口均不再需要，且历史数据迁移有结论；只被测试导入也需区分公共契约和未接入原型。当前 46 个零静态入边文件包含动态入口、worker、声明文件，不是 46 个僵尸模块；83 个剩余未使用诊断（41变量、42参数）也不是83个可删项，调用副作用和接口签名需要保留。

## 验证记录

- 本轮：完整静态扫描和2组依赖环核对；13条确认/取消词句的隔离函数探针；假网络天气缓存探针；1,000消息标识限流桶探针。原始结果在证据 JSON。
- 当前源码已有回归：9/28完整运行 730文件/6,473项，首次6,472通过、1项旧源码字符串断言失败；修正该断言后相关3文件/36项通过，最新逐文件结果6,473通过、无待处理失败。**不是一次全绿运行。**
- 同基线 lint、桌面/移动/后端构建通过；后端指纹 `67cb30136248`；更早同清理阶段 Windows Cargo离线检查通过。本轮没有改生产代码，因此没有重复跑整套构建和测试。
- 当前样本不足以给整体“稳定率”、端到端覆盖率或模型延迟改善百分比。后续以真实官方 API 的聊天/任务/语音、文件预览和桌面执行验收补证，失败仍要保留已经完成的动作记录。
