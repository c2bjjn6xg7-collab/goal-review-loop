# Phase 8D 前置任务:P0+P1+P2 细化开发文档

> 用途:给开发师的**独立可交付执行手册**。照着本文档能完成 P0(2 个 bug 修复)+
> P1(LockManager lockName)+ P2(scope-guard worktree 白名单),无需额外上下文。
> 上游文档:`docs/phase-8d-implementation-brief.md`(总任务书)、
> `docs/phase-8d-worktree-parallel-execution.md`(设计 source of truth)。
> Created: 2026-06-18

本文档的价值在于**已经替开发师查清了根因链路**(精确到行号),开发师不用再
花时间定位,直接按"修复指引"动手 + 用"验证方法"确认。

---

## P0-A:修复 `--no-commit` 失效

### 现象(已复现)
`review-loop start --no-commit` 跑到 final audit PASS 后,**仍产生了 commit**
(smoke 实测 commit `db359007`,`feat(agent): complete ...`)。预期:`--no-commit`
应跳过 commit。

### 根因链路(已查清,精确到行号)

`--no-commit` 从 CLI 到最终判断的透传链路如下,**最后一环(CLI 解析)最可疑**:

```
[1] src/cli/start.ts        --no-commit flag → options.noCommit
[2] src/cli/start.ts        options → executeStart → runOrchestrator params
[3] run-orchestrator.ts:316  noCommit: params.no_commit ?? !config.git.commit_on_pass
[4] task-graph-loop.ts:561   noCommit 透传给 runFinalization
[5] run-orchestrator.ts:2293 if (noCommit || !config.git.commit_on_pass) { 跳过 commit }
```

**已确认通**:[3]→[4]→[5] 链路正确。`task-graph-loop.ts:561` 把 noCommit 传给了
runFinalization,runFinalization 内部 line 2293 的判断逻辑正确。

**最可能的断点:[1] 或 [2]** —— CLI 层没有把 `--no-commit` flag 解析成
`params.no_commit` 传给 runOrchestrator。如果是这样,`params.no_commit` 是
`undefined`,line 316 的 `undefined ?? !config.git.commit_on_pass`,而
`config.git.commit_on_pass = true`(见 `review-loop.yaml`),`!true = false`,
所以 `noCommit = false` → 走 commit 路径。

### 修复指引

1. **先验证根因**:在 `src/cli/start.ts` 的 `executeStart` 里加临时 `console.log`,
   打印 `params.no_commit`(或传给 runOrchestrator 的对象)跑一次 `--no-commit`。
   - 如果打印 `undefined` → 确认 [1]/[2] 断了,继续步骤 2。
   - 如果打印 `true` → 根因不在 CLI,回头看 [3] 的 `params` 对象来源(可能是
     executeStart 构造 params 时漏了 no_commit 字段)。

2. **修复**:确保 `start.ts` 的 commander option `--no-commit` 被正确解析
   (commander 的 `--no-foo` 会设 `options.foo = false`,注意命名:
   `--no-commit` → `options.commit = false`,**不是** `options.noCommit`)。
   把它正确映射成传给 runOrchestrator 的 `no_commit`。

3. **检查 resume 路径同理**:`src/cli/resume.ts` 如果也有 `--no-commit`,
   同样要透传(resume 也能进 finalization)。

### 验证方法(必须有回归测试)

新增 `tests/integration/no-commit-bypass.test.ts`:
```ts
// 1. 记录 HEAD
const headBefore = await gitRevParse(projectRoot);
// 2. 用 fake-agent 让 run 跑到 PASSED(start --no-commit)
// 3. 记录 HEAD
const headAfter = await gitRevParse(projectRoot);
// 4. 断言 HEAD 不变(--no-commit 真没 commit)
expect(headAfter).toBe(headBefore);
// 5. 断言 state 是 PASSED(run 成功了,只是没 commit)
expect(state.phase).toBe('PASSED');
```
用 fake-agent 模式(参考现有 `tests/integration/finalization.test.ts` 的
fake-agent 写法),不要真调 LLM。

### 验收
- `--no-commit` 跑到 PASSED,`git rev-parse HEAD` 前后一致(无新 commit)。
- 不带 `--no-commit` 时,行为不变(该 commit 还 commit)——回归不破坏正常路径。
- `config.git.commit_on_pass: false` 时,即使不带 `--no-commit` 也不 commit
  (这条路径现有测试应覆盖,确认没回归)。

---

## P0-B:修复 BLOCKED 后进程卡死

### 现象(已复现)
final audit FAIL → state 写入 BLOCKED 后,主进程**挂起 10+ 分钟**:
CPU 0%、无子进程、无新日志,需 `kill -9`。state.json 已是终态 BLOCKED(数据没丢,
只是进程没退出)。smoke 第一轮(需求 A)复现过。

