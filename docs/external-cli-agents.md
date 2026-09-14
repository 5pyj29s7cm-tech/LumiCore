# Codex CLI / Claude Code 接入

Lumi 可以把一个明确授权的任务交给本机 Codex CLI 或 Claude Code。它们作为现有任务中的工具执行，沿用同一套权限检查、进度、取消、结果记录和文件归档，不创建第二套任务调度器。

用户可以说：

- `让 Codex CLI 检查 D:\项目\demo，只审查，不修改。`
- `用 Claude Code 修改 D:\项目\demo 中的这个问题，运行相关测试。`
- `继续刚才 Codex 的任务，把结果整理成文件。`

第一次调用需要明确工作目录。继续时使用 Lumi 返回的 `runId`，由后端读取对应 CLI 会话编号；不得使用 CLI 的全局“最近一次会话”。

## 工具与结果

| 工具 | 行为 |
| --- | --- |
| `external_cli_status` | 检查安装、版本和登录；不发送模型任务，也不能证明额度充足 |
| `external_cli_run` | 执行或接续任务，持续报告进度，最多 15 分钟 |
| `external_cli_get_run` | 读取所属用户/工作域的完整结果，包括失败、取消和部分产物 |

CLI 正常退出且返回成功的终结事件，才记为执行完成。Codex 的中间重连错误不会覆盖随后成功的终结事件。CLI 完成只证明收到结果，代码质量和业务目标仍需 Lumi 另行验收。

分享用的文件写入本次分配的 `Lumi output directory`。后端比较前后文件内容，只收集实际新增或修改的文件；符号链接、硬链接、超大文件及纯文本中声称的路径不会成为附件。成功回执通过既有聊天附件与生成资料库流程保存。取消和失败保留回执及部分产物信息，不会把部分产物标成已完成交付。

## 安装与配置

默认发现 PATH 中的原生 CLI、常用 npm 安装目录和 Lumi 专用目录。Windows 下优先寻找 `%LOCALAPPDATA%\LumiCore\cli-tools\codex` 中安装的 Codex 包，不覆盖全局 CLI。

可在后端进程环境中指定 `LUMI_CODEX_CLI_PATH` 或 `LUMI_CLAUDE_CLI_PATH`，值必须为 CLI 可执行文件或 Node 入口脚本的绝对路径。不会执行 `.cmd`、`.bat`、`.ps1` 包装器；npm 包会解析为已知的原生程序或 Node 入口。提示词通过 stdin 传递，不拼接进 shell 命令。

使用 CLI 自己的账号与配置，不自动使用 Lumi 官方模型接口，也不更改全局模型、API 地址或推理强度。Claude Code 可以配置其他兼容服务，工具名称不代表其当前使用的是 Anthropic 模型。CLI 登录成功与模型调用成功分别核验。

本机验证发现旧 Codex CLI 0.125.0 无法读取现有 `ultra` 配置，因此另外安装了 0.154.0；全局配置未修改。Claude Code 2.1.234 当前配置的 DeepSeek 接口返回 `402 Insufficient Balance`，保留配置，未切换账号。

## 执行边界

- 仅在已认证的本机执行上下文或可信系统上下文运行；远程受限入口不可继承本机 CLI 账号。
- 隐私严格模式禁止外部 CLI 调用。
- 默认只读，编辑需选择 `workspace-write` 并经过现有授权流程。Codex 使用其沙箱；Claude 的工具权限不是操作系统级文件沙箱。
- 同一工作目录及相互包含的目录，不允许两项 CLI 工作同时执行。
- 取消/超时终止本次拥有的进程树，等待真实退出再解除占用；不得终止其他 CLI 会话。
- 不自动重发失败请求。后端重启后残留的“运行中”记录标为中断，需要先检查结果。

官方调用文档：[Codex 非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude Code 编程调用](https://code.claude.com/docs/en/headless)。
