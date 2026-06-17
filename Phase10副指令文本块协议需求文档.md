---
schema_version: 1
document_type: phase-development-requirements
phase: 10
status: DRAFT
depends_on: "Phase 8 系列闭环 PASS（必需）；Phase 9 事件流（推荐但非必需）"
primary_acceptance_platform: macOS
created_at: "2026-06-17"
---

# Phase 10 需求草案：Agent 副指令文本块协议（ReviewLoopRequest）

## 1. 文档定位

本文档定义一种**结构化副指令文本块协议** `ReviewLoopRequest`，让流水线中的 Planner /
Developer / Auditor 在主产物（plan.md / handoff.md / audit-report.md）之外，
还能输出**结构化的副指令**，由 orchestrator 解析后影响下一轮迭代或下次任务。

本协议借鉴 hermes-deck 的 `AgentRouting` 文本块设计思路，但**不引入跨 Agent 委派**
（不复用 deck_delegate_agent 这类语义），保持 review-loop 固定角色流水线骨架不变。

## 2. 用户目标

解决以下当前 schema 卡得太死、Agent 表达力不足导致的实际问题：

- Planner 拆任务时，发现需求里有概念模糊（如"兼容旧版"），希望让下一轮 Planner 主动澄清，
  而不是凭感觉拍。
- Developer 改完代码时，发现某些非阻塞问题（如重复代码、命名不一致），希望记录成
  followup 而不是塞进当前 PR 扩大 scope。
- Auditor 给 PASS 时，希望同步标记 1~3 条非阻塞建议，让用户/调度器在下一次迭代或
  下次 run 中处理。
- 任何角色想标记一个**风险点**（"这里改动有 race condition 嫌疑，建议复测"），不至于
  被埋没在自由文本里。

## 3. 核心原则

1. **文本块是主产物的副输出**：仍然必须先满足 schema（plan.md 必须有 plan、audit 必须有
   decision 等），文本块只是补充。
2. **文本块格式严格、可校验**：解析失败必须可重现地报错，不允许"看起来像 ReviewLoopRequest
   但解析失败"的歧义。
3. **解析失败不阻塞主流程**：解析失败时记录到 `.agent/parse-warnings.md`，主流程仍按主产物
   推进；可选给 Agent 一次"自我纠正"机会。
4. **不引入跨 Agent 调用**：文本块的 type 全部由 orchestrator 在主流程内消费，不会临时拉
   外部 Agent。临时委派如未来需要，另立 phase。
5. **每种 type 都有明确的消费时机**：clarify 影响下一轮 Planner，followup 写到
   `.agent/followups.md`，risk_note 进入 audit log。
6. **可关闭**：`review-loop.yaml` 中 `feedback_protocol.enabled: false` 时退化，
   解析器不读、Agent prompt 不暗示。

## 4. 文本块语法

### 4.1 块标识

````markdown
```ReviewLoopRequest
<YAML 内容>
```
````

- 语言标签**必须**为 `ReviewLoopRequest`（大小写敏感）。
- 内容**必须**为合法 YAML（不接受 JSON，避免与现有 JSON artifact 混淆）。
- 一个块表达**一条**副指令；同一文档可有多个块。

### 4.2 通用字段

```yaml
type: clarify | followup_task | risk_note | scope_concern | verification_suggestion
priority: low | medium | high      # 默认 medium
origin_agent: planner | developer | auditor | final_auditor   # 由 orchestrator 注入校验，Agent 写错会拒绝
message: |
  自由文本说明（必填）
```

### 4.3 各 type 专属字段

**`clarify`** — 对当前 GOAL/Plan 的澄清诉求

```yaml
type: clarify
target: planner            # 目前仅支持 planner（即由下一轮 Planner 在 prompt 中澄清）
question: "需求中的 兼容旧版 具体指哪个版本？"
blocking: false            # true 时 orchestrator 中止当前 phase，进 BLOCKED 等用户介入
```

**`followup_task`** — 建议下次迭代/下次 run 处理的任务

```yaml
type: followup_task
title: "重构 src/foo.ts 错误处理"
description: "当前实现 catch 后只记日志，应区分可恢复/不可恢复错误"
estimated_difficulty: low | medium | high
suggested_files:
  - src/foo.ts
```

**`risk_note`** — 标记潜在风险，进入 audit log

```yaml
type: risk_note
category: race_condition | data_loss | security | performance | other
description: "token 刷新与登出存在 race"
mitigation_hint: "可加 mutex 或改成 atomic CAS"
```

**`scope_concern`** — Developer 发现需要的改动超出当前 allowed_changes

