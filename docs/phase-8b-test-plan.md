# Phase 8B 测试计划：Task Graph 顺序执行

## 测试位置（先看这里）

整轮测试涉及两个位置，**不要混用**。

### 主仓库：`/Users/dengyidong/Desktop/cc劳工系统`

用于：

- 工程门禁（typecheck / lint / build / npm test / audit / pack）
- 单元和集成测试聚焦（vitest 跑现有测试）
- 边界与负面验证（写一个**临时** `.test.ts` 跑 `validateTaskGraph`，跑完用 `git checkout -- tests/` 清掉）

约束：

- 当前 main HEAD：`628ac50 docs: add phase 8b test plan for developer ai`
- 在 main 分支上工作，**不允许** commit、push、或留下未跟踪的临时文件
- **不允许** 修改 `src/`、`tests/`、`prompts/`、`docs/phase-8b-*` 中已有内容
- 边界验证写的临时测试文件**不要 git add**，跑完立即删除或 checkout 还原
- **不允许** 在主仓库执行 `review-loop start`

### 临时 Smoke 仓库：`/tmp/phase-8b-smoke`

用于：

- 真实模型 dogfood（让 review-loop 真实写代码、提交、运行 vitest）

约束：

- 必须由你在测试开始时 `mkdir` 创建并 `git init`，不要复用任何旧目录
- 这是一次性目录，review-loop 会在里面 `git commit`、写 `src/`、`tests/`，这是预期行为
- 测试结束后可以删除整个目录，**不要** 把里面任何内容拷回主仓库

### 测试报告位置

- 报告文件名：`phase-8b-test-report.md`
- 报告路径：写在 `/tmp/` 下或你自己的工作区，**绝对不要** 提交到主仓库
- 报告内容必须包含真实数字和时间戳

## 给开发师 AI 的总体说明

Phase 8B 已经合并到 `main`（commits `61ef05a..fd7c71a`）。本轮你不是开发新功能，而是**作为测试者**对已合并代码做端到端验证。

你的任务分两层：

1. **回归测试**：跑完整门禁，确认 main 落地后所有指标依然全绿。
2. **真实模型 dogfood**：用 Review Loop 自身在国产模型链路下跑一个多任务需求，验证 task-graph 在真实 Claude/Codex 配置下能完整跑完。

整轮测试不允许修改 `src/`、`tests/`、`prompts/` 下任何业务代码。如果发现 bug，记录到测试报告，**不要自己改**——下一轮规划师会基于你的报告再开返工。

## 必读上下文

在动手之前，请按顺序读完：

1. `docs/phase-8b-task-graph-requirements.md` — Phase 8B 原始需求
2. `src/scheduler/task-graph.ts` — 任务图校验和拓扑排序
3. `src/orchestrator/run-orchestrator.ts` 的 `runTaskGraphLoop` 函数（约 line 2821 起）
4. `tests/integration/task-graph.test.ts` — fake provider 集成测试
5. `tests/fixtures/fake-agent.mjs` — fake provider 实现
6. `prompts/planner.md` 中的 Task Graph 分解指令（最近新增段落）
7. `review-loop.yaml` — 国产模型 dogfood 配置

## 工程门禁（回归层）

在干净 main 分支上执行，全部必须通过：

```bash
git checkout main
git pull --ff-only
npm ci
npm run typecheck
npm run lint
npm run build
npm test
git diff --check
npm audit --omit=dev
npm pack --dry-run
```

**期望结果**：

| 检查 | 期望 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run lint` | 0 错误，0 警告 |
| `npm run build` | 通过 |
| `npm test` | 50 个测试文件，767 个测试全过 |
| `git diff --check` | 干净 |
| `npm audit --omit=dev` | 0 漏洞 |
| `npm pack --dry-run` | 成功，含 plugin/ 目录 |

任何一项失败都视为阻断，直接进入"测试报告"环节，不要继续后面的真实 smoke。

## 单元/集成测试聚焦项

跑完整 `npm test` 后，再单独验证 Phase 8B 关键测试文件：

```bash
npx vitest run tests/unit/task-graph.test.ts \
  tests/unit/task-prompt-builder.test.ts \
  tests/integration/task-graph.test.ts
```

**期望**：3 个文件，约 24 个测试，全过。

记录每个文件的测试数和耗时。如果有 skip 或 todo 标记，列出原因（开发者声称无 skip）。

## 真实模型 dogfood Smoke

### 准备工作

1. 创建一个**临时干净仓库**用于 smoke，不要污染主仓库：

```bash
mkdir -p /tmp/phase-8b-smoke && cd /tmp/phase-8b-smoke
git init
npm init -y
echo "node_modules/" > .gitignore
mkdir src tests
echo 'export function hello(name) { return `Hello, ${name}`; }' > src/hello.js
cat > tests/hello.test.js <<'EOF'
import { test, expect } from 'vitest';
import { hello } from '../src/hello.js';
test('hello returns greeting', () => { expect(hello('World')).toBe('Hello, World'); });
EOF
npm install -D vitest
npm pkg set scripts.test="vitest run"
git add -A && git commit -m "init: smoke baseline"
```

2. 复制主仓库的 `review-loop.yaml` 到 smoke 仓库根目录。
3. 确认 `claude` 和 `codex` CLI 在 PATH 上可调用：

```bash
which claude && claude --version
which codex && codex --version
```

如果任一缺失，记录"环境阻断"，跳过 smoke。

### 执行

在临时仓库内执行：

```bash
review-loop start \
  --config ./review-loop.yaml \
  --task-slug phase-8b-smoke \
  --max-iterations 3 \
  --watch \
  --request "Add three small utility functions to src/, each with its own vitest test:
