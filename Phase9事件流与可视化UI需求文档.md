---
schema_version: 1
document_type: phase-development-requirements
phase: 9
status: DRAFT
depends_on: "Phase 8 系列闭环 PASS（8B 串行任务执行已完成；8D 并发可在 Phase 9 之前或之后落地，互不阻塞）"
primary_acceptance_platform: macOS
created_at: "2026-06-17"
---

# Phase 9 需求草案：事件流后端与可视化时间轴 UI

## 1. 文档定位

本文档定义 review-loop 在现有 `progress.json` / `transcripts/` 之上新增的**实时事件流**
与**可视化时间轴 UI**，借鉴 hermes-deck 的事件聚合与折叠卡片渲染思路，但保留
review-loop 自身的状态机骨架与审计闭环。

Phase 9 不替换、不重构现有 progress / transcript 体系，事件流与既有产物**并存**。
UI 是事件流的消费者，不直接读 state.json / progress.json。

## 2. 用户目标

用户希望：

- 跑 review-loop 期间能实时看到 Agent 在想什么、调用了什么工具、改了什么文件，
  而不是只能看到阶段切换。
- 长任务（动辄 10+ 分钟）期间能判断"是在正常推进还是卡住了"。
- 多任务并发（Phase 8D）跑起来时，能在一个视图里看到所有任务的实时状态。
- 跑完之后能像翻聊天记录一样回放整个执行过程。

## 3. 核心原则

1. **事件流是只追加的（append-only）**：写入 `.agent/events.ndjson`，不可回写、不可修改。
2. **事件不替代审计产物**：state.json / progress.json / transcripts / audit-report.md 仍是
   决定 PASS/FAIL 的唯一依据。事件只用于"过程可见性"，不可作为审计证据。
3. **UI 是事件流的纯消费者**：UI 故障不影响主流程；杀掉 UI 不影响 run。
4. **事件 Schema 必须稳定**：每条事件带 `schema_version`，破坏式变更必须升版本号。
5. **不引入对话调度**：事件流是单向广播，不接受用户在 UI 里干预流程。干预仍走 CLI。
6. **可关闭**：`review-loop.yaml` 中 `events.enabled: false` 时全链路退化为现状。

## 4. 事件 Schema 草案

每条事件是一行 JSON（NDJSON 格式），写入 `.agent/events.ndjson`。

### 4.1 公共字段

```yaml
schema_version: 1
event_id: "evt_<ulid>"      # 单调递增、可去重
ts: "2026-06-17T08:00:00.123Z"
run_id: "<run_id>"
type: "<event_type>"
payload: { ... }            # 由 type 决定
```

### 4.2 事件类型枚举

| type | 触发时机 | payload 关键字段 |
|---|---|---|
| `phase.start` | Phase 切换为非终态 | phase, iteration |
| `phase.complete` | Phase 切换出 | phase, status |
| `agent.start` | Planner/Developer/Auditor/FinalAuditor 子进程启动 | role, provider, prompt_digest |
| `agent.thinking_delta` | 子进程 stdout 流式块（如果 provider 暴露 thinking） | role, chunk |
| `agent.tool_call` | 子进程触发工具调用（apply_patch / shell 等） | role, tool, args_summary |
| `agent.tool_result` | 工具调用完成 | role, tool, status, duration_ms |
| `agent.complete` | 子进程退出 | role, status, exit_code, duration_ms |
| `verification.start` | verification command 开始 | cmd_id, command |
| `verification.complete` | verification 结束 | cmd_id, status, exit_code |
| `audit.decision` | Auditor / FinalAuditor 输出 decision | role, decision, findings_count |
| `scope.violation` | Scope Guard 拦截 | files, allowed_globs |
| `task.start` | 单 task 开始（Phase 8B/8D） | task_id, wave_index |
| `task.complete` | 单 task 结束 | task_id, status |
| `wave.start` | Wave 开始（Phase 8D 集成后） | wave_index, task_count, max_parallel |
| `wave.complete` | Wave 结束 | wave_index, passed, failed |
| `cancel.requested` | 用户请求取消 | requested_at |
| `lock.acquired` / `lock.released` | 锁操作 | path |

### 4.3 事件聚合规则（UI 侧）

UI 不直接渲染单条事件，而是聚合成 **segment**（参考 hermes-deck）：

