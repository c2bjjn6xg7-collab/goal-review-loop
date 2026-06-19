# Phase 8D P5 实现任务书:Wave 调度器

> Status: **Brief only — do NOT code until this doc is approved**
> Scope: Goal Review Loop repository
> Priority: 8D 最难的一块,串行→并发核心重构
> Depends on: P0-P4 已落地(main `2754414`)
> Source of truth for **design**: `docs/phase-8d-worktree-parallel-execution.md` §7.1
> Source of truth for **implementation**: 本文档
> Created: 2026-06-19

**P5 是骨头,不是饼干。** 本文档规定**三轮拆法**,每轮可独立验收、独立合并。
开发师严格按轮推进,**不要跨轮**。每轮交付物明确,边界清晰。

---

## 0. 已查清的实现依据(开发师不用再查)

| 依据 | 位置 | P5 含义 |
|---|---|---|
| 串行推进循环 | `task-graph-loop.ts:141` `for (i=startIndex; i<ordered.length; i++)` | **第二轮替换这个 for 循环**为 wave 驱动 |
| `current_task_index` 读写点 | `task-graph-loop.ts:139,148,155` + `types.ts:1083` + `run-orchestrator.ts:293` | **第二轮废弃**,改 task_statuses 驱动 |
| per-task 状态(已存在,复用) | `types.ts:1079` `TaskGraphState.task_statuses` + `task_attempts` | resume 改 status 驱动**复用这两个**,不新建 |
| wave 输入 | `types.ts:1037` `TaskNode.depends_on: string[]` + `1036` `parallelizable` | wave 计算纯函数的输入 |
| P3 接入点 | `src/scheduler/worktree-manager.ts` `createForTask/cleanupTask` | wave executor 内为每个 task 调它建 worktree |
| P4 接入点 | `src/scheduler/conflict-detector.ts` `detectWaveConflicts` | wave 分层后,同 wave 内冲突 task demote 下一 wave |
| **配置缺口** | `max_parallel_workers` **不存在**(只有 provider 级 `max_parallel_runs` types.ts:480) | 第一轮要新增全局并发上限配置 |

---

## 三轮拆法总览

| 轮 | 交付物 | 风险 | 能否独立合并 |
|---|---|---|---|
| **第一轮** | wave 计算纯函数 + 单测(`computeWaves`/`demoteConflicts`)+ `max_parallel_workers` 配置 | 低(纯函数,不动循环) | ✅ |
| **第二轮** | `runWaveExecutor` + 接入 task-graph(wave 驱动替换 for 循环)+ 废弃 current_task_index | **高**(动核心循环) | ✅(parallel:false 默认仍走旧 serial,byte-identical) |
| **第三轮** | 只补边界测试(wave-gate、冲突 demote、resume 按 status),**不加新功能** | 低 | ✅ |

**铁律**:`parallel:false`(默认)时,行为与现状 byte-identical——8B 串行路径零回归。
这是三轮共同的红线,每轮都要验证。

---

## 第一轮:Wave 计算纯函数 + 并发配置

**目标**:把 wave 分层逻辑做成纯函数,完全可测,不碰任何循环/IO。这一轮零风险,
但它是第二轮 executor 的地基,必须先做扎实。

### 1.1 新增配置 `max_parallel_workers`

文件 `src/types.ts` 和 `src/artifacts/config.ts`:

```ts
// ReviewLoopConfig 加顶层字段(或放 loop 段,看现有风格)
interface ReviewLoopConfig {
  // ...existing...
  /** Phase 8D: 全局并发 worker 上限。默认 1(=串行,byte-identical)。 */
  max_parallel_workers?: number;  // 1..16
}
```

默认值 `1`(关键:默认 1 = 串行 = byte-identical)。schema 校验 1..16。

### 1.2 新文件 `src/scheduler/wave-compute.ts`

纯函数,无 IO,无副作用。输入是 TaskNode 数组,输出是分层后的 wave 数组。

