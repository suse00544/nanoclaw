---
name: trace-debugger
description: Tada AI 质量反馈与 Langfuse 排查。用户说“查 trace/session”、给出 trace_id、session_id 或裸 ID（包括 13 位数字 ID）时必须触发；使用脚本查询正式和预览 Langfuse，还原上下文并定位根因。
---

# Tada AI 质量反馈排查

## 必须执行的查询规则

1. 收到 trace ID、session ID、裸 ID，或用户说“查这个”时，必须调用本 skill 的 `langfuse-query.sh`；禁止不查询就根据 ID 格式、长度或时间戳猜测结果。
2. `13 位纯数字` 是 Tada 常见的 Langfuse `session_id`，不是无效格式。裸的 13 位数字 ID 先执行：

   ```bash
   /app/skills/trace-debugger/scripts/langfuse-query.sh session <id> auto
   ```

3. 裸 ID 的 session 查询未命中时，再执行 `trace <id> auto`；不能反过来，也不能用“trace ID 通常是 UUID”拒绝查询。
4. 只能依据脚本的成功 JSON 回答“查到”；脚本失败时如实报告配置、网络、认证或未命中错误。

## 核心职责

本群接收 Tada 产品的用户反馈上报。收到反馈后：**拉 trace → 还原上下文 → 定位根因 → 输出结论**。

---

## Langfuse 环境与凭证

凭证不写在 skill 文档里。当前支持正式环境和预览环境，两套凭证分别放在当前 agent group 的配置目录：

```bash
/workspace/agent/config/langfuse.env          # 正式环境
/workspace/agent/config/langfuse-preview.env  # Tada-Agent-Preview
```

两个文件使用相同变量名：