1. isEven(n) in src/isEven.js — returns true if n is even
2. sum(arr) in src/sum.js — returns sum of array
3. capitalize(s) in src/capitalize.js — returns string with first letter uppercase
Each function must have a corresponding test file under tests/. The Planner must produce a task-graph with at least 2 tasks."
```

### 观察点

任务运行期间，每 5 分钟做一次状态采样（不要干预进程）：

```bash
cat .agent/progress.md | tail -30
cat .agent/state.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('phase:',d['phase'],'iter:',d.get('iteration'),'task_idx:',d.get('task_graph_state',{}).get('current_task_index') if d.get('task_graph_state') else 'N/A')"
```

记录每次采样的：
- 时间戳
- phase
- iteration
- current_task_index
- 当前 last_event

### 期望终态

| 指标 | 期望 |
|---|---|
| 最终 phase | `PASSED` |
| `.agent/task-graph.json` | 存在，至少 2 个任务，所有任务 status=`done` |
| `.agent/audit-report.md` | decision=`PASS` |
| `.agent/final-audit.md` | decision=`PASS` |
| 最终 commit | 存在，commit message 含 task slug 和 run_id |
| `npm test` 在 smoke 仓库 | 通过，新增 3 个测试文件、3 个测试 |

### 失败兜底

如果 smoke 中途 BLOCKED，**不要重试 3 次以上**。BLOCKED 后立即：

1. 收集 `.agent/state.json` 的 `last_error`
2. 收集 `.agent/debug/*.log` 最后 50 行
3. 收集 `.agent/audit-report.md`（如果存在）
4. 记录到测试报告的"Smoke 失败诊断"小节，不要自己尝试修复代码

## 边界与负面验证

在 fake provider 层面跑下面这些场景（用 vitest 已有 fixture，不要新增 fake-agent 行为）：

1. **环检测**：构造一个有循环依赖的 task-graph，调用 `validateTaskGraph` 应返回 `valid=false`，错误信息提到 cycle。
2. **依赖引用错误**：task A 依赖不存在的 B，应被 `validateTaskGraph` 拒绝。
3. **超过 10 任务**：构造 11 任务 graph，应被 schema 拒绝。
4. **空 allowed_changes**：任务 allowed_changes 为空数组，应被拒绝。
5. **不安全路径**：task allowed_changes 含 `../foo` 或 `/etc/passwd`，应被拒绝。

这些是只读测试：写一个临时 `.test.ts` 文件**不要 commit**，跑完后 `git checkout -- tests/` 清理掉。如果某条已有覆盖，标注"已被现有测试覆盖"即可。

## 测试报告模板

完成全部测试后，在临时仓库或个人工作区生成 `phase-8b-test-report.md`，结构如下（**不要提交到 main 仓库**）：

```markdown
# Phase 8B 测试报告

## 1. 环境
- Node 版本：
- npm 版本：
- claude --version：
- codex --version：
- main 当前 HEAD：
- 测试执行时间：

## 2. 工程门禁结果
（每项结果，附耗时）

## 3. 单元/集成测试聚焦
- task-graph.test.ts: N tests, 耗时, 全过 / 失败列表
- task-prompt-builder.test.ts: ...
- 集成测试: ...

## 4. 真实模型 dogfood Smoke
### 4.1 配置确认
### 4.2 状态采样时间线
（每 5 分钟一行）
### 4.3 终态
- phase:
- task-graph.json 摘要:
- audit decision:
- final-audit decision:
- final commit:
- smoke 仓库测试结果:

## 5. 边界与负面验证
（每条 1 行结论）

## 6. 发现 Findings
| ID | 严重性 | 描述 | 重现步骤 | 建议 |
|---|---|---|---|---|
| F-8B-T-001 | ... | ... | ... | ... |

## 7. 残留风险
（你测试过程中观察到、但不构成 Finding 的风险点）

## 8. 结论
- PASS / PARTIAL / FAIL
- 推荐下一步动作
```

## 严格约束

- 不允许修改 `src/`、`tests/`、`prompts/`、`docs/phase-8b-*` 下任何文件
- 不允许在 main 上 commit/push 任何东西
- 不允许跳过任何门禁项
- 不允许在 smoke 阶段连续重试超过 3 次
- 测试报告必须包含真实数字和时间戳，不允许"约"、"大概"、"应该"

## 完成定义

测试视为完成，当：

1. 全部门禁项跑过且记录结果
2. 真实 smoke 跑过一次（成功或失败都算）
3. 边界与负面验证 5 条全部走过
4. 测试报告生成，内容完整
5. 报告里明确给出 PASS / PARTIAL / FAIL 结论
