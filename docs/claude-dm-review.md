# Claude Code feasibility review prompt

请审查 `D:\Redbook_workflow` 当前项目，验证以下方案是否可实现，不要修改文件。

目标：
把现有小红书评论线索流程扩展为“律师建联 + 回复后信息提取 + 表格汇总”。

重点检查：

1. `scripts/legal-leads.mjs` 现有 `buildLeads`、`buildContactQueue`、`updateLeadsFromReplies` 是否足够扩展。
2. 新增 `scripts/dm-assistant.mjs` 的模块边界是否清晰，是否避免了 `legal-leads.mjs` 继续变大。
3. 是否能稳定输出账号ID/账号名、姓氏、电话、纠纷四列。
4. `trust_stage/status` 是否能避免重复追问或拒绝后继续联系。
5. 首句模板、律所名、律所电话放在 `config/dm-assistant.json` 或命令参数是否合适。
6. 测试是否覆盖首句去重、固定模板、回复抽取、身份说明、拒绝停止和最终表格。

请输出：

- 可行性结论
- 推荐模块边界
- 风险点
- 最小实现步骤
- 测试清单
