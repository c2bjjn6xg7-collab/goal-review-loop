# Phase 8D P3+P4 细化开发文档:WorktreeManager + 冲突检测

> 用途:给开发师的独立可交付执行手册。P3(WorktreeManager)+ P4(冲突检测)是
> 并发核心的地基,**边界清晰、互不依赖**,适合一轮完成。
> 上游:`docs/phase-8d-implementation-brief.md` §4.1/§4.2(函数签名)、
> `docs/phase-8d-worktree-parallel-execution.md` §5/§9(设计)。
> Created: 2026-06-18

**本轮铁律**:P3/P4 只建模块 + 单测,**不接入 wave scheduler(P5)**、不动
`task-graph-loop.ts` 的核心循环。它们是 P5 的依赖,但本身是 leaf 模块,先独立验收。

---

## 已查清的实现依据(开发师不用再查)

| 依据 | 位置 | 用途 |
|---|---|---|
| git 调用风格 | `src/git/git-manager.ts:31` `runGit(args, cwd)` | P3 调 `git worktree add/remove/prune` 照此风格 |
| 现有 task 分支创建 | `src/git/git-manager.ts:171` `createTaskBranch` | P3 在此基础上加 worktree(分支+worktree 配套) |
| micromatch 用法 | `src/scope/scope-guard.ts:2,91` `micromatch.isMatch(p, patterns, {dot:true})` | P4 复用同库同风格,**不引入新依赖** |
| task 结构 | `src/types.ts:1030` `TaskNode` + `allowed_changes`(line 1038) | P4 冲突检测的输入 |
| 残留半成品 | **无**(`src/scheduler/` 只有 task-graph.ts) | P3/P4 全新模块,无冲突 |

---

## P3:WorktreeManager

### 新文件 `src/scheduler/worktree-manager.ts`

职责:为每个 task 创建/清理 git worktree + 分支。设计文档 §5 定义命名:
- 分支:`agent/{run_id}/{task_id}-{slug}`
- worktree:`.agent/worktrees/{run_id}/{task_id}/`
- 基:所有 task 从同一 stable `base_commit` 分出

### 类签名(任务书 §4.1)

```ts
export interface WorktreeInfo {
  taskId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
}

export class WorktreeManager {
  constructor(private readonly projectRoot: string);

  /**
   * Create a worktree + branch for a task. Idempotent: if the worktree/branch
   * already exists for this (runId, taskId), reuse it (don't error).
   * @returns worktreePath (the dir to cd into) + branch name
   */
  async createForTask(params: {
    runId: string;
    taskId: string;
    slug: string;
    baseCommit: string;
  }): Promise<{ worktreePath: string; branch: string }>;

  /** Remove a task's worktree dir. KEEP the branch (8E cherry-picks from it). */
  async cleanupTask(runId: string, taskId: string): Promise<void>;

  /** `git worktree prune` — call at scheduler start/resume to drop stale metadata. */
  async prune(): Promise<void>;

  /** List all worktrees for a run (for resume/orphan detection). */
  async listForRun(runId: string): Promise<WorktreeInfo[]>;
}
```

### 实现指引

1. **`createForTask` 用 `git worktree add`**:
   ```ts
   const branch = `agent/${runId}/${taskId}-${slug}`;
   const worktreePath = join(projectRoot, '.agent', 'worktrees', runId, taskId);
   // git worktree add -b <branch> <path> <baseCommit>
   await runGit(['worktree', 'add', '-b', branch, worktreePath, baseCommit], projectRoot);
   ```
   参照 `createTaskBranch`(git-manager.ts:171)的错误处理风格:捕获 stderr,转成可读错误。

2. **幂等**:创建前先检查 worktree 是否已存在(`existsSync(worktreePath)` +
   `git worktree list` 含该路径)。已存在则直接 return,不重建。这对 resume 关键。

3. **`cleanupTask` 用 `git worktree remove`**(**保留分支**):
   ```ts
   // git worktree remove <path>  (删 worktree 目录 + 元数据, 不删分支)
   await runGit(['worktree', 'remove', worktreePath], projectRoot).catch(() => {});
   ```
   **fail-closed**:删除失败不抛(scheduler 仍能继续),但记 warning。**绝不**
   `git branch -D`(分支要留给 8E cherry-pick)。

4. **`prune` + `listForRun`**:用 `git worktree list --porcelain` 解析。

### 铁律

- **不自动 `git worktree remove --force`** 未确认内容(resume 时检测孤儿 worktree
  → 报告用户,不自动删)。
- worktree 路径在 `.agent/worktrees/` 内,已被 scope-guard 保护(P2 已做)。
- 所有 git 调用捕获 stderr,转成 `WorktreeManagerError`(参照 git-manager.ts:7 的
  `GitManagerError`)。

### 验证(单测 `tests/unit/worktree-manager.test.ts`)

用真实临时 git repo(参照现有 `tests/unit/git-manager.test.ts` 的临时 repo 风格,
或 `createTestRepo` helper):

