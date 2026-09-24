# Laya 本地任务接续试验

这是离线实验工具，不由主程序导入，不产生工具调用，不修改生产配置。
它只判断：本轮话语是否明确要求继续、重试或修改给定的已有任务。
`OTHER` 不代表可以忽略用户，也不表示禁止新任务；它只表示不能接续这一项旧任务。

## 2026-09-24 结果

本轮未达到启用标准。固定的 60 条合成验收案例中，原始模型答对 38 条，
仅训练评分层的版本答对 35 条，出现 5 次错误的接续判断，漏掉 20 次真正的接续要求。
选项交换顺序后有 9 条判断改变。按调参阶段固定的置信门槛，仅接受 5/60 条，
其中真正的接续只识别出 1/26 条。不能用这 5 条的正确率代替整体准确率。

实验模型没有启用，仍无执行权限。这个结论仅针对当前权重、评分层训练方法、
输入形式和样本；没有证明 Laya 的其他训练方法也不行。

## 数据与验证

- 114 条人工编写的合成训练样本，24 条调参样本，60 条保留验收样本。
- 按任务领域隔离：训练为表格、音乐播放、文档、网站；调参为归档、演示稿；
  验收为视频、图片、文件整理。各组还含没有已有任务的边界案例。
- 输入只保留当前话语和任务目标。编号、标签、分类、样本状态不输入模型。
- 标签由编写实验的同一作者给出，没有独立人工复核，也没有真实用户会话验收。
- 编码器、两层 Transformer 和其余参数冻结，仅训练 592,897 个评分层参数。
- 两种选项顺序都参与训练和验收；验收时分别报告准确率、误接续、漏接续和拒答比例。
- 使用调参交叉熵选检查点，温度和拒答门槛也只根据调参集确定。
- `fit` 不读验收文件；`evaluate` 验证冻结文件的散列，并拒绝覆盖已有验收结果。
- 重载评分层的输出与保存前一致；原始模型权重未改动。

本地实验目录：`D:/LumiCore-Decision-Eval/20260924/continuation-v2`

检查点与结果目录：`D:/LumiCore-Decision-Eval/20260924/continuation-v2-fit`

报告：`D:/LumiCore-Audit-Reports/20260924/model-latency/Laya本地接续训练验收.md`

## 复现

使用已安装 Laya、PyTorch 和 safetensors 的 Python 环境以及本地模型目录。
所有模型加载均强制离线，CPU 使用 4 个线程，不下载模型。模型输出不接入生产裁决。

```powershell
python scripts/laya/test_continuation_experiment.py
python scripts/laya/build_continuation_dataset.py D:/new-experiment/data
python scripts/laya/continuation_experiment.py fit --data D:/new-experiment/data --out D:/new-experiment/result --base D:/local-laya-model
python scripts/laya/continuation_experiment.py evaluate --data D:/new-experiment/data --out D:/new-experiment/result --base D:/local-laya-model
```

这些脚本可以复现已知实验，不应把再次运行相同验收集描述成新的独立验收。
如改变训练方法，应事先准备新的验收集，保留本轮失败结果，不围绕这 60 条反复调整。
