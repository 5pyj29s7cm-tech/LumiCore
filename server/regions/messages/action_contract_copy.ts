export const CN_ACTION_CONTRACT_COPY = {
  "legalDocument": {
    "label": "法律文书/代理词",
    "coreAction": "以三段论为核心基础，基于用户提供的事实和文件起草或审阅法律文书",
    "preparationIsNotCompletion": [
      "法律常识说明",
      "列大纲",
      "没有读到案情材料",
      "外部平台检索行动单不等于已完成查询或立案"
    ],
    "requiredEvidence": [
      "draft/review text grounded in supplied facts",
      "现行有效法律核验 gate 通过",
      "三段论推理链/法律依据-事实证据-涵摄结论证据",
      "文书文件路径或明确的审阅意见",
      "外部平台结果需要授权会话/API 证据、来源登记或入案归档"
    ],
    "nextStep": "先拿到事实、证据、诉讼目标和管辖等信息，再起草或审阅。"
  },
  "artifactWork": {
    "label": "文件/产物交付",
    "coreAction": "生成、读取或修改实际文件产物",
    "preparationIsNotCompletion": [
      "写出大纲",
      "只有文本说明",
      "只列出文件夹"
    ],
    "requiredEvidence": [
      "file path exists with expected content/nonzero size",
      "或工作产物验收通过"
    ],
    "nextStep": "执行文件生成/读取工具并验证产物。",
    "caution": "不能把聊天文本或计划说成已写入文件。"
  },
  "currentAppMutation": {
    "label": "当前应用内的可见编辑",
    "coreAction": "在恢复的目标应用前台执行新建、输入/粘贴和保存等用户要求的可见操作",
    "preparationIsNotCompletion": [
      "只打开或聚焦目标应用",
      "只按下新建快捷键",
      "只生成项目目录下的本地文本文件",
      "操作后没有新的窗口/OCR/控件快照验证"
    ],
    "requiredEvidence": [
      "匹配 appTarget 的前台窗口证据",
      "匹配请求的 UI 新建与输入/粘贴动作回执",
      "核心动作之后的窗口/OCR/控件快照验证",
      "若声称已保存，还需要保存动作和保存后的文档证据"
    ],
    "nextStep": "先确认恢复的 appTarget 正在前台，执行真实 UI 新建与输入，再做事后可见验证；验证失败就如实报告阻塞。",
    "caution": "项目目录下的 write_file 不能证明内容已写入目标应用；OCR/回执明确说未打开、未新建或未输入时必须视为反证。"
  },
  "desktopOperation": {
    "label": "桌面/本机软件操作",
    "coreAction": "在真实桌面或本机软件上完成可见操作",
    "preparationIsNotCompletion": [
      "查进程",
      "列应用",
      "打开快捷方式",
      "只执行命令行"
    ],
    "requiredEvidence": [
      "active window/process/screen state proves the requested result",
      "或工具返回的操作验证"
    ],
    "nextStep": "先聚焦已运行的窗口，执行核心操作，再用窗口/屏幕证据验证。",
    "caution": "不能把进程存在或应用打开说成业务动作已完成。"
  }
} as const;
