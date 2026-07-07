# Claude Code 二审：小红书建联助手 代码审查报告

**审查日期**: 2026-07-07
**审查范围**: `scripts/dm-assistant.mjs`, `scripts/legal-leads.mjs`, `test/legal-leads.test.mjs`
**审查重点**: `buildDmQueue`, `buildSkippedDmQueue`, `isCompetitorAccount`, `updateLeadsFromDmReplies`, `loadDmOptions`, DM 队列去重/状态/过滤/回复提取测试

---

## 1. 结论

**部分可行** — 核心逻辑正确，方案边界符合要求，但存在 2 个必改问题和若干建议优化，修复后可投入使用。

---

## 2. 必改问题

### 2.1 [严重] `markDmQueueSent` 导出但从未被 CLI 流程调用

- **文件**: `dm-assistant.mjs:163-171`, `legal-leads.mjs`
- **问题**: `markDmQueueSent` 可以将队列条目标记为 `first_touch_sent`，但 `legal-leads.mjs` 的 `dm-queue` 命令生成队列后，没有提供 `dm-mark-sent` 子命令来实际调用它。操作人员手动发送首句后，没有任何机制将发送状态回写到 leads 或队列文件。
- **后果**: 下次运行 `dm-queue` 时，已发送过的账号如果没有在 leads 文件中被手动更新 `status` 字段，会被重新排入队列，导致重复发送。
- **状态机断层**: `SKIP_QUEUE_STATUSES` 包含 `first_touch_sent` 和 `queued_first_touch`，但如果无人回写，这些状态永远不会被设置。
- **修复建议**: 在 `legal-leads.mjs` 中新增 `dm-mark-sent` 命令，读取 `dm-queue.json`，调用 `markDmQueueSent`，将结果回写到 `dm-queue.json` 并同步更新 `legal-leads.json` 中对应 lead 的 status。

### 2.2 [中等] `isCompetitorAccount` 仅检查账号字段，未检查评论正文

- **文件**: `dm-assistant.mjs:348-356`
- **问题**: 当前逻辑拼接 `account_name`, `account_identity`, `account_id`, `profile_url` 进行关键词匹配。但如果一个同行使用普通账号名（如"法律小助手"改名为"小明"），其评论内容（`source_comment`）可能暴露同行身份（如"我是XX律所的律师，可以帮你"）。
- **后果**: 部分同行账号可能通过改名绕过过滤，进入建联队列。
- **方案边界确认**: 任务方案明确说"疑似同行账号默认跳过"，当前实现覆盖面不足。
- **修复建议**: 将 `lead.source_comment` 也加入 haystack，或者新增一个独立检查 `isCompetitorComment`。同时注意——普通用户评论中也可能包含"律师""诉讼"等词汇，仅靠关键词匹配会有误伤风险。建议对 `source_comment` 中的匹配使用更严格的模式（如正则："我是.*律师"、"我们律所"、"加微信.*咨询"等同行行为特征），而非单纯关键词 `includes`。

---

## 3. 建议优化

### 3.1 状态机

| 问题 | 位置 | 建议 |
|------|------|------|
| `buildNextReply` 在缺少姓氏或纠纷类型时返回的消息是 `trustMessageTemplate`（身份核实模板），而非针对性地询问缺失信息 | `dm-assistant.mjs:250-256` | 当仅缺 `surnameOrTitle` 时，回复应明确问"请问您贵姓？"；当仅缺 `disputeType` 时，回复应问"请问具体是哪类纠纷？"当前统一发身份核实模板，逻辑上不算错（模板本身含"登记姓氏和电话"），但语义不够精准 |
| `trust_stage` 和 `status` 是两个独立字段，存在冗余和不一致风险 | `dm-assistant.mjs:122-137`, `dm-assistant.mjs:221-275` | 建议统一为单一状态枚举，或以 `status` 为主、`trust_stage` 为辅助描述。当前两字段在大部分情况下值相同，但 `markDmQueueSent` 将 `status` 设为 `first_touch_sent` 而 `trust_stage` 也是 `first_touch_sent`——完全是重复的 |
| `buildNextReply` 在多轮对话中的状态推进依赖调用方正确传递累积信息 | `dm-assistant.mjs:221-275` | 建议增加显式的状态转换表/枚举，便于调试和测试。目前函数内部的分支判断隐含了优先级：拒绝 > 信息完整 > 信任说明 > 缺信息 > 缺电话。优先级合理，但缺少文档说明 |

