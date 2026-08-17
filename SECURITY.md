# Security Policy

## Supported versions

安全修复优先覆盖 `main` 和最新公开发行版。旧预览安装包可能不再回补，请先升级后复现。

## Reporting a vulnerability

请不要在公开 Issue、Discussion、Pull Request 或聊天截图中披露漏洞细节、API Key、访问令牌、客户数据或可识别个人的信息。

请发送邮件至 `3565286431@qq.com`，标题以 `[LumiOS Security]` 开头，并包含：

- 受影响版本或提交；
- 影响范围和攻击前提；
- 最小复现步骤；
- 建议的缓解方式；
- 是否已经在其他地方公开。

维护者会先确认收到报告，再评估修复与披露时间。不要在未协调前测试不属于你的账号、设备或数据。

## Secret handling

- 凭据只允许通过本地配置、操作系统密钥存储或 GitHub Secrets 注入。
- `.env`、`data/keys.json`、`server/mcp/config.json`、数据库、日志和运行时资料不得提交。
- 一旦密钥进入 Git 历史，应立即撤销或轮换；删除当前文件不能消除历史泄露。
- 官网与桌面应用运行时必须隔离，公开站点不得访问用户数据库、模型密钥或桌面控制接口。
