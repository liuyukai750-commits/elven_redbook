# 小红书建联助手 — 二审报告

**审查日期**：2026-07-07
**审查分支**：`redbook_lyk`
**审查范围**：`scripts/dm-assistant.mjs`、`scripts/legal-leads.mjs`、`test/legal-leads.test.mjs`、`config/dm-assistant.example.json`、`docs/dm-assistant.md`、`docs/dm-assistant-design.md`

---

## 可行性结论

**基本可行，但存在 3 个阻塞级问题需要在合并前修复。**

核心流程（评论→线索→首句建联队列→回复提取→4 列交付）逻辑完整，状态机设计合理。`dm-assistant.mjs` 作为独立模块抽取得当，与 `legal-leads.mjs` 的 CLI 编排层边界清晰。

但以下问题构成阻塞：

1. **`buildDmQueue` 状态过滤不完整**——已进入中间会话状态（`replied` / `surname_needed` / `phone_needed` / `dispute_needed` / `trust_explained`）的线索在重复运行 `dm-queue` 时会被重新加入首句队列。
2. **`markDmQueueSent` 无 CLI 调用路径**——队列生成后缺少"标记已发送"的命令，导致 `first_touch_sent` 状态从未被正式写入，`buildDmQueue` 的状态跳过逻辑实际上不生效。
3. **测试文件引用不存在的模块**——`test/legal-leads.test.mjs` 第 20 行 `import { normalizeXhsUrl } from "../scripts/in-app-browser-batch.mjs"`，该文件在仓库中不存在，测试无法运行。

---

## 主要风险

### 风险 1：重复建联（中高风险）

**位置**：`scripts/dm-assistant.mjs:89`

```js
if (["do_not_contact", "first_touch_sent", "info_complete"].includes(lead.status)) continue;
```

只跳过了 3 种状态。线索在 `replied`、`trust_explained`、`surname_needed`、`phone_needed`、`dispute_needed` 状态下（即对方已回复、正在沟通中）会被重新加入首句队列，导致向正在沟通的用户再次发送首句模板消息，造成骚扰风险。

**同时**：`buildDmQueue` 的去重 key 是 `profile_url || accountIdentity`，当同一账号在不同帖子下有多条评论时，先遍历到的低分线索会"抢占"去重槽位，高分线索被静默丢弃。

### 风险 2：拒绝后仍可能被联系（中等风险）

**位置**：`scripts/legal-leads.mjs:573-591` `buildContactQueue`

旧版 `buildContactQueue`（`contact-queue` 命令）**完全不检查 `do_not_contact` 状态**，只检查 `account_name && source_comment`。如果用户混用新旧两条命令路径，标记为拒绝的用户仍会出现在旧版建联队列中。

### 风险 3：设计文档与实际状态机不一致（中等风险）

**设计文档** (`docs/dm-assistant-design.md`) 定义的状态：
`new` → `draft_ready` → `manual_send_pending` → `sent_by_human` → `replied` → `info_extracted` → `closed`

**实际代码**使用的状态：
`queued_first_touch` → `first_touch_sent` → `replied` / `trust_explained` / `surname_needed` / `phone_needed` / `dispute_needed` → `info_complete` / `do_not_contact`

两套状态命名完全不同，且设计文档中的 `closed`、`draft_ready`、`manual_send_pending` 在代码中不存在，代码中的 `trust_explained`、`info_complete` 在设计文档中也不存在。这会导致新接手开发者严重困惑。

### 风险 4：纠纷类型推断逻辑双写不一致（中等风险）

两处纠纷推断逻辑使用不同的关键词表：

| 位置 | 关键词来源 |
|------|-----------|
| `legal-leads.mjs:analyzeComment` | `config/legal-keywords.json`（外部配置驱动） |
| `dm-assistant.mjs:inferDisputeType` | 硬编码 `DISPUTE_KEYWORDS` 常量（7 组） |

两组关键词不完全一致。例如 `DISPUTE_KEYWORDS` 中有"一般纠纷/诉讼"（含"起诉""立案""开庭"等），而配置文件可能将其归入 `dispute` 组映射为"一般纠纷/诉讼"。当 DM 回复处理阶段重新推断纠纷类型时，可能覆盖初始分析阶段从配置中得到的更准确分类。

### 风险 5：`findReplyForLead` 匹配过于宽松（低中风险）

**位置**：`scripts/dm-assistant.mjs:321-331`

5 种匹配条件用 OR 连接（`lead_id` / `account_id` / `account_identity` / `profile_url` / `account_name`），任意一条命中即匹配。当回复数据中两个不同用户的 `account_name` 相同时（小红书昵称可重复），可能错配回复。

### 风险 6：帖子博主识别依赖数据完整性（低风险）

**位置**：`scripts/legal-leads.mjs:431`

`isNoteAuthor` 只在 `noteAuthorId && userId && noteAuthorId === userId` 时被标记。如果 API 返回数据缺少 `noteAuthorId`，则帖子博主的评论不会被过滤，可能被当作线索。

