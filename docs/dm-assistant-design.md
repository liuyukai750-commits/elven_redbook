# 小红书建联助手设计

## 目标

把公开评论里筛出的律师需求账号变成一个可跟进的建联队列。系统可以生成建议话术、记录人工处理状态，并在对方回复后提取姓氏、电话和纠纷信息，但不自动批量私信陌生用户。

## 数据字段

建联队列建议保留这些字段：

- 账号ID/账号名
- 账号名
- 主页链接
- 来源帖子链接
- 评论内容
- 纠纷类型
- 首句草稿
- 人工处理状态
- 姓氏/称呼
- 电话
- 纠纷问题摘要
- 备注

最终交付表格保持 4 列：

```text
账号ID/账号名 | 姓氏/称呼 | 电话 | 纠纷
```

## 状态流转

当前代码以这些状态为准：

- `new`：新发现线索，还未进入建联队列。
- `queued_first_touch`：已生成首句草稿，等待人工确认发送。
- `first_touch_sent`：人工已发送首条消息。
- `replied`：对方已回复，但信息还不完整或需要继续判断。
- `trust_explained`：对方询问身份、律所或收费时，优先生成身份说明回复。
- `surname_needed`：缺少姓氏或称呼。
- `phone_needed`：缺少电话。
- `dispute_needed`：缺少纠纷类型。
- `info_complete`：账号、姓氏/称呼、电话、纠纷类型已齐全。
- `do_not_contact`：对方拒绝或表示不需要，后续不再进入建联队列。

`trust_stage` 用来记录当前沟通阶段；`status` 用来决定是否继续进入队列、是否进入最终表格。

## 首条消息规则

- 首条消息由固定模板生成，支持填入账号名、纠纷类型、来源评论摘要、律所名和律所电话。
- 发送动作必须由人工确认。
- 不做无人工确认的陌生人批量私信。
- 不发送夸大承诺、诱导留资或可能造成骚扰的内容。
- 已经处于 `queued_first_touch`、`first_touch_sent`、`replied`、`trust_explained`、`surname_needed`、`phone_needed`、`dispute_needed`、`info_complete`、`do_not_contact` 的线索，不再重复进入首句队列。

## 回复后的 AI 处理

当用户把私聊回复文本导入系统后，AI 可以：

- 判断对方是否愿意继续沟通。
- 提取姓氏或称呼。
- 提取电话。
- 归类纠纷类型。
- 生成下一句建议回复。
- 回写到对应账号行。

如果没有明确电话或姓氏，字段保持为空，不猜测。

## 文件建议

- `config/dm-assistant.example.json`：建联助手配置示例。
- `config/dm-assistant.json`：本地实际律所配置，不建议提交。
- `output/dm-queue.csv`：给人工处理的首句建联队列。
- `output/dm-queue.json`：程序读写用结构化队列数据。
- `input/dm-replies.json`：人工导入的私聊回复。
- `output/dm-summary.csv`：最终 4 列交付表格。
- `output/dm-summary.xlsx`：最终 4 列 Excel 表格。
- `docs/claude-task.md`：交给 Claude Code 的明确任务。
- `docs/claude-review.md`：Claude Code 的审查结果或候选 patch。

## 稳定性原则

- 采集、筛选、建联队列、回复提取分模块处理，避免一个页面异常影响全部流程。
- 每次批量运行记录进度、失败原因和输出路径，支持断点续跑。
- 对个人信息只做本地保存，不写入日志。
- 遇到登录失效、验证码、风控、页面结构变化时暂停，而不是继续重试。
- 输出文件保持可人工阅读和可程序恢复两种格式：CSV/XLSX 给人看，JSON 给程序续跑。