- 连续的 `agent.thinking_delta` 合并为同一个 thinking segment（带计时器）
- `agent.tool_call` + 对应的 `agent.tool_result` 合并为同一个 tool segment
- `phase.start` ... `phase.complete` 之间的所有事件归属于该 phase 的 timeline 节点
- `wave.start` ... `wave.complete` 之间，多个 task 的事件按 task_id 分组并行展示
## 5. 事件总线（EventBus）

新增 `src/runtime/event-bus.ts`，职责：

- 提供 `emit(event)` API，由 orchestrator 各处调用。
- 内部维护一个**异步写入队列**，事件落盘 `.agent/events.ndjson`，落盘失败仅日志告警，不抛错给主流程。
- 支持 `tail` 模式：UI 启动时可读全量历史，并继续监听新事件。
- 自动注入 `event_id` / `ts` / `run_id`，调用方只填 `type` + `payload`。
- 全局可通过 `events.enabled: false` 关闭。

落盘格式：每行一个 JSON，`\n` 分隔，UTF-8。

## 6. 关键埋点

### 6.1 Orchestrator 层

- `run-orchestrator.ts` 现有所有 `emitProgress(...)` 调用旁加一行 `eventBus.emit({type:"phase.*", ...})`。
- 现有 `emitProgress` 不动，**事件与 progress.json 并存**。

### 6.2 Agent 子进程层

- `process-runner.ts` 的 stdout 监听**改成边读边发 `agent.thinking_delta` 事件**，
  原 stdout 文件落盘逻辑保留。
- `agent-adapter.ts` 在 spawn 前后发 `agent.start` / `agent.complete`。
- 工具调用埋点取决于 provider 能力：
  - Claude CLI 不直接暴露 tool call 事件，需要解析 `--output-format json` 输出。
  - Codex CLI / ACP 暴露 stream events，可直接转译。
  - 暂不支持的 provider，发 `agent.thinking_delta` 即可，不强求 tool 级颗粒度。

### 6.3 Verification / Scope / Audit 层

- `verification-runner.ts`：每条命令前后发事件。
- `scope-guard.ts`：检测到越界时发 `scope.violation`。
- `auditor-adapter.ts` / `final-auditor-adapter.ts`：解析完 audit-report 后发 `audit.decision`。

### 6.4 Task / Wave 层（与 Phase 8D 配合）

- `task-graph-loop.ts`：每个 task 前后发 `task.start` / `task.complete`。
- Phase 8D 引入 wave 后，`wave-executor.ts`：每 wave 前后发 `wave.start` / `wave.complete`。

## 7. UI 形态

**首期交付 7.1 本地 Web 面板**。TUI 与原生 App 列为可选/远期方案，按需推进。

### 7.1 本地 Web 面板（首期必做）

命令：`review-loop serve [--port 3939] [--open]`

技术栈：

- 后端：Node 内置 `http` + Server-Sent Events（SSE），无需引入 Express。
  - `GET /api/events?since=<event_id>` 返回 SSE 流，从指定 event_id 起推送。
  - `GET /api/snapshot` 一次性返回当前 state.json + 已聚合的 segments，UI 启动时拉取。
  - `GET /api/runs` 列出当前 `.agent/` 下可见的所有 run（含历史 archive）。
- 前端：单页 React（建议用 Vite 构建，产物打包进 `dist/web/`），复刻 hermes-deck 的
  折叠时间轴卡片，组件结构对照：
  - `SegmentTimeline` — 按 phase / wave / task 分段渲染
  - `ProcessSection` — 折叠卡片，带颜色点 + ▸/▾ 图标 + 计时器
  - `ThinkingPanel` — 实时滚动的 thinking delta
  - `ToolCallChip` — apply_patch 等工具调用的紧凑卡片
- 仅监听 `127.0.0.1`，无鉴权（不暴露到外网）。

布局示意：