---

## 建议修改

### 修改 1（阻塞）：补全 `buildDmQueue` 状态跳过列表

```diff
- if (["do_not_contact", "first_touch_sent", "info_complete"].includes(lead.status)) continue;
+ const SKIP_STATUSES = [
+   "do_not_contact",
+   "first_touch_sent",
+   "queued_first_touch",
+   "replied",
+   "trust_explained",
+   "surname_needed",
+   "phone_needed",
+   "dispute_needed",
+   "info_complete"
+ ];
+ if (SKIP_STATUSES.includes(lead.status)) continue;
```

### 修改 2（阻塞）：添加 `dm-mark-sent` CLI 命令或在 `dm-queue` 输出后自动标记

当前 `markDmQueueSent` 已实现但无调用路径。建议两种方案：

**方案 A（推荐）**：`dm-queue` 生成队列后自动将原 leads 中对应项标记为 `queued_first_touch`，防止重复生成。新增 `dm-mark-sent` 命令供人工发送后调用。

**方案 B**：在 `dm-queue` 命令输出提示中明确告知用户需要手动更新状态，并在文档中说明。

### 修改 3（阻塞）：移除测试中对不存在文件的引用

```diff
- import { normalizeXhsUrl } from "../scripts/in-app-browser-batch.mjs";
+ // normalizeXhsUrl 功能在 legal-leads.mjs 中已有 extractXhsUserId / normalizeNoteUrl 覆盖
+ // 若需要独立测试，应先将该函数提取到共享模块
```

或在仓库中补充 `scripts/in-app-browser-batch.mjs` 文件（如果它确实存在但未被提交）。

### 修改 4（建议）：按 score 降序排列后再去重

`buildDmQueue` 中，在遍历 `leads` 之前先按 `score` 降序排列，确保同一账号的多条线索中，得分最高的被保留：

```js
const sorted = [...leads].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
for (const lead of sorted) { ... }
```

### 修改 5（建议）：`buildContactQueue` 增加状态过滤

```diff
  export function buildContactQueue(leads, template) {
    const seen = new Set();
    return leads
      .filter(lead => lead.account_name && lead.source_comment)
+     .filter(lead => lead.status !== "do_not_contact")
      .filter(lead => {
```

### 修改 6（建议）：统一纠纷推断逻辑

将 `dm-assistant.mjs` 中的 `DISPUTE_KEYWORDS` 和 `inferDisputeType` 改为接受外部配置参数，与 `legal-leads.mjs` 的 `analyzeComment` 共享同一份关键词配置。或者至少将 `DISPUTE_KEYWORDS` 提取到共享的 `config/legal-keywords.json` 中。

### 修改 7（建议）：同步设计文档与实际状态机

更新 `docs/dm-assistant-design.md`，使其状态定义与实际代码一致。建议以代码为准：
- 补充 `queued_first_touch`、`trust_explained`、`info_complete`、`do_not_contact` 的说明
- 标注 `new`、`draft_ready`、`closed` 为"规划中/待实现"

### 修改 8（建议）：提取共享工具函数

以下函数在 `dm-assistant.mjs` 和 `legal-leads.mjs` 中各有一份独立实现：

| 函数 | dm-assistant.mjs | legal-leads.mjs |
|------|------------------|-----------------|
| `appendRemark` | :342 | :629 |
| `normalizeSurname` | :333 | :722 |
| `csvEscape` | :350 | :762 |
| `stripWhitespace` | :346 | :745 |
| `DISPLAY_HEADERS` | :51 | :34 |
| `HEADERS` | :44 | :27 |

建议提取到 `scripts/utils.mjs`，两个模块统一 import。

### 修改 9（建议）：`findReplyForLead` 增加匹配优先级

当 `lead_id` 匹配时优先使用（精确匹配），其次才是其他字段的模糊匹配。

---

## 可选 Patch

以下 patch 可直接应用到仓库，修复阻塞级问题：

### Patch A：修复 `buildDmQueue` 状态过滤（`scripts/dm-assistant.mjs`）

```patch
@@ -86,7 +86,18 @@
     const accountIdentity = resolveAccountIdentity(lead);
     const dedupeKey = String(lead.profile_url || accountIdentity).trim().toLowerCase();
     const score = Number(lead.score ?? 0);
     if (!accountIdentity || !lead.source_comment) continue;
-    if (["do_not_contact", "first_touch_sent", "info_complete"].includes(lead.status)) continue;
+    const SKIP_STATUSES = [
+      "do_not_contact",
+      "first_touch_sent",
+      "queued_first_touch",
+      "replied",
+      "trust_explained",
+      "surname_needed",
+      "phone_needed",
+      "dispute_needed",
+      "info_complete"
+    ];
+    if (SKIP_STATUSES.includes(lead.status)) continue;
     if (score && score < config.minScore) continue;
     if (seen.has(dedupeKey)) continue;
     seen.add(dedupeKey);
```