### 根因线索(已定位可疑位置)

最可疑:`src/orchestrator/run-orchestrator.ts:2163-2165` 的 **finally 块**:
```ts
} finally {
  if (finalAuditorPromptFile) finalAuditorCleanupResult = await deletePromptFile(finalAuditorPromptFile);
}
```
如果 `deletePromptFile` 挂起(文件被锁、IO 卡、代理慢导致底层 fs 操作超时),
finalization 就卡在 finally 里出不来。final audit 已经 FAIL,line 2192 的
`if (finalAuditorResult.status !== 'success')` 会走 BLOCKED,但**到不了那行**
——卡在 finally。

其他可疑点(按可能性排序):
- BLOCKED 收尾的 archive/history 操作(`appendLog`/归档)在慢 IO 下挂起
- `transitionToBlocked`(line 2175 等)内部的 lock release 等待
- emitProgress 的文件写盘在磁盘满/IO 卡时阻塞

### 修复指引

1. **复现 + 定位**:写一个集成测试,用 fake-agent 让 final auditor 返回 FAIL
   (参考 `finalization.test.ts` 的 `5: final audit FAIL blocks commit` 用例,
   它已经能让 final audit FAIL)。在 BLOCKED 收尾路径加日志/计时,确认卡在哪个 await。

2. **修复方向**(根据定位结果):
   - 如果是 `deletePromptFile` 卡:给它加超时(`Promise.race` + timeout),超时就
     记 warning 继续走,不让清理阻塞终态。
   - 如果是 archive/emitProgress:这些应该是 fire-and-forget(Phase 9 的原则),
     确认它们不会 await 阻塞。
   - 通用兜底:finalization 的所有非关键清理(cleanup/archive/progress)都该有
     超时保护,**state 转换到 BLOCKED 是最高优先级,必须先于任何清理完成**。

### 验证方法(必须有回归测试)

新增 `tests/integration/blocked-exit-hang.test.ts`:
```ts
// 1. fake-agent 让 final auditor 返回 FAIL/decision FAILED
// 2. 启动 run(用 child_process spawn,不是直接 await,这样才能测进程退出)
// 3. 用 Promise.race: 等 run 进程退出 vs 30s 超时
// 4. 断言:run 进程在 30s 内退出(exit code 非 0 即可,因为 BLOCKED)
// 5. 断言:state 是 BLOCKED(数据落盘了)
// 6. 断言:无残留子进程
```
关键:用 `child_process.spawn` 起一个独立 node 进程跑 review-loop,然后等它退出。
这样能真正测"进程是否卡死"(直接 await 函数测不到进程级挂起)。

### 验收
- final audit FAIL 后,run 进程在合理时间内(< 30s)干净退出。
- state 正确写入 BLOCKED。
- 无残留子进程(`pgrep` 干净)。
- final audit PASS 路径不受影响(回归)。

---

## P1:LockManager 加 lockName 参数

### 现状
`src/runtime/lock-manager.ts:27` 附近,锁文件名写死成 `run.lock`。
8D 下主调度器锁和 worktree 内 task 锁会撞名。

### 修复指引

在 `LockManager` 构造函数加可选 `lockName` 参数,默认 `'run.lock'`:

```ts
// 现状(大致):
export class LockManager {
  constructor(private readonly agentDir: string) {}
  // 内部用 join(agentDir, 'run.lock')
}

// 改后:
export interface LockManagerOptions { lockName?: string; }
export class LockManager {
  private readonly lockName: string;
  constructor(
    private readonly agentDir: string,
    options: LockManagerOptions = {},
  ) {
    this.lockName = options.lockName ?? 'run.lock';
  }
  // 内部用 join(agentDir, this.lockName)
}
```

**铁律**:默认值 `'run.lock'` 保证所有现有 `new LockManager(agentDir)` 调用
**行为 byte-identical**(回归红线)。grep 所有 `new LockManager(` 确认无需改动
(它们都不传第二参,走默认)。

### 验证方法

新增/扩展 `tests/unit/lock-manager.test.ts`:
```ts
it('two different lockName on same agentDir do not interfere', async () => {
  const lm1 = new LockManager(tmp, { lockName: 'run.lock' });
  const lm2 = new LockManager(tmp, { lockName: 'scheduler.lock' });
  await lm1.acquire('run-1');
  // lm2 能正常 acquire(不同文件,不冲突)
  await lm2.acquire('run-2');
  // lm1 再 acquire 同 run 应失败(自己的锁还在)
  await expect(lm1.acquire('run-3')).rejects;
});

it('default lockName preserves current behavior', async () => {
  const lm = new LockManager(tmp);  // 不传 options
  // 行为和改前一致:用 run.lock
});
```

