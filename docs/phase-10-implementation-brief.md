# Phase 10 实现任务书:副指令文本块协议(ReviewLoopRequest)

> Status: Ready for implementation
> Scope: Goal Review Loop repository
> Priority: Next up (first of the 10 → 9 → 8D → 8E sequence)
> Depends on: Phase 8 series PASS (current main); Phase 9 NOT required
> Source of truth: this brief + `Phase10副指令文本块协议需求文档.md`(设计草案)
> Created: 2026-06-17

本文档是给开发师的**实现导向任务书**。设计意图和语义见需求草案
(`Phase10副指令文本块协议需求文档.md`);本文档规定**怎么落地**,包括
精确的文件清单、函数签名、解析规则、prompt 草案、测试矩阵、验收标准。
两文档冲突时,以本文档为准(本文档已吸收设计审查 Q3.1–Q3.4 的修正)。

---

## 0. 为什么先做这个(给开发师的上下文)

Phase 10 在落地顺序里排第一,因为:

- **改动面最小、纯增量**:1 个新解析器 + 4 个 prompt 追加 + 配置项,不碰状态机、不碰 lock、不碰 diff。
- **失败安全**:解析失败只丢副指令(写 parse-warnings.md),主流程按主产物推进,绝不阻塞。
- **不依赖 9/8D/8E**:Phase 9 未落地时,本协议仅靠文件落盘工作(需求草案 §8 已明确)。
- **立刻解决用户痛点**:clarify / followup / risk_note 是用户当前每次跑都疼的地方。

**铁律**:本 phase 的主产物(plan.md / handoff / audit-report / final-audit)合法性
是主流程推进的唯一依据。文本块只是补充,任何情况下不能让文本块阻塞或改写主流程判定。

---

## 1. 任务分解(按依赖顺序)

| # | 任务 | 依赖 | 验证方式 |
|---|---|---|---|
| 1 | 配置 schema + 默认值 | 无 | `npm run typecheck` + schema 单测 |
| 2 | feedback-block-parser(纯函数) | 无 | parser 单测矩阵 |
| 3 | 各 type 的字段校验(ajv) | 2 | 校验单测 |
| 4 | 主流程挂载(5 个 validate 点) | 1,2,3 | 集成测试 |
| 5 | 副产物写入器(clarifications/followups/parse-warnings) | 4 | 集成测试 |
| 6 | prompt 追加(4 个模板) | 无(可并行) | 人工 review + grep 校验 |
| 7 | self_correction 单块重写 | 4 | 单测 |
| 8 | CLI:followups list/close | 5 | CLI 单测 |
| 9 | 验收清单逐条过 | 全部 | 见 §7 |

建议顺序:1 → 2 → 3 → 6(并行) → 4 → 5 → 7 → 8 → 9。

---

## 2. 配置 schema(任务 1)

### 2.1 文件:`src/types.ts`

在 `ReviewLoopConfig` 加一个顶层字段(和 `loop` / `git` 平级):

```ts
export interface ReviewLoopConfig {
  version: number;
  agents: { /* 不变 */ };
  providers?: Record<string, ProviderConfig>;
  loop: { /* 不变 */ };
  git: GitConfig;
  runtime: RuntimeConfig;
  /** Phase 10: Agent 副指令文本块协议 */
  feedback_protocol: FeedbackProtocolConfig;  // 新增
}

export interface FeedbackProtocolConfig {
  enabled: boolean;                    // 默认 true
  self_correction: boolean;            // 默认 false
  max_blocks_per_document: number;     // 默认 10
  allowed_types_per_role: Record<Role, FeedbackType[]>;
}

export type Role = 'planner' | 'developer' | 'auditor' | 'final_auditor';
export type FeedbackType =
  | 'clarify' | 'followup_task' | 'risk_note'
  | 'scope_concern' | 'verification_suggestion';
```

`allowed_types_per_role` 默认值(照搬需求草案 §9):

```ts
{
  planner:        ['clarify', 'risk_note', 'followup_task'],
  developer:      ['scope_concern', 'verification_suggestion', 'risk_note', 'followup_task'],
  auditor:        ['risk_note', 'followup_task'],
  final_auditor:  ['risk_note', 'followup_task'],
}
```

