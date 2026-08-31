# Local Maintenance Inventory

Updated: 2026-08-11

This file records the current local delta after the NanoClaw v2 upgrade, the
Feishu adapter replacement, and the preservation of local data. Keep it current
before future upstream NanoClaw or Feishu adapter upgrades.

## Current State

- Runtime base: NanoClaw v2, currently aligned to upstream package version
  `2.1.54`.
- Channel strategy: use a local NanoClaw channel adapter backed by Feishu/Lark's
  official Node SDK, not the OpenClaw runtime.
- Local runtime data is preserved in `data/`, `data/v2.db`,
  `data/v2-sessions/`, `groups/`, `logs/`, and `backups/`.
- Online service deployment exists outside the source tree and should be treated
  as runtime infrastructure, not source code.
- The working tree is not a clean "upstream v2 plus patches" state yet. The v2
  migration produced many untracked v2 files while the current Git branch still
  carries the old history. Establishing a clean baseline is the next maintenance
  priority.

## Official v2 Baseline

Upstream NanoClaw v2 main ships the host/runtime architecture:

- Central DB at `data/v2.db`.
- Per-session split DBs under `data/v2-sessions/<session_id>/`.
- Agent group / messaging group / wiring / session entity model.
- Channel registry infrastructure, with `cli` as the only built-in channel.
- Channel/provider install skills under `.claude/skills`.
- Container runner, OneCLI gateway integration, approvals, scheduling, guard
  layer, and `ncl` admin CLI.

Upstream does not include the current Feishu adapter or the
`@larksuiteoapi/node-sdk` dependency.

## Local Source Delta To Keep

These are intentional local changes relative to upstream v2:

- `src/channels/feishu.ts`
  - Feishu/Lark WebSocket adapter using `@larksuiteoapi/node-sdk`.
  - Registers channel type `fs`, instance `fs`.
  - Uses official SDK WebSocket events and official IM APIs for delivery.
  - Resolves bot identity from Feishu bot info.
  - Supports group/thread routing through NanoClaw's channel adapter contract.
  - Keeps quoted messages as context, but does not treat quote-only replies as
    mentions.
  - In DMs, messages engage by default.
  - In groups, replies are only generated when the bot is actually mentioned.
  - Non-mentioned group messages can still be ingested into context according to
    wiring policy.
  - Typing reaction is tied to agent engagement, so non-mentioned context-only
    messages should not get a reaction.
  - Text delivery uses Feishu `post` messages so Markdown-like content, tables,
    and code blocks render better than plain text.
  - Supports interactive card delivery and card action/menu callbacks.
  - Supports file upload delivery.

- `src/channels/index.ts`
  - Adds `import './feishu.js';` so the adapter self-registers at host startup.

- `package.json` and `pnpm-lock.yaml`
  - Add `@larksuiteoapi/node-sdk@1.68.0`.
  - No OpenClaw runtime dependency remains.

- `src/container-runner.ts`
  - Adds local OneCLI model-secret auto-grant logic for the model API host from
    `ANTHROPIC_BASE_URL`.
  - This fixes the practical case where OneCLI has the credential but a freshly
    created NanoClaw agent has not been granted access to that secret.
  - The grant is best-effort and memoized per process.

## Removed Or Rejected Local Delta

- Removed the previously vendored `vendor/openclaw-lark` bundle.
- Removed OpenClaw runtime/package usage from active source dependencies.
- `openclaw` references that remain under `.claude/skills/migrate-from-openclaw`
  are upstream NanoClaw migration tooling, not runtime dependencies.

## Local Runtime Data To Preserve

Current `data/v2.db` inventory:

- `agent_groups`: 37
- `messaging_groups`: 35
- `messaging_group_agents`: 37
- `sessions`: 5

All listed agent groups currently use model `MiniMax-M3` and `cli_scope=group`.

Important preserved folders:

- `data/v2.db`: central configuration and entity state.
- `data/v2-sessions/`: active v2 session DBs.
- `groups/feishu_main`: main Feishu assistant memory, skills, workspace, and
  local tool state.
- `groups/feishu_*`: per-agent-group memories, files, skills, and workspaces.
- `logs/`: operational history for debugging.
- `backups/`: migration and recovery material.

Do not delete these during source cleanup or when rebasing onto upstream.

## Local Agent Groups

The current DB contains the main Feishu assistant, many migrated Feishu chat
groups, several topic/test groups, and todo-specific agent groups:

- Main assistant: `feishu_main` / `飞书助手`.
- CLI assistant: `cli-main` / `Beacon`.
- Migrated Feishu groups include `trace`, `太古城美食内推`,
  `OBD敏捷讨论`, `Tada Artifacts 每日赛`, `Cron任务监控`,
  `【tada】Bug及体验问题反馈群`, `Thread测试`, `tada-trace`, and
  multiple hashed-name groups.