```ts
import type { TaskNode } from '../types.js';

export interface WavePlan {
  /** 每个元素是一个 wave,内是该 wave 可并发的 task_id 列表(已按拓扑序)。 */
  waves: string[][];
  /** 每个 task 分到的 wave 索引(0-based)。供调试/日志。 */
  waveIndexOfTask: Map<string, number>;
}

/**
 * 按 DAG 拓扑深度分层。一个 task 的 wave_index = 它依赖的最深 task 的 wave+1;
 * 无 depends_on 的 task 在 wave 0。
 *
 * 循环依赖 / 缺失依赖 → 抛 WaveComputeError(不要静默吞)。
 * parallelizable: false 的 task 独占一个 wave(wave 内只有它一个)。
 */
export function computeWaves(tasks: TaskNode[]): WavePlan;

/**
 * 给定一个 wave 的 task 列表 + 冲突检测结果(P4 detectWaveConflicts 输出),
 * 把与同 wave 其他 task 冲突的 task demote 到下一 wave。
 * 返回调整后的 wave 结构。
 *
 * demote 规则:冲突双方中 task_id 字典序较大的那个 demote(确定性)。
 * demote 后重新检查下一 wave 是否又产生新冲突(可能级联 demote)。
 */
export function demoteConflicts(plan: WavePlan, conflicts: Map<string, string[]>): WavePlan;
```

### 1.3 实现要点

- **拓扑分层用 Kahn 或 DFS**。推荐:对每个 task 递归算 wave_index =
  `max(dep.wave_index for dep in depends_on) + 1`,无依赖 = 0。带环检测(visited
  + on-stack,遇环抛错)。
- **parallelizable: false 的 task**:它出现在某个 wave,但该 wave 里只有它
  (其他 task 若拓扑同层,挤到下一 wave)。实现:先算所有 task 的 wave_index,
  再把 non-parallelizable task 的 wave 调整为独占。
- **demoteConflicts**:对每个 wave,查 conflicts,把冲突 task 移到下一 wave,
  下一 wave 重新检测(级联)。设一个上限迭代(如 wave 数 × 2)防死循环,超了抛错
  (说明冲突图病态,需人工)。

### 1.4 验证(`tests/unit/wave-compute.test.ts`)

```ts
describe('computeWaves', () => {
  it('T1,T2 roots + T3 depends T1 → wave [T1,T2] then [T3]', () => {
    const tasks = [
      { id: 't1', depends_on: [], parallelizable: true, ... },
      { id: 't2', depends_on: [], parallelizable: true, ... },
      { id: 't3', depends_on: ['t1'], parallelizable: true, ... },
    ];
    const plan = computeWaves(tasks);
    expect(plan.waves).toEqual([['t1', 't2'], ['t3']]);
  });

  it('chain t1→t2→t3 → three waves of one', () => { ... });

  it('throws on cycle t1→t2→t1', () => {
    expect(() => computeWaves([...])).toThrow(/cycle/i);
  });

  it('throws on missing dependency t2 depends_on ghost', () => { ... });

  it('non-parallelizable task occupies a wave alone', () => {
    // t1(np) + t2(parallelizable) 同层 → t1 独占 wave0, t2 到 wave1
  });

  it('empty task list → empty plan (not throw)', () => { ... });
});

describe('demoteConflicts', () => {
  it('demotes lexically-larger task id on conflict', () => {
    // wave0=[auth, login], conflicts: auth↔login → login(t2) demote 到 wave1
  });

  it('cascades: demoted task conflicts in next wave → demote again', () => { ... });

  it('no conflicts → plan unchanged', () => { ... });
});
```

### 1.5 第一轮验收
- `max_parallel_workers` 默认 1,schema 1..16。
- `computeWaves` 6+ 用例全过(含环/缺失依赖/np 独占/空)。
- `demoteConflicts` 3+ 用例(含级联)。
- **工程门全绿,现有 892 测试 byte-identical**(这一轮没动循环,零回归)。
- **不碰** task-graph-loop.ts、run-orchestrator.ts 核心。

---

## 第二轮:Wave Executor + 接入 task-graph

**目标**:把第一轮的 `computeWaves` 接入调度。风险最高,**必须保证
`max_parallel_workers<=1` 时退化成串行且 byte-identical**。