### 2.2 文件:`src/artifacts/config.ts`

- 在默认配置里加 `feedback_protocol` 段(用上面的默认值)。
- 在 config schema(ajv)里加对应校验:`enabled`/`self_correction` 是 boolean,`max_blocks_per_document` 是 1..50 的整数,`allowed_types_per_role` 的每个 value 是 FeedbackType 子集。
- **兼容性铁律**:`feedback_protocol.enabled: false` 时,解析器不读、prompt 不暗示,行为与当前 main **byte-identical**(这条进验收 §7.3)。

---

## 3. 解析器(任务 2 + 3)

### 3.1 新文件:`src/artifacts/feedback-block-parser.ts`

**不要引入 remark / unified / micromark**。理由:文本块结构极简,正则定位
+ js-yaml 解析即可;markdown AST 库会引入几百 KB 依赖,杀鸡用牛刀。

`js-yaml` **已是项目依赖**(`package.json` 里 `"js-yaml": "^4.2.0"`),直接用。

### 3.2 严格解析规则(设计审查 Q3.1 定稿)

1. **语言标签精确匹配 `ReviewLoopRequest`,大小写敏感,不宽容**。
   `reviewlooprequest` / `Review-loop-request` 一律判失败。
   理由:宽容会让 Agent 无意中用到的字符被误解析;失败代价轻(丢一条副指令 + 写 warning),严格是安全的。