- Todo/project-specific groups include `主动跟进 1.0`,
  `Landing 信息与运营`, `Agent 安全设定`, `内容筛选库建设`,
  `旅行场景 Showcase`, `ASR 效果优化`, `小红书抖音链接识别`,
  `地图组件联动`, and `World 设计`.

## Local Skills And Capabilities

Global container skills in `container/skills`:

- `agent-browser`: browser automation.
- `frontend-engineer`: frontend implementation and visual verification workflow.
- `lark-*`: the 27 official Lark CLI skills pinned to the same
  `@larksuite/cli` version as `container/cli-tools.json`. Source provenance is
  recorded in `container/lark-cli-skills.json`; refresh them with
  `pnpm exec tsx scripts/sync-lark-cli-skills.ts` after bumping the CLI.
- `lark-cli-user`: NanoClaw's per-Feishu-user setup, authorization, and
  credential-isolation layer. Its rules override only the setup/auth entry
  points in the official `lark-shared` skill.
- `onecli-gateway`: credentialed API access through OneCLI.
- `self-customize`: controlled self-modification through NanoClaw.
- `trace-debugger`: trace and quality-debugging workflow.
- `welcome`: onboarding behavior.

Project install/customization skills in `.agents/skills`:

- Channel skills: Discord, Slack, Telegram, Telegram swarm, WhatsApp, Gmail.
- Capability skills: compacting, image vision, PDF reader, reactions,
  voice transcription, Ollama tool, local Whisper, Apple container conversion,
  Qodo helpers, X integration.
- Operational skills: setup, debug, customize, update NanoClaw, update skills,
  claw helper.

Group-local skills under `groups/*/skills`:

- Main Feishu group currently has no active group-local skills. The previous
  batch (`agent-reach`, `cloudflare-deploy`, `find-skills`,
  `flight-selection`, `frontend-design`, `itinerary-planning`,
  `media-crawler-pro`, `moving-planner`, `nano-banana-pro`,
  `renovation-guard`, `rent`, `resume-diagnosis`, `seedream5`,
  `skill-creator`, `skill-optimizer`, `snust-course-reminder`,
  `study-abroad-advisor`, `tada-artifact-design-soft`,
  `travel-planning-methodology`, `wedding-planner`, and `xiaohongshu-cli`) was
  moved to `archive/disabled-feishu-main-skills-2026-08-11/`.
- Other migrated Feishu groups include travel-planning, skill creation,
  frontend/design, fairmeet, canvas design, tool evaluation, and
  restoration-bug skills.

Potential cleanup candidates inside `groups/`:

- `_uv-cache/`
- extracted attachment folders under `groups/*/files/*_extracted/`
- `__pycache__/`

These are runtime/cache artifacts. Clean them only after confirming no active
agent workflow depends on their local files.

## Capability Review

Use this section as the working review list. Status values:

- Keep: useful capability, should survive online migration.
- Keep, but harden: useful, but needs secret/config isolation or v2 cleanup.
- Archive: not part of the target platform; keep a copy outside active runtime.
- Delete candidate: safe to remove after confirming it is unused.

