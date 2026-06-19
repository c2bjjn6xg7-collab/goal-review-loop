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

### 1.1 新增配置块 `parallel`(不是顶层)

⚠️ **不要放顶层**。`src/artifacts/config.ts:50/60/80/91` 的 schema 顶层是
`additionalProperties: false`——放顶层会配置校验失败。必须放进 `parallel` 块,
且 schema 里新增对应 `$defs` 段。

设计文档 §4(line 77-79)定义的形态:
```yaml
parallel:
  enabled: false              # 默认 false(显式 opt-in, 见 §1.1a)
  max_parallel_workers: 1     # 默认 1(=串行, byte-identical)
```

文件 `src/types.ts`:
```ts
export interface ParallelConfig {
  /** 显式开关。默认 false。设计文档 §4 要求 --parallel 或 config 显式开启。 */
  enabled: boolean;
  /** 全局并发 worker 上限。默认 1(=串行)。范围 1..16。 */
  max_parallel_workers: number;
}

export interface ReviewLoopConfig {
  // ...existing top-level fields...
  parallel?: ParallelConfig;   // 可选, 缺省时当作 enabled:false
}
```

文件 `src/artifacts/config.ts`:
- 默认值:`parallel: { enabled: false, max_parallel_workers: 1 }`。
- schema:新增 `$defs.parallelConfig`,顶层 schema 加 `parallel` 属性 `$ref` 它;
  `max_parallel_workers` 校验 1..16;`enabled` 是 boolean。
- 向后兼容:config 缺 `parallel` 段时,填充默认 `{enabled:false, max_parallel_workers:1}`
  (现有 config 无此段 → 行为 byte-identical)。

### 1.1a 显式 opt-in(设计文档 §4 line 40 要求)

Wave 并发**默认关闭**,通过两种方式之一显式开启(两者满足其一即可):

1. CLI flag:`review-loop start --parallel`(以及 `--max-parallel-workers N`)
2. config:`parallel.enabled: true`

判定逻辑(P5 第二轮接入时用,第一轮只需在 config 里体现):
```ts
const parallelEnabled = cliFlags.parallel || config.parallel?.enabled === true;
const maxWorkers = parallelEnabled
  ? (cliFlags.maxParallelWorkers ?? config.parallel?.max_parallel_workers ?? 1)
  : 1;
```

**仅 `max_parallel_workers > 1` 不算开启**——必须 `enabled` 为真(或 --parallel)。
这避免"用户只想调上限数字却意外开并发"的误操作。设计文档 §4 line 40 原话:
"explicit parallel execution mode"。

### 1.1b TaskStatus 扩展:新增 BLOCKED

⚠️ **现状 `TaskStatus` 没有 blocked**。`src/types.ts:1004-1010` 只有
`pending/running/passed/failed/skipped`。8B 串行路径(task-graph-loop.ts)只写
passed/failed,从没产生 blocked。

但设计文档 §7.2(2-C 升级阶梯)和 §7.3(熔断)明确用 blocked(task 升级耗尽
→ blocked;连续失败 → run blocked)。所以本 phase 必须**新增 BLOCKED 到枚举**:

```ts
// src/types.ts:1004
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  BLOCKED: 'blocked',   // ← 新增
  SKIPPED: 'skipped',
} as const;
```

**影响面(开发师必须检查)**:
- 任何 `switch(taskStatus)` / 穷举 TaskStatus 的地方要补 BLOCKED case。
  grep `TaskStatus` 和 `: 'passed' | 'failed'` 找全。
- `emitTaskProgress` 的 taskStatus 参数(task-graph-loop.ts:682)类型是
  `'running'|'passed'|'failed'|'rework'` —— 需加 `'blocked'`,或 BLOCKED 走单独
  的日志路径。
- UI/状态展示(`status` 命令)要能显示 blocked。
- **8B 串行路径不产生 BLOCKED**(它只 passed/failed),所以加这个枚举值对
  现有 892 测试 byte-identical——前提是 BLOCKED 只在 wave 路径写入,串行路径不碰。

