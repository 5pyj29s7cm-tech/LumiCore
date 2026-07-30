# Lumi Extension API v1

Lumi 扩展是签名的声明式连接定义，不是可在 Lumi 进程中执行的第三方代码。API v1 支持：

- OpenAI-compatible 模型 Provider；
- 通过固定 HTTPS/loopback endpoint 调用的 HTTP 工具；
- 同时包含 Provider 和工具的 hybrid 扩展。

## 身份与签名

- `id` 必须使用 `ext_` 命名空间。
- `schemaVersion` 和 `extensionApiVersion` 均为 `1`。
- 发布者使用 Ed25519；首次信任需要对精确清单确认。
- 同一扩展 ID 的签名密钥不可在普通升级中更换，同一版本的清单摘要不可变化。
- 签名覆盖 Lumi 将执行的规范化清单；`signature` 字段本身不进入签名。

生成密钥并签名：

```powershell
openssl genpkey -algorithm Ed25519 -out publisher-private.pem
npm run extension:sign -- --manifest manifest.json --private-key publisher-private.pem --out manifest.signed.json
```

私钥只保留在发布者侧。签名工具会把公钥写入清单，但不会把私钥或 API 密钥写入清单。

## 权限模型

清单必须明确声明：

- `networkOrigins`：精确 origin；公网必须 HTTPS；
- `credentialRefs`：本地凭据库/环境变量名称，不是凭据值；
- `localNetwork`：访问 loopback/私网时显式开启；
- `maxRequestBytes`、`maxResponseBytes`、`timeoutMs`、`maxConcurrency`。

运行时禁止重定向，检查 DNS 解析地址并阻止未授权私网/链路本地目标。工具不能声明文件系统、进程、Shell、安装器或桌面控制能力。

## Provider

Provider 必须声明：

- 与扩展 ID 相同的 `provider.id`；
- `protocol: "openai-compatible"`；
- 精确 `baseUrl` 和固定 `modelsPath`；
- `auth: none | bearer`，bearer 只引用 `credentialRef`；
- 默认模型以及每个模型的 text/vision/tools/json/streaming 能力。

激活前 Lumi 会读取模型列表并确认默认模型真实存在。运行时请求仍经过隐私策略、固定/回退路由、超时、字节/并发预算和模型路由回执。

## HTTP 工具

每个工具必须声明 JSON Schema、权限、安全等级、固定 endpoint、能力 lane/operation/risk、副作用和必需验证字段。

- 读取/测试不能声明外部提交。
- 外部状态变更或通信必须 `securityLevel: confirm`。
- 未确认的外发不会执行。
- 超时或未知结果使用相同幂等键做只读 reconciliation；不能确认时停止，不能重发。
- 工具结果附带 extension ID/version、revision ID、manifest digest、signer fingerprint 和 endpoint origin。

## 生命周期工具

- `extension_registry_list`
- `extension_registry_install`
- `extension_registry_test`
- `extension_registry_rollback`
- `extension_registry_disable`
- `extension_registry_receipts`

安装、回滚和停用需要确认。修订、发布者信任和生命周期回执持久化在 SQLite；启动时重新验证签名、摘要和信任后才恢复工具/Provider。

## 明确不支持

- 任意第三方代码加载；
- 清单内 API key、token、cookie、密码或自定义 Authorization header；
- 动态 URL、路径穿越、query/fragment 注入或跨 origin 跳转；
- 绕过 Lumi 的工具策略、确认、幂等、回执或隐私模式；
- 未经审查的发布者密钥轮换。
