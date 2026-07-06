# 小红书律师建联助手

## 目标

建联助手负责把已筛选的小红书评论线索整理成首句队列，并在对方回复后提取最终表格字段：

```text
账号ID/账号名
姓氏/称呼
电话
纠纷
```

内部 JSON 会保留主页、原评论、首句、回复、状态、风险标记和备注，方便追溯。

## 配置

可以复制示例配置：

```powershell
Copy-Item .\config\dm-assistant.example.json .\config\dm-assistant.json
```

然后把 `firmName` 和 `firmPhone` 改成正式律所信息。

也可以不写配置文件，直接用命令参数：

```powershell
node scripts/legal-leads.mjs dm-queue --firm-name "某某律师事务所" --firm-phone "010-00000000"
```

## 生成首句队列

先生成线索：

```powershell
node scripts/legal-leads.mjs from-file --input .\examples\sample-comments.json
```

再生成建联队列：

```powershell
node scripts/legal-leads.mjs dm-queue --firm-name "某某律师事务所" --firm-phone "010-00000000"
```

输出：

```text
output\dm-queue.json
output\dm-queue.csv
```

首句使用固定模板，不由 AI 自由生成。队列会按账号去重，并跳过已完成、拒绝联系或低分线索。

## 处理回复

把私信回复整理成 JSON，例如：

```json
[
  {
    "account_identity": "u1",
    "text": "可以，我姓王，电话13800138000，主要是离婚财产和孩子抚养问题。"
  }
]
```

运行：

```powershell
node scripts/legal-leads.mjs dm-replies --input .\input\dm-replies.json --firm-name "某某律师事务所" --firm-phone "010-00000000"
```

输出：

```text
output\dm-summary.csv
output\dm-summary.xlsx
output\dm-summary.json
output\legal-leads.json
```

`dm-summary.*` 只包含最终交付 4 列。`legal-leads.json` 保留完整状态和回复记录。

## 状态规则

- `queued_first_touch`：已进入首句队列。
- `first_touch_sent`：首句已发送。
- `replied`：对方回复但还需要判断。
- `trust_explained`：对方问身份时，先说明律所和电话。
- `surname_needed`：缺称呼。
- `phone_needed`：缺电话。
- `dispute_needed`：缺纠纷类型。
- `info_complete`：账号、姓氏、电话、纠纷齐全。
- `do_not_contact`：对方拒绝或表示不需要。

拒绝用户不会进入最终有效线索表。