本 brief 后文所有提到的 "blocked" 均指 `TaskStatus.BLOCKED`(本 phase 新增)。
failed 指升级前的失败态;BLOCKED 指升级阶梯耗尽后的终态(见设计文档 §7.2)。

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
  再把 non-parallelizable task 的 wave 调整为独占。**多条规则(写死,避免歧义)**:
  1. 每个 np task 独占一个 singleton wave(该 wave 只有它一个 task)。
  2. 多个 np task 同拓扑层时,**按拓扑序各自独占**(np_A 在 wave k,np_B 在
     wave k+1,即使它们无依赖关系)——不要把两个 np 放同一 wave(它们都要求独占,
     并放违背 np 语义)。
  3. **parallel task 不得插入 np 的 singleton wave**。即 np task 所在 wave 绝不
     混入 parallel task,即使该 parallel task 拓扑本可在此层。parallel task 顺延
     到下一个非 np 独占的 wave。
  4. 确定性:多个 np 同层时,按 task_id 字典序排独占顺序。
- **demoteConflicts**:对每个 wave,查 conflicts,把冲突 task 移到下一 wave,
  下一 wave 重新检测(级联)。**上限 = task 总数 × conflict 边数**(即
  `tasks.length × Σ|conflicts[t]|`)——这是所有 demote 操作的理论上界(每次移动
  至少消耗一条 conflict 边),到上限仍有冲突说明图病态(如 task A 和 B 在任何
  wave 都必然冲突,需要人工拆分),抛 WaveComputeError。**不要用 `wave×2`**,
  那会误杀合法的大冲突图(一个 task 可能要级联 demote 多次)。

### 1.4 验证(`tests/unit/wave-compute.test.ts`)

测试里用一个 helper 构造 TaskNode,避免 `{ ... }` 占位导致开发师自由发挥:
```ts
import type { TaskNode } from '../../src/types.js';

function makeTask(id: string, opts: {
  dependsOn?: string[];
  parallelizable?: boolean;
} = {}): TaskNode {
  return {
    id,
    title: id,
    description: `${id} test`,
    depends_on: opts.dependsOn ?? [],
    parallelizable: opts.parallelizable ?? true,
    allowed_changes: [],
    disallowed_changes: [],
    verification_commands: [],
    risk: 'low',
    slug: id,
  } as unknown as TaskNode;  // 测试只填 wave-compute 关心的字段
}
```
(实际 TaskNode 字段以 types.ts:1030 为准,helper 补全必填项即可。)

```ts
describe('computeWaves', () => {
  it('T1,T2 roots + T3 depends T1 → wave [T1,T2] then [T3]', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2'),
      makeTask('t3', { dependsOn: ['t1'] }),
    ];
    const plan = computeWaves(tasks);
    expect(plan.waves).toEqual([['t1', 't2'], ['t3']]);
  });

  it('chain t1→t2→t3 → three waves of one', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2', { dependsOn: ['t1'] }),
      makeTask('t3', { dependsOn: ['t2'] }),
    ];
    expect(computeWaves(tasks).waves).toEqual([['t1'], ['t2'], ['t3']]);
  });

  it('throws on cycle t1→t2→t1', () => {
    const tasks = [makeTask('t1', { dependsOn: ['t2'] }), makeTask('t2', { dependsOn: ['t1'] })];
    expect(() => computeWaves(tasks)).toThrow(/cycle/i);
  });

  it('throws on missing dependency t2 depends_on ghost', () => {
    const tasks = [makeTask('t2', { dependsOn: ['ghost'] })];
    expect(() => computeWaves(tasks)).toThrow(/ghost|missing/i);
  });

  it('non-parallelizable task occupies a wave alone', () => {
    const tasks = [
      makeTask('t1', { parallelizable: false }),
      makeTask('t2', { parallelizable: true }),
    ];
    // t1(np) 独占 wave0; t2(parallel) 顺延到 wave1, 不混入 np 的 singleton
    expect(computeWaves(tasks).waves).toEqual([['t1'], ['t2']]);
  });

  it('two np tasks same layer → each alone, ordered by id', () => {
    const tasks = [
      makeTask('tB', { parallelizable: false }),
      makeTask('tA', { parallelizable: false }),
    ];
    expect(computeWaves(tasks).waves).toEqual([['tA'], ['tB']]);  // id 字典序
  });

  it('empty task list → empty plan (not throw)', () => {
    expect(computeWaves([]).waves).toEqual([]);
  });
});

describe('demoteConflicts', () => {
  it('demotes lexically-larger task id on conflict', () => {
    // wave0=[auth, login], conflicts: auth↔login → login(t2) demote 到 wave1
    const plan: WavePlan = { waves: [['auth', 'login']], waveIndexOfTask: new Map([['auth',0],['login',0]]) };
    const conflicts = new Map([['auth', ['login']], ['login', ['auth']]]);
    const out = demoteConflicts(plan, conflicts);
    expect(out.waves[0]).toEqual(['auth']);       // auth 字典序小, 留 wave0
    expect(out.waves[1]).toContain('login');       // login demote
  });

  it('cascades: demoted task conflicts in next wave → demote again', () => { /* ... */ });

  it('no conflicts → plan unchanged', () => {
    const plan: WavePlan = { waves: [['a','b']], waveIndexOfTask: new Map() };
    expect(demoteConflicts(plan, new Map())).toEqual(plan);
  });
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
`parallel.enabled:false` 或 `max_parallel_workers<=1` 时退化成串行且 byte-identical**。

### 2.1 新文件 `src/scheduler/wave-executor.ts`

```ts
export interface WaveExecutorParams {
  // 复用现有 runTaskGraphLoop 的绝大多数参数(见 task-graph-loop.ts 签名)
  // ...
  /** 全局并发上限(来自 CLI --max-parallel-workers 或 config.parallel.max_parallel_workers)。 */
  maxParallelWorkers: number;
}