2. **fence 必须顶格开始**(行首 ` ``` `,不允许前导空格)。
   副作用:自然排除"嵌套在另一段 code fence里"的情况(嵌套必然带缩进)。
3. **fence 结束** = 向下扫到下一个**顶格** ` ``` `。
4. **内容必须是合法 YAML**(用 `yaml.load`,不接受 JSON)。
5. **行号定位**:解析失败的块要带行号写进 parse-warnings.md,供 self_correction prompt 精准定位。js-yaml 的 `YAMLException.mark.line` 透传。

### 3.3 函数签名

```ts
import { load as yamlLoad } from 'js-yaml';

export interface FeedbackBlock {
  type: FeedbackType;
  priority: 'low' | 'medium' | 'high';   // 默认 medium
  origin_agent: Role;
  message: string;                       // 必填
  // 各 type 专属字段(见 §3.5),用 loose typing 或判别联合
  fields: Record<string, unknown>;
  source_line: number;                   // 块在源文档的起始行
}

export interface FeedbackParseError {
  source_line: number;
  reason: string;                        // "language tag mismatch" / "YAML: <msg>" / ...
  raw_excerpt: string;                   // 原始块内容前 200 字符
}

export interface ParsedFeedbackBlocks {
  blocks: FeedbackBlock[];
  errors: FeedbackParseError[];
}

/**
 * 从 markdown 文本解析所有 ReviewLoopRequest 块。
 * 纯函数,无 IO,易测。
 *
 * @param md        主产物 markdown 全文
 * @param expectedRole 调用方传入的角色(用于校验 origin_agent)
 * @param maxBlocks 单文档上限,超出忽略尾部并追加到 errors
 */
export function parseFeedbackBlocks(
  md: string,
  expectedRole: Role,
  maxBlocks: number,
): ParsedFeedbackBlocks;
```

### 3.4 校验规则(ajv,任务 3)

参照 `src/scheduler/task-graph.ts:12` 的 `new Ajv({ allErrors: true, strict: false })`
风格。为每个 type 编译一个 schema(5 个),按 `type` 字段 dispatch:

- `type` 必须在枚举内。
- `origin_agent` 必须等于调用方传入的 `expectedRole`,否则拒绝(防 Auditor 误用 clarify)。
- `type` 必须在 `allowed_types_per_role[expectedRole]` 内,否则拒绝(双保险)。
- 各 type 专属字段按 schema 校验(字段清单见需求草案 §4.3)。

`origin_agent` / `type` 不合法的块 → 进 `errors`,不进 `blocks`。

### 3.5 各 type 专属字段(校验用)

照搬需求草案 §4.3,这里只列字段名,开发师照着写 ajv schema:

- `clarify`: `target`(目前仅 `'planner'`)、`question`(string,必填)、`blocking`(boolean,默认 false)
- `followup_task`: `title`、`description`、`estimated_difficulty`(`low|medium|high`)、`suggested_files`(string[])
- `risk_note`: `category`(`race_condition|data_loss|security|performance|other`)、`description`、`mitigation_hint`
- `scope_concern`: `requested_paths`(string[])、`reason`
- `verification_suggestion`: `command`(string[])、`reason`

---

## 4. 主流程挂载点(任务 4)

### 4.1 挂载位置(已查证)

每个角色产物 schema 校验通过后,**立即**解析 feedback 块。挂载点(已核对 `run-orchestrator.ts`):

| 角色 | 挂载点(validator 调用之后) | 文件:行 |
|---|---|---|
| planner | `validatePlannerOutput` 之后 | `run-orchestrator.ts:242`, `:483` |
| developer(单 goal) | `validateDeveloperOutput` 之后 | `run-orchestrator.ts:996` |
| developer(task-graph) | `validateDeveloperOutput` 之后 | `task-graph-loop.ts`(per-task handoff 校验处) |
| auditor | `validateAuditorOutput` 之后 | `run-orchestrator.ts:1345` |
| final-auditor | `validateFinalAuditorOutput` 之后 | `run-orchestrator.ts:2162` |

**封装成一个 helper**,避免 5 处重复:

```ts
// src/orchestrator/feedback-dispatcher.ts(新文件)
export async function dispatchFeedbackBlocks(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  role: Role;
  artifactPath: string;        // plan.md / handoff / audit-report / final-audit
  config: FeedbackProtocolConfig;
  registry: OrchestratorFileRegistry;
}): Promise<FeedbackDispatchResult>;
```

这个 helper:读产物 → `parseFeedbackBlocks` → 按 role 路由(§5)→ 写副产物 → 返回汇总。
**所有 IO 错误吞掉**(best-effort,和 `emitProgress` 的 try/catch 模式一致,见
`run-orchestrator.ts:2711`),只 `console.warn`,绝不抛回主流程。

### 4.2 解析时机铁律

- **只在主产物 schema 校验通过后解析**。主产物非法 → 主流程按既有逻辑 REWORK/BLOCKED,根本不解析副指令。
- **解析失败不重试主流程**。self_correction(任务 7)是唯一的重试路径,且只在配置开启时。

---

## 5. 副产物路由(任务 5)

### 5.1 路由表(设计审查 Q3.2 定稿)

| 块来源角色 | 块 type | 目标 | 影响 |
|---|---|---|---|
| planner | clarify(blocking:true) | state → BLOCKED | 当前 run 中止,等 resume |
| planner | clarify(blocking:false) | `.agent/clarifications.md`(追加) | 下一轮 Planner prompt 自动附上 |
| planner | risk_note | plan.md 的 risk 章节(追加) | 仅记录 |
| planner | followup_task | `.agent/followups.md`(追加) | 跨 run 累积 |
| developer | scope_concern | audit log(Auditor 可见) | **不自动扩 scope**;下一轮 Auditor 决定 REWORK/BLOCKED |
| developer | verification_suggestion | `.agent/followups.md`(追加) | 当前 run 不自动执行 |
| developer | risk_note | audit log | 见 §6 反激励处理 |
| developer | followup_task | `.agent/followups.md`(追加) | 跨 run 累积 |
| auditor / final_auditor | risk_note | audit log | PASS 时仍写入 |
| auditor / final_auditor | followup_task | `.agent/followups.md`(追加) | 跨 run 累积 |
| auditor / final_auditor | clarify | **拒绝 + warning** | Auditor 不该有 clarify,该直接 REWORK/BLOCKED |

### 5.2 副产物文件格式

- `.agent/clarifications.md`:需求草案 §6.1,简单的 question 列表,下一轮 Planner prompt builder 读取拼接。
- `.agent/followups.md`:需求草案 §6.4 的 checkbox 结构,按 run_id + timestamp 分节累积。
- `.agent/parse-warnings.md`:需求草案 §5.4,追加式,带 timestamp + source-file + 行号 + 原始内容。

这三个文件**全部加入 scope-guard 的 orchestrator-owned 白名单**
(`src/scope/scope-guard.ts:30-48` 的 `ORCHESTRATOR_OWNED_PATTERNS`),否则
Developer 的 scope 检查会把它们当越界改动。这是**必须的前置兼容改动**。

---

## 6. Prompt 追加(任务 6)—— 含 risk_note 反激励处理

### 6.1 四个模板各追加一节(设计审查 Q3.3 定稿)

在 `prompts/planner.md`、`prompts/developer.md`、`prompts/auditor.md`、
`prompts/final-auditor.md` 末尾追加。`prompts/rework.md` **不改**。

只暴露对每个 role 有意义的 type(和 `allowed_types_per_role` 一致)。
具体 prompt 草案见需求草案审查报告 Q3.3,核心要点:

- **planner**: 暴露 clarify / risk_note / followup_task。强调"plan.md 主结构仍必需,块只是补充,每文档最多 5 个"。
- **developer**: 暴露 scope_concern / verification_suggestion / risk_note / followup_task。
- **auditor / final-auditor**: 只暴露 risk_note / followup_task。明确"不应输出 clarify"。

### 6.2 risk_note 反激励处理(关键,设计审查 Q3.2)

**这是本 phase 最容易做错的点**。原始设计让 risk_note 进 audit log,会导致
"Developer 老实报风险 → Auditor 看到 → REWORK → Developer 下次不敢报 → 风险被埋没"
的劣币驱逐良币。

必须在 prompt 里正面处理:

1. **auditor.md 加一段明确语义框架**:
   > "Developer 主动披露的 risk_note 是**尽职信号**,不应因 risk_note 本身的存在而 REWORK;
   > 只有当 risk_note 指出的问题经你**独立验证**确实成立时才 REWORK。risk_note 数量多
   > 视为该 handoff 更可信(风险已被自检)。"
2. **developer.md 鼓励 risk_note 配 verification_suggestion**:报 race condition 风险时,
   同时给一个并发测试的 verification_suggestion。闭环 = "已识别风险 + 已建议验证",
   而非裸风险。
3. **prompt 里硬约束每文档块数上限**(planner/developer 5 个,auditor 3 个),
   防止 followup_task 刷屏。配置 `max_blocks_per_document: 10` 是硬上限,prompt 软约束在前。

### 6.3 防滥用 / 防误用

- **防 followup 刷屏**:prompt 软约束"不要凑数" + 硬上限 10 + 超出忽略尾部记 warning。
- **防 Auditor 误用 clarify**:解析器层硬拒绝(origin_agent + allowed_types 双校验)+ prompt 明确"不该用 clarify"。

---

## 7. 验收标准(逐条可测)

需求草案 §11 的 11 条全部保留,本任务书补充/收紧以下几条(冲突以本节为准):

1. **失败安全(最高优先级)**:主产物非法时,解析器根本不被调用;主流程按既有逻辑 REWORK/BLOCKED。集成测试:故意产出非法 handoff,验证 parse-warnings.md 不产生、主流程行为不变。
2. **解析器纯函数可测**:`parseFeedbackBlocks` 不做 IO,单测直接喂字符串。
3. **语言标签严格**:测 `reviewlooprequest` / `Review-loop-request` / `review_loop_request` 都被判失败并写 warning。
4. **fence 顶格**:测嵌套在 ` ```markdown ` 内的块被拒(因带缩进)。
5. **前缀冲突无关**:本条不适用(那是 8D 的事),删掉需求草案里任何路径冲突的验收。
6. **`enabled: false` byte-identical**:关掉后,跑现有全套测试(`npm test`),输出与当前 main 完全一致。这是回归红线。
7. **self_correction 单块重写(改进点)**:解析失败时,**只重写失败的块**,不是重写整份产物(需求草案 §5.5 原写"重写整份产物",改成单块重写,把 token 成本降 1-2 数量级)。重试上限 1 次,不递归。
8. **risk_note 反激励回归测试**:Developer 输出含 risk_note 的 handoff,验证 Auditor **不因 risk_note 存在本身而 REWORK**(除非独立验证风险成立)。fake-agent 驱动。
9. **origin_agent 拒绝**:Auditor 产物里出现 clarify → 被拒 + warning。
10. **scope-guard 白名单**:`.agent/clarifications.md` / `followups.md` / `parse-warnings.md` 写入后不被 Developer scope 检查误判为越界。
11. **与 Phase 9 解耦**:Phase 9 未落地时,本协议仅靠文件落盘工作;事件发射(`feedback.received`)留接口但不阻塞,Phase 9 落地后补。
12. **工程门全过**:`npm run typecheck`、`npm run lint`(0 warning)、`npm test`、`npm run build`、`git diff --check`。

---

## 8. self_correction 实现细节(任务 7)

需求草案 §5.5 的"重写整份产物"改成**单块重写**(设计审查 Q3.4):

- 解析失败 → 把失败的块编号 + 错误塞进一个窄 prompt,只让 Agent 重写这一个块。
- 重写后的块再过一次 `parseFeedbackBlocks`(单块模式)。
- 上限 1 次,不递归。
- **默认关闭**(`self_correction: false`)。判断标准:Developer 调用最贵、副指令价值高(risk_note 埋雷代价大)→ 可开;Planner/Auditor 副指令丢了不致命 → 默认关。

---

## 9. 文件清单(开发师 checklist)

**新增**:
- `src/artifacts/feedback-block-parser.ts`(解析器 + ajv 校验)
- `src/orchestrator/feedback-dispatcher.ts`(主流程挂载 helper + 路由)
- `src/cli/followups.ts`(list / close 子命令)
- `tests/artifacts/feedback-block-parser.test.ts`(单测矩阵)
- `tests/orchestrator/feedback-dispatcher.test.ts`(集成测试)
- `tests/orchestrator/feedback-failure-safety.test.ts`(失败安全 + enabled:false 回归)

**修改**:
- `src/types.ts`(`FeedbackProtocolConfig` 等类型)
- `src/artifacts/config.ts`(默认值 + schema)
- `src/scope/scope-guard.ts`(3 个新文件加白名单 — **前置必做**)
- `src/orchestrator/run-orchestrator.ts`(5 个挂载点调 `dispatchFeedbackBlocks`)
- `src/orchestrator/task-graph-loop.ts`(developer task-graph 路径挂载)
- `src/agents/planner-adapter.ts` / `developer-adapter.ts`(若 prompt builder 在此):把 clarifications.md 注入下一轮 Planner prompt
- `prompts/planner.md` / `developer.md` / `auditor.md` / `final-auditor.md`(各追加一节)
- `src/cli/index.ts`(注册 followups 子命令)
- `docs/configuration.md`(文档化 `feedback_protocol` 段)

**不动**:`prompts/rework.md`、`src/scheduler/`、`src/git/`、`src/runtime/lock-manager.ts`、任何 provider 代码。

---

## 10. 开发师执行指引(ReviewLoopRequest 自举)

可以用 review-loop 自己来实现自己。建议的 start request:

```text
Implement Phase 10 according to docs/phase-10-implementation-brief.md
(the implementation brief is authoritative; Phase10副指令文本块协议需求文档.md
is the design reference). Build the ReviewLoopRequest feedback block protocol:
YAML blocks parsed by js-yaml (no markdown AST libs), strict language-tag
matching, per-role type allowlists, failure-safe (parse errors never block the
main flow), self_correction as single-block rewrite (off by default). Add the
risk_note anti-incentive handling to the auditor prompt. Treat §7 acceptance as
the definition of done. Start with the parser (task 2) — it's a pure function
and unblocks everything.
```

**约束提醒给开发师**:
- 先写解析器单测(TDD),它纯函数、零依赖、最容易锁死行为。
- scope-guard 白名单改动(§5.2)是前置必做,否则集成测试会因为副产物文件被误判越界而失败。
- `enabled: false` 的 byte-identical 回归(§7.6)是红线,任何改动导致现有测试输出变化都算回归。
