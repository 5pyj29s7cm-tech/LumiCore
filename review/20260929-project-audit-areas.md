# LumiCore 分区矩阵与核对入口

日期：2026-09-29。对应[主审计报告](20260929-project-audit.md)。

统计：1,063 个第一方 JS/TS 文件，77 个路径分区。表内行数只含 JS/TS，不应与主报告包含 Rust、Python、样式等的 371,039 行混用。测试关联来自测试/辅助文件对生产模块的直接字面导入，含 mock、含间接加载遗漏，**不是覆盖率，不可相加**。扫描到736个测试/辅助JS/TS文件，Vitest实际执行730个测试文件；这两个口径不同。

所有行均完成导入/依赖扫描；人工关键链路审阅参见主报告20个功能分区，并非每个文件逐行审阅。0条直测关联不能推出模块没用。

| 路径分区 | 功能归属 | JS/TS文件 | 行数 | 直接关联测试/辅助文件 |
|---|---|---:|---:|---:|
| `(root)` | 启动、退出、配置与持久化 | 9 | 3,264 | 243 |
| `routes` | 记忆、人格、上下文与知识资料 | 2 | 3,613 | 13 |
| `scripts` | 脚本、通用支持与文案 | 56 | 37,233 | 35 |
| `server/adapters` | 工具、桌面、浏览器与外部 CLI | 7 | 1,507 | 7 |
| `server/agents` | 工具、桌面、浏览器与外部 CLI | 5 | 2,994 | 14 |
| `server/autonomy` | 自主任务和指挥中心 | 12 | 5,063 | 43 |
| `server/biometrics` | 语音、感知、时间与提醒 | 5 | 1,147 | 3 |
| `server/cad` | 媒体、音乐视频、数字人及 CAD | 2 | 623 | 3 |
| `server/client` | 工具、桌面、浏览器与外部 CLI | 3 | 2,670 | 15 |
| `server/cloud` | 模型路由、云端韧性与监控 | 5 | 924 | 32 |
| `server/cognition` | 意图、执行计划与结果判定 | 70 | 27,120 | 133 |
| `server/command_center` | 自主任务和指挥中心 | 2 | 438 | 6 |
| `server/config` | 启动、退出、配置与持久化 | 9 | 1,444 | 54 |
| `server/contacts` | 记忆、人格、上下文与知识资料 | 3 | 142 | 0（需查间接/实机） |
| `server/context` | 记忆、人格、上下文与知识资料 | 6 | 860 | 3 |
| `server/conversation` | 意图、执行计划与结果判定 | 21 | 12,836 | 86 |
| `server/creative` | 媒体、音乐视频、数字人及 CAD | 2 | 390 | 1 |
| `server/db` | 启动、退出、配置与持久化 | 1 | 266 | 1 |
| `server/desktop` | 工具、桌面、浏览器与外部 CLI | 4 | 2,054 | 9 |
| `server/devices` | 设备、协作协议与场景输出 | 5 | 591 | 6 |
| `server/evidence` | 工具、桌面、浏览器与外部 CLI | 7 | 4,863 | 12 |
| `server/extensions` | 技能、流程、扩展与 MCP | 1 | 2,043 | 1 |
| `server/external_agents` | 工具、桌面、浏览器与外部 CLI | 2 | 340 | 2 |
| `server/external_apps` | 工具、桌面、浏览器与外部 CLI | 1 | 82 | 0（需查间接/实机） |
| `server/external_capabilities` | 工具、桌面、浏览器与外部 CLI | 3 | 2,258 | 4 |
| `server/external_control` | 工具、桌面、浏览器与外部 CLI | 6 | 1,567 | 3 |
| `server/files` | 记忆、人格、上下文与知识资料 | 4 | 328 | 3 |
| `server/http` | HTTP 接入与鉴权 | 1 | 16 | 1 |
| `server/i18n` | 脚本、通用支持与文案 | 9 | 300 | 0（需查间接/实机） |
| `server/industry` | 组织、行业、法律与多平台消息 | 14 | 460 | 12 |
| `server/knowledge` | 记忆、人格、上下文与知识资料 | 4 | 881 | 4 |
| `server/lap` | 设备、协作协议与场景输出 | 12 | 1,850 | 8 |
| `server/legal` | 组织、行业、法律与多平台消息 | 6 | 2,579 | 4 |
| `server/llm` | 模型路由、云端韧性与监控 | 26 | 12,055 | 95 |
| `server/marketplace` | 技能、流程、扩展与 MCP | 2 | 770 | 3 |
| `server/mcp` | 技能、流程、扩展与 MCP | 10 | 5,698 | 17 |
| `server/media` | 媒体、音乐视频、数字人及 CAD | 1 | 42 | 2 |
| `server/memory` | 记忆、人格、上下文与知识资料 | 15 | 3,902 | 29 |
| `server/memory_avatar` | 媒体、音乐视频、数字人及 CAD | 15 | 2,659 | 13 |
| `server/messaging` | 组织、行业、法律与多平台消息 | 20 | 4,681 | 22 |
| `server/middleware` | HTTP 接入与鉴权 | 1 | 260 | 4 |
| `server/monitor` | 模型路由、云端韧性与监控 | 3 | 502 | 3 |
| `server/org` | 组织、行业、法律与多平台消息 | 13 | 6,743 | 57 |
| `server/output` | 设备、协作协议与场景输出 | 1 | 125 | 0（需查间接/实机） |
| `server/persistence` | 启动、退出、配置与持久化 | 1 | 76 | 1 |
| `server/personality` | 记忆、人格、上下文与知识资料 | 10 | 3,240 | 11 |
| `server/regions` | 组织、行业、法律与多平台消息 | 54 | 17,694 | 20 |
| `server/relay` | 模型路由、云端韧性与监控 | 1 | 111 | 1 |
| `server/routes` | HTTP 接入与鉴权 | 26 | 7,368 | 54 |
| `server/runtime` | 启动、退出、配置与持久化 | 21 | 4,805 | 43 |
| `server/scene` | 设备、协作协议与场景输出 | 1 | 156 | 1 |
| `server/scheduler.ts` | 语音、感知、时间与提醒 | 1 | 3,568 | 8 |
| `server/self_extension` | 技能、流程、扩展与 MCP | 7 | 4,495 | 6 |
| `server/services` | 语音、感知、时间与提醒 | 1 | 54 | 0（需查间接/实机） |
| `server/skills` | 技能、流程、扩展与 MCP | 67 | 14,381 | 29 |
| `server/socket` | 意图、执行计划与结果判定 | 35 | 19,455 | 71 |
| `server/stt` | 语音、感知、时间与提醒 | 15 | 3,919 | 20 |
| `server/time` | 语音、感知、时间与提醒 | 3 | 669 | 1 |
| `server/tools` | 工具、桌面、浏览器与外部 CLI | 82 | 31,349 | 198 |
| `server/tts` | 语音、感知、时间与提醒 | 10 | 1,857 | 14 |
| `server/utils` | 脚本、通用支持与文案 | 5 | 635 | 10 |
| `server/web_login` | 工具、桌面、浏览器与外部 CLI | 3 | 1,080 | 3 |
| `server/work_product` | 组织、行业、法律与多平台消息 | 2 | 1,100 | 6 |
| `server/work_takeover` | 组织、行业、法律与多平台消息 | 11 | 4,379 | 13 |
| `server/workflows` | 技能、流程、扩展与 MCP | 2 | 1,748 | 9 |
| `shared` | 意图、执行计划与结果判定 | 22 | 2,666 | 37 |
| `src/components` | 前端界面、状态、资源及多端 | 137 | 49,607 | 27 |
| `src/contexts` | 前端界面、状态、资源及多端 | 1 | 935 | 1 |
| `src/core` | 前端界面、状态、资源及多端 | 1 | 199 | 0（需查间接/实机） |
| `src/entries` | 前端界面、状态、资源及多端 | 5 | 195 | 0（需查间接/实机） |
| `src/hooks` | 前端界面、状态、资源及多端 | 21 | 6,013 | 17 |
| `src/i18n` | 前端界面、状态、资源及多端 | 44 | 3,311 | 10 |
| `src/lib` | 前端界面、状态、资源及多端 | 41 | 6,453 | 45 |
| `src/pets` | 前端界面、状态、资源及多端 | 3 | 1,823 | 0（需查间接/实机） |
| `src/platforms` | 前端界面、状态、资源及多端 | 1 | 362 | 0（需查间接/实机） |
| `src/services` | 前端界面、状态、资源及多端 | 20 | 2,387 | 16 |
| `src/types` | 前端界面、状态、资源及多端 | 3 | 345 | 0（需查间接/实机） |