### 3.2 失败恢复

| 问题 | 位置 | 建议 |
|------|------|------|
| 无重试/断点续传机制 | `legal-leads.mjs:237-260` | `dm-queue` 每次都从头构建队列。如果中途中断（如写文件失败），已生成的队列数据丢失。建议将队列生成和文件写入分步进行，生成后立即写入临时文件 |
| `writeOutputFile` 有 EBUSY/EPERM 降级逻辑（加时间戳），但未通知用户使用了降级路径 | `legal-leads.mjs:365-376` | 建议在降级写入时打印 warning 日志，避免用户找不到输出文件 |
| `spawnCapture` 对 redbook 命令失败时的错误信息做了 `redactSecrets`，只处理了 cookie 参数，但 `legal-keywords.json` 中的其他敏感信息未被脱敏 | `legal-leads.mjs:318-326` | 脱敏范围可以更广，或直接只打印错误类型而非完整 stderr |

### 3.3 测试覆盖

当前测试覆盖了核心 happy path，但以下关键风险场景缺少测试：

| 缺少的测试场景 | 风险 |
|---------------|------|
| `buildDmQueue` 的 `minScore` 阈值过滤（score < 25 应被跳过） | 低分线索进入队列 |
| `buildDmQueue` 的 `dailySendLimit` 截断（如限制 30 条） | 超量发送 |
| `isCompetitorAccount` 输入为 `null`/`undefined`/空字符串 | NPE 或漏过滤 |
| `isCompetitorAccount` 关键词"律师事务所"包含子串"律师"和"律所"时的匹配行为（当前 `includes` 下"律师事务所"会同时命中"律师"和"律所"两个关键词，但这不是 bug——只是说明行为） | 理解偏差 |
| `normalizeDmReplies` 接收非数组非对象输入（如字符串、null） | 运行时异常 |
| `updateLeadsFromDmReplies` 中一条 reply 同时匹配多条 lead（如账号在多个笔记下评论） | 状态污染 |
| `buildNextReply` 完整状态流转：`first_touch_sent → replied → phone_needed → info_complete` | 多轮对话逻辑正确性 |
| `loadDmOptions` CLI 参数覆盖 config 文件的优先级 | 配置合并 bug |
| 空 leads 数组输入到 `buildDmQueue` | 空队列处理 |
| `buildSkippedDmQueue` 只检查 competitor，不检查其他跳过原因 | 跳过队列不完整 |

### 3.4 文案与模板

| 问题 | 位置 | 建议 |
|------|------|------|
| `DEFAULT_FIRST_MESSAGE_TEMPLATE` 使用 `{{律所名}}` 占位符，但如果 `firmName` 为空，输出为"我是这边的助理"，语义不完整 | `dm-assistant.mjs:1-2` | `validateDmOptions` 已校验 firmName 必填，但仅在 `dm-queue` 和 `dm-replies` 命令中调用。建议在 `createDmOptions` 中也做软校验或给出默认占位文案 |
| `PHONE_MESSAGE_TEMPLATE` 使用 `{{纠纷类型}}` 占位符，但当纠纷类型无法推断时（空字符串），输出为"我先按记录" | `dm-assistant.mjs:7-8` | `renderDmTemplate` 中 `disputeType` 已有兜底值 `"法律"`（第 327 行），覆盖了此情况 |
| `COMPLETE_MESSAGE` 提到"律所工作人员"，但未包含律所名称 | `dm-assistant.mjs:10` | 可考虑在完成消息中也加入律所名以增强可信度 |

### 3.5 表格与数据字段

