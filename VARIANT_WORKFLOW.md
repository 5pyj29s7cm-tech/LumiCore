# Lumi 子程序生产流程

Lumi 主程序只维护通用底层能力；律师、CAD 等定制版从主程序稳定提交创建，在独立私有仓库中维护。每个子程序保留共同 Git 历史、独立远程仓库和 `.lumi/variant.json` 来源记录。

## 准备工作

1. 在 GitHub 新建一个空的私有仓库，不要初始化 README、许可证或 `.gitignore`。
2. 在主程序 `main` 工作区运行命令；主程序和目标子程序都必须没有未提交修改。
3. Git 和 GitHub 凭据必须已经登录。GitHub 子仓库默认关闭 Actions，避免继承主程序安装包流水线；确实需要时才使用 `--keep-actions`。

## 创建一个子程序

交互式运行：

```powershell
npm run variant:new
```

或一次性提供参数：

```powershell
npm run variant:new -- `
  --name "Lumi CAD 客户版" `
  --id cad-client `
  --repo https://github.com/你的账号/lumi-cad-client.git
```

命令会自动：

- 更新主程序 `origin/main`，并从当前稳定提交创建 `variant/<英文代号>`；
- 在主程序同级的 `lumiOS-variants/lumi-<英文代号>` 创建 Git Worktree；
- 写入来源、基线版本、同步策略和独立仓库地址；
- 生成独立 VS Code 工作区并安装依赖；
- 添加同名子仓库远程、提交初始化记录、推送到子仓库 `main`；
- 打开新的 VS Code 窗口。

诊断时可使用 `--skip-install`、`--skip-push` 或 `--skip-open`。这些参数不会降低仓库私有性和防覆盖检查。

## 主程序升级到子程序

```powershell
npm run variant:sync -- --id cad-client
```

命令会拉取主仓库和子仓库的 `main`，将主程序 `main` 合并到子程序，更新来源记录，运行代码检查与全量测试，通过后才推送子仓库。发生合并冲突或测试失败时停止推送，保留现场供维护人员处理。

`--skip-verify` 只用于本地诊断，不应作为发布或交付依据。

## 子程序通用能力反哺主程序

先把通用修改做成独立的线性提交，再运行：

```powershell
npm run variant:promote -- `
  --id cad-client `
  --commits abc1234,def5678
```

命令只接受已经存在于该子仓库 `main` 的非合并提交。它会从主程序 `main` 创建 `integrate/<英文代号>-<提交号>`，按顺序 cherry-pick，运行代码检查与全量测试，推送集成分支并输出 Pull Request 地址。最终仍需代码审查和 PR 合并，不能直接写入主程序 `main`。

## 开发边界

- 客户界面、行业流程、行业技能、交付配置和适配器留在子仓库。
- 可复用能力与客户专属修改必须分开提交；建议通用提交使用 `contrib/*` 分支。
- 不在子仓库重写 Lumi 的身份隔离、记忆隔离、安全确认、统一回执和模型路由底层。
- 不提交客户数据、数据库、日志、语音、安装包、API 密钥或其他凭据。
- 主程序只从已审查的具体提交反哺，不直接合并整个子程序分支。

## 失败恢复

- `variant:new` 中断后可用相同参数重试；脚本不会覆盖非空仓库或替换指向不同地址的远程。
- `variant:sync` 发生冲突时，在子程序工作区解决并完成合并；不想继续时由维护人员确认后执行 `git merge --abort`。
- `variant:promote` 发生 cherry-pick 冲突时，主工作区会保留在集成分支；解决后运行 `git cherry-pick --continue`，或确认放弃后运行 `git cherry-pick --abort` 并切回 `main`。
- 任何命令都不会自动删除分支、Worktree、仓库或未提交文件。
