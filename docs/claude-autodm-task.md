# Claude Code 二审任务：小红书建联助手

## 背景

当前项目在 `D:\Redbook_workflow_redbook_lyk` 分支 worktree 中开发。Codex 已经实现公开评论采集、线索表格、`dm-queue` 建联队列、`dm-replies` 回复后信息整理。

用户希望后续把高意向法律需求账号进入建联流程。为稳定和账号安全，当前实现先把首句生成到队列，并过滤疑似同行账号，不做绕过验证码或平台风控的群发逻辑。

## 需要你验证的点

请重点审查：

1. `scripts/dm-assistant.mjs`
   - `buildDmQueue`
   - `buildSkippedDmQueue`
   - `isCompetitorAccount`
   - `updateLeadsFromDmReplies`
2. `scripts/legal-leads.mjs`
   - `dm-queue`
   - `dm-replies`
   - `loadDmOptions`
3. `test/legal-leads.test.mjs`
   - DM 队列去重、状态、疑似同行过滤、回复提取测试是否覆盖关键风险。

## 方案边界

- 不实现绕过验证码、风控或限制的逻辑。
- 不把电话、姓名、对话内容写入调试日志。
- 疑似同行账号默认跳过，关键词包括：律师、律所、法务、法律咨询、法律服务、普法、诉讼、律师事务所。
- 首句模板固定，回复后再发送身份核实和电话信息模板。

## 请输出

请把审查结果写到：

`D:\Redbook_workflow_redbook_lyk\docs\claude-autodm-review.md`

格式建议：

1. 结论：可行/部分可行/不建议
2. 必改问题：按严重程度列出
3. 建议优化：状态机、失败恢复、测试、文案、表格字段
4. 可选 patch：如果你建议改代码，请给出最小 diff 或明确文件/函数/逻辑