## 需要优先关注的函数范围

行数为AST起止范围，含注释、嵌套回调和JSX；嵌套项不累加，不是可删除行数。

| 文件 | 函数/回调 | 起始行 | 范围行数 |
|---|---|---:|---:|
| [src/components/DesktopUI.tsx](../src/components/DesktopUI.tsx#L1360) | DesktopUI | 1360 | 4,966 |
| [src/components/AgentChatPage.tsx](../src/components/AgentChatPage.tsx#L419) | AgentChatPage | 419 | 4,764 |
| [server/socket/chat.ts](../server/socket/chat.ts#L625) | registerChatHandler | 625 | 4,481 |
| [server/socket/chat.ts](../server/socket/chat.ts#L741) | 内联回调 | 741 | 4,364 |
| [server/socket/voice.ts](../server/socket/voice.ts#L1737) | processVoiceInput | 1737 | 3,190 |
| [server/socket/task.ts](../server/socket/task.ts#L199) | registerTaskHandler | 199 | 2,133 |
| [server/socket/task.ts](../server/socket/task.ts#L280) | 内联回调 | 280 | 2,051 |
| [server/socket/voice.ts](../server/socket/voice.ts#L5117) | registerVoiceHandlers | 5117 | 1,564 |
| [server/tools/definitions/work_takeover_tools.ts](../server/tools/definitions/work_takeover_tools.ts#L211) | registerWorkTakeoverTools | 211 | 1,406 |
| [src/hooks/useVoiceCall.ts](../src/hooks/useVoiceCall.ts#L213) | useVoiceCall | 213 | 1,395 |
| [server/scheduler.ts](../server/scheduler.ts#L2195) | registerScheduledTasks | 2195 | 1,372 |
| [src/components/SkillCenter.tsx](../src/components/SkillCenter.tsx#L384) | SkillCenter | 384 | 1,350 |
| [server/tools/definitions/external_app_tools.ts](../server/tools/definitions/external_app_tools.ts#L1261) | registerExternalAppTools | 1261 | 1,292 |
| [server/regions/packs/cn/messaging_routes.ts](../server/regions/packs/cn/messaging_routes.ts#L2383) | processWithPersonality | 2383 | 1,170 |

## 非 JS/TS 层及外部边界

| 层 | 核对对象 | 本轮证据边界 |
|---|---|---|
| Rust/Tauri | lib.rs、native_identity、local_bootstrap、desktop_command_supervisor、backend_shutdown；原生命令和窗口能力 | 关键生命周期/身份控制点人工审阅；前期Windows编译记录，不代表Mac/Windows真实全部命令验收 |
| Python | CAD vectorizer、Laya影子worker及已有辅助脚本 | 第一方文件盘点，调用边界/角色核对；前期语法检查，不代表模型质量或CAD准确度 |
| PowerShell/安装脚本 | Windows部署、安装smoke、打包配置 | 入口与前期解析/构建记录；本轮未新装客户端 |
| CI/配置 | package scripts、Vitest收集规则、ci.yml、build-installers.yml、依赖审计脚本 | 核对检查链与门槛；未触发GitHub构建、未在线更新CVE状态 |
| 动态技能 | bundled技能package入口、MCP注册、签名扩展、worker | 静态import不能证明不可达，禁止无调用即删 |
| 用户资料/模型/账号 | 实际数据库、API key、作品库、下载模型 | 本轮不读取/不修改，不能拿静态审计替代数据和性能实测 |
| 官网/独立子程序/合作后台 | 独立仓库和服务器 | 本次范围外；主仓有共享代码不代表它们已同步或验收 |

## 审阅证据定位

以下路径在本轮读取过相关控制点，行号对应主报告具体结论；完整测试关联和源码散列见[证据JSON](20260929-project-audit-evidence.json)。

- [server/cognition/task_concurrency.ts:125](../server/cognition/task_concurrency.ts#L125)
- [server/cognition/task_concurrency.ts:147](../server/cognition/task_concurrency.ts#L147)
- [server/tools/pending_confirmation.ts:673](../server/tools/pending_confirmation.ts#L673)
- [server/tools/pending_confirmation.ts:677](../server/tools/pending_confirmation.ts#L677)
- [server/socket/chat.ts:1625](../server/socket/chat.ts#L1625)
- [server/socket/action_turn_durability.ts:133](../server/socket/action_turn_durability.ts#L133)
- [server/socket/chat.ts:861](../server/socket/chat.ts#L861)
- [server/socket/voice.ts:1864](../server/socket/voice.ts#L1864)
- [server/socket/task.ts:1054](../server/socket/task.ts#L1054)
- [server/socket/task.ts:1779](../server/socket/task.ts#L1779)
- [server/socket/task.ts:1918](../server/socket/task.ts#L1918)
- [server/llm/adapter.ts:1665](../server/llm/adapter.ts#L1665)
- [server/cognition/execution_decision.ts:524](../server/cognition/execution_decision.ts#L524)
- [server/cognition/action_continuation.ts:614](../server/cognition/action_continuation.ts#L614)
- [server/cognition/turn_flow.ts:349](../server/cognition/turn_flow.ts#L349)
- [server/cognition/execution_pipeline.ts:484](../server/cognition/execution_pipeline.ts#L484)
- [server/socket/chat.ts:3317](../server/socket/chat.ts#L3317)
- [server/cognition/execution_pipeline.ts:352](../server/cognition/execution_pipeline.ts#L352)
- [server/socket/chat.ts:3347](../server/socket/chat.ts#L3347)
- [server/mcp/lumi_server.ts:183](../server/mcp/lumi_server.ts#L183)
- [server/mcp/lumi_server.ts:389](../server/mcp/lumi_server.ts#L389)
- [server/runtime/mcp_server.ts:40](../server/runtime/mcp_server.ts#L40)
- [server/mcp/lumi_server.ts:299](../server/mcp/lumi_server.ts#L299)
- [db_layer.ts:21](../db_layer.ts#L21)
- [server/cognition/user_output_protection.ts:3](../server/cognition/user_output_protection.ts#L3)
- [server/cognition/vision_routing.ts:1](../server/cognition/vision_routing.ts#L1)
- [server/socket/task.ts:1570](../server/socket/task.ts#L1570)
- [server/cognition/task_execution_ledger.ts:625](../server/cognition/task_execution_ledger.ts#L625)
- [server/scheduler.ts:2443](../server/scheduler.ts#L2443)
- [server/services/weather.ts:9](../server/services/weather.ts#L9)
- [server/messaging/ingress_policy.ts:18](../server/messaging/ingress_policy.ts#L18)
- [server/files/generated_archive.ts:27](../server/files/generated_archive.ts#L27)
- [db_layer.ts:2528](../db_layer.ts#L2528)
- [src/components/MemoryAvatarStage.tsx:253](../src/components/MemoryAvatarStage.tsx#L253)
- [src/components/MemoryAvatarProfile.tsx:221](../src/components/MemoryAvatarProfile.tsx#L221)
- [scripts/check-vitest-count.mjs:5](../scripts/check-vitest-count.mjs#L5)
