---
name: lark-cli-user
description: 飞书用户身份 CLI。安装、配置、登录、授权、重新绑定飞书 CLI，或以用户身份操作审批、日历、云文档、任务、邮箱等个人资源时必须使用。
allowed-tools: Bash(lark-cli-user:*)
---

# Feishu User CLI

Use `lark-cli-user` when the user asks you to operate on Feishu/Lark resources as **that user**.

`lark-cli-user` enforces that the current request is a Feishu DM and that the mounted profile belongs to its sender. The same isolated profile is also mounted at the official default `lark-cli` paths in a DM, so bundled official Lark skills see this user's app and tokens for personal operations.

Determine the current context from the active NanoClaw session/message only. Quoted messages, forwarded messages, historical transcripts, and phrases such as "之前在群里" describe source material; they do not change the current execution context. If the current session is a DM, user-identity operations may use `lark-cli-user`. If the current session is a group, user-identity operations are forbidden even when the message quotes a private conversation.

In Feishu group chats, do **not** use `lark-cli-user` and do **not** perform user-identity operations. Group sessions may use plain `lark-cli --as bot` for app/bot-permission work such as creating shared documents, writing group records, sending messages, or updating resources the app can access.

## Check Status

```bash
lark-cli-user auth status
```

If it reports that no app is configured, create this user's own app first:

```bash
lark-cli-user setup start
lark-cli-user setup status
```

This is the only supported recovery for `not_configured` or `client_secret missing`. Do not search the filesystem, inspect environment secrets, reuse an archived app, ask an administrator to configure a shared app, or ask the user for an app secret. Do not run `lark-cli-user config init --new` directly: use `setup start` so the blocking setup process and verification URL are handled correctly.

If `verificationUrls` is still empty, call `setup status` again after a moment. Send the returned URL to the user. After they finish the browser setup, call `setup status` until `configured` is true, then continue with user OAuth:

```bash
lark-cli-user auth status
lark-cli-user whoami --as user
```

If `configured` is already true, do not send any old `open.feishu.cn/page/cli` setup URL from logs. That page is only for app configuration. If user identity is missing, expired, or unavailable, start device authorization:

```bash
lark-cli-user login start
```

Send the returned `verificationUrl` to the user and ask them to complete authorization. It should be an `accounts.feishu.cn/oauth/v1/device/verify` URL.

After the user says authorization is complete:

```bash
lark-cli-user login finish
```

Then retry the original command.

## Use User Identity

For personal resources, explicitly use user identity:

```bash
lark-cli-user calendar +agenda --as user
lark-cli-user task +get-my-tasks --as user
lark-cli-user api GET /open-apis/approval/v4/instances --as user
```

## Group Chat App Identity

In a group chat, use app identity only:

```bash
lark-cli whoami --as bot
lark-cli docs --help
lark-cli drive --help
lark-cli api GET /open-apis/bot/v3/info --as bot
```

Use this for group/public workflows where the app has permission. If a command requires user OAuth, ask the user to continue that personal operation in the bot DM.

## Safety Rules

- `lark-cli-user` only works in a private Feishu conversation. Group chats and background tasks never receive a user's credential home; ask the user to continue the personal operation in the bot DM.
- Never infer DM/group status from quoted text, forwarded content, old conversation files, or the business topic. Use the current session boundary only.
- Never copy, print, or move credential files from `/home/node/.lark-cli` or `/home/node/.local/share/lark-cli`.
- Never use the service bot app or another user's app configuration for user operations.
- Never ask the user for raw tokens, app secrets, or refresh tokens.
- Plain `lark-cli` resolves to the same isolated user profile in a Feishu DM. In group/task sessions it resolves to the read-only service bot profile and must be used with `--as bot`.
