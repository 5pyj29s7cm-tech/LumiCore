# 删除无用代码记录

日期：2026-09-25。执行用户“从现在开始的工作就是删代码”的要求。

## 撤回纯拆分

已先校验第六批拆分后没有后续业务改动，再从该批开始前的工作区快照恢复 `scheduler.ts`、`action_contract.ts`、`result_finalizer.ts`。未使用 Git HEAD 覆盖这些源文件，前五批修复保留。

删除第六批新增的 19 个拆分模块，撤回 475 行结构开销；恢复拆分前的测试检查方式，移除仅验证拆分结构的新增测试，保留原有业务回归。第六批报告已标记撤回，原始审计内容保留。

## 新删除的代码

本批额外删除 22 个无调用文件，共 1,069 行：

- 根目录 `components/ui/` 的 12 个重复、未接入组件：avatar、badge、button、card、dialog、input、scroll-area、separator、sheet、slider、tabs、textarea。
- 根目录 `lib/utils.ts`：未被引用的重复工具文件。TypeScript、Vite 和组件生成配置中的 `@/` 均指向 `src/`，实际使用的 `src/lib/utils.ts` 保留。
- `src/components/ui/` 中未使用的 badge、tabs、textarea 三个组件。
- `src/components/LumiCharacterPortrait.tsx`：无调用的旧转发文件，实际人物呈现组件保留。
- `server/regions/packs/cn/task_completion_feedback_messages.ts`：无调用的旧结果反馈文案封装。
- `server/legal/types.ts`：无调用的旧模型常量。
- `server/output/index.ts`、`server/context/index.ts`、`server/socket/self_intro_demo.ts`：无调用的转发文件，调用方使用的实际实现保留。

另删 25 行未使用代码：`action_contract.ts` 中无引用的私有目标匹配函数，以及 `scheduler.ts` 中从未调用、从未读取的模型 getter setter/成员和无用导入。合计额外净删 **1,094 行源码**，没有新增运行代码或抽象层。

删除依据为模块依赖、符号/路径搜索、构建别名、运行入口及测试引用核对。文件由显式路径逐个删除；删除前校验绝对路径仍在 `D:\lumiOS` 内。并未把动态加载的技能或 worker 当成无用模块删除。

## 统计口径

沿用前几批第一方源码统计，含注释和空行，排除第三方源码、依赖、生成产物、运行数据与临时验证目录。

| 范围 | 本轮开始 | 删除后 | 净减少 |
|---|---:|---:|---:|
| 源码与脚本 | 375,786 | 374,217 | 1,569 |
| 测试 | 158,725 | 158,649 | 76 |
| 合计 | 534,511 | 532,866 | 1,645 |

源码减少由 **475 行撤回 + 1,094 行新删除** 组成，分别列出避免重复计算。相对第六批拆分之前，源码和含测试总量均净减少 1,094 行。

## 验证结果

- 现有 **732 个测试文件、6,480 项测试全部通过**，日志 `.codex-run/cleanup-seventh-full.log`；没有新增测试代码，也没有删掉前五批的业务测试。
- 类型检查、国际化与 hooks 检查通过，日志 `.codex-run/cleanup-seventh-lint.log`。
- 前端和后端构建通过；后端源指纹 `80d0aea43e99`。日志为 `.codex-run/cleanup-seventh-build-ui.log`、`.codex-run/cleanup-seventh-build-server.log`。
- 分区大纲与逐文件索引已按删除后的真实路径更新，路径校验通过。
- 测试结束后重新统计，确认源码 374,217 行、测试 158,649 行，见 `.codex-run/cleanup-seventh-counts.json`。相对本次连续精简最初的 382,303 行，源码累计净减少 **8,086 行**。

仅进行隔离的自动回归与构建，未进行真实客户端交互验收；未提交、推送或重启客户端。