### 2.1 新文件 `src/scheduler/wave-executor.ts`

```ts
export interface WaveExecutorParams {
  // 复用现有 runTaskGraphLoop 的绝大多数参数(见 task-graph-loop.ts 签名)
  // ...
  /** 全局并发上限(来自 config.max_parallel_workers)。 */
  maxParallelWorkers: number;
}

export async function runWaveExecutor(params: WaveExecutorParams): Promise<OrchestratorResult>;
```

**核心流程**:
```
1. computeWaves(tasks) → WavePlan
2. 对 conflicts 调 detectWaveConflicts(trackedFiles) → demoteConflicts(plan, conflicts)
3. for each wave in plan:
   a. 该 wave 的 task 数若 > maxParallelWorkers,超出部分排队等下一轮空位
   b. 对 wave 内每个 task(并发,受 maxParallelWorkers 限):
      - WorktreeManager.createForTask(建 worktree+分支)
      - 在 worktree 里跑 Developer/验证/Auditor(复用现有 per-task 逻辑,
        抽成可复用函数,见 2.2)
      - WorktreeManager.cleanupTask(留分支)
   c. 等 wave 内所有 task 到达 passed/blocked(wave-gate,设计文档 §27a)
   d. blocked 不 gate 下一 wave;rework/running 中的则 gate
4. 全部 wave 完 → 走现有 finalization(不在此轮改)
```

### 2.2 关键重构:把 per-task 逻辑抽成可复用函数

现状:`task-graph-loop.ts:170-285` 的 per-task rework 循环(attempt 1..maxIterations)
是**内联在 for 循环里**的。第二轮要把它抽成:

```ts
async function runOneTaskInWorktree(params: {
  task: TaskNode;
  worktreePath: string;
  // ...复用现有 Developer/验证/Auditor 调用参数
}): Promise<{ passed: boolean; error: string | null }>;
```

这样 wave executor 能对每个 task 调它,串行 executor(旧 for 循环)也能调它。
**抽函数时保持行为完全一致**——这是第二轮最容易出回归的地方,要逐行比对。

### 2.3 接入点:`run-orchestrator.ts:300 / :594`

现有两处 `runTaskGraphLoop(...)` 调用。改成:
```ts
if (config.max_parallel_workers && config.max_parallel_workers > 1) {
  return await runWaveExecutor({ ...params, maxParallelWorkers: config.max_parallel_workers });
} else {
  return await runTaskGraphLoop({ ...params });  // 旧串行,byte-identical
}
```

### 2.4 废弃 `current_task_index`

- `task-graph-loop.ts:141` 的 for 循环改 status 驱动(其实串行路径也可保留 for,
  但 wave 路径不用 current_task_index)。
- **resume 改读 task_statuses**(types.ts:1079 已有,复用):resume 时跳过 passed、
  重跑 failed、保留 blocked。current_task_index 在 wave 模式下不再写。
- **保留 current_task_index 字段**(types.ts:1083)不删,只为串行路径 + 向后兼容,
  但加注释标"wave 模式下无效"。删字段是破坏性改动,留给后续。

### 2.5 第二轮验收
- `max_parallel_workers: 1`(默认)时,**现有 892 测试 byte-identical**(红线)。
- `max_parallel_workers: 2` 时,2 个独立 task 在同一 wave 并发跑(集成测试用
  fake-agent,断言 2 个 worktree 同时存在)。
- wave-gate:wave 有 task 在 rework 时,下一 wave 不启动(设计文档 §27a)。
- resume:崩溃后按 task_statuses 恢复,跳过 passed task。
- per-task 逻辑抽函数后,行为与改动前一致(逐 case 比对)。

**这一轮的集成测试一定要用 fake-agent**(不要真调 codex/claude,慢且贵)。

---

## 第三轮:边界测试补全(不加新功能)

**目标**:第二轮接好后,补足并发边界 case 的测试。**只写测试,不改实现**——
防止"为了过测试偷偷加功能"导致并发失控。

### 3.1 必补的测试 case