```yaml
type: scope_concern
requested_paths:
  - src/auth/middleware.ts
reason: "实现 GOAL 必须修改该文件，但 task 的 allowed_changes 未包含"
```

**`verification_suggestion`** — 建议补充的验证命令

```yaml
type: verification_suggestion
command: ["npm", "run", "test:integration"]
reason: "本次改动跨 auth + db 模块，单元测试覆盖不足"
```

## 5. 解析器

新增 `src/artifacts/feedback-block-parser.ts`：

### 5.1 输入

任何主产物 markdown 文件路径（plan.md / developer-handoff.md / audit-report.md /
final-audit.md）。

### 5.2 输出

```ts
interface ParsedFeedbackBlocks {
  blocks: FeedbackBlock[];        // 成功解析
  errors: FeedbackParseError[];   // 解析失败的块（带原始内容定位）
}
```

### 5.3 校验规则

1. 语言标签必须精确为 `ReviewLoopRequest`。
2. 内容必须是合法 YAML。
3. `type` 必须为枚举内值。
4. `origin_agent` 必须与解析时调用方传入的 expected role 一致；不一致拒绝。
5. 各 type 专属字段按 JSON Schema 校验，使用现有 ajv（与 task-graph 风格一致）。
6. 同一文档内**最多 10 个块**，超出忽略尾部并记 warning。

### 5.4 错误处理

- 解析失败的块写入 `.agent/parse-warnings.md`（追加），格式：
  ```
  ## <timestamp> <source-file>
  - block #2: type 字段缺失
  - 原始内容：...
  ```
- 主流程不抛错。

### 5.5 自我纠正机制（self_correction）

**默认关闭，按需开启。**

**是什么**：解析失败时，给 Agent 一次"重写整份产物"的机会，让它修正 ReviewLoopRequest 块
里的格式错误（如 type 拼写错、字段名写错、YAML 缩进错）。

**怎么工作**：

1. 第一次解析失败 → 写入 parse-warnings.md
2. 如果 `self_correction: true`：
   - Orchestrator 重新调用同一 Agent（同一 role、同一 provider）
   - 在原 prompt 基础上追加：
     ```
     上次输出中以下 ReviewLoopRequest 块解析失败：
     - 第 N 个块：<具体错误，如 type "followuptask" 不在合法枚举中>
     请重新输出完整产物，修正这些错误。
     ```
   - 拿到第二次输出后再解析一次
3. **最多重试 1 次，不递归**：第二次仍失败，直接放弃，主流程按原主产物推进
4. 如果 `self_correction: false`（默认）：
   - 不重试，解析失败的块直接丢弃，仅留 parse-warnings.md 供事后查看

**价值与代价**：

| | 关闭（默认） | 开启 |
|---|---|---|
| 体验 | 副指令偶尔丢失，主流程不受影响 | 副指令保留率更高 |
| 成本 | 无额外 Agent 调用 | 每次解析失败多花一次 Agent 调用 |
| 适用 | 一般场景，副指令丢一两条无所谓 | 对副指令完整性敏感、不在乎多花一次调用 |

**为什么默认关闭**：大部分场景下，主产物（plan.md / audit decision）合法即可推进，
副指令丢失 1~2 条不影响主流程；但每次重试要多花一次 LLM 调用（钱 + 时间）。
让用户**显式选择是否打开**比默认开启更稳妥。

**配置项**：`review-loop.yaml` 中 `feedback_protocol.self_correction: true | false`。

## 6. 主流程消费

### 6.1 Planner 输出的块

解析时机：Planner 完成后，紧接 plan.md schema 校验。

消费规则：
- `clarify` with `blocking: true` → 当前 phase 转 BLOCKED，写 last_error，等用户 resume。
- `clarify` with `blocking: false` → 写入 `.agent/clarifications.md`，下一轮 Planner prompt 自动附上。
- `risk_note` → 追加进 plan.md 的 risk 章节。
- 其他 type → 在 Planner 阶段不消费，仅记录到 followups.md。

### 6.2 Developer 输出的块

解析时机：developer-handoff.md 校验后、Verification 启动前。

消费规则：
- `scope_concern` → 写 audit log，**不自动扩 allowed_changes**（保持安全），下一轮 Auditor
  会看到此提示并决定是否 REWORK 或 BLOCKED。
- `verification_suggestion` → 当前 run 不自动执行（避免无限扩 verify），仅写 followups.md。
  未来可考虑 Auditor 决定是否采纳。
- `followup_task` → 写 followups.md。
- `risk_note` → 写 audit log（Auditor 可见）。

### 6.3 Auditor / Final Auditor 输出的块

解析时机：audit-report.md / final-audit.md schema 校验后。