export async function runWaveExecutor(params: WaveExecutorParams): Promise<OrchestratorResult>;
```

**核心流程**:
```
1. computeWaves(tasks) → WavePlan
2. 对 conflicts 调 detectWaveConflicts(trackedFiles) → demoteConflicts(plan, conflicts)
3. for each wave in plan:
   a. **同一 wave 内分批执行**(不是"等下一轮 wave"):该 wave 的 task 数若 >
      maxParallelWorkers,在**本 wave 内**分批,每批 maxParallelWorkers 个并发;
      一批完成(全部 passed/blocked)再放下一批,本 wave 所有批次跑完才进拓扑
      下一 wave。不要把超额 task 推到拓扑下一 wave——那会破坏依赖语义(下一 wave
      的 task 可能 depends_on 本 wave 的超额 task)。
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
const parallelEnabled = cliFlags.parallel || config.parallel?.enabled === true;
const maxParallelWorkers = parallelEnabled
  ? (cliFlags.maxParallelWorkers ?? config.parallel?.max_parallel_workers ?? 1)
  : 1;

if (parallelEnabled && maxParallelWorkers > 1) {
  return await runWaveExecutor({ ...params, maxParallelWorkers });
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
Design source: docs/phase-8d-worktree-parallel-execution.md §4 (config) and §7.1 (waves).

Round 1 ONLY: pure wave-compute functions + parallel config block + TaskStatus.BLOCKED.
Do NOT touch task-graph-loop.ts core loop, run-orchestrator.ts executor dispatch, or
any executor — round 1 is leaf functions + types only.

1. Add a `parallel` config BLOCK (NOT top-level — top-level schema is
   additionalProperties:false, see config.ts:50/60/80/91). Shape per design §4:
   parallel: { enabled: boolean (default false, explicit opt-in via --parallel or
   config), max_parallel_workers: number (default 1, range 1..16) }. Default
   {enabled:false, max_parallel_workers:1} = byte-identical serial. Add $defs.parallelConfig
   and ref it from the top-level schema. See §1.1/§1.1a.
2. Add BLOCKED to the TaskStatus enum (src/types.ts:1004). Today it is
   pending/running/passed/failed/skipped only. BLOCKED is used by the wave path's
   escalation-ladder terminal state (design §7.2). Check every exhaustive switch over
   TaskStatus and add a BLOCKED case; the 8B serial path never writes BLOCKED so
   existing tests stay byte-identical. See §1.1b.
3. New file src/scheduler/wave-compute.ts: computeWaves(tasks) does topological depth
   layering (depends_on in TaskNode types.ts:1037); parallelizable=false tasks each
   occupy a singleton wave, ordered by task_id, parallel tasks never mixed into an np
   singleton (see §1.3 rules); throws on cycle / missing dep. demoteConflicts moves
   conflicting tasks (lexically-larger id) to the next wave, cascading, with cap =
   tasks.length × Σ|conflicts[t]| (NOT wave×2). See §1.2/§1.3.
4. New file tests/unit/wave-compute.test.ts using a makeTask(id, opts) helper (§1.4):
   8+ cases (3-task diamond, chain, cycle throws, missing dep throws, np-alone,
   two-np-same-layer-by-id, empty, demote basic, demote cascade, no-conflict).

Existing 892 tests must stay byte-identical (round 1 doesn't touch the loop, and
BLOCKED is never written by the serial path). All gates green.
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
