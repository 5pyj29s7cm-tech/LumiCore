# 本地 Laya 对照接入

目前仅支持 `shadow`：本地模型给出旁路判断，正式任务仍由 Lumi 的统一流程控制。Laya 的结果不会进入提示词、不会选择工具、不会更改权限或任务状态。2026-09-23 的初次合成用例测试未达到接管标准，因此没有启用自动决策模式。

## 配置

在 Lumi 数据目录的 `data/laya-shadow.json` 写入：

```json
{
  "enabled": true,
  "mode": "shadow",
  "pythonPath": "D:/your-laya-venv/Scripts/python.exe",
  "modelPath": "D:/models/laya-multilingual"
}
```

Python 环境需要 `laya==0.3.7` 和兼容的 CPU PyTorch；模型目录需要完整的多语言权重、配置及 tokenizer。测试使用 `convaiinnovations/laya-multilingual` 的固定版本 `b4a904d1a2a54c822b829e24291d4b8f280fe43e`。安装包携带通信脚本，不捆绑 Python 环境或模型权重。

也可通过 `LUMI_LAYA_CONFIG` 指定独立配置文件，便于隔离测试。配置最多 8 KB，每 10 秒重读一次。将 `enabled` 改为 `false` 后，下次调用或诊断读取会停止旁路进程。未配置默认关闭。保持文件仅由本机受信任账户修改，因为它指定要运行的本地 Python 程序。

## 运行方式

- 文字、语音和其他采用统一执行管线的入口共用一个观察器，来宾受限会话不发送样本。
- 只经标准输入输出连接本机子进程，不开放端口，不调用云端 API，不自动下载模型。
- CPU 4 线程；最多一个正在执行的观察请求，繁忙时跳过，不积压。
- 冷启动最多 30 秒，单次判断最多 2 秒；失败停止子进程、冷却 30 秒。正式请求始终不等待模型返回。
- 无输入截断：超长样本跳过；Python 端再次核对 token 长度，超出上下文则拒绝。
- 空闲 5 分钟或后端退出会释放子进程。
- 不把聊天原文和任务资料写入日志；只在内存保留计数和最近一次判断摘要。程序退出后统计清空，不进入个人记忆、知识库或技能训练。

`getCapabilityRuntimeMetrics().layaShadow` 可通过现有本机详细健康诊断查看状态、成功数、跳过数、分歧数和最后一次耗时。`controlsExecution` 固定为 `false`。分歧不等于 Laya 正确，也不等于主程序错误。

## 复测

```powershell
node scripts/run-vitest.mjs test/laya_shadow.test.ts test/decision_continuity_regression.test.ts
```

正式接管前必须另做标注训练、独立验证、当前模型版本与中文业务评估、选项顺序稳定性检查及真实执行验收。现有权限、确认、任务编号、取消和完成回执必须始终由主程序管理。