### 验收
- 两把不同 lockName 的锁互不干扰。
- 不传 lockName 时,行为与改动前完全一致(现有 lock-manager 测试全过)。

---

## P2:scope-guard 加 `.agent/worktrees/**` 白名单

### 现状
`src/scope/scope-guard.ts` 有两个数组:
- `SYSTEM_PROTECTED_PATHS`(line 7 附近):系统保护路径
- `ORCHESTRATOR_OWNED_PATTERNS`(line 34 附近):orchestrator 拥有的路径

8D worktree 放 `.agent/worktrees/{run_id}/{task_id}/`(项目内),必须加入这两个数组,
否则 worker 可能改到别的 task 的 worktree。

### 修复指引

在两个数组各加一行:
```ts
const SYSTEM_PROTECTED_PATHS = [
  // ... 现有 ...
  '.agent/worktrees/**',   // ← 新增
];
const ORCHESTRATOR_OWNED_PATTERNS = [
  // ... 现有 ...
  '.agent/worktrees/**',   // ← 新增
];
```

参考现有写法:`.agent/clarifications.md` 等 Phase 10 副产物是怎么加进去的
(commit `b2da0b2` / `64ffe29`),照同样的位置和风格加。

### 验证方法

新增/扩展 `tests/unit/scope-guard.test.ts` 或 `feedback-failure-safety.test.ts`:
```ts
it('worktree paths are system-protected even if allowed_changes permits them', () => {
  const res = checkScope({
    allowedChanges: ['src/**', '.agent/worktrees/other-task/**'],  // 即使显式允许
    disallowedChanges: [],
    changedFiles: cf([
      { path: '.agent/worktrees/other-task/src/foo.ts', status: 'modified' },
    ]),
    orchestratorOwnedFiles: [],
  });
  // 即使 allowed_changes 写了,worktree 路径仍被 system-protected 拒绝
  expect(res.passed).toBe(false);  // 或 denied 里包含该路径
});
```
关键:测试要验证**即使 allowed_changes 显式写了 worktree 路径,仍被拒**
(system-protected 优先级高于 allowed_changes)。

### 验收
- `.agent/worktrees/**` 被识别为 system-protected + orchestrator-owned。
- 即使 task 的 allowed_changes 写了 `.agent/worktrees/other-task/**`,仍被拒。
- 现有 scope-guard 测试全过(回归)。

---

## 总验收(三个任务都做完后)

1. **工程门全绿**:
   ```bash
   npm run typecheck && npm run lint && npm run build && npm test && git diff --check
   ```
   lint 必须 **0 warning**。

2. **默认行为 byte-identical(红线)**:P1/P2 都是不传新参/不改现有路径时行为不变。
   现有全部测试(目前 855+)应全过,无回归。

3. **新增回归测试**:
   - `no-commit-bypass.test.ts`(--no-commit 真不 commit)
   - `blocked-exit-hang.test.ts`(BLOCKED 不卡死)
   - lock-manager lockName 测试
   - scope-guard worktree 白名单测试

4. **真实 smoke 复验**(可选但推荐):三个任务完成后,跑一次真实
   `review-loop start --no-commit`(小需求),确认:
   - `--no-commit` 真的不 commit 了(P0-A 验证)
   - 如果让 final audit FAIL,BLOCKED 不卡死(P0-B 验证)

---

## 给开发师的执行顺序建议

1. **P0-A 先做**(--no-commit):根因最可能就是一个 CLI 解析小问题,修起来快,
   但不修的话后续每个 review-loop run 都会意外 commit,污染 git。
2. **P0-B 其次**(BLOCKED 卡死):需要复现 + 定位,可能比 P0-A 久。先写复现测试。
3. **P1 + P2 并行**:都是小改(各加几行),独立,可同时做。
4. 全部完成后跑总验收。

---

## 附:为什么这三个是 8D 前置(不是 8D 本体)

- **P0-A**(`--no-commit`):8D 并发 N 个 task,如果 commit 行为不对,会产生 N 个
  污染 commit。必须在并发前修对。
- **P0-B**(BLOCKED 卡死):8D 下一个 task 卡死会拖住整个 wave(blocked 不 gate
  下一 wave,但卡死的进程占着 worker 槽)。必须先修。
- **P1**(lockName):8D 主调度器锁和 task 锁要分离,否则撞名。
- **P2**(worktree 白名单):8D worktree 在项目内,必须 scope 保护。

这四个都是"小而必要"的前置,做完才安全进入 8D 本体(P3 WorktreeManager 起的并发核心)。