### Patch B：`buildDmQueue` 按 score 排序后去重（`scripts/dm-assistant.mjs`）

```patch
@@ -83,7 +83,8 @@
   const seen = new Set();
   const queue = [];

-  for (const lead of leads) {
+  const sorted = [...leads].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
+  for (const lead of sorted) {
     const accountIdentity = resolveAccountIdentity(lead);
```

### Patch C：移除测试中不存在的 import（`test/legal-leads.test.mjs`）

```patch
@@ -17,3 +17,2 @@
 } from "../scripts/dm-assistant.mjs";
-import { normalizeXhsUrl } from "../scripts/in-app-browser-batch.mjs";

 const config = {
@@ -160,6 +159,2 @@

-test("normalizeXhsUrl strips tracking query params", () => {
-  const value = normalizeXhsUrl("https://www.xiaohongshu.com/explore/abc123?xsec_token=secret&source=feed");
-  assert.equal(value, "https://www.xiaohongshu.com/explore/abc123");
-});
-
```

### Patch D：`buildContactQueue` 过滤拒绝用户（`scripts/legal-leads.mjs`）

```patch
@@ -575,6 +575,7 @@
   return leads
     .filter(lead => lead.account_name && lead.source_comment)
+    .filter(lead => lead.status !== "do_not_contact")
     .filter(lead => {
```

---

## 建议补充测试

以下场景当前测试未覆盖，建议优先补充：

### P0（阻塞级）

1. **`buildDmQueue` 跳过所有中间状态**：构造 `replied` / `surname_needed` / `phone_needed` 状态的 leads，验证 `buildDmQueue` 不将其加入队列。
2. **`buildDmQueue` 重复运行幂等性**：对同一批 leads 连续两次调用 `buildDmQueue`，验证第二次返回空队列（当前缺少 `queued_first_touch` 过滤会导致非空）。

### P1（高优先级）

3. **`buildNextReply` 多轮对话**：模拟两轮连续回复（第一轮回姓名、第二轮回电话），验证状态从 `first_touch_sent` → `phone_needed` → `info_complete` 逐步推进。
4. **拒绝模式全覆盖**：逐一测试每个 `REJECTION_PATTERNS` 正则，确认拒绝意图被正确识别。同时测试误判场景（例如"不用客气，我自己查过了"不应触发拒绝，当前会触发）。
5. **`findReplyForLead` 精确匹配**：当 `lead_id` 匹配时验证优先使用，当多个线索有相同 account_name 时验证不串号。
6. **`buildDmQueue` score 阈值**：验证低于 `minScore` 的线索不被加入队列。

### P2（中优先级）

7. **`normalizeDmReplies` 多种输入形状**：测试 `{ replies: [...] }`、`{ messages: [...] }`、`{ items: [...] }`、直接数组四种格式。
8. **`extractDmInfo` 复姓处理**：测试"免贵姓欧阳""我姓司马"等复姓场景。
9. **`extractDmInfo` 无电话无姓氏**：测试回复中不含任何可提取信息时的返回值。
10. **`toDmSummaryRows` 非完整模式**：测试 `onlyComplete: false` 时返回所有非拒绝线索。
11. **`buildDmQueue` dailySendLimit 截断**：构造 50 条可入队线索，设置 `dailySendLimit: 30`，验证只返回前 30 条。
12. **信任说明优先于信息缺失**：回复同时包含"你们靠谱吗"和"我姓王，合同纠纷"，验证优先走 `trust_explained` 路径而非直接提取信息。

---

## 附录：其他发现

### 发现 1：`markDmQueueSent` 孤立函数

`markDmQueueSent`（第 115 行）已导出但 CLI 中无命令调用它。当前工作流为：`dm-queue` 生成队列 CSV → 人工在 Excel 中标记已发送 → 直接跳到 `dm-replies`。缺少正式的"标记已发送"步骤，导致 leads.json 中对应项的 status 永远停留在 `queued_first_touch`。

### 发现 2：`trust_stage` 与 `status` 双字段语义重叠

两个字段在大多数状态下值相同（`do_not_contact`、`info_complete`、`first_touch_sent`），仅在 `replied` + `trust_explained` 组合时有区分。建议明确文档说明两者的分工，或合并为单一字段。

### 发现 3：XLSX 生成中 DM 路径与其他路径的 `createXlsxBuffer` 调用方式不一致

`runFromFile`（第 138 行）传入内部 HEADERS 常量 + `leadToRow` 映射函数；`runDmReplies`（第 282-285 行）传入已翻译的 display headers + 手动映射 rows。建议统一接口。

### 发现 4：example 配置文件缺少 `completeMessage` 字段

`config/dm-assistant.example.json` 中没有 `COMPLETE_MESSAGE` 对应的可配置字段，但代码中硬编码了 `COMPLETE_MESSAGE` 常量（第 10 行）。如果律所需要自定义完成消息，需要修改代码。