| Capability | Location | Status | Notes |
| --- | --- | --- | --- |
| Feishu adapter | `src/channels/feishu.ts` | Keep, but harden | Core local feature. Keep isolated as one adapter module plus one registration import. Add focused tests around mention/thread/card behavior before future upgrades. |
| OneCLI model secret auto-grant | `src/container-runner.ts` | Keep, but revisit | Solves current model credential access issue. Revisit when OneCLI supports this cleanly through agent secret mode or policy config. |
| Agent browser | `container/skills/agent-browser` | Keep | General-purpose browser automation. Useful both local and online. |
| Frontend engineer | `container/skills/frontend-engineer` | Keep | General frontend workflow discipline. No local secret dependency. |
| Official Lark CLI skills | `container/skills/lark-*` | Keep, track upstream | Business operations such as approval, reimbursement, docs, drive, calendar, tasks, IM, Base, and Sheets. Keep their source tag aligned with the pinned CLI using `scripts/sync-lark-cli-skills.ts`. |
| Lark per-user identity skill | `container/skills/lark-cli-user` | Keep, but harden | NanoClaw-specific credential boundary layered over official skills. Private Feishu sessions mount only the current sender's persistent CLI profile; groups and background tasks mount none. |
| OneCLI gateway skill | `container/skills/onecli-gateway` | Keep | Core credential-access instruction layer. Keep aligned with OneCLI SDK behavior. |
| Self customize | `container/skills/self-customize` | Keep, but harden | Useful for agent extensibility, but keep approval and diff-size boundaries strict. |
| Welcome | `container/skills/welcome` | Keep | Low-risk onboarding behavior. |
| Trace debugger | `container/skills/trace-debugger` | Keep, but harden | Useful for Tada AI feedback triage. Move Langfuse credentials out of the skill text into OneCLI/env before any commit or online migration. |
| Previous main Feishu group-local skills | `archive/disabled-feishu-main-skills-2026-08-11/` | Archive | Removed from `groups/feishu_main/skills` so they are no longer active. This includes agent reach, Cloudflare deploy, travel/design/domain/image/social-media skills, skill creator/optimizer, and SNUsT reminder. Review individually before restoring any of them. |
| Manus resume optimizer | `groups/feishu_main/manus-resume-optimizer` | Archive or move | It is outside the normal `skills/` directory. Move under `skills/` if active, otherwise archive. |
| Group-specific travel/design/eval skills | `groups/feishu_cc072154/skills`, `groups/feishu_cb0551e0/skills`, `groups/feishu_94f883de/skills` | Keep scoped | These look like per-group memory/capability assets. Do not promote globally unless reused. |
| Tada restoration bugs | `groups/feishu_2e943140/.claude/skills/tada-restoration-bugs` | Keep scoped or archive | It is in a group-local `.claude/skills` path rather than `skills/`; normalize if still active. |
| Legacy channel install skills | `.agents/skills/add-discord`, `add-slack`, `add-telegram`, `add-whatsapp`, etc. | Archive | These are mostly v1/old-branch install recipes. Official v2 uses `.claude/skills` channel/provider install flow. |
| Legacy WhatsApp add-ons | `.agents/skills/add-image-vision`, `add-pdf-reader`, `add-reactions`, `add-voice-transcription`, `use-local-whisper` | Archive | Mostly tied to old WhatsApp implementation. Keep only as reference if WhatsApp returns. |
| Legacy X integration | `.agents/skills/x-integration` | Delete candidate | Marked v1-compatible. Do not keep active in v2 unless rewritten. |
| Qodo helper skills | `.agents/skills/get-qodo-rules`, `qodo-pr-resolver` | Archive or migrate | Useful only if Qodo is part of the current dev workflow. Prefer a standalone dev skill outside NanoClaw runtime. |
| Apple Container conversion | `.agents/skills/convert-to-apple-container` | Archive | Keep as reference, not active runtime capability unless moving away from Docker. |
| Ollama tool / local Whisper / parallel research | `.agents/skills/add-ollama-tool`, `add-parallel`, `use-local-whisper` | Archive until revalidated | Reinstall through v2 container config or current MCP flow if needed. |

## Immediate Cleanup Recommendations

1. Move all plaintext service credentials out of skill markdown and into OneCLI
   or host-managed environment files before any commit, push, or online
   migration.
2. Keep `src/channels/feishu.ts` as the only Feishu-specific source module.
   Avoid scattering Feishu behavior into router/session core.
3. Treat `.agents/skills` as historical unless a skill is revalidated against
   v2. Do not run old merge-based instructions directly on this v2 tree.
4. Normalize active group-local skills into `groups/<folder>/skills/<name>/`.
   Archive skills that live in ad-hoc paths.
5. Exclude `_uv-cache`, virtualenvs, extracted attachments, and `__pycache__`
   from any source migration. They are runtime/cache data, not source.

## Local Services

The previous local expense reimbursement MCP service has been removed. Expense
approval workflows should use the Feishu CLI/user-auth path instead of the old
`expense` mcporter server.

## Repo Hygiene Problems

The repository currently has a large dirty working tree because the v2 migration
overlaid many upstream v2 files onto an older branch. This makes
`git diff upstream/main` noisy and unreliable.

Before future upgrades:

1. Create a backup of `data/`, `groups/`, `.env`, `logs/`, `backups/`, and
   `services/`.
2. Establish a clean source baseline from upstream v2 in a new branch or fresh
   clone.
3. Re-apply only the local source delta listed above.
4. Restore local runtime data separately.
5. Run `pnpm run build`, `pnpm test`, and restart the service.

## Future Upgrade Strategy

Keep the local patch surface small:

- Prefer upstream NanoClaw for core runtime, DB schema, CLI, scheduling,
  approvals, and container lifecycle.
- Keep Feishu as one isolated adapter module plus one registration import.
- Avoid modifying NanoClaw core for Feishu-specific behavior unless the adapter
  contract cannot express it.
- Keep trace debugging as a skill/service, not core runtime changes.
- Keep model/credential behavior in OneCLI configuration where possible; keep
  the current auto-grant patch only if OneCLI cannot handle this reliably.

For moving from local to online:

- Migrate source code separately from runtime data.
- Move `data/v2.db` and `data/v2-sessions/` only after stopping the local host.
- Move `groups/` as the durable memory/skill/workspace state.
- Recreate `.env` and OneCLI credentials on the online host instead of copying
  raw secrets through chat or docs.
- Rebuild the agent container on the target host.
- Verify Feishu WebSocket connection, bot identity, mention behavior, and a real
  group-thread reply before switching traffic permanently.