消费规则：
- `risk_note` → 进 audit log，PASS 时仍写入便于跟踪。
- `followup_task` → 写 followups.md（项目级 followup 清单）。
- `clarify` → 拒绝并 warning（Auditor 不应该有 clarify 诉求，应当直接 REWORK 或 BLOCKED）。

### 6.4 followups.md 累积

`.agent/followups.md` 是项目级 followup 清单，结构：

```markdown
# Followups

## <run_id> @ <timestamp>

### From <role>

- [ ] **<title>**
  <description>
  Files: src/foo.ts
  Difficulty: medium
```

用户可手动勾选已处理；下次 `review-loop start` 时可选择 `--with-followups` 把
未勾选项注入 GOAL prompt。
## 7. Prompt 层改造

各 role 的 prompt 模板需追加"如何使用 ReviewLoopRequest"段落：

- 简短说明可用的 type 和典型场景
- 强调"主产物仍必填，文本块只是补充"
- 给 1~2 个示例

修改文件：

- `prompts/planner-system.md`
- `prompts/developer-system.md`
- `prompts/auditor-system.md`
- `prompts/final-auditor-system.md`

对每个 role 只暴露**对它有意义的 type**（如 Auditor 不暴露 clarify）。

## 8. 与事件流（Phase 9）的集成

Phase 9 落地后，Phase 10 增加：

- 解析成功的每个块发 `feedback.received` 事件（payload: type / role / priority / message）
- 解析失败发 `feedback.parse_error` 事件
- UI 时间轴在对应 role 的 segment 下显示一条小标记（如黄色 ⚠ followup, 红色 ⚠ risk）

Phase 9 未落地时，本协议仍可独立工作，仅依赖文件落盘。

## 9. 配置

`review-loop.yaml` 新增：

```yaml
feedback_protocol:
  enabled: true                    # 默认 true
  self_correction: false           # 解析失败是否给 Agent 一次重写机会
  max_blocks_per_document: 10
  allowed_types_per_role:
    planner: [clarify, risk_note, followup_task]
    developer: [scope_concern, verification_suggestion, risk_note, followup_task]
    auditor: [risk_note, followup_task]
    final_auditor: [risk_note, followup_task]
```

## 10. CLI 草案

```bash
review-loop followups list                  # 列出 followups.md 中未完成项
review-loop followups close <id>            # 标记已处理
review-loop start --with-followups          # 把未完成 followups 注入下一次 GOAL
review-loop feedback validate <file>        # 离线校验某个 markdown 中的文本块
```

## 11. 验收标准草案

1. 在 plan.md / handoff.md / audit-report.md 中嵌入合法 ReviewLoopRequest 块，能被解析并按
   消费规则路由到正确目标（clarifications.md / followups.md / audit log / risk 章节）。
2. 块格式错误时写入 parse-warnings.md，主流程仍按主产物推进至成功完成。
3. `feedback_protocol.enabled: false` 时，解析器不读、prompt 不暗示，行为与 Phase 9 完全一致。
4. `clarify` with `blocking: true` 能让 phase 进入 BLOCKED，`review-loop resume` 能恢复。
5. `clarify` with `blocking: false` 能让下一轮 Planner prompt 自动附上 question 列表。
6. `followup_task` 在多个 run 中累积，`review-loop followups list` 能按时间顺序列出。
7. `--with-followups` 启动新 run 时，未完成 followups 被注入 GOAL 提示词。
8. `origin_agent` 与实际 role 不一致的块被拒绝并记 warning。
9. 单文档块数超过 10 的尾部块被忽略并记 warning。
10. 自我纠正模式下，解析失败 → 重试 → 仍失败 时，主流程仍按原主产物推进，不卡死。
11. 与 Phase 9 集成：每条解析成功/失败的块都有对应事件出现在 events.ndjson 中。

## 12. 范围外（明确不做）

- ❌ 跨 Agent 临时委派（second_opinion / second_review 等"叫别人帮忙"语义）— 用户已确认
  暂不需要此能力，未来如需另立 phase。
- ❌ 文本块自动扩展 allowed_changes、自动追加 verification command 等"自动改主流程参数"
  的能力 — 安全考虑，所有改动仍走人/审计决定。
- ❌ Agent 之间的链式 Q&A（A 发 clarify → B 答 → A 再问）— 当前只支持单向：
  Agent 输出块 → orchestrator 消费 → 影响下一轮 prompt。
- ❌ JSON 形式的副指令块 — 仅支持 YAML，避免和现有 JSON artifact 混淆。
- ❌ 跨项目的 followups 共享 — followups.md 只在当前项目 `.agent/` 下，不做全局存储。
