# 全仓失效代码删除与分区验证

日期：2026-09-28。仓库：`D:/lumiOS`。提交基线：`35760c39764b7aae724184583b7f663bdc6670ec`，版本 3.1.0。

## 本轮结论

本轮净减少 **2,465 行业务源码与脚本**，没有新增生产模块、抽象层或功能。另减少 128 行仅对应废弃实现的测试，合计净减少 **2,593 行**。当前业务源码与脚本 371,752 行，含测试 530,273 行。

本轮做完了全仓第一方 JS/TS 入口与依赖扫描、未使用私有声明扫描、确认失效项删除，以及现有 730 个测试文件 / 6,473 项测试回归。所有测试通过。Windows 原生层编译检查、桌面/移动前端与后端构建也通过。

这不是“所有功能实机验收通过”或“所有架构问题均已解决”的声明。真实官网 API、聊天窗口交互、WPS/浏览器操作、音乐视频制作与直播未在本轮重测。

## 删除项与依据

| 分区 | 实际删除 | 删除依据 / 现用实现 |
|---|---|---|
| 桌面演示与任务执行 | `self_intro_workflow.ts` 净删 1,003 行：旧的 `runLegacySelfIntroDemoAdapter`、固定演示动作、坐标/文件/剪贴板辅助代码及旧专用验收器 | 旧适配器没有调用或导出；manifest 调用的是保留的 `runSelfIntroDemo`，由能力快照生成计划。删除后仍通过现用入口与执行回归 |
| 技能与 MCP | `server/mcp/client.ts` 删除 123 行未调用的自动修补技能源码逻辑 | 私有方法没有调用，整条辅助方法链仅被该旧方法引用；技能生成、安装、审批、启动与复用实现保留 |
| 模型配置界面 | `Settings.tsx` 净删 608 行旧的视觉/生图/语音服务设置外壳与未挂载行组件 | 编译器确认未使用，现用配置界面保留；世界模型仍使用的视觉连接测试函数保留 |
| 前端界面 | 删除旧聊天配色表、旧桌面图标组件、个人页旧条目、未使用技能状态辅助函数与颜色转换函数 | 没有渲染入口或调用；桌面、聊天、技能大厅的现用组件保留 |
| 决策、模型、记忆、法律与业务 | 删除未使用的私有解析函数、旧正则常量、空注册表和重复的局部辅助定义 | TypeScript 未使用诊断与符号引用核对；不改变现用路由与权限检查 |
| 生物识别 | 删除整个 `server/biometrics/cloud_verify.ts`（154 行） | 没有生产调用，只有测试直接导入的未接入云端备用模块；现用本地声纹/身份流程保留 |
| LAP 协作 | 删除整个 `server/lap/community_directory.ts`（120 行） | 没有生产调用，环境变量也只在模块与专用测试中出现；现用 LAP 会话/委派/上下文保留 |
| 语音消息 | 删除整个 `server/socket/voice_messaging_context.ts`（42 行） | 唯一生产 import 也未使用；剩余只有旧单测直接调用，不能代表真实语音链路。删除孤立的联系人猜测辅助器 |
| 法律消息接入 | 删除 1 行转发文件 `server/messaging/legal_notice_intake.ts` | 生产已直接调用区域实现；两个现用测试改为同样直接引用区域实现，断言保留 |
| 全仓导入与文案 | 删除未使用的 import；另清理 22 个旧界面专用翻译项 | 普通导入清理核对编译产出的 JS token 不变；3 处仅影响编译器转导出别名的变化另外逐项核对。翻译只删本次移除代码引用、且仓库已无引用的键 |

删除源文件前逐一核对绝对路径，范围限定在本仓库。没有删除用户数据、模型、已生成文件或实际凭据。没有改动合作团队模型服务。

## 测试数量变化

上一轮为 732 个文件 / 6,480 项，本轮为 730 个文件 / 6,473 项。减少的 7 项如下：

