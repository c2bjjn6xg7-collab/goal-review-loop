---
schema_version: 1
run_id: "20260622020433-0g30a6"
author_role: "planner"
---

# Phase 9 R2A — Read-Only Web Dashboard Plan

## Requirement Understanding

Phase 9 R1 已落地 `.agent/events.jsonl`（append-only JSONL）与 `EventStore`
（`src/runtime/event-store.ts`）。R2A 在此基础上交付**只读** Web Dashboard：

- 新增 HTTP server，复用 `EventStore.readAll()` 读取事件流。
- 根路径 `GET /` 返回一个内联 HTML 单页，每 2 秒用原生 `fetch` 轮询
  `GET /api/events`，渲染 run_id / phase / 最近事件 / artifacts。
- 新增 CLI 子命令 `review-loop dashboard`，支持 `--port`（默认 `0` = 随机端口）
  与 `--project-root`（默认 `process.cwd()`），启动后打印实际监听端口。
- **纯只读**：不修改 `.agent` 下任何文件，不触发 agent，不做写操作。
- **零新依赖**：HTML 内联，前端用 `fetch`，server 用 `node:http`，测试用
  `node:http` 直接发请求（不引入 supertest）。

不在 R2A 范围内：SSE/WebSocket（R2B）、操作按钮（R2C）、event-bus/event-store/
status watch 等 R1 既有模块的修改、`review-loop.yaml` 改动。

## Current Project Status

- 仓库根：`/Users/dengyidong/Desktop/cc劳工系统`，基线提交 `c7d3dac`。
- TypeScript ESM，构建 `npm run build`（`tsc` 输出到 `dist/`），测试 `npm test`
  （vitest）。`tsconfig.json` `rootDir: src`，源文件互相 import 使用 `.js`
  后缀。
- CLI 入口：`src/cli/main.ts` → `src/cli/index.ts`。子命令工厂模式
  （`createStatusCommand` 等）通过 `program.addCommand(...)` 注册。
- Event 流：`src/runtime/event-store.ts` 暴露 `EventStore`（`constructor(agentDir, runId)`、`readAll()`、`getLastSequence()` 等）。
  Run 终结事件 kind：`run.completed | run.blocked | run.failed`。
- Status 文本渲染参考：`renderTextSummary` in `src/cli/status.ts:171`。
- 测试目录：`tests/unit/`、`tests/integration/`，扩展名 `*.test.ts`。Vitest
  globals 已开启。
- 现有 `.agent/events.jsonl` 验证文件格式真实可用。

## Technical Approach

### 模块划分

1. **`src/web/event-source.ts`**（薄读取层）
   - 暴露 `loadDashboardSnapshot(projectRoot)` 函数：定位 `.agent/`，读取
     `state.json` 拿到 `run_id`（缺失时回退到首个事件的 `run_id` 或
     `'unknown'`），实例化 `EventStore`，调用 `readAll()`，再加上派生字段
     （`current_phase`、`latest_events`、`artifacts`）。
   - 不写入；所有错误（缺 `.agent`、缺 `events.jsonl`、JSON 解析错误）都翻译
     成 `{ ok: false, message }` 响应而不是抛出，保证 server 永远只读。
   - 派生规则与 `renderTextSummary` 对齐：
     - `run_id`：state.json 或事件流
     - `current_phase`：终结事件存在 → 终结事件的 phase；否则最后一条事件的
       phase
     - `latest_events`：最后 N 条（N=20，足够展示但避免无限增长）
     - `artifacts`：扫描最近 N 条事件的 `artifact_refs`，按 path 去重保序

2. **`src/web/dashboard-server.ts`**（HTTP 路由）
   - 使用 `node:http` 创建 server。两个路由：
     - `GET /` → 返回 inline HTML（`Content-Type: text/html; charset=utf-8`）
     - `GET /api/events` → 返回 `loadDashboardSnapshot` 的 JSON
       （`Content-Type: application/json`）
   - 其他路径返回 404 JSON。其他方法返回 405。
   - 仅监听 `127.0.0.1`，端口由调用方决定（0 = 随机）。
   - 暴露 `createDashboardServer({ projectRoot })`：返回 `{ server, start(port), stop() }`，
     便于测试 `await start(0)` 拿到实际端口。