| 问题 | 位置 | 建议 |
|------|------|------|
| `buildDmQueue` 生成的条目不含 `surname_or_title` 和 `phone`（此时尚未获取） | `dm-assistant.mjs:122-137` | 字段预留正确，但需确保后续 `updateLeadsFromDmReplies` 正确回填 |
| `buildSkippedDmQueue` 中没有记录匹配到的具体关键词 | `dm-assistant.mjs:143-160` | 建议在 `risk_flags` 或 `remarks` 中写明具体命中的关键词，便于人工复核（如 "命中关键词：律师"） |
| `toDmSummaryRows` 默认 `onlyComplete=true` 只输出 `info_complete` 状态的 lead | `dm-assistant.mjs:291-301` | 合理，但 CLI 中 `--include-partial` flag 可以展示不完整记录，当前已支持 |
| DM 导出字段仅 4 列（账号、姓氏、电话、纠纷），缺少 `lead_id`、`status`、`source_comment` 等溯源信息 | `dm-assistant.mjs:67-72` | 导出是交付格式，精简合理；但建议额外输出一份带 `lead_id` 和 `status` 的完整版 CSV 供内部追溯 |

---

## 4. 可选 Patch

### Patch A: 新增 `dm-mark-sent` CLI 命令（对应问题 2.1）

**文件**: `scripts/legal-leads.mjs`

在 `main()` 的 command 分支中新增：

```js
if (command === "dm-mark-sent") {
  await runDmMarkSent(args);
  return;
}
```

新增函数：

```js
async function runDmMarkSent(args) {
  const input = path.resolve(args.input ?? path.join(DEFAULT_OUTPUT_DIR, "dm-queue.json"));
  const leadsPath = path.resolve(args.leads ?? path.join(DEFAULT_OUTPUT_DIR, "legal-leads.json"));
  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);

  const queue = await readJsonFile(input);
  const sent = markDmQueueSent(queue);

  // 回写到 dm-queue.json
  await writeOutputFile(input, JSON.stringify(sent, null, 2), "utf8");

  // 同步更新 legal-leads.json 中对应 lead 的 status
  const leads = await readJsonFile(leadsPath);
  const sentLeadIds = new Set(sent.map(item => item.lead_id).filter(Boolean));
  const updatedLeads = leads.map(lead =>
    sentLeadIds.has(lead.lead_id)
      ? { ...lead, status: "first_touch_sent", remarks: appendRemark(lead.remarks, "首句已发送") }
      : lead
  );
  await writeOutputFile(leadsPath, JSON.stringify(updatedLeads, null, 2), "utf8");

  console.log(`Marked ${sent.length} queue items as sent.`);
  console.log(`Updated ${updatedLeads.filter(l => sentLeadIds.has(l.lead_id)).length} leads.`);
}
```

### Patch B: 增强 `isCompetitorAccount` 的评论内容检查（对应问题 2.2）

**文件**: `scripts/dm-assistant.mjs`

在 `isCompetitorAccount` 中增加 `source_comment` 检查：

```js
// 同行行为特征模式（用于匹配评论内容）
const COMPETITOR_COMMENT_PATTERNS = [
  /我是.{0,5}(律师|法务|法律顾问)/,
  /我们(律所|律师事务所|法律咨询)/,
  /加(微信|V|v).{0,10}(咨询|法律)/,
  /(免费|公益)法律咨询/,
  /执业律师/,
  /律师执业证/
];

export function isCompetitorAccount(lead, keywords = DEFAULT_COMPETITOR_KEYWORDS) {
  // 原有：账号字段关键词检查
  const haystack = [
    lead.account_name,
    lead.account_identity,
    lead.account_id,
    lead.profile_url
  ].map(value => String(value ?? "")).join(" ");
  const keywordHit = normalizeKeywordList(keywords).some(
    keyword => keyword && haystack.includes(keyword)
  );
  if (keywordHit) return true;

  // 新增：评论内容行为模式检查
  const comment = String(lead.source_comment ?? "");
  if (comment && COMPETITOR_COMMENT_PATTERNS.some(pattern => pattern.test(comment))) {
    return true;
  }

  return false;
}
```

### Patch C: `buildNextReply` 缺信息时给出针对性问询（对应建议 3.1）

**文件**: `scripts/dm-assistant.mjs:250-256`

当前：