```text
┌──────────────────────────────────────────────────────────────────┐
│ Run abc123  ·  DEVELOPING (iter 2/3)  ·  ⏱ 02:14                 │
├──────────────────────────────────────────────────────────────────┤
│ ▾ ● PLANNING                                          3.2s  ✓    │
│     planner: plan.md (5 tasks)                                   │
│                                                                  │
│ ▾ ● DEVELOPING iter 2                                12.4s  ●    │
│     ▸ developer: Thinking…                                       │
│       (实时滚动文本，浅灰背景)                                   │
│     ✓ apply_patch  src/foo.ts                         1.2s       │
│     ✓ apply_patch  src/foo.test.ts                    0.8s       │
│                                                                  │
│ ▸ ○ VERIFYING                                       (pending)    │
└──────────────────────────────────────────────────────────────────┘
```

交互：

- 卡片点击折叠/展开，长卡片默认折叠
- thinking 区域支持"自动滚动到底部"，用户向上滚后暂停跟随，2s 后或滚回底部恢复
- 顶部 run 选择器：可在多个 run（含 archive）之间切换
- 多 worktree 并发（Phase 8D）：tabs 切换"主流"或单个 task 的事件流
- 完成后整页可保存为静态 HTML，作为 run 的可视化档案

颜色约定（参考 hermes-deck）：

- 紫色实心圆 ● = running
- 绿色对勾 ✓ = done
- 红色叉 ✗ = failed
- 灰色空心圆 ○ = pending

### 7.2 终端 TUI（可选，按需推进）

命令：`review-loop watch`

适合纯命令行环境（SSH、无桌面服务器、Tmux 工作流）。Web 面板首期上线后，TUI 视用户
反馈再排期，不在 Phase 9 首期交付承诺内。

技术栈候选：`ink`（React for CLI）或 `blessed`。

布局参考（ASCII 版时间轴）：

```text
┌─ Run abc123 ─ Phase: DEVELOPING (iter 2/3) ───────────┐
│ ▾ ✓ PLANNING                              3.2s        │
│   └ planner: plan.md (5 tasks)                        │
│ ▾ ● DEVELOPING iter 2                     12.4s       │
│   ├ ● developer: Thinking… (live)                     │
│   ├ ✓ apply_patch src/foo.ts             1.2s         │
│   └ ✓ apply_patch src/foo.test.ts        0.8s         │
│ ▸ ○ VERIFYING                            (pending)    │
└────────────────────────────────────────────────────────┘
```

### 7.3 Codex Desktop 插件融合（远期）

- 插件 tail `events.ndjson`，把事件翻译成 Codex chat inline 状态消息。
- 不做独立 GUI，借 Codex Desktop chat UI 当显示层。
- 与 Web 面板互补：Web 面板适合主动观看，Codex 插件适合"在 chat 里被动收到进度提示"。

## 8. 借鉴 hermes-deck 的具体清单（实施参考）

本节明确"什么能从 hermes-deck 借鉴、怎么借鉴"，让后续 AI 在落地 Web UI 时
有清晰的依据，不需要重新讨论"要不要看 hermes-deck / 看哪部分"。