- 删除 `test/lap_community_directory.test.ts` 的 3 项，只验证未接入的社区目录。
- 删除 `test/self_intro_workflow_delivery.test.ts` 的 3 项，只验证旧 Office 演示验收器。
- 从 `test/voice_live_regressions.test.ts` 删除 1 项，只验证不再被任何生产流程调用的联系人猜测辅助器。其余语音回归保留。
- `test/privacy_speech.test.ts` 只删对已移除云端识别模块的断言；现用语音、克隆、唤醒、严格隐私与网络边界断言保留，测试数不变。

没有因回归失败而删除现用功能断言。没有新增只验证拆文件结构的测试。

## 全仓入口审计范围

共扫描 1066 个第一方 JS/TS 文件，归入 77 个路径分区。统计字面量 import、动态 import、require、转导出及类型引用；以启动文件、构建脚本、桌面/移动根入口、内置技能入口、worker、声明文件为保守根节点，遍历后无根节点不可达文件。

仍有 46 个没有静态入边的文件，均已逐项分类为动态入口、worker 或类型声明，详见下表。没有把“没有 import”直接当成删除依据。该扫描不能证明所有导出函数都在真实运行时使用，也不能证明每个分支正确。

## 分区验证矩阵

下表的“关联测试”来自通过测试文件对生产模块的直接导入关系，可能含 mock，且同一测试可关联多个分区；不是覆盖率，也不应相加。所有 JS/TS 分区均已纳入依赖扫描和类型检查；运行构建覆盖可达代码。无直接关联测试的分区明确标出，不能据此声称行为已独立验收。

