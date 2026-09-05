# Lumi 子程序发布列车

Lumi 主程序维护通用核心能力；设计、电商、财税、法律等子程序在独立私有仓库中维护行业功能。所有子程序保留共同 Git 历史，并通过 `.lumi/variant.json` 记录来源、真实交付分支、核心同步基线和发布门禁。

## 元数据是唯一事实来源

schema v2 明确区分三类分支：

- `upstream.branch`：要继承的 Lumi 核心分支，通常是 `main`。
- `delivery.localBranch`：当前子程序 worktree 的真实本地交付分支，可以是 `variant/*`，也可以是历史遗留的 `feature/*`。
- `delivery.remoteBranch`：子程序仓库接收正式交付的远端分支。
- `delivery.defaultBranch`：用户打开仓库时看到的默认分支，通常是 `main`。

管理器扫描所有 Git worktree，再读取其中的 `.lumi/variant.json` 发现子程序；不再用 `variant/<id>` 的命名猜测子程序身份。如果审查用的 detached worktree 保留了同一子程序元数据，管理器优先使用元数据指定交付分支上的唯一正式 worktree；单独的 detached 子程序仍会列出以诊断分支状态，身份冲突或多个交付候选仍会阻断。旧 schema v1 会被只读兼容，并在下一次成功同步时升级为 v2。

## 创建子程序

先在 GitHub 新建空的私有仓库，不初始化 README、许可证或 `.gitignore`。随后在主程序 `main` 的干净工作区运行：

```powershell
npm run variant:new -- `
  --name "Lumi CAD 客户版" `
  --id cad-client `
  --repo https://github.com/你的账号/lumi-cad-client.git
```

命令会创建独立 worktree、schema v2 元数据和 VS Code 工作区，运行 lint、全量测试、build 三道门禁后才推送子仓 `main`。`--skip-install`、`--skip-push` 和 `--skip-open` 只用于初始化诊断；正式发布不能跳过门禁。

## 查看整条发布列车

```powershell
npm run variant:status
npm run variant:status -- --fetch
npm run variant:status -- --id ecommerce-client
npm run variant:status -- --verify
```

默认一次列出所有由元数据发现的子程序，包括：

- 当前核心提交、`lastSyncedCommit` 和落后提交数；
- 本地/远端/默认分支及各自提交；
- worktree 是否干净、历史是否分叉、交付提交是否已推送；
- `ready`、`needs_core_sync`、`default_branch_stale`、`blocked` 等明确状态；
- lint/test/build 最近是否真正执行。本次未运行时会明确标记为 `not_run`。

`--fetch` 会更新远端引用；不加时完全使用本地已知引用。`--verify` 只运行门禁，不写 Git 历史。

## 先预演，再同步

单个子程序：

```powershell
npm run variant:sync -- --id legal-client --dry-run
npm run variant:sync -- --id legal-client
```

全部子程序：

```powershell
npm run variant:sync -- --all --dry-run
npm run variant:sync -- --all
```

dry-run 不 fetch、不 pull、不改工作区、索引、分支或元数据，也不运行门禁和发布命令；它会在隔离的临时对象库中调用 Git 的真实三方合并算法，提前给出 `mergePreview` 和 `core_merge_conflict_preview`，预演产生的对象随后删除。正式 `--all` 会先完成所有子程序的本地合并与三道门禁，只有全部通过后才进入推送阶段；如果本地阶段任一子程序失败，本轮已经开始处理的所有子程序都会恢复到运行前 SHA。命令启动前仍强制要求每个 worktree 干净，因此不会覆盖用户预存的未提交文件。

跨仓远端无法组成一个原子 Git 事务。管理器会在第一次真实 push 前，对所有子仓执行只读 push 预检，以尽早发现权限、非快进或分支问题；随后逐仓推送。推送阶段每完成一个仓库都会原子更新主仓 Git 目录下的 `lumi/variant-release-state.json`。如果网络或远端在中途失败，命令会输出 `partial_remote_publish`、各仓 `remoteBefore`/`targetCommit`/状态和确定的重跑命令，并保留已经验证的本地提交；若断网导致远端状态无法复核，则保守标记 `remote_state_unknown`，不会误回滚可能已经发布的提交或删除恢复证据。按回执重跑会跳过已对齐仓库并继续未完成仓库，全部完成后自动删除恢复文件。

`--no-push` 可以完成本地合并、元数据升级和门禁，但不写远端。正式同步不接受 `--skip-verify`。

## 修正过期的远端默认分支

如果真实能力位于交付分支，而仓库默认 `main` 仍是旧初始化提交，先完成正常同步和推送，再执行：

```powershell
npm run variant:publish-default -- --id ecommerce-client --dry-run
npm run variant:publish-default -- --id ecommerce-client
```

该命令只允许安全快进：

1. 当前 worktree 必须干净并处于元数据指定的本地交付分支；
2. 当前提交必须已经存在于元数据指定的远端交付分支；
3. 远端默认分支必须是当前交付提交的祖先；
4. lint、全量测试、build 必须全部通过；
5. 使用普通 push 快进默认分支，绝不 force push；成功后把元数据与本地 tracking 切到默认分支。

如果默认分支与交付历史已经分叉，命令会明确阻断，必须人工审查历史；它不会覆盖任何一侧。

默认分支对齐所需的元数据提交属于发布事务：门禁失败或远端未接受 push 时，工作区会自动恢复到命令开始前的 SHA，不会留下把下一次重试阻断在错误交付分支上的临时提交。若远端已经接受提交但客户端只在 tracking 更新阶段失败，回执会标记 `published_tracking_pending`；重跑只修复 tracking，不会再创建元数据提交。

## 子程序能力反哺主程序

把通用修改做成独立的线性提交，再运行：

```powershell
npm run variant:promote -- `
  --id cad-client `
  --commits abc1234,def5678
