# 第二轮全仓死代码检查：无效状态与旧调用链

日期：2026-09-28。仓库：`D:/lumiOS`。承接[上一轮报告](./20260928-whole-repository-deletion-audit.md)。

本轮业务源码与脚本净减少 **713 行**，未新增运行模块或抽象层。业务源码现为 **371,039 行**；相对连续精简开始的 382,303 行，累计净减少 **11,264 行**。

## 实际删除与影响

| 分区 | 删除内容 | 保留与验证边界 |
|---|---|---|
| 聊天 | 删除只写不读的 `workflowSteps` React 状态、对应 setter、工具事件步骤副本和每轮步骤副本 | 聊天消息、用户可见进度、任务请求归属、完成证据、取消状态、错误提示仍走原有现用链路；减少无意义的数组复制与状态更新 |
| 移动端 | 删除未显示的时钟、每秒计时器、没有入口的旧控制中心切换、旧主题状态和空语音回复回调；移除永远为 false 的局部静音状态 | 导航、语音按钮和音效服务保留；没有删除音效服务自身的全局声音设置 |
| 形象与声纹界面 | 删除未参与渲染的悬停状态及更新事件、只累计不读取的声纹帧计数 | CSS 悬停样式、实际声纹模板、可用模板计数和声纹验证保留 |
| 记忆树 | 删除 `TimelineTransitionController.tsx` 和 `useMemoryFilter.ts` 两个仅从 barrel 导出、没有页面调用的旧文件 | 知识库实际使用的 `MemoryTreeScene`、搜索、节点布局和点击处理保留 |
| 传感器 | 删除 `initMediaPipe` 旧手部/简单人脸初始化、检测器及对应模型常量/类型/状态 | 全仓调用核对确认没有消费者；现用 `acquireFaceLandmarker`、`detectFaceLandmarks`、`extractFaceEmbedding`、摄像头权限和引用释放保留 |
| 主动提示 | 删除 `server/context/proactive_triggers.ts` 及语音对它的无效上下文拼接 | 唯一写入缓存的 `processActivityEvent` 没有生产调用，因此该缓存读路径始终无数据。现用主动语音、问候与提醒继续使用 `proactive:configure`、`proactive:request_speak` 等链路 |
| 法律、业务与设置界面 | 清理无用的局部翻译闭包、仅为闭包保留的语言变量、法律面板不再使用的翻译参数/props/依赖 | 文案已经由现用国际化接口提供。法律面板重复渲染的隔离检查在清理前后均通过；未将其误报为本轮新修复的请求循环问题 |
| 执行与工作流 | 删除只计算不读取的工具名列表、路由集合、旧上下文拼接以及未被使用的不确定回执局部副本 | 实际执行策略、回执、幂等确认和工作流核验逻辑保留 |

以上删除依据是实际调用、作用域内引用、初始化副作用和入口核对，不是只按名字或行数。构建/编译过程中发现仍被现用分支使用的声明会保留；不把诊断候选直接当作删除清单。

## 检查范围和保留项

- 扫描导出函数及变量，再核对动态 import、解构调用和 barrel 转导出。静态扫描对动态解构、公开测试辅助接口等会产生候选误报，未据此批量删除。
- 删除后 1,063 个第一方 JS/TS 文件在保守入口图中均可达；46 个无静态入边文件仍为技能入口、worker、平台根入口或类型声明，分类沿用上一轮。
- 普通常规类型检查通过。额外未使用检查还剩 41 条局部变量、42 条参数诊断；有些调用承担校验/资源或接口作用，继续保留逐项审查，不为清零诊断删除权限校验、模型 getter 或异步结果消费。

## 验证结果

- 全量现有回归第一次执行 730 个文件、6473 项：6472 项通过，1 项源代码断言还期待已经删除的旧上下文变量名。更新该断言中的入口列表后，相关 3 个文件、36 项复验全部通过。最终所有 6473 项均有通过结果；原始失败日志保留，没有伪造全量首次通过记录。
- `npm run lint` 通过：TypeScript、国际化、hooks 检查均通过。
- 桌面端、移动端和后端生产构建通过；桌面紧凑布局和首屏资源预算检查通过。
- 后端构建源码指纹：`67cb30136248`。
- `git diff --check` 通过。没有改 Rust/Python/部署脚本，本轮没有重复运行上一轮已经通过的原生编译与辅助脚本检查。
- 没有新增长期测试文件；保留原测试数量。`client_runtime_resources.test.ts` 只移除针对已删除旧初始化器的源码切片/否定断言，现用人脸生命周期断言保留。

日志：

- `.codex-run/cleanup-ninth-full.log`、`cleanup-ninth-tests.json`：全量原始结果。
- `.codex-run/cleanup-ninth-focused.log`、`cleanup-ninth-focused-tests.json`：复验结果。
- `.codex-run/cleanup-ninth-verification.json`：按测试文件合并最新结果，保留首次失败与复验来源。
- `.codex-run/cleanup-ninth-lint.log`、`cleanup-ninth-build-ui.log`、`cleanup-ninth-build-mobile.log`、`cleanup-ninth-build-server.log`。

## 行数

统计口径与上一轮一致：第一方源码/脚本，含注释及空行，排除依赖、运行数据、构建产物、临时诊断目录；JSON/Markdown 不计入。

| 范围 | 本轮前 | 本轮后 | 净减少 |
|---|---:|---:|---:|
| 业务源码与脚本 | 371,752 | 371,039 | 713 |
| 测试 | 158,521 | 158,516 | 5 |
| 合计 | 530,273 | 529,555 | 718 |

已修改文件中主要减少项（整文件删除见上表）：

| 文件 | 本轮净减少行数 |
|---|---:|
| `src/components/AgentChatPage.tsx` | 93 |
| `src/lib/mediapipe/loader.ts` | 82 |
| `server/socket/voice.ts` | 21 |
| `src/components/org/LegalHub.tsx` | 17 |
| `src/components/Settings.tsx` | 17 |
| `src/platforms/mobile/MobilePlatform.tsx` | 16 |
| `src/components/DeviceSyncCenter.tsx` | 7 |
| `server/workflows/runtime.ts` | 5 |
| `src/hooks/useVoiceprint.ts` | 5 |
| `src/components/org/DesignHub.tsx` | 4 |
| `src/components/PersonalityEvolution.tsx` | 3 |
| `src/components/AvatarStudio.tsx` | 3 |

这次完成的是死代码与无效状态清理后的回归验证，不是所有功能的真实客户端验收。未实测官网模型接口、桌面软件操作、直播或媒体制作；没有提交、推送、安装或重启客户端。之前的修复和审计记录继续保留。
