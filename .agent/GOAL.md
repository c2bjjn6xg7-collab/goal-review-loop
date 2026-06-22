---
schema_version: 1
run_id: "20260622020433-0g30a6"
goal_id: "phase-9-r2a-readonly-dashboard"
title: "Phase 9 R2A: Read-Only Web Dashboard consuming events.jsonl"
allowed_changes:
  - "src/web/**"
  - "src/cli/dashboard.ts"
  - "src/cli/index.ts"
  - "tests/unit/dashboard-server.test.ts"
  - "tests/unit/dashboard-html.test.ts"
  - "tests/unit/event-source.test.ts"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - "src/runtime/event-store.ts"
  - "src/runtime/event-bus.ts"
  - "src/cli/status.ts"
  - "review-loop.yaml"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
  - id: "typecheck"
    command: ["npm", "run", "typecheck"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "build"
    command: ["npm", "run", "build"]
    cwd: "."
    required: true
    timeout_seconds: 300
---

# Objective

实现 Phase 9 R2A 只读 Web Dashboard：新增一个 `node:http`-based HTTP server，
启动后监听 `127.0.0.1` 的指定端口（默认 0=随机），通过 `EventStore.readAll()`
读取 `.agent/events.jsonl`，在 `GET /` 提供一个内联 HTML 单页，前端每 2 秒
轮询 `GET /api/events` 刷新展示当前 run 的 `run_id`、`phase`、最近事件列表与
artifacts 引用。新增 CLI 子命令 `review-loop dashboard`，支持 `--port` 与
`--project-root`。整个特性纯只读、零新依赖。

# Success Criteria

1. **CLI 命令注册成功**：执行 `node dist/cli/main.js dashboard --help` 显示
   `--port` 与 `--project-root` 两个选项，且命令 description 描述只读
   dashboard。
2. **Server 监听本地端口**：`createDashboardServer({ projectRoot })` 调用
   `.start(0)` 后返回实际监听端口（非 0），仅绑定 `127.0.0.1`；调用
   `.stop()` 后再次发起请求失败（连接被拒绝）。
3. **`GET /` 返回 HTML 单页**：状态码 200，`Content-Type` 包含
   `text/html; charset=utf-8`，响应体包含字符串
   `fetch('/api/events')` 与 `setInterval`，且使用 `textContent` 注入动态
   字段以避免 XSS。
4. **`GET /api/events` 返回 JSON snapshot**：状态码 200，`Content-Type`
   `application/json`，JSON 至少包含字段 `run_id: string`、
   `current_phase: string`、`latest_events: ReviewLoopEvent[]` 与
   `artifacts: { type: string; path: string; label?: string }[]`，事件按
   `seq` 升序，`latest_events` 至多 20 条。
5. **缺失文件优雅降级**：当目标 `.agent/events.jsonl` 不存在（或 `.agent`
   不存在）时，`GET /api/events` 仍返回 200，`latest_events: []`，
   `run_id` 取自 `state.json`（若存在）或字符串 `"unknown"`；不抛出。
6. **未知路径/方法**：未知路径返回 404 JSON；非 GET 方法返回 405 JSON。
7. **纯只读**：实现代码与测试不调用 `fs.writeFile` / `appendFile` /
   `rename` / `unlink` 等对 `.agent/` 目录的写入操作（测试中用临时目录
   seed 数据除外）。
8. **零新 npm 依赖**：`package.json` 的 `dependencies` 与 `devDependencies`
   字段不发生增减；新代码仅使用 `node:*` 内置模块、已有依赖
   （`fs-extra`、`commander` 等）以及 `src/runtime/event-store.ts` 现有导出。
9. **测试覆盖**：新增至少三个 vitest 单测文件（`dashboard-server.test.ts`、
   `dashboard-html.test.ts`、`event-source.test.ts`），覆盖
   - HTML 响应结构与关键 token
   - `/api/events` 正常路径
   - `/api/events` 在缺失 `.agent`/`events.jsonl` 下的降级
   - 未知路径 404 与非 GET 405
   - `EventSource` 的派生字段（current_phase、latest_events 截断、
     artifacts 去重）
10. **所有 verification commands 通过**：`npm run typecheck`、
    `npm run build`、`npm test` 均退出码为 0。
11. **不动既有模块**：`src/runtime/event-store.ts`、`src/runtime/event-bus.ts`、
    `src/cli/status.ts`、`review-loop.yaml` 文件内容不变（diff 为空）。
12. **CLI 注册可见**：`src/cli/index.ts` 通过 `program.addCommand(
    createDashboardCommand())` 注册新命令。

# Non-Goals

- 不实现 SSE/WebSocket 实时推送（Phase 9 R2B）。
- 不实现 cancel/resume 等操作按钮或任何 POST/PUT/DELETE 路由（Phase 9 R2C）。
- 不修改 `src/runtime/event-store.ts`、`src/runtime/event-bus.ts`、
  `src/cli/status.ts` 等 Phase 9 R1 既有代码。
- 不修改 `review-loop.yaml`。
- 不实现多 run 切换 / 历史 archive 浏览。
- 不引入前端构建（React/Vite 等），不抄 hermes-deck 的 segment 聚合逻辑（R2A
  只展示原始事件流）。
- 不实现持久化的端口配置或自动浏览器打开。
- 不实现鉴权（仅绑定 `127.0.0.1`）。

# Constraints

- **TypeScript**：所有新代码遵循 `tsconfig.json`，`strict: true`、
  `noUnusedLocals/Parameters: true`、Node16 ESM。新模块互相 import 必须使用
  `.js` 扩展。
- **不引入新 npm 依赖**：`package.json` 的 `dependencies` 与 `devDependencies`
  保持不变。
- **HTTP server**：使用 `node:http`，仅监听 `127.0.0.1`。
- **HTML 内联**：单页 HTML 整段写在 TS 模板字符串里；前端 JS 也内联，使用
  原生 `fetch` 与 `setInterval`，轮询间隔 2000ms。
- **复用 `EventStore.readAll()`**：不重复实现 JSONL 解析。
- **纯只读**：HTTP handler 与 CLI 命令均不得对 `.agent/` 写入；不得调用任何
  会启动 agent / 修改 state 的代码路径。
- **XSS 防护**：前端注入事件字段时只使用 `textContent` 或
  `document.createTextNode`，不得使用 `innerHTML` 拼接事件数据。
- **测试不引入 supertest**：测试用 `node:http` 直接发请求并断言。
- **CLI 行为**：`review-loop dashboard` 启动后必须以 `Dashboard listening on
  http://127.0.0.1:<port>` 形式打印实际端口；进程在收到 SIGINT 时调用
  `.stop()` 后退出。
- **路径白名单**：仅允许修改本 GOAL `allowed_changes` 列出的路径；不得修改
  `disallowed_changes` 列出的路径，且不得修改任何 `.agent/` 下文件。