| 源码分区 | JS/TS 文件 | 当前行数 | 本轮净删行数 | 关联通过测试文件 |
|---|---:|---:|---:|---|
| `(root)` | 9 | 3,264 | 11 | 241 |
| `routes` | 2 | 3,613 | 0 | 13 |
| `scripts` | 56 | 37,233 | 0 | 35 |
| `server/adapters` | 7 | 1,507 | 5 | 7 |
| `server/agents` | 5 | 2,994 | 0 | 14 |
| `server/autonomy` | 12 | 5,063 | 0 | 43 |
| `server/biometrics` | 5 | 1,147 | 154 | 3 |
| `server/cad` | 2 | 623 | 0 | 3 |
| `server/client` | 3 | 2,670 | 1 | 15 |
| `server/cloud` | 5 | 924 | 0 | 32 |
| `server/cognition` | 70 | 27,124 | 15 | 133 |
| `server/command_center` | 2 | 438 | 0 | 6 |
| `server/config` | 9 | 1,444 | 0 | 54 |
| `server/contacts` | 3 | 142 | 0 | 无直接导入关联；仅静态/构建验证 |
| `server/context` | 7 | 1,061 | 0 | 3 |
| `server/conversation` | 21 | 12,836 | 0 | 85 |
| `server/creative` | 2 | 390 | 0 | 1 |
| `server/db` | 1 | 266 | 0 | 1 |
| `server/desktop` | 4 | 2,054 | 0 | 9 |
| `server/devices` | 5 | 591 | 1 | 6 |
| `server/evidence` | 7 | 4,863 | 0 | 12 |
| `server/extensions` | 1 | 2,043 | 0 | 1 |
| `server/external_agents` | 2 | 340 | 0 | 2 |
| `server/external_apps` | 1 | 82 | 0 | 无直接导入关联；仅静态/构建验证 |
| `server/external_capabilities` | 3 | 2,258 | 0 | 4 |
| `server/external_control` | 6 | 1,567 | 0 | 3 |
| `server/files` | 4 | 328 | 0 | 3 |
| `server/http` | 1 | 16 | 0 | 1 |
| `server/i18n` | 9 | 300 | 0 | 无直接导入关联；仅静态/构建验证 |
| `server/industry` | 14 | 460 | 0 | 12 |
| `server/knowledge` | 4 | 881 | 0 | 4 |
| `server/lap` | 12 | 1,850 | 128 | 8 |
| `server/legal` | 6 | 2,579 | 2 | 4 |
| `server/llm` | 26 | 12,055 | 51 | 95 |
| `server/marketplace` | 2 | 770 | 3 | 3 |
| `server/mcp` | 10 | 5,698 | 138 | 17 |
| `server/media` | 1 | 42 | 0 | 2 |
| `server/memory` | 15 | 3,902 | 7 | 29 |
| `server/memory_avatar` | 15 | 2,659 | 5 | 13 |
| `server/messaging` | 20 | 4,681 | 1 | 20 |
| `server/middleware` | 1 | 260 | 0 | 4 |
| `server/monitor` | 3 | 502 | 0 | 3 |
| `server/org` | 13 | 6,743 | 0 | 57 |
| `server/output` | 1 | 125 | 0 | 无直接导入关联；仅静态/构建验证 |
| `server/persistence` | 1 | 76 | 0 | 1 |
| `server/personality` | 10 | 3,240 | 0 | 11 |
| `server/regions` | 54 | 17,694 | 13 | 20 |
| `server/relay` | 1 | 111 | 0 | 1 |
| `server/routes` | 26 | 7,368 | -3 | 54 |
| `server/runtime` | 21 | 4,805 | 1 | 41 |
| `server/scene` | 1 | 156 | 0 | 1 |
| `server/scheduler.ts` | 1 | 3,568 | 0 | 8 |
| `server/self_extension` | 7 | 4,495 | 0 | 6 |
| `server/services` | 1 | 54 | 0 | 无直接导入关联；仅静态/构建验证 |
| `server/skills` | 67 | 14,381 | 1009 | 29 |
| `server/socket` | 35 | 19,477 | 63 | 71 |
| `server/stt` | 15 | 3,919 | 0 | 20 |
| `server/time` | 3 | 669 | 0 | 1 |
| `server/tools` | 82 | 31,349 | 2 | 182 |
| `server/tts` | 10 | 1,857 | 0 | 14 |
| `server/utils` | 5 | 635 | 0 | 10 |
| `server/web_login` | 3 | 1,080 | 0 | 3 |
| `server/work_product` | 2 | 1,100 | 0 | 6 |
| `server/work_takeover` | 11 | 4,379 | 5 | 13 |
| `server/workflows` | 2 | 1,753 | 0 | 9 |
| `shared` | 22 | 2,666 | 0 | 37 |
| `src/components` | 139 | 49,985 | 834 | 27 |
| `src/contexts` | 1 | 935 | 0 | 1 |
| `src/core` | 1 | 199 | 0 | 无直接导入关联；仅静态/构建验证 |
| `src/entries` | 5 | 195 | 0 | 无直接导入关联；仅静态/构建验证 |
| `src/hooks` | 21 | 6,018 | 0 | 16 |
| `src/i18n` | 44 | 3,311 | 0 | 10 |
| `src/lib` | 41 | 6,535 | 0 | 44 |
| `src/pets` | 3 | 1,823 | 8 | 无直接导入关联；仅静态/构建验证 |
| `src/platforms` | 1 | 378 | 11 | 无直接导入关联；仅静态/构建验证 |
| `src/services` | 20 | 2,387 | 0 | 15 |
| `src/types` | 3 | 345 | 0 | 无直接导入关联；仅静态/构建验证 |

原生及辅助程序单列：

| 分区 | 验证 | 结果与边界 |
|---|---|---|
| `src-tauri/` | `cargo check --offline --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target-codex-check` | Windows 当前目标通过；没有运行原生 UI、macOS/iOS/Android 实机测试 |
| Laya worker、CAD 矢量化、Whisper、声纹 Python 辅助程序 | 4 个文件 `ast.parse` | 全部语法通过；未启动模型/辅助进程，不等于依赖与设备实测通过 |
| PowerShell 部署/安装检查脚本 | 2 个 Git 跟踪文件用 PowerShell Parser 检查 | 全部语法通过；没有实际执行安装/部署 |
| CSS/HTML 桌面与移动入口 | 两个平台各自生产构建，桌面紧凑布局检查与初始资源预算检查 | 全部通过；桌面初始资源 254.6 KiB gzip，预算 750 KiB |

## 保留的无静态入边文件

