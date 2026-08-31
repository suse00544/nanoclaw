---
name: trace-debugger
description: Tada AI 质量反馈排查。收到用户反馈后拉 Langfuse trace，还原上下文，定位根因，输出结论。当群内收到包含 trace_id 的反馈消息时自动触发。
---

# Tada AI 质量反馈排查

## 核心职责

本群接收 Tada 产品的用户反馈上报。收到反馈后：**拉 trace → 还原上下文 → 定位根因 → 输出结论**。

---

## Langfuse 凭证

凭证不写在 skill 文档里。默认从当前 agent group 的配置文件读取：

```bash
set -a
source /workspace/agent/config/langfuse.env
set +a
```

配置文件必须提供：

```bash
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

如果这些变量已经由运行环境提供，可以直接使用环境变量。认证方式：HTTP Basic Auth，username = `LANGFUSE_PUBLIC_KEY`，password = `LANGFUSE_SECRET_KEY`。

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

## Trace 查询 API

### 查单轮 trace

```bash
set -a
source /workspace/agent/config/langfuse.env
set +a

curl --noproxy '*' -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces/{trace_id}"
```

关键字段：`input`（用户消息）、`output`（Agent 回复）、`metadata.elapsed_ms`（耗时）、`metadata.model`（模型）、`tags`（供应商+型号）。

### 查整个会话

```bash
set -a
source /workspace/agent/config/langfuse.env
set +a

curl --noproxy '*' -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/sessions/{session_id}"
```

返回 `traces` 数组，按时间排列的所有对话轮次。

### 查执行细节（LLM 调用、工具调用）

```bash
set -a
source /workspace/agent/config/langfuse.env
set +a

curl --noproxy '*' -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/observations?traceId={trace_id}&limit=50"
```

返回 observation 类型：
- `GENERATION: llm-call` — LLM 调用，含 thinking、tool_use、token 消耗
- `TOOL: tool:xxx` — 工具调用，含参数和结果
- `SPAN: agent_query` — 顶层 span

**重点关注**：thinking 字段（模型推理过程）、usage（token 消耗是否接近窗口限制）、工具 output 是否有 Error。

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
