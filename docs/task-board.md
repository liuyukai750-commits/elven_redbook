# 任务板

## 当前阶段

从“评论采集和线索表格”进入“建联助手”阶段。目标是把有律师需求的账号整理成可人工确认的建联队列，并在对方回复后由 AI 辅助提取有效信息。

## 已完成

- 单篇小红书评论 DOM 抽取流程已验证。
- 批量采集按帖子分目录输出的模式已验证。
- Chrome CDP 方案已作为内置浏览器不稳定时的备选控制方式。
- 明确了不自动批量私信陌生用户的合规边界。
- 已清理 `red_output*` 测试输出目录。
- 已创建 `redbook_lyk` 分支，并推送到 `origin/redbook_lyk`。
- 已新增建联助手模块 `scripts/dm-assistant.mjs`。
- 已恢复建联相关配置、示例和文档为 UTF-8 中文。
- 已修复 `config/legal-keywords.json` 的中文关键词配置。
- 已补充 Claude Code 交接文件 `docs/claude-task.md`。
- 已读取 Claude Code 二审结果 `docs/claude-review.md`，并合并关键建议。
- 当前完整测试通过：20/20。

## 待处理

- 继续清理 `scripts/legal-leads.mjs` 和 `test/legal-leads.test.mjs` 中更早期的乱码测试样例，优先保持行为不变。
- 准备小规模端到端演示：生成线索 -> 生成 `dm-queue` -> 导入回复 -> 输出 `dm-summary`。

## 协作规则

- Codex 负责主线实现和测试。
- Claude Code 通过任务文件做二审或候选 patch。
- Cursor 用于用户人工查看、修改和确认。
- 不让多个 Agent 同时在同一目录自由改同一批文件。

## Claude Code 状态

Codex 侧已确认 `claude.cmd --version` 可用，版本为 `2.1.201`。从 Codex 直接调用 `claude.cmd -p` 做项目审查时被审批器拦截，原因是该操作会把本地项目内容发送到外部 Claude 服务。用户随后在授权环境里生成了 `docs/claude-review.md`，Codex 已读取并合并其中关键建议：补全 `dm-queue` 状态过滤、同账号按高分去重、旧 `contact-queue` 过滤拒绝用户、同步设计文档和补测试。
