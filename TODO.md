# NanoClaw 待办清单

## 性能优化
- [ ] 接入 Claude Context Editing（clear_tool_uses），减少工具调用上下文膨胀
- [ ] 接入 Tool Search（按需加载工具定义），减少 token 消耗
- [ ] 接入 Thinking Block Clearing，清除旧思考过程

## 模型切换
- [ ] 将 MiniMax M2.5 模型切换做成 skill（代码在 skill/model-switching 分支）
- [ ] credential-proxy 修复 URL pathname 前缀丢失问题（已定位根因）

## 飞书增强
- [ ] sendFile 能力验证和修复（Beacon 反馈不好使）
- [ ] CLAUDE.md 改为每次容器启动时从 main group 同步（当前只在注册时复制一次）
- [x] 修复 "(no content)" 和重复消息问题（已在 CLAUDE.md 加规则：send_message 发过后 result 留空）

## 容器环境
- [ ] mcporter 和 uv 预装到 Dockerfile（当前每次容器启动要重装）

## 运维
- [x] 飞书 WebSocket 健康检查和自动重连（已实现：15 分钟无事件自动重连）
- [ ] 清理僵尸进程机制（防止 npm run dev 残留进程抢 WebSocket 连接）

## 调试
- [ ] 修复 agent-runner trace 日志（SDK 消息结构是 message 而不是 content，工具调用日志没打出来）
