# LumiCore 前端缺口清单 — 2026-06-13

Codex 产品完整化参考。按优先级排列：P0=用户路径断点，P1=功能残缺，P2=体验补全，P3=后端死代码可清理。

---

## P0 — 用户路径断点（接入就能用）

### 1. 系统探索 + 计划系统（14 条路由）
**文件**: `server/routes/plan_explore_routes.ts`
**前端**: 无任何消费者
**路由 bug**: 路径是 `/api/explore/...`，但挂载在 `/api` 下，实际变成 `/api/api/explore/...`

| 路由 | 用途 |
|------|------|
| `GET /api/explore/status` | 系统扫描状态 |
| `POST /api/explore/scan` | 触发系统扫描 |
| `GET /api/explore/history` | 扫描历史 |
| `GET /api/explore/profession` | 职业检测结果 |
| `POST /api/explore/profession/rescan` | 重新检测职业 |
| `POST /api/explore/profession/install` | 安装职业代理 |
| `GET /api/explore/profession/templates/:profession` | 职业模板详情 |
| `GET /api/plans` | 计划列表 |
| `GET /api/plans/today` | 今日计划 |
| `GET /api/plans/:id` | 计划详情 |
| `POST /api/plans` | 创建计划 |
| `PUT /api/plans/:id` | 更新计划 |
| `PUT /api/plans/:planId/steps/:stepId` | 更新步骤 |
| `DELETE /api/plans/:id` | 删除计划 |

**建议**: 在 Settings 的 Autonomous 面板旁边加一个 "系统探索" 页，复用 Settings.tsx 里已有的骨架。

### 2. 分支连接（4 条路由）
**文件**: `server/routes/branch_routes.ts`
**前端**: 无任何消费者
**用途**: 雇员终端连接公司组织

| 路由 | 用途 |
|------|------|
| `GET /api/branch/state` | 分支连接状态 |
| `POST /api/branch/connect` | 连接公司组织 |
| `POST /api/branch/disconnect` | 断开 |
| `POST /api/branch/sync` | 同步数据 |

**建议**: 在 OrgPortal 或 Settings 里加 "分支终端" 入口，输入公司码连接。

### 3. LAP 长期自主规划（5 条路由）
**文件**: `server/lap/routes.ts`
**前端**: 无任何消费者
**用途**: Agent 长期会话 + 任务追踪

| 路由 | 用途 |
|------|------|
| `GET /api/lap/identity` | Agent 身份 |
| `GET /api/lap/sessions` | 会话列表 |
| `GET /api/lap/tasks/:agentId` | Agent 任务 |
| `GET /api/lap/contexts/:sessionId` | 会话上下文 |
| `DELETE /api/lap/sessions/:sessionId` | 删除会话 |

**建议**: 在 AutonomousFeed 旁边加 "长期会话" 视图。

---

## P1 — 功能残缺（后端发了，前端没接）

### 4. 联系人系统（5 条路由）
**文件**: `server/routes/contacts_routes.ts`
**前端**: 无任何消费者

| 路由 | 用途 |
|------|------|
| `GET /api/contacts` | 联系人列表 |
| `POST /api/contacts` | 添加联系人 |
| `PUT /api/contacts/:id` | 编辑 |
| `DELETE /api/contacts/:id` | 删除 |
| `POST /api/contacts/:id/interact` | 交互记录 |

**建议**: 在侧边栏或 DesktopUI 加 "联系人" 面板。

### 5. 组织模板实时事件（6 个 socket）
**后端 emit，前端无 listener**

| 事件 | 用途 |
|------|------|
| `template:submitted` | 模板提交审核 |
| `template:approved` | 模板审核通过 |
| `template:rejected` | 模板驳回 |
| `template:published` | 模板发布 |
| `template:status` | 模板状态变更 |
| `kb:article` | 知识库文章变更 |

**建议**: TemplateReviewQueue / TemplateMarketplace 监听这些事件做实时刷新，不用手动刷新页面。

### 6. Token 用量实时推送（2 个 socket）
| 事件 | 用途 |
|------|------|
| `token:usage_update` | 用量更新 |

**建议**: TokenDashboard / Profile 监听，替换轮询 `/api/llm/usage`。

### 7. 唤醒词事件（3 个 socket）
| 事件 | 用途 |
|------|------|
| `wake:detected` | 唤醒词检测到 |
| `wake:error` | 唤醒错误 |
| `wake:started` | 唤醒服务已启动 |

**建议**: DesktopUI 监听，语音唤醒时有 UI 反馈。

