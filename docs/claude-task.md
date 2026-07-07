# Claude Code 任务：建联助手二审

## 背景

当前仓库：`D:\Redbook_workflow`

当前分支：`redbook_lyk`

Codex 已经在主线实现“小红书律师建联助手”方向，核心目标是：

- 从已筛选的公开评论线索生成建联队列。
- 陌生人首条私信只生成草稿，发送前必须人工确认。
- 对方回复后，提取姓氏/称呼、电话、纠纷类型。
- 最终输出 4 列：账号ID/账号名、姓氏/称呼、电话、纠纷。

## 请审查的文件

- `scripts/dm-assistant.mjs`
- `scripts/legal-leads.mjs`
- `test/legal-leads.test.mjs`
- `config/dm-assistant.example.json`
- `docs/dm-assistant.md`
- `docs/dm-assistant-design.md`

## 审查重点

1. `scripts/dm-assistant.mjs` 的模块边界是否清楚，是否避免继续把 `legal-leads.mjs` 变得过大。
2. `buildDmQueue` 是否严格只生成“待人工确认发送”的首句队列。
3. `updateLeadsFromDmReplies` 是否只在有回复后提取电话、姓氏和纠纷信息。
4. 状态流转是否足够稳定，尤其是 `queued_first_touch`、`first_touch_sent`、`replied`、`trust_explained`、`surname_needed`、`phone_needed`、`dispute_needed`、`info_complete`、`do_not_contact`。
5. 是否有重复建联、拒绝后继续联系、误把帖子博主当线索、误处理评论区回复的风险。
6. CSV/XLSX 的最终交付字段是否足够简洁，是否适合长期人工跟进。
7. 测试是否还缺关键场景。

## 输出要求

请把结果写到：

`D:\Redbook_workflow\docs\claude-review.md`

输出结构：

- 可行性结论
- 主要风险
- 建议修改
- 可选 patch
- 建议补充测试

## 协作边界

不要直接在主仓库大范围改文件。优先输出 review 和 patch 建议，由 Codex 合并和验证。
