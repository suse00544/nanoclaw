## NanoClaw 身份隔离覆盖规则

当运行环境中存在 `lark-cli-user` 时，说明当前是 NanoClaw 的用户隔离容器。必须先读取
[`../lark-cli-user/SKILL.md`](../lark-cli-user/SKILL.md)，并优先遵守其身份边界。

- 配置初始化使用 `lark-cli-user setup start|status`，禁止直接运行 `lark-cli config init`。
- 登录、授权和身份检查使用 `lark-cli-user auth ...` 和 `lark-cli-user whoami ...`。
- 业务命令可按本 Skill 使用 `lark-cli`；在飞书私聊中，它与 `lark-cli-user` 指向同一个当前发件人的持久化配置。
- 群聊和后台任务不挂载任何用户凭证，不得初始化、复用或寻找其他人的凭证。

本节仅覆盖下方的“配置初始化”和“认证”命令入口；业务域、最小权限、风险确认和 JSON 输出规则仍按照本官方 Skill 执行。