**hermes-deck 仓库**：[TNJ2026/hermes-deck](https://github.com/TNJ2026/hermes-deck)
**License**：MIT（允许借鉴/翻译/改造，建议在本项目 README 致谢一行）
**前一位 AI 的 clone 路径**：`/tmp/hermes-deck-main/`（首次启动需重新 clone）

### 8.1 借鉴优先级总览

| 优先级 | 借鉴项 | 可移植度 | 落地形式 |
|---|---|---|---|
| **高（必抄）** | AssistantSegment 数据模型 | 100% | 直接翻译成 TS interface |
| **高（必抄）** | 事件聚合状态机（ChatStore+Send） | 100% | 翻译成 TS 函数/类 |
| **高（必抄）** | 组件层级分解（SegmentTimeline → ProcessSection → Header/Body） | 90% | React 组件骨架 |
| **中** | 视觉细节（颜色、图标、计时器、滚动跟随） | 80% | CSS + React hooks 模仿 |
| **中** | Thinking 段结束时冻结计时器（finalizeOpenThinking） | 100% | 翻译成 TS 逻辑 |
| **中** | 完成消息不重渲染优化 | 100% | React.memo + 稳定 key |
| 低 | macOS 应用生命周期 / 窗口管理 | 0% | Web 不需要 |
| **不抄** | SwiftUI View 代码本身 | 0% | 跨语言不可移植 |
| **不抄** | JSON-RPC over stdio 传输 | 0% | 我们用 SSE，协议不同 |
| **不抄** | Session/Profile 管理 | 0% | 用户已确认不要 |
| **不抄** | deck_delegate_agent / AgentRouting 委派 | 0% | 用户已确认不要 |
| **不抄** | 语音输入 / Codex ACP / Claude CLI 多 agent 路由 | 0% | review-loop 角色固定 |

### 8.2 高价值借鉴项 1：数据模型（AssistantSegment）

**源文件**：`/tmp/hermes-deck-main/hermes_deck/Models/ChatModels.swift`

**借鉴对象**：`AssistantSegment` 结构体及其 `Kind` 枚举（Swift），它表示
"对话流中的一个原子片段"，是整个时间轴 UI 的最小渲染单位。

**翻译目标**：在 `src/web/types/segment.ts` 新建 TypeScript 类型，对齐 review-loop
的事件类型（见本文档 §4.2）。建议形态：

```ts
// 片段大类（与 hermes-deck 的 AssistantSegmentKind 对齐）
type SegmentKind =
  | { type: "thinking"; text: string; startedAt: number; endedAt: number | null }
  | { type: "tool"; toolID: string; name: string; status: ToolStatus; argsSummary?: string; result?: string; durationMs?: number }
  | { type: "message"; text: string }
  // review-loop 特有的扩展（hermes-deck 没有）
  | { type: "verification"; cmdId: string; command: string; status: VerifyStatus; exitCode?: number }
  | { type: "audit"; role: "auditor" | "final_auditor"; decision?: "PASS" | "REWORK" | "BLOCKED"; findingsCount?: number }
  | { type: "scope_violation"; files: string[]; allowedGlobs: string[] };

type ToolStatus = "running" | "done" | "failed";
type VerifyStatus = "running" | "passed" | "failed";

interface Segment {
  id: string;                              // 稳定 ID（从 event_id 派生）
  kind: SegmentKind;
  status: "running" | "done" | "failed";
  ownerRole?: "planner" | "developer" | "auditor" | "final_auditor";
  ownerTaskId?: string;                    // Phase 8D 多 worktree 时使用
  ownerWaveIndex?: number;
}
```

**实施要点**：

1. 不要直接 1:1 翻译 hermes-deck，要**叠加 review-loop 特有的 segment 类型**（verification、audit、scope_violation）
2. `id` 必须稳定（用 event_id 或派生哈希），React 渲染依赖它做 diff
3. `status` 字段独立于 `kind`，因为同一 segment 可能从 running → done


### 8.3 高价值借鉴项 2：事件聚合状态机

**源文件**：`/tmp/hermes-deck-main/hermes_deck/Models/ChatStore+Send.swift`（重点行 222-355）

**借鉴对象**：把 hermes-deck 的"实时事件 → segment 数组"聚合逻辑翻译成 TS。

**翻译目标**：在 `src/web/segment-store.ts` 新建 `SegmentStore` 类。

**核心规则**（来自 hermes-deck，已验证为生产可用的设计）：

1. **连续 thinking 合并**：连续多个 `agent.thinking_delta` 事件合并为同一个 thinking segment，
   text 累加，startedAt 不变
2. **Tool 事件按 toolID 配对**：
   - `agent.tool_call` 创建新 tool segment（status: running）
   - `agent.tool_result` 按 toolID 找到 segment，更新 result + status
3. **段切换时冻结 thinking**（`finalizeOpenThinking`）：当出现非 thinking 事件时，
   把当前 open 的 thinking segment 的 endedAt 设为当前时间，停止计时器
4. **Phase 边界划分**：`phase.start` / `phase.complete` 之间的所有 segment 归属同一 phase
5. **Wave/Task 嵌套**（review-loop 特有）：`wave.start` 内部分组，每组按 `task.start`/`task.complete` 再分子组

**伪代码骨架**：

```ts
class SegmentStore {
  private segments: Segment[] = [];
  private currentThinkingId: string | null = null;

  applyEvent(evt: HermesEvent): void {
    switch (evt.type) {
      case "agent.thinking_delta":
        if (this.currentThinkingId) {
          this.appendThinking(this.currentThinkingId, evt.payload.chunk);
        } else {
          const id = this.openNewThinking(evt);
          this.currentThinkingId = id;
        }
        break;
      case "agent.tool_call":
        this.finalizeOpenThinking();    // 关键：切换段前冻结 thinking
        this.openTool(evt);
        break;
      case "agent.tool_result":
        this.completeTool(evt.payload.toolID, evt);
        break;
      case "agent.complete":
        this.finalizeOpenThinking();
        break;
      // ... 其他事件
    }
  }

  private finalizeOpenThinking(): void {
    if (!this.currentThinkingId) return;
    const seg = this.segments.find(s => s.id === this.currentThinkingId);
    if (seg && seg.kind.type === "thinking") {
      seg.kind.endedAt = Date.now();
      seg.status = "done";
    }
    this.currentThinkingId = null;
  }

  getSegments(): readonly Segment[] { return this.segments; }
}
```

**实施要点**：

1. 必须保留 `finalizeOpenThinking` 这个细节，否则 thinking 计时器会持续滚动很难看
2. 状态修改要触发 React 重渲染：要么用 useState/useReducer 包，要么用 Zustand/Valtio
3. **不要在 SegmentStore 里调网络/SSE**，它只接受事件输入，便于单元测试
4. 多 worktree 并发场景：每个 task 一个独立 SegmentStore，UI 顶层维护 Map<taskId, SegmentStore>


### 8.4 高价值借鉴项 3：组件层级分解

**源文件**：

- `/tmp/hermes-deck-main/hermes_deck/Views/Chat/Message/SegmentTimeline.swift` — 时间轴容器
- `/tmp/hermes-deck-main/hermes_deck/Views/Chat/Message/ToolCallViews.swift` — 工具调用卡片
- `/tmp/hermes-deck-main/hermes_deck/Views/Chat/Message/AgentHandoffStatusView.swift` — 委派状态卡

**借鉴对象**：组件分解的层级结构（不是 Swift 代码本身）。

**翻译目标**：在 `src/web/components/` 下建立对应的 React 组件，参考下表。

| hermes-deck 组件 | 对应 React 组件 | 职责 |
|---|---|---|
| `SegmentTimeline` | `<SegmentTimeline>` | 顶层时间轴容器，map segments 渲染 |
| `ProcessSection` | `<ProcessSection>` | 单个折叠卡片（最常用的 UI 单元） |
| `ProcessHeader` | `<ProcessHeader>` | 标题行：颜色点 + ▸/▾ + 标题 + 计时器 |
| `ProcessBody` | `<ProcessBody>` | 折叠展开后的内容容器 |
| Thinking content view | `<ThinkingContent>` | thinking 文本流，自动滚动到底部 |
| `ToolCallChip` (in ToolCallViews) | `<ToolCallChip>` | 工具调用紧凑卡片：图标+名称+耗时+状态 |
| Tool args/result expandable | `<ToolDetailExpandable>` | 点击展开 tool 的 args 和 result |
| Message content | `<MessageContent>` | 普通消息文本（Markdown 渲染） |
| `AgentHandoffStatusView` | （**不抄**，review-loop 没有委派） | — |

**review-loop 新增组件**（hermes-deck 没有的）：

| React 组件 | 职责 |
|---|---|
| `<PhaseGroup>` | 把同 phase 的 segments 归到一个外层折叠组（PLANNING / DEVELOPING / VERIFYING / AUDITING / FINALIZING） |
| `<WaveGroup>` | Phase 8D 后用于展示 Wave N，内部展示该 wave 内并发的多个 task |
| `<TaskColumn>` | Wave 内每个 task 一列（或一行），独立的 SegmentTimeline 实例 |
| `<VerificationCard>` | review-loop 特有，展示验证命令的执行情况 |
| `<AuditDecisionBadge>` | review-loop 特有，醒目展示 PASS/REWORK/BLOCKED |
| `<ScopeViolationAlert>` | review-loop 特有，红色横幅展示 Scope Guard 拦截 |

**实施要点**：

1. 不要照抄 SwiftUI View 的具体写法，**抄的是层级关系**
2. `<ProcessSection>` 是核心可复用组件，所有 segment 类型都包一层它
3. 颜色/图标参考 §8.5
4. 多 worktree 并发场景下用 `<WaveGroup> > [<TaskColumn>]` 而不是塞进同一 timeline


### 8.5 中价值借鉴项：视觉细节与交互模式

**颜色系统**（直接抄 hermes-deck 的语义，CSS 变量化）：

```css
:root {
  --status-running: #8B5CF6;   /* 紫色实心圆 ● running */
  --status-done: #10B981;      /* 绿色对勾 ✓ done */
  --status-failed: #EF4444;    /* 红色叉 ✗ failed */
  --status-pending: #9CA3AF;   /* 灰色空心圆 ○ pending */
  --status-blocked: #F59E0B;   /* 橙色感叹号 ⚠ blocked */
  --thinking-bg: #F3F4F6;      /* thinking 内容浅灰背景 */
}
```

**图标约定**：

- 折叠状态：▸（折叠） / ▾（展开） — 直接用 Unicode 字符或 lucide-react 的 `ChevronRight` / `ChevronDown`
- 状态点：● ✓ ✗ ○ ⚠ — 同样用 Unicode 或 lucide 的 `Circle` / `Check` / `X` / `AlertTriangle`
- 工具图标：apply_patch、shell、search 等用 lucide 对应图标，不要重新设计

**计时器细节**（重要，hermes-deck 的精髓）：

1. **Running 时**：显示 "Thinking 3s"，每 100ms 自增（`useEffect` + `setInterval`）
2. **完成后**：固定显示 "Thought for 4.2s"（精确到 0.1s）
3. **冻结时机**：`finalizeOpenThinking` 触发时把 endedAt 写死，UI 此后不再更新该 segment 计时器
4. **节能**：定时器以 segment 为单位，已完成的 segment 不挂定时器

**滚动跟随逻辑**（直接抄 hermes-deck 的体验）：

1. 默认自动滚动到底部跟随最新内容
2. 用户向上滚 → 立刻暂停跟随
3. 暂停后 2 秒内用户没继续滚 → 仍保持暂停（不要打扰阅读）
4. 用户滚回最底部 → 立刻恢复跟随
5. 推荐用 `IntersectionObserver` 监听底部 sentinel 元素是否在 viewport

**完成消息不重渲染**（性能关键）：

- 所有已 `done` 状态的 segment 用 `React.memo` 包
- 比较函数：`(prev, next) => prev.id === next.id && prev.status === next.status`
- 只有 running 状态的 segment 才会因为 text 增量更新而重渲染

### 8.6 翻译任务的明确交付物

本节定义"借鉴 hermes-deck"在 Phase 9 落地时**必须交付的产物**，避免落地阶段
变成"自由发挥"。后续 AI 实施时按下表交付：

| 编号 | 交付文件 | 内容 | 来源 |
|---|---|---|---|
| D1 | `src/web/types/segment.ts` | Segment 类型定义 | 翻译 ChatModels.swift |
| D2 | `src/web/segment-store.ts` | SegmentStore 类（事件聚合状态机） | 翻译 ChatStore+Send.swift |
| D3 | `src/web/segment-store.test.ts` | SegmentStore 单元测试（构造各种事件序列校验） | 自写 |
| D4 | `src/web/components/SegmentTimeline.tsx` | 顶层时间轴 | 参考 SegmentTimeline.swift 层级 |
| D5 | `src/web/components/ProcessSection.tsx` | 折叠卡片基础组件 | 参考 SwiftUI 同名结构 |
| D6 | `src/web/components/ToolCallChip.tsx` | 工具调用卡片 | 参考 ToolCallViews.swift |
| D7 | `src/web/components/PhaseGroup.tsx` | review-loop 特有 | 自写 |
| D8 | `src/web/components/WaveGroup.tsx` | review-loop 特有，Phase 8D 集成时用 | 自写 |
| D9 | `src/web/styles/tokens.css` | 颜色/间距/字体的 CSS 变量 | §8.5 表 |
| D10 | `README` 中致谢段落 | 借鉴 hermes-deck 声明 | License 合规 |

### 8.7 给后续 AI 的指引（每次落地此 phase 前必读）

若你是接手此 Phase 9 落地工作的后续 AI，请按以下顺序操作：

1. **先 clone hermes-deck**：`git clone https://github.com/TNJ2026/hermes-deck /tmp/hermes-deck-main`
2. **优先读三个文件**（不要读完整仓库，避免被无关代码淹没）：
   - `Models/ChatModels.swift`（数据模型）
   - `Models/ChatStore+Send.swift` 行 222-355（聚合逻辑）
   - `Views/Chat/Message/SegmentTimeline.swift`（组件结构）
3. **按 §8.6 表逐项交付**，每个交付物作为一个独立 commit
4. **不要复制 Swift 代码字面**，要理解后用 TS/React 重新实现
5. **不要扩展借鉴范围**：不抄 session、profile、AgentRouting、语音输入
6. **遇到 hermes-deck 没有但 review-loop 需要的概念**（如 wave、verification、audit decision），
   按 §8.4 表中"review-loop 新增组件"自写，无需在 hermes-deck 中找原型
7. **License 合规**：在本项目 README 加一行致谢，例如：
   ```
   The web panel UI in this project is inspired by
   [hermes-deck](https://github.com/TNJ2026/hermes-deck) (MIT License).
   ```


## 9. 性能与可靠性

1. **事件不阻塞主流程**：emit 必须是 fire-and-forget，写盘异步、错误吞掉。
2. **events.ndjson 大小限制**：单 run 超过 50 MB 时自动 rotate 为 `events.ndjson.1`。
3. **崩溃恢复**：UI 重连时按 `event_id` 去重；orchestrator 崩溃后 resume 继续追加。
4. **多 worktree 并发（Phase 8D）**：每个 worktree 自己的 `.agent/events.ndjson`，
   主调度器维护一个 `events.ndjson` 汇总各子 run 的事件（带 task_id 标签），UI 可选择
   看主流或单 worktree 流。

## 10. 配置

`review-loop.yaml` 新增：

```yaml
events:
  enabled: true                # 默认 true
  rotate_max_bytes: 52428800   # 50 MB
  drop_oversize_payload: true  # delta chunk > 4KB 时截断而非丢事件
```

## 11. CLI 草案

```bash
review-loop serve [--port 3939] [--open]   # 启动 Web 面板（首期）
review-loop serve --replay                 # 回放历史事件，UI 跑完后退出
review-loop watch                          # （可选）启动终端 TUI
review-loop events tail                    # 直接 tail NDJSON 给脚本消费
review-loop events validate                # 校验 events.ndjson schema 合法性
```

## 12. 验收标准草案

1. `events.ndjson` 在跑任意 run 时持续追加，每行合法 JSON。
2. 关闭 `events.enabled` 后无事件文件产生，主流程行为与 Phase 8 完全一致。
3. UI 进程（Web server）崩溃时主流程继续完成。
4. 主流程崩溃时 events.ndjson 至崩溃点的事件完整可读。
5. resume 时新事件继续追加，event_id 全局单调递增不重复。
6. **Web 面板**能展示 thinking 实时滚动、tool call 耗时、phase / wave / task 折叠展开。
7. **Web 面板**支持 SSE 自动重连：服务端短暂断开后，浏览器侧从最后一个 event_id 续推，无重复无丢失。
8. **Web 面板**仅监听 127.0.0.1，端口被占用时给出明确报错并退出。
9. Phase 8D 并发场景下，**Web 面板**能在同一视图展示多个 task 的并行进度。
10. 事件总数与 progress.json 的 stage 切换次数一致（一致性自检）。
11. 单 run 跑 30 分钟以上，UI 不卡顿、浏览器内存稳定（不持续增长）。

## 13. 与现有体系的关系

| 维度 | progress.json | events.ndjson |
|---|---|---|
| 颗粒度 | 阶段级 | 事件级 |
| 实时性 | 阶段切换时写 | 实时 push |
| 是否审计依据 | 是 | 否 |
| 是否可恢复源 | 是 | 否（只用于展示） |
| 消费者 | `status` CLI / 用户 | `watch` CLI / UI / 插件 |

两者并存，不互相替代。

## 14. 范围外（明确不做）

- ❌ 用户在 UI 中介入流程（暂停 / 跳过 / 修改 prompt）— 任何控制仍走 CLI。
- ❌ 把 events.ndjson 作为 audit 输入。
- ❌ 多 run 跨进程的全局事件总线（每个 run 独立一份 NDJSON）。
- ❌ Web 面板的远程访问与鉴权。
- ❌ 临时委派 / 角色路由（明确不在本 phase 范围内，未来如需，单独立 phase）。