```js
if (!surnameOrTitle || !disputeType) {
  return {
    status: !surnameOrTitle ? "surname_needed" : "dispute_needed",
    trustStage: !surnameOrTitle ? "surname_needed" : "dispute_needed",
    message: renderDmTemplate(options.trustMessageTemplate, { dispute_type: disputeType }, options),
    riskFlags
  };
}
```

建议改为：

```js
if (!surnameOrTitle && !disputeType) {
  return {
    status: "surname_needed",
    trustStage: "surname_needed",
    message: `好的，我先帮你登记。请问您贵姓？另外方便说一下具体是哪类纠纷吗（比如离婚、劳动仲裁、欠款等）？`,
    riskFlags
  };
}
if (!surnameOrTitle) {
  return {
    status: "surname_needed",
    trustStage: "surname_needed",
    message: `请问您贵姓？我帮你做一下登记。`,
    riskFlags
  };
}
if (!disputeType) {
  return {
    status: "dispute_needed",
    trustStage: "dispute_needed",
    message: `请问具体是哪方面的法律问题呢？（比如离婚、劳动仲裁、欠款、合同等）这样我好帮你按类型整理。`,
    riskFlags
  };
}
```

### Patch D: 在 `buildSkippedDmQueue` 中记录命中的具体关键词

**文件**: `scripts/dm-assistant.mjs:143-160`

在 items 和 remarks 中记录命中关键词：

```js
export function buildSkippedDmQueue(leads, options = {}) {
  const config = createDmOptions(options);
  const keywords = config.competitorKeywords;
  return leads
    .filter(lead => isCompetitorAccount(lead, keywords))
    .map((lead, index) => {
      // 找出具体命中的关键词
      const haystack = [
        lead.account_name, lead.account_identity, lead.account_id, lead.profile_url
      ].map(v => String(v ?? "")).join(" ");
      const matchedKeywords = normalizeKeywordList(keywords).filter(
        kw => kw && haystack.includes(kw)
      );
      return {
        queue_id: `skip_${String(index + 1).padStart(4, "0")}`,
        lead_id: lead.lead_id ?? "",
        account_identity: resolveAccountIdentity(lead),
        account_id: lead.account_id ?? extractAccountId(lead.profile_url) ?? "",
        account_name: lead.account_name ?? "",
        profile_url: lead.profile_url ?? "",
        source_comment: lead.source_comment ?? "",
        dispute_type: lead.dispute_type || inferDisputeType(lead.source_comment) || "",
        status: "skipped_competitor",
        risk_flags: ["possible_lawyer_or_legal_service_account"],
        remarks: `账号名或身份字段命中疑似同行关键词：${matchedKeywords.join("、")}，跳过建联。`,
        created_at: new Date().toISOString()
      };
    });
}
```

---

## 5. 方案边界合规确认

| 边界要求 | 状态 |
|----------|------|
| 不实现绕过验证码、风控或限制的逻辑 | ✅ 合规 — 代码中无相关逻辑，遇到 captcha 直接 throw Error |
| 不把电话、姓名、对话内容写入调试日志 | ✅ 合规 — 无 console.log 打印 PII；stderr 脱敏处理 |
| 疑似同行账号默认跳过，关键词：律师、律所、法务、法律咨询、法律服务、普法、诉讼、律师事务所 | ⚠️ 基本合规 — 关键词列表完整，但仅检查账号字段（见问题 2.2） |
| 首句模板固定 | ✅ 合规 — `DEFAULT_FIRST_MESSAGE_TEMPLATE` 为固定模板，支持配置覆盖 |
| 回复后再发送身份核实和电话信息模板 | ✅ 合规 — `buildNextReply` 按 `needsTrustExplanation → trustMessageTemplate` → `phoneMessageTemplate` 顺序推进 |

---

## 6. 总结

代码整体质量良好，模块拆分合理（`dm-assistant.mjs` 为纯逻辑，`legal-leads.mjs` 为 CLI 编排），状态机设计完整，模板系统灵活。两个必改问题（`dm-mark-sent` 缺失、同行检测覆盖面不足）修复成本低、风险小。建议优化中，测试补充和针对性文案改进性价比最高。建议在修复 2.1 和 2.2 后即可投入使用，后续迭代中逐步补充测试和文案优化。