```

管理器只接受已经存在于元数据所指远端交付分支的非合并提交。它会从主程序 `main` 创建 `integrate/<子程序>-<提交号>`，cherry-pick 后运行 lint、全量测试、build，再推送集成分支并输出 Pull Request 地址；不会直接写入主程序 `main`。

## 失败恢复

- `variant:new` 不覆盖非空仓库，也不替换指向不同地址的远端。
- `variant:sync --dry-run` 会先报告真实三方合并冲突；正式 `--all` 的本地合并或门禁失败会自动恢复本轮所有已处理子程序，并在结构化回执中列出每个恢复后的 SHA。
- 推送预检失败时不会开始任何远端写入，并会回滚本地发布列车。逐仓真实推送中断时不要手工猜测或回退已经发布的仓库；读取 `partial_remote_publish` 回执或恢复文件，修复网络/权限后执行其中的重跑命令。
- `variant:publish-default` 的门禁或 push 失败会自动移除临时元数据提交；修复原因后直接重跑。
- `variant:promote` 冲突时保留集成分支；审查后使用 `git cherry-pick --continue`，或确认放弃后 abort 并切回 `main`。
- 事务回滚只把命令开始时已确认干净的目标 worktree 恢复到已记录 SHA；任何命令都不会自动删除 worktree、仓库、分支或用户未提交文件。

## 开发边界

- 行业界面、业务流程、行业技能、交付配置和适配器留在子仓库。
- 可复用核心能力与客户专属修改必须分开提交。
- 不在子仓库重写身份隔离、记忆隔离、安全确认、统一回执和模型路由底层。
- 不提交客户数据、数据库、日志、语音、安装包、API 密钥或其他凭据。

## 可验证的同步门禁

```powershell
npm run variant:check
```

该命令强制刷新主核与每个子仓的实时远端头，并要求所有子程序同时满足：已吸收当前主核提交、本地交付提交与远端交付提交完全一致、默认分支已对齐，以及当前提交组合存在 lint/test/build 全通过的持久化回执。普通 `variant:status` 只使用缓存远端时，不会把旧回执报告为当前通过，而是返回 `remote_check_required`。

`variant:new`、正式 `variant:sync`、`variant:publish-default` 和 `variant:status --verify` 会在主仓 Git 公共目录的 `lumi/variant-gate-receipts/` 中原子记录回执。回执绑定主核 SHA、子程序 SHA、实时远端 SHA、每项门禁耗时和 SHA-256 完整性摘要；任一提交变化、远端前移、门禁缺失或回执损坏都会使严格检查失败。回执不写入产品仓库，也不包含凭据。
