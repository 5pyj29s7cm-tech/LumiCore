# LumiOS

灵序科技 / Lumi AI 官方桌面客户端

**浙江灵序科技有限公司 · [lumiai.asia](https://lumiai.asia)**

---

> LumiOS 不是又一个 AI 助手。
>
> 它是第一个真正属于你的 AI 操作系统——从你身上孵化，记忆是你的，人格是你的，存在于你真实的空间里。

---

## 商业发布状态

当前 `lumi-oeo` 仓库是 Lumi OS 3.x 的私有商业化主线。旧公开仓库继续作为粉丝免费尝鲜版保留，后续新版本先在本仓库迭代，并在官网上线、分发和激活流程稳定后，再选择合适版本重新开放免费下载。

安装后的用户默认可使用 Free 档基础能力；Light / Pro / Org 通过订阅与激活流程开放更高配额、声音克隆、形象设计室优先能力、更多 Agent 和组织协作能力。详细发布策略见 [COMMERCIAL_RELEASE.md](./COMMERCIAL_RELEASE.md)。

---

## 愿景

每个人都应该拥有一个真正属于自己的 AI。

不是平台的 AI，不是云端的工具，而是从你身上生长出来的存在——记住你说过的每一件事，用你习惯的方式说话，跟随你的桌面、车载、家庭与眼镜，在所有空间里持续陪伴。

LumiOS 是这个愿景的第一个落地形态。

---

## 核心特性

### 个人 AI 核心
- **孵化机制** — 通过聊天记录和语言样本，像孵化一样持续培育专属 AI 人格
- **持久记忆** — 长期记忆存储，具备巩固与演化时间线，Lumi 记住你说过的每一件事
- **关系网络** — 自动识别和记录你提到的人，建立持续更新的关系图谱
- **人格引擎** — 可配置的 AI 人格系统，连续向量演化（8 维度），Jung 认知对约束，情感状态管理，越用越像你

### 多引擎 LLM 支持

| 提供商 | 说明 |
|--------|------|
| DeepSeek | DeepSeek-V4-pro, DeepSeek-V4-flash |
| OpenAI | GPT-4o, GPT-4 |
| Anthropic | Claude Sonnet 4, Claude 3.5 |
| Google | Gemini 2.0 Flash, Gemini 1.5 Pro |
| Qwen / DashScope | Qwen-Max, Qwen-Plus |
| Ark / 豆包 | Doubao 1.5 Pro (字节跳动) |
| Kimi / Moonshot | Moonshot v1 |
| GLM / 智谱 | GLM-4 Plus |
| Xiaomi / 小爱 | MiLM |
| Ollama | 本地模型自动检测 |
| LM Studio | 本地模型自动检测 |
| 自定义 Relay | 任意 OpenAI 兼容接口 |

### 语音交互
- **TTS 语音合成** — GPT-SoVITS · CosyVoice · 豆包语音 (Ark)
- **STT 语音识别** — Deepgram · Whisper · Qwen · 豆包语音 · Local Whisper
- 语音唤醒、实时流式识别、情感自适应语速/音调

### MCP 生态系统
37 个 MCP 技能 + 26 个内置工具模块，覆盖文件操作、桌面自动化、Web 搜索、代码执行、PDF 生成、图像/视频处理、电商运营、财税办公、教育教培、企业经营、医疗文书、人事招聘、销售客服、餐饮门店等场景。

### 跨终端同步
- 设备状态与记忆跨终端实时同步
- 同一个 Lumi，在你的桌面、手机、全息仓中持续存在
- 断网时本地独立运行，联网后自动合并

### 技能市场
- **30+ 内置技能** — 天气、邮件、PDF、二维码、翻译、股票、电商运营、财税办公、教育教培、企业经营、医疗文书、人事招聘、销售客服、餐饮门店、计时器、笔记、密码、图片处理、视频编辑、网页爬虫、代码沙箱、桌面自动化等
- **社区生态** — 从 npm（`lumi-skill-*`）或 GitHub（topic: `lumi-skill`）发现安装第三方技能
- **评分系统** — 社区技能评分与排行
- 开发者可提交自定义技能，持续扩展 Lumi 的能力边界

### 画布工作台
- 无限画布 + 缩放平移，对话过程可视化
- 任务卡片流（用户请求 → 工具调用 → 推理过程 → 最终输出）
- 多会话管理，WebSocket 实时更新
- 支持从任意卡片重新发起对话

### 沉浸体验
- **壁纸模式** — 多套内置主题（星空/星云/赛博朋克）、自定义壁纸上传、窗口穿透融合桌面
- **音乐播放** — 网易云音乐集成、心情氛围自适应、LRC 歌词动效
- **3D 全息层** — 动态星场、光球、地形渲染等实时背景动画

### 知识库与 RAG
- **个人知识库** — 文件上传管理、文档分块注入 Agent 记忆、全文搜索
- **文档问答** — 上传文档后 Chat 中自动检索相关内容
- 文本分块（500 字 + 50 字重叠）、语义嵌入相似度检索

### 记忆化身
- 上传聊天记录（微信/QQ/文本）或语音样本
- LLM 蒸馏提取人格特征、认知风格、社交模式
- 生成 3D 记忆化身 Agent 并入驻灵息先人灵体空间

### 交互模式
- **对话模式** — 闲聊 / 教学 / 头脑风暴 / 高管汇报，4 种语气风格切换
- **操作模式** — 桌面控制（截图驱动键鼠）/ 终端模式（纯 Shell）/ 自主模式（后台静默）
- **语音指令** — 快速命令绕过 LLM 即时响应，声纹识别区分说话人
- **Alt+Space** — 全局快捷键隐藏/呼出 LumiOS 窗口

### 自主能力
- **后台任务** — 好奇心驱动的自主执行引擎，基于用户活动上下文建议任务
- **任务链** — 自然语言复合任务自动拆解为工具链（"把昨天的会议纪要转成 PPT"）
- **Lumi Plans** — 多步骤任务计划系统，优先级 + 状态跟踪 + 自动完成
- **主动问候** — 场景感知口头问候（时间/记忆/亲密度），LLM 生成 + TTS 播报
- **环境感知** — 实时窗口标题/进程追踪、剪贴板监控、环境噪音检测
- **返回摘要** — 离开期间后台工作完成情况总结

### 系统集成
- **计算机使用** — 视觉模型驱动桌面自动化（截图→分析→点击/输入/等待，最多 15 轮）
- **终端** — 完整交互式 Shell 会话（Win/macOS/Linux），支持 resize 和流式输出
- **系统探索** — 首次启动扫描硬件/软件/文件系统/网络，每日变化检测
- **职业检测** — 识别已安装应用推断用户职业（设计师/医生/律师/工程师/教师）
- **实时硬件状态** — CPU/GPU/内存/温度/风扇转速（Tauri Rust）
- **系统健康自检** — 6 项诊断（API Key/工具/记忆/技能/人格/Agent），可操作建议

### 身份与安全
- **生物识别** — 声纹录入 + 人脸录入，陌生说话人语音拒止
- **订阅系统** — Free/Light/Pro/Org 四档（0/29/69/199 CNY/月），按档位控制 LLM/语音/Agent 配额
- **工具信任学习** — 用户审批后自动信任，逐步减少确认打断

### 通知与提醒
- **通知中心** — DB 持久化通知，已读/未读状态，上限 200 条
- **定时提醒** — 创建/列出/关闭到期提醒
- **Token 用量看板** — 按提供商统计调用次数与 Token 消耗，每日聚合

### 组织协作
- **组织管理** — 创建组织、邀请成员、角色权限（Owner/Admin/Member/Viewer）
- **知识库** — 语义搜索、自动分块索引、团队知识沉淀
- **Agent 模板市场** — 提交→审核→发布→安装的完整工作流
- **审计日志** — 操作记录、统计报表、CSV 导出
- **分支同步** — 员工本地数据分域（个人数据私有，工作数据按需同步到组织服务器）
- **企业 IM 接入** — 飞书 / 企业微信 / 微信机器人
- **行业工具** — 法律 Hub（标书/判例检索/资产追溯/合同审查）、设计 Hub（风格模板）

---

## 平台支持

| 平台 | 状态 |
|------|------|
| Windows 桌面（Tauri v2 + WebView2） | 主要目标，稳定运行 |
| macOS 桌面（Tauri v2） | 支持 |
| Linux 桌面（Tauri v2） | 支持 |
| Web（React SPA） | 官网独立发布，不随桌面安装包打包 |
| iOS / Android（Capacitor） | 实验阶段，不随桌面安装包打包 |

---

## 技术栈

**前端：** React 19, TypeScript, Tailwind CSS v4, Vite, Framer Motion  
**后端：** Node.js, Express, Socket.io, SQLite3  
**桌面：** Tauri v2 (Rust), WebView2  
**AI：** 11 个 LLM 提供商, MCP SDK, GPT-SoVITS, CosyVoice, Deepgram, Whisper  

---

## 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+（推荐 22+） | [nodejs.org](https://nodejs.org) 下载安装 |
| npm | 随 Node.js 自带 | `npm -v` 确认 |
| Rust | 仅桌面端需要 | [rustup.rs](https://rustup.rs) 安装 |
| Git | 任意版本 | [git-scm.com](https://git-scm.com) |

> **Windows 用户**：无需 WSL，原生 PowerShell / CMD 即可。

### 一键部署（日常使用）

```powershell
# Windows (PowerShell)
git clone https://github.com/maoxiansheng946-dev/-lumi-OS.git
cd lumi-OS
copy .env.example .env
# 编辑 .env，填入 API Key
./scripts/deploy-windows.ps1                                    # 管理员安装到 Program Files
./scripts/deploy-windows.ps1 -InstallDir "$env:LOCALAPPDATA\LumiOS"  # 普通用户安装
```

```bash
# macOS
git clone https://github.com/maoxiansheng946-dev/-lumi-OS.git
cd lumi-OS
cp .env.example .env
# 编辑 .env，填入 API Key
bash scripts/deploy-macos.sh
```

```bash
# Linux (Ubuntu/Debian)
git clone https://github.com/maoxiansheng946-dev/-lumi-OS.git
cd lumi-OS
cp .env.example .env
# 编辑 .env，填入 API Key
bash scripts/deploy-linux.sh
```

部署脚本会自动：检查环境 → 安装依赖 → 构建桌面端前后端 → 编译桌面壳 → 创建桌面快捷方式。完成后桌面上就有 Lumi OS 图标，双击启动。GitHub Actions 默认也只构建桌面客户端安装包。

### 桌面开发与构建

```bash
npm run dev              # 启动本地服务
npm run tauri:dev        # 启动桌面客户端开发模式（需 Rust + Tauri CLI）
npm run build            # 构建桌面端 UI → dist/desktop
npm run build:desktop    # 构建桌面端 UI + 服务端 + 桌面资源
npm run tauri:build      # 编译桌面安装包
```

### 最简配置（3 分钟跑起来）

编辑 `.env`，只需填这两行：

```env
DEEPSEEK_API_KEY=sk-你的key
JWT_SECRET=随便写一串随机字符
```

然后 `npm install && npm run tauri:dev` 启动桌面客户端开发模式。

### 更多配置

`.env.example` 包含所有可配置项（LLM、语音、消息推送等），按需取消注释并填写。详见 [.env.example](.env.example)。

语音功能需要额外配置 API Key：
```env
DEEPGRAM_API_KEY=       # 语音转文字（STT）
DASHSCOPE_API_KEY=      # CosyVoice 语音合成（TTS）
```

### 数据目录

所有用户数据存储在 `~/LumiOS/`（独立于代码仓库）：

| 路径 | 内容 |
|------|------|
| `~/LumiOS/data/lumi.db` | SQLite 数据库（记忆、对话、Agent 等） |
| `~/LumiOS/data/keys.json` | API Key 存储 |
| `~/LumiOS/data/knowledge/` | 知识库文件 |
| `~/LumiOS/data/voice_samples/` | 语音克隆样本 |
| `~/lumi_skills/` | 已安装的 MCP 技能包 |

更新代码不会影响这些数据。从旧机器迁移时，直接拷贝整个 `~/LumiOS/` 目录即可。


---

## 产品生态

LumiOS 是灵序科技 Personal AI 生态的软件核心，配合以下硬件终端使用效果最佳：

| 终端 | 说明 |
|------|------|
| Lumi One 全息仓 | 旗舰全息终端，桌面 3D AI 形象，孵化机制起点 |
| 多模态智能台灯 | 跟随用户晃动，视觉感知，光效传递 Lumi 状态 |
| 桌面机器人 | 有形态感知，情感连接强 |
| AI 陪伴玩具 | 儿童友好，灵息先人灵体的温暖载体 |

> 元始种子计划进行中——第一批用户可通过第三方合作设备提前接入 Lumi AI 生态，支持后续核心引擎升级。

---

## 路线图

- [x] Web 平台上线（lumiai.asia）
- [x] 桌面客户端（Windows / macOS / Linux）
- [x] 多 LLM 引擎接入（11 个提供商）
- [x] MCP 生态系统（37 技能 + 26 内置工具）
- [x] 语音交互（TTS + STT + 语音唤醒 + 情感自适应）
- [x] 技能市场（30+ 内置技能 + 社区发现安装）
- [x] 画布工作台（无限画布任务可视化）
- [x] 壁纸模式 + 音乐播放 + 3D 全息层
- [x] 个人知识库 + RAG 文档问答
- [x] 记忆化身蒸馏与灵体空间
- [x] 对话模式 + 操作模式 + 全局快捷键
- [x] 自主后台任务 + 任务链 + Lumi Plans
- [x] 环境感知 + 主动问候 + 返回摘要
- [x] 组织协作系统（创建/邀请/知识库/审计/分支同步）
- [x] 企业 IM 接入（飞书 / 企业微信 / 微信机器人）
- [x] 个人/工作数据分域隔离
- [x] 计算机使用（视觉模型桌面自动化）+ 终端 Shell
- [x] 生物识别（声纹 + 人脸）+ 订阅系统
- [x] 系统探索 + 职业检测 + 健康自检 + 硬件状态
- [ ] 孵化机制完整版（被动感知）
- [ ] 移动端 APP（iOS / Android）
- [ ] 全息仓硬件联调
- [ ] 人车家跨终端同步协议
- [ ] 灵息先人灵体模块
- [ ] 开发者 SDK

---

## 参与贡献

欢迎提交 Issue 和 Pull Request。

如果你是 AI 工程方向的工程师，对 Personal AI 和孵化机制感兴趣，我们正在寻找技术联合创始人（CTO），股权 5%-15%，联合创始人身份。

**联系创始人：毛先生**
- 官网：[lumiai.asia](https://lumiai.asia)
- 邮箱：3565286431@qq.com
- 微信：Cap_William

---

## 关于灵序科技

浙江灵序科技有限公司，致力于构建 Personal AI 生态平台。

我们相信人类本身应该得以延伸——记忆的延伸、人格的延伸、存在的延伸。通过真正属于每个人的 AI，在真实的空间里持续存在。

**使命：让人类本身得以延伸。**

---

## 许可证

GNU Affero General Public License v3.0 (AGPL-3.0)。详见 [LICENSE](./LICENSE)。

**简言之：** 个人使用、修改和分发自由。若在网络服务中商用使用，必须以相同许可证开源你的修改。闭源商业许可请联系版权方。