| 文件 | 保留依据 |
|---|---|
| `server/skills/bundled/melody/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/stockbot/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/cross-border-trade/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/legal-casework/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/content-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/manufacturing-qa/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/product-project-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/data-bi/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/tools/javascript_sandbox_worker.cjs` | 独立 worker，构建/运行时按路径加载 |
| `server/skills/bundled/property-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/construction-tender-cost/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/admin-assistant/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/design-studio-pack/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/live-commerce/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/logistics-warehouse/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/procurement-supply-chain/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/pdftools/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/insurance-advisor/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/cad-drafting/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/messaging-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/web-scraper/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/email-assistant/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/executive-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/notes/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/education-teacher/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/nanobanana/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/medical-admin/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/image/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/calculator/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/hr-recruiting/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/timer/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/restaurant-store-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/sales-customer-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/password/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/weather/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/qrcode/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/shorturl/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/translator/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/modules.d.ts` | TypeScript 环境声明 |
| `server/autonomy/system_explorer_worker.ts` | 独立 worker，构建/运行时按路径加载 |
| `server/runtime/server_entry.ts` | 后端启动及构建入口 |
| `src/entries/desktop-root.tsx` | HTML/Vite 平台启动入口 |
| `src/entries/mobile-root.tsx` | HTML/Vite 平台启动入口 |
| `src/types/qrcode.d.ts` | TypeScript 环境声明 |
| `server/skills/bundled/ecommerce-ops/index.ts` | 技能 package.json 的 main/start 动态入口 |
| `server/skills/bundled/finance-office/index.ts` | 技能 package.json 的 main/start 动态入口 |

## 完整检查与日志

| 检查 | 结果 | 本地日志 |
|---|---|---|
| 全量现有回归 | 730 文件、6,473 项全部通过 | `.codex-run/cleanup-eighth-full.log`；机器可读 `cleanup-eighth-tests.json` |
| TypeScript / i18n / hooks | 全部通过 | `.codex-run/cleanup-eighth-lint.log` |
| 桌面前端、布局、资源预算 | 全部通过 | `.codex-run/cleanup-eighth-build-ui.log` |
| 移动前端 | 通过 | `.codex-run/cleanup-eighth-build-mobile.log` |
| 后端及 worker | 通过，后端源码指纹 `b694d10bb621` | `.codex-run/cleanup-eighth-build-server.log` |
| Windows 原生编译检查 | 通过 | `.codex-run/cleanup-eighth-rust.log` |
| Python / PowerShell 语法 | 通过 | `.codex-run/cleanup-eighth-python.json` / `cleanup-eighth-powershell.json` |
| 分区到测试文件的对应关系 | 已保存完整名单 | `.codex-run/cleanup-eighth-area-verification.json` |

## 仍须区分的边界

- 删除之后，额外开启 `noUnusedLocals/noUnusedParameters` 的扫描不再发现未使用的私有函数、私有方法和 import。仍有 90 条局部变量及 46 条参数诊断；其中包含初始化调用、React 状态/回调和接口签名，不能仅因返回值未读取就整体删除。它们保留为下一轮逐项审查清单，见 `.codex-run/cleanup-eighth-unused-nodes.json`。常规项目类型检查已通过。
- 兼容用户历史数据的迁移逻辑、动态插件入口、权限边界、取消与清理逻辑继续保留，不能因为名字里有 legacy 或代码较长就删。
- 现有测试未覆盖的行为没有被标成通过；本轮未进行真实聊天、桌面控制、官网接口或外部平台验收。
- 构建完成但未安装、未重启客户端。工作区尚未提交或推送；之前的审计报告与修复保留。

## 行数口径

沿用连续几轮统计口径：第一方源码与脚本，含注释/空行，排除依赖、第三方模型源码、生成产物、运行数据及临时诊断目录；JSON/Markdown 不计入该行数。22 个翻译项与审计报告变化因此另列，不混入源码减量。

| 范围 | 本轮开始 | 本轮结束 | 净减少 |
|---|---:|---:|---:|
| 业务源码与脚本 | 374,217 | 371,752 | 2,465 |
| 测试 | 158,649 | 158,521 | 128 |
| 合计 | 532,866 | 530,273 | 2,593 |

相对连续精简开始的业务源码 382,303 行，目前累计净减少 **10,551 行**。这个累计数包含前几轮，不是本轮单独成果。