```ts
describe('WorktreeManager', () => {
  it('createForTask creates a worktree + branch at base commit', async () => {
    // 造临时 repo + commit A
    // createForTask({runId, taskId:'t1', slug:'foo', baseCommit: A})
    // 断言: worktreePath 存在; git rev-parse 该分支 = A; worktree 内 HEAD = A
  });

  it('createForTask is idempotent (reuse on repeat)', async () => {
    // 两次 createForTask 相同参数 → 第二次不报错, worktreePath 相同
  });

  it('cleanupTask removes worktree but keeps branch', async () => {
    // createForTask → cleanupTask
    // 断言: worktreePath 不存在; git rev-parse 该分支 仍成功(分支在)
  });

  it('cleanupTask failure is non-fatal (warning, no throw)', async () => {
    // 制造删除失败场景(如路径被占用) → 不抛, 继续
  });

  it('prune drops stale worktree metadata', async () => {
    // createForTask → 手动 rm worktree 目录 → prune → git worktree list 不含它
  });

  it('listForRun returns only this run\'s worktrees', async () => {
    // 两个 runId 各 createForTask → listForRun(run1) 只返回 run1 的
  });
});
```

### 验收
- 6 个单测全过。
- createForTask 幂等(关键,resume 依赖)。
- cleanupTask 保留分支(8E 依赖)。
- 失败 fail-closed 不抛。

---

## P4:冲突检测

### 新文件 `src/scheduler/conflict-detector.ts`

职责:判断两个 task 的 `allowed_changes` 是否可能改到同一个文件。设计文档 §9 +
审查 Q1.3。**用项目已有的 micromatch**,不引入新库。

### 双保险算法(保守优先,审查 Q1.3 定稿)

判断两个 glob `a` 和 `b` 是否冲突:

```ts
export function globsMayConflict(a: string, b: string, trackedFiles: string[]): boolean {
  // 1. 前缀快筛:取每个 glob 第一个 ** 或通配符前的字面量目录前缀。
  //    两前缀无包含关系 → 必不冲突(快速排除)
  const aPrefix = globDirPrefix(a);  // 'src/auth/**' -> 'src/auth/'
  const bPrefix = globDirPrefix(b);
  if (aPrefix && bPrefix) {
    if (!(aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix))) {
      return false;  // 字面前缀都不交, 必不冲突
    }
  }
  // 2. 真实文件样本精筛:trackedFiles 里, 是否存在一个文件同时被 a 和 b 命中
  const aHits = trackedFiles.filter(f => micromatch.isMatch(f, [a], { dot: true }));
  const anyOverlap = aHits.some(f => micromatch.isMatch(f, [b], { dot: true }));
  if (anyOverlap) return true;
  // 3. 拿不准 → 保守判冲突(宁可串行也别改坏)
  return true;
}

// globDirPrefix: 取第一个 ** 或通配符之前的字面量目录
// 'src/auth/**'       -> 'src/auth/'
// 'src/auth/login.ts' -> 'src/auth/login.ts' (无通配, 整条当前缀)
// '*.ts'              -> '' (无目录前缀)
// 'src/**/test.ts'    -> 'src/'
function globDirPrefix(glob: string): string { ... }
```

### 关键 case(必须有测试,设计文档 §12.1 §30)

| a | b | 期望 | 算法路径 |
|---|---|---|---|
| `src/auth/**` | `src/auth/login.ts` | **冲突** | 前缀 `src/auth/` 包含 → 进样本 → 命中 |
| `src/auth/**` | `src/core/**` | 不冲突 | 前缀不交 → 快速 false |
| `*.ts` | `src/foo.ts` | 冲突(保守) | `*.ts` 无目录前缀 → 样本未命中 → 保守 true |
| `src/**/test.ts` | `src/a/test.ts` | 冲突 | 前缀 `src/` 交 → 样本命中 |

### 对一组 task 的检测

```ts
export function detectWaveConflicts(
  tasks: TaskNode[],
  trackedFiles: string[],
): Map<string, string[]> {
  // 返回每个 taskId -> 与它冲突的其他 taskId 列表
  // 双重循环两两判断 globsMayConflict(任一 a 的 allowed vs 任一 b 的 allowed)
  // 自己不和自己比
}
```

`trackedFiles` 来源:`git ls-files`(现有用法见 task-graph-loop.ts,搜 ls-files)。
detectWaveConflicts 调用方(P5 wave scheduler)负责传入;P4 本身只做纯计算。

### 实现指引

- **import micromatch from 'micromatch'**(已在依赖,scope-guard.ts:2 同款)。
- `globDirPrefix` 实现:split glob,取到第一个含 `*` 或 `?` 或 `[` 的段为止,前面
  的目录用 `/` join,末尾带 `/`。若 glob 不含 `/` 或第一段就通配,返回 `''`。
- **`detectWaveConflicts` 是纯函数**(无 IO),易测。
- 复杂度:N 个 task × M 个 glob/task × K 个 tracked file。实际 task ≤ 10
  (task-graph maxItems:10),tracked file 用 `git ls-files` 全量(项目级,几千个),
  可接受。**不要**预先优化。

### 验证(单测 `tests/unit/conflict-detector.test.ts`)