### 8. 音乐播放扩展事件（6 个 socket）
| 事件 | 状态 |
|------|------|
| `music:queue` | 后端发，前端没听 |
| `music:queue:added` | 后端发，前端没听 |
| `music:queue:cleared` | 后端发，前端没听 |
| `music:liked` | 后端发，前端没听 |
| `music:disliked` | 后端发，前端没听 |
| `music:lyrics` | **前端听了，后端没发** |

**建议**: MusicCenter 监听这些事件同步队列 UI；后端补上 `music:lyrics` emit。

### 9. 记忆系统未接路由（6 条）
| 路由 | 用途 |
|------|------|
| `GET /api/memories` | 记忆列表 |
| `POST /api/memories` | 创建记忆 |
| `GET /api/memory/growth` | 成长数据 |
| `GET /api/memory/tiers` | 记忆分层 |
| `PUT /api/memory/:id/move` | 移动记忆 |
| `GET /api/memory/narrative` | 叙事时间线 |
| `GET /api/memory/timeline` | 时间线 |

**建议**: KnowledgeBase 已经接了一部分（tree/protect/tier/auto-organize），补上列表 CRUD 和时间线。

---

## P2 — 体验补全

### 10. 人格详情 + 成长日志（2 条）
| 路由 | 用途 |
|------|------|
| `GET /api/personalities/:id` | 单个人格详情 |
| `GET /api/personality/:id/growth-journal` | 成长日志 |

**建议**: PersonalityEditor 加详情页 + 成长日志时间线。

### 11. 文件管理缺口（3 条）
| 路由 | 用途 |
|------|------|
| `POST /api/files/save` | 保存文件内容 |
| `POST /api/files/rename` | 重命名 |
| `GET /api/files/info/:id` | 文件信息 |

**建议**: KnowledgeBase 右键菜单加 "重命名" / "属性"。

### 12. 市场功能缺口（4 条）
| 路由 | 用途 |
|------|------|
| `GET /api/marketplace/skills/:id` | 技能详情 |
| `GET /api/marketplace/personalities` | 人格市场 |
| `POST /api/marketplace/skills/:id/rate` | 评分 |
| `GET /api/marketplace/skills/:id/reviews` | 评论列表 |

### 13. 技能管理缺口（2 条）
| 路由 | 用途 |
|------|------|
| `POST /api/skills/install` | 安装（前端用 marketplace/acquire 代替） |
| `GET /api/skills/workflows` | 工作流列表 |

### 14. 其他零散路由（5 条）
| 路由 | 用途 |
|------|------|
| `POST /api/llm/test` | LLM 测试调用 |
| `GET /api/cloud/health` | 云端健康检查 |
| `GET /api/modules/products` | 模块产品列表 |
| `GET /api/modules/docs` | 模块文档 |
| `GET /api/mcp/npm/search` | NPM MCP 搜索 |

### 15. Socket 事件缺口
| 事件 | 用途 |
|------|------|
| `mcp:chunk` | MCP 流式输出 |
| `mcp:proactive` | MCP 主动通知 |
| `mcp:health_update` | MCP 健康变更 |
| `org:heartbeat:ack` | 组织心跳确认 |
| `org:sync:ack` | 组织同步确认 |
| `org:kb:stale` | 知识库过期通知 |
| `agent:removed` | 代理被移除通知 |

---

## P3 — 后端死代码（可清理或标记）

以下路由/事件完全没有前端消费者，如果确认不再需要可清理：

| 子系统 | 路由数 | 备注 |
|--------|--------|------|
| `/api/lap/*` | 5 | LAP 全部未接入 |
| `/api/api/explore/*` | 7 | 双前缀 bug + 未接入 |
| `/api/api/plans/*` | 7 | 双前缀 bug + 未接入 |
| `/api/contacts/*` | 5 | 联系人全部未接入 |
| `/api/branch/*` | 4 | 分支全部未接入 |
| Token socket (1) | emit | `token:usage_update` |
| Wake socket (3) | emit | `wake:detected`, `wake:error`, `wake:started` |

---

## 建议接入顺序

1. **第 1 批** (P0): 系统探索 + 计划系统（修双前缀 bug → 前端页面）→ 分支连接 → LAP
2. **第 2 批** (P1): 联系人 → 组织模板 socket → 记忆系统补全
3. **第 3 批** (P2): 人格详情 → 市场 → 文件管理 → 音乐 → MCP socket
4. **第 4 批** (P3): 清理死代码或加 `// TODO: frontend wire-up pending`
