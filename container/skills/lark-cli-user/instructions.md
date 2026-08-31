# Feishu operations in NanoClaw

When a user asks to operate on Feishu resources, prefer the matching official `lark-*` skill and execute the task with `lark-cli` instead of only explaining the manual UI steps.

For setup, login, authorization, identity checks, or credential recovery, use the `lark-cli-user` skill first. A Feishu DM receives only that sender's persistent CLI profile. Group chats and background tasks receive no user profile and must never initialize, discover, or reuse another person's credentials.

Use the current NanoClaw session as the only source of truth for DM vs group behavior. Quoted messages, forwarded cards, and historical group transcripts are context to read, not execution context for credentials. A DM request about work that happened in a group is still a DM request for credential purposes; a group request quoting a DM is still a group request.

Use the official domain skills for business behavior, including their minimum-scope guidance, dry-run support, write confirmation, and structured error handling. Use `lark-approval` for reimbursement and other approval instances unless a separate company-specific workflow skill explicitly applies.