```bash
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

认证方式：HTTP Basic Auth，username = `LANGFUSE_PUBLIC_KEY`，password = `LANGFUSE_SECRET_KEY`。禁止打印、转述或把这些变量写进排查结论。

使用 skill 自带脚本查询，避免手工切换凭证：

```bash
/app/skills/trace-debugger/scripts/langfuse-query.sh trace <trace_id> auto
/app/skills/trace-debugger/scripts/langfuse-query.sh session <session_id> auto
/app/skills/trace-debugger/scripts/langfuse-query.sh observations <trace_id> auto
```

第三个参数可取 `auto`、`production`、`preview`。默认使用 `auto`：固定优先查询正式环境，失败或未命中时再查预览环境。反馈明确标注环境时可直接指定 `production` 或 `preview`，减少一次无效请求。

必须以该脚本返回的成功 JSON 为准，不得手工拼接接口后凭错误文本推断“两个环境都查过”。配置文件缺失、网络超时或认证失败时，应明确报告对应环境未完成查询，不能表述为 trace/session 不存在。

注意：agent 容器默认可能带有 OneCLI 的 `HTTPS_PROXY`。Langfuse 凭证已经由本配置文件显式提供，查询 Langfuse 时必须绕过 OneCLI 代理，避免网关返回 `resolution_failed`。所有 `curl` 命令都加 `--noproxy '*'`。

---

## 反馈消息格式

群内机器人会转发用户上报，固定格式：

```
消息追踪转发
问题类型：AI 质量
本轮问题：<用户当轮发送的消息>
trace_id：<langfuse trace id>
langfuse_session_id：<session id>
用户 ID：<uuid>
用户昵称：<昵称>
用户手机号：<脱敏手机号>
用户创建时间：<ISO timestamp>
备注：<用户自己写的问题描述>
```

### 字段说明

| 字段 | 含义 |
|------|------|
| `问题类型` | 目前固定为"AI 质量" |
| `本轮问题` | 用户在被反馈这一轮发送的原始消息 |
| `trace_id` | 该轮对话的 trace ID，查 LLM 调用、工具调用、token 消耗 |
| `langfuse_session_id` | 整个会话 session ID，查所有对话轮次还原上下文 |
| `用户 ID` | Tada 系统内的用户 UUID |
| `用户昵称` | 用户昵称 |
| `备注` | **最重要** — 用户描述的问题现象，排查从这里开始 |

---

## Trace 查询

### 查单轮 trace

```bash
/app/skills/trace-debugger/scripts/langfuse-query.sh trace {trace_id} auto
```

关键字段：`input`（用户消息）、`output`（Agent 回复）、`metadata.elapsed_ms`（耗时）、`metadata.model`（模型）、`tags`（供应商+型号）。

### 查整个会话

```bash
/app/skills/trace-debugger/scripts/langfuse-query.sh session {session_id} auto
```

返回 `traces` 数组，按时间排列的所有对话轮次。

### 查执行细节（LLM 调用、工具调用）

```bash
/app/skills/trace-debugger/scripts/langfuse-query.sh observations {trace_id} auto
```

返回 observation 类型：
- `GENERATION: llm-call` — LLM 调用，含 thinking、tool_use、token 消耗
- `TOOL: tool:xxx` — 工具调用，含参数和结果
- `SPAN: agent_query` — 顶层 span

**重点关注**：thinking 字段（模型推理过程）、usage（token 消耗是否接近窗口限制）、工具 output 是否有 Error。

---

## 预览数据库补充排查

只有 Langfuse trace 无法解释问题、需要核对预览环境业务状态时，才查询预览数据库。配置位于：

```bash
/workspace/agent/config/tada-agent-preview-db.env
```

配置变量为 `TADA_AGENT_DB_USER`、`TADA_AGENT_DB_EXTERNAL_HOST`、`TADA_AGENT_DB_PORT`、`TADA_AGENT_DB_PASSWORD`，可选 `TADA_AGENT_DB_NAME`（未设置时与用户名相同）。

数据库排查必须遵守：

1. 只执行 `SELECT`、`EXPLAIN` 或只读事务，禁止写入、DDL、授权和锁表操作。
2. 查询必须限定用户、session、trace 或时间范围，并设置合理 `LIMIT`，禁止无条件扫描大表。
3. 禁止输出连接密码、完整手机号、token 等敏感字段；结论中只保留定位问题所需的脱敏证据。
4. 正式环境问题不得使用预览数据库推断结果，必须明确写出数据环境。

---

## 排查流程

### Step 1：读备注，明确方向

| 症状 | 排查方向 |
|------|----------|
| 没收到回复 / 回复不完整 | 查 `request_succeeded` 和 `output` |
| 回答质量差 / 答非所问 | 查完整会话上下文 + 该轮 thinking |
| 工具调用失败 | 查 observations 里工具的 output |
| 太慢 | 查 `elapsed_ms` 和 `ttft_ms` |

### Step 2：拉完整会话，理解上下文

用 session API 拉所有轮次，按时间排列，打印每轮的 input/output 摘要。

### Step 3：拉问题轮次的执行细节

用 observations API 拉所有步骤，重点看：
- 每次 LLM call 的 thinking（模型在想什么）
- 工具调用的 input/output（有没有报错）
- token 消耗（是否接近上限）

### Step 4：定位根因

| 根因类型 | 表现 | 判断方法 |
|----------|------|----------|
| **模型幻觉/误判** | 回复和用户意图不符 | 看 thinking 推理链的逻辑断裂点 |
| **context 丢失** | 模型"忘了"之前的内容 | input tokens 接近窗口限制（128K/200K），或 messages 组装丢消息 |
| **工具调用失败** | 工具报错但模型没处理 | TOOL observation 的 output 含 Error |
| **tool-use 续写 bug** | 工具调用后模型状态混乱 | 对比前后两次 LLM call 的 thinking |
| **Skill 问题** | Skill 指令误导模型 | 看 load_skill 的 output，对照 Skill 规则 |
| **延迟/超时** | 用户等太久 | 看 elapsed_ms、ttft_ms |

### Step 5：输出排查结论

```
## 排查结论

**用户反馈**：<一句话描述>
**根因**：<根因分类> — <具体原因>
**证据**：<trace 中的关键 thinking/output 片段>
**影响面**：仅本次 / 同类可复现 / 全局性
**建议修复**：<具体建议>
```

---

## 注意事项

1. **备注为空时**，根据 `本轮问题` 和 trace output 自行判断问题
2. **同一用户连续反馈**，注意 session_id 是否相同
3. **token > 100K 特别注意** — 长会话易出 context 丢失
4. **关注模型差异** — `claude-sonnet-4-6` vs `deepseek-v4-pro` 问题模式不同
5. **tada-artifact 问题**注意 write_file 和 deploy_page 执行链路
