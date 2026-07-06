# 小红书法律线索合规自动化工具

这个项目用于本地完成小红书公开评论采集、律师需求筛选、表格导出和建联草稿管理。项目不自动批量私信陌生用户，也不绕过验证码、登录风控或平台安全机制。

## 当前能力

- 从小红书页面抽取公开评论。
- 按关键词和规则筛选有法律需求的评论。
- 导出 CSV/XLSX/JSON 表格。
- 按帖子分别保存结果，方便回溯来源。
- 生成建联草稿和待处理队列。
- 在对方回复后，辅助提取姓氏、电话和纠纷问题，再回写表格。

## 合规边界

- 陌生用户首条私信只生成草稿，必须人工确认发送。
- 只在对方主动咨询、明确同意继续沟通，或人工确认已经建联并收到回复后，才整理电话、姓氏等信息。
- 电话、姓名、私聊内容等个人信息只保存在本地文件中，不写入调试日志。
- 遇到验证码、风控、登录失效时暂停处理，由人工介入。

## 快速验证

```powershell
npm run sample
npm test
```

默认输出目录：

```text
D:\Redbook_workflow\output\
```

## Chrome CDP 采集

内置浏览器不稳定时，可以使用 Chrome CDP 方案。它会使用本项目下的独立浏览器资料目录：

```text
D:\Redbook_workflow\chrome-profile
```

启动并登录小红书：

```powershell
npm run chrome:launch -- --keyword 离婚
```

登录后采集搜索结果中的帖子评论：

```powershell
npm run chrome:collect -- --keyword 离婚 --limit 10 --output D:\Redbook_workflow\output\run-20260706
```

## 输出约定

- 批量运行结果应放入 `output/` 或明确命名的运行目录。
- 每篇帖子可以单独生成一个子目录，保存对应评论表格和筛选结果。
- `comments.xlsx` 表示原始可见评论。
- `legal-leads.xlsx` 表示筛选后的高意向线索，可能为空。
- 测试临时目录如 `red_output*` 不应长期保留。

## 建联队列

建联队列用于人工确认发送首条消息。建议字段包括：

```text
账号名 | 主页链接 | 来源帖子链接 | 评论内容 | 需求类型 | 是否明确求助 | 建议回复草稿 | 人工处理状态 | 姓/称呼 | 电话 | 纠纷问题摘要 | 备注
```

首条消息模板建议放在：

```text
config\contact-template.txt
```

生成建联队列：

```powershell
npm run contact-queue -- --template-file .\config\contact-template.txt
```

处理私聊回复样例：

```powershell
npm run from-replies -- --input .\examples\sample-replies.json
```

## 协作方式

- `AGENTS.md`：Codex、Claude Code、Cursor 的分工和协作边界。
- `docs\task-board.md`：当前任务板。
- `docs\dm-assistant-design.md`：建联助手产品设计和合规边界。
- `docs\claude-task.md`：需要 Claude Code 二审时的任务文件。
- `docs\claude-review.md`：Claude Code 的建议、审查结果或候选 patch。

推荐工作流是 Codex 负责主线实现和验证，Claude Code 通过共享文件做二审或候选实现，Cursor 由用户人工查看和微调。