3. **`src/web/dashboard-html.ts`**（HTML 模板）
   - 导出 `renderDashboardHtml(): string`，返回完整 HTML 字符串：
     - 顶部显示 `Run: <id>  Phase: <phase>`
     - "Latest events" 表格：时间 / kind / message（带 role 后缀如有）
     - "Artifacts" 列表
     - `<script>` 中用 `fetch('/api/events')` 每 2000ms 轮询并刷新 DOM
     - 所有动态文本通过 `textContent` 注入，避免 XSS（事件 message 可能含
       任意字符）。

4. **`src/cli/dashboard.ts`**（CLI 子命令）
   - `createDashboardCommand(): Command`：选项 `--port <port>`（默认 `'0'`，
     解析成非负整数，0 表示随机），`--project-root <path>`（默认
     `process.cwd()`）。
   - 动作：创建 server → `start(port)` → 打印
     `Dashboard listening on http://127.0.0.1:<actualPort>` → 注册 SIGINT/SIGTERM
     stop 钩子。

5. **`src/cli/index.ts`**：注册 `createDashboardCommand()`。

### 测试策略

`tests/unit/dashboard-server.test.ts`（vitest，无外部依赖）：

- 用 `fs-extra` 在 `os.tmpdir()` 创建临时 `agentDir`，用 `EventStore` 预先
  append 若干事件，并写最小 `state.json`。
- 通过 `createDashboardServer({ projectRoot })` 启动，端口 `0`，使用
  `node:http` 的 `http.get` 发起请求。
- 覆盖：
  - `GET /` 返回 HTML（status 200，content-type 含 `text/html`），body
    包含轮询脚本与基本结构（如 `id="run-id"`、`fetch('/api/events')`）。
  - `GET /api/events` 返回 JSON，结构包含 `run_id`、`current_phase`、
    `latest_events`、`artifacts`。
  - 当 `events.jsonl` 不存在或 `.agent` 不存在时，`/api/events` 仍返回 200
    且 `latest_events: []`（不抛出）。
  - 未知路径返回 404；非 GET 返回 405。
  - server.stop() 后再次请求失败（确认资源释放）。

`tests/unit/dashboard-html.test.ts`：snapshot + 关键 token assertion（含
`fetch('/api/events')`、`setInterval`、`textContent`）。

`tests/unit/event-source.test.ts`：构造若干 fixture 事件，验证派生
`current_phase`、`latest_events` 长度、`artifacts` 去重保序、错误回退。

### 不引入新依赖的具体做法

- HTTP server：`import { createServer } from 'node:http'`
- HTML：模板字面量字符串，CSS 内联（minimal styling）
- 前端 fetch：`fetch('/api/events').then(r=>r.json()).then(render)`，浏览器
  原生 ES。
- 测试 HTTP 请求：`http.request` + 收集 chunks 转字符串的小 helper。

## Work Breakdown

单一原子任务即可：所有文件互相耦合（HTML 模板嵌入到 server，server 调用
event-source，CLI 注册 server），并且需要同步编译/测试通过。按 Phase 8B 指南
"orchestrator wiring + integration tests" 属于必须一起落地的范畴；硬拆只会
产生半就绪状态。

- **task-1 (atomic)**：实现 `src/web/event-source.ts`、`src/web/dashboard-html.ts`、
  `src/web/dashboard-server.ts`、`src/cli/dashboard.ts`，在 `src/cli/index.ts`
  注册子命令；新增上述测试；`npm test` 全绿。

## Risks

- **R1**: 旧 run 缺失 `events.jsonl` 或 `state.json`。缓解：`event-source` 全
  路径 try/catch，永远返回结构化 JSON；UI 显示 "No events yet" 而非崩溃。
- **R2**: 事件 message / artifact path 含恶意字符引起 XSS。缓解：前端只用
  `textContent` / `appendChild`，HTML 模板不拼接事件内容；`/api/events` 永远
  返回 JSON。
- **R3**: 端口冲突或权限问题。缓解：默认 `--port 0` 让 OS 分配；监听
  `127.0.0.1` 避免外部暴露与权限弹窗。
- **R4**: 轮询期间 `events.jsonl` 被持续追加引起的 race。缓解：`EventStore.readAll`
  已经容忍尾部不完整行；server 每次请求都重新 `readAll`，无内存状态。
- **R5**: Windows / 非 ASCII 路径。缓解：仅使用 `path.join` / `path.resolve`，
  不解析 URL 路径外的内容；测试覆盖 macOS 默认场景（与项目目标一致）。