```ts
describe('globsMayConflict', () => {
  const files = ['src/auth/login.ts', 'src/auth/session.ts', 'src/core/db.ts', 'package.json'];
  it.each([
    ['src/auth/**', 'src/auth/login.ts', true,   'prefix contained'],
    ['src/auth/**', 'src/core/**',      false,  'prefix disjoint'],
    ['*.ts',         'src/foo.ts',       true,   'no dir prefix → conservative'],
    ['src/**/test.ts','src/a/test.ts',   true,   'prefix src/ overlaps'],
    ['package.json', 'src/**',           false,  'specific file vs disjoint dir'],
  ])('globsMayConflict(%s, %s) = %s (%s)', (a, b, expected) => {
    expect(globsMayConflict(a, b, files)).toBe(expected);
  });
});

describe('detectWaveConflicts', () => {
  it('flags overlapping tasks, ignores disjoint ones', () => {
    const tasks = [
      { task_id: 't1', allowed_changes: ['src/auth/**'], depends_on: [], disallowed_changes: [] },
      { task_id: 't2', allowed_changes: ['src/auth/login.ts'], depends_on: [], disallowed_changes: [] },
      { task_id: 't3', allowed_changes: ['src/core/**'], depends_on: [], disallowed_changes: [] },
    ] as TaskNode[];
    const conflicts = detectWaveConflicts(tasks, ['src/auth/login.ts','src/auth/session.ts','src/core/db.ts']);
    expect(conflicts.get('t1')).toContain('t2');  // auth 重叠
    expect(conflicts.get('t1')).not.toContain('t3');  // core 不重叠
    expect(conflicts.get('t2')).toContain('t1');
  });

  it('task does not conflict with itself', () => {
    // 单 task → conflicts.get(t1) 为空或不含 t1
  });
});
```

### 验收(设计文档 §12.1 §30)
- `src/auth/**` vs `src/auth/login.ts` 判**冲突**(bare-string-equality 实现过不了这测试)。
- 保守优先:拿不准判冲突(宁可串行)。
- detectWaveConflicts 是纯函数,不碰 IO。

---

## 共同约束

1. **不碰 P5**:不动 `task-graph-loop.ts` 核心循环、不接入 wave scheduler。P3/P4 是
   P5 的依赖,本身是 leaf 模块。
2. **默认行为 byte-identical**:P3/P4 是新模块,现有行为零回归。现有 869 测试全过。
3. **工程门全绿**:typecheck / lint(0 warning)/ build / test(869+新增)/
   `git diff --check`。
4. **不碰**:`prompts/`、`src/git/commit-manager.ts`、provider 代码、Phase 10 代码、
   P0/P1/P2 已修的部分。

---

## 给开发师的执行顺序

1. **P3 先**(WorktreeManager):它是 P4 测试可能用到的基建(造 worktree 场景),
   且更独立。先写 `WorktreeManager` + 6 个单测绿。
2. **P4 后**(冲突检测):纯函数,简单。5+ 个 case 全过即可。
3. 全部完成后跑总工程门。

两模块互不依赖,顺序仅为节奏建议。

---

## 自举 start request(可用 review-loop 跑)

```text
Implement Phase 8D P3 + P4 per docs/phase-8d-p3-p4-tasks.md. Design source:
docs/phase-8d-worktree-parallel-execution.md §5 (worktree naming) and §9
(conflict detection). Implementation brief: docs/phase-8d-implementation-brief.md
§4.1 and §4.2.

P3 — new file src/scheduler/worktree-manager.ts: a WorktreeManager class
wrapping `git worktree add/remove/prune` (use runGit from src/git/git-manager.ts).
createForTask is idempotent (reuse existing); cleanupTask removes the worktree
dir but KEEPS the branch (8E cherry-picks); prune drops stale metadata;
listForRun for resume. 6 unit tests (real temp git repo). See §P3 in the brief.

P4 — new file src/scheduler/conflict-detector.ts: pure functions
globsMayConflict(a, b, trackedFiles) and detectWaveConflicts(tasks, trackedFiles).
Double-guard algorithm: directory-prefix fast filter + real-file-sample overlap,
conservative (unsure → conflict). Reuse existing micromatch dep (see scope-guard.ts:2).
Key case: src/auth/** vs src/auth/login.ts MUST conflict. See §P4 in the brief.

Do NOT touch P5 (wave scheduler), task-graph-loop.ts core loop, prompts/,
commit-manager, or P0/P1/P2 code. Default behavior must stay byte-identical
(existing 869 tests must pass). All gates green.
```

---

## 验收清单(开发师自检 + 验收复验)

- [ ] `src/scheduler/worktree-manager.ts` + 6 单测绿
- [ ] `src/scheduler/conflict-detector.ts` + 5+ 单测绿(含 §30 关键 case)
- [ ] createForTask 幂等 / cleanupTask 留分支 / 失败 fail-closed
- [ ] globsMayConflict 关键 case:`src/auth/**` vs `src/auth/login.ts` = 冲突
- [ ] 保守优先:拿不准判冲突
- [ ] typecheck 0 / lint 0 warning / build 0 / test 全过(869 + 新增)
- [ ] P5 未被碰(task-graph-loop 核心循环无改动)