```ts
// tests/integration/wave-scheduler.test.ts(第二轮已建,此轮补全)
describe('wave scheduler boundaries', () => {
  it('blocked task does not gate next wave (isolated)', () => {
    // wave0: [t1 pass, t2 blocked] → wave1 still starts
  });

  it('reworking task gates its wave (next wave waits)', () => {
    // wave0: [t1 rework in progress] → wave1 不启动
  });

  it('conflicting tasks demoted to different waves', () => {
    // auth/** vs auth/login.ts → 不在同 wave
  });

  it('resume after crash skips passed tasks', () => {
    // 模拟崩溃: t1 passed, t2 running → resume 只重跑 t2
  });

  it('maxParallelWorkers=1 reduces to serial (byte-identical)', () => {
    // 同样的图, workers=1 vs 旧串行, 产物/状态一致
  });

  it('non-parallelizable task runs alone', () => {
    // np task 的 wave 只有它
  });
});
```

### 3.2 第三轮验收
- 6 个边界 case 全过。
- 实现代码**零改动**(纯测试轮)——`git diff src/` 应为空。
- 全量工程门绿。

---

## 共同约束(三轮适用)

1. **byte-identical 红线**:`max_parallel_workers` 默认 1 = 串行,现有 892 测试
   每轮都要全过,零回归。
2. **不碰**:prompts/、commit-manager、provider 代码、Phase 10 代码、P0-P4 已落地代码。
3. **工程门**:typecheck / lint(0 warning)/ build / test / `git diff --check`。
4. **集成测试用 fake-agent**:`tests/fixtures/fake-agent.mjs` 已有,不要真调 LLM。

---

## 自举 start request(每轮一个 run)

### 第一轮 start request

```text
Implement Phase 8D P5 round 1 per docs/phase-8d-p5-wave-scheduler-brief.md §第一轮.
Design source: docs/phase-8d-worktree-parallel-execution.md §7.1.

Round 1 ONLY: pure wave-compute functions + max_parallel_workers config. Do NOT
touch task-graph-loop.ts, run-orchestrator.ts, or any executor — round 1 is
leaf functions only.

1. Add max_parallel_workers (default 1, range 1..16) to ReviewLoopConfig in
   src/types.ts and src/artifacts/config.ts. Default 1 = byte-identical serial.
2. New file src/scheduler/wave-compute.ts: computeWaves(tasks) does topological
   depth layering (depends_on in TaskNode, types.ts:1037); parallelizable=false
   tasks occupy a wave alone; throws on cycle / missing dep. demoteConflicts
   moves conflicting tasks to the next wave (cascading, with an iteration cap).
   See §1.2/§1.3.
3. New file tests/unit/wave-compute.test.ts: 9+ cases (the 3-task diamond,
   chain, cycle throws, missing dep throws, np-alone, empty, demote basic,
   demote cascade, no-conflict). See §1.4.

Existing 892 tests must stay byte-identical (round 1 doesn't touch the loop).
All gates green.
```

第二、三轮的 start request 在第一轮合并后再写(根据实际抽函数结果调整)。

---

## 风险提示(给开发师)

1. **第二轮抽 per-task 函数是最危险的**。现状(task-graph-loop.ts:170-285)的
   rework 循环逻辑复杂,抽函数时**逐行比对**,确保 attempt 计数、state 写入、
   emitProgress 顺序完全一致。建议抽完后跑一个对照测试:同一 task 图,旧内联 vs
   新函数,产物 state.json 必须一致。
2. **`max_parallel_workers` 默认 1 是安全网**。任何一轮如果默认值行为变了,892
   个测试会立刻暴露。别动默认值。
3. **resume 改 status 驱动时,task_statuses 已有(types.ts:1079)**,直接复用,不要
   新建字段。current_task_index 保留不删(向后兼容),wave 模式不写它。
4. **别为了过测试加功能**。第三轮是纯测试轮,如果某个边界 case 测出 bug,回第二轮
   修实现,不要在测试轮偷偷改实现。
5. **wave 内并发的 WorktreeManager 调用要 try/catch**:一个 task 的 worktree 创建
   失败,不能拖垮整个 wave(1-C 隔离原则)。失败 task 标 infra_error,其他 task 继续。
