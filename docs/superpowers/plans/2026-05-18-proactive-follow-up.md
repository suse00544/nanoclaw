# Proactive Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive follow-up capability to NanoClaw — Agent creates follow-up items in JSON files, a scanner periodically checks them, and triggers the Agent to proactively message users.

**Architecture:** A new `follow-up-scanner.ts` module scans `groups/{name}/follow-ups/*.json` files every hour. When a file's `next_check` is due, it creates a one-shot task via the existing scheduler infrastructure with the follow-up context as the prompt. The container agent gets new system prompt guidance teaching it to identify, propose, create, and manage follow-up items via read/write file operations.

**Tech Stack:** TypeScript, existing NanoClaw task-scheduler, JSON files on disk, container agent CLAUDE.md instructions.

---

### Task 1: Follow-Up Scanner Module

**Files:**
- Create: `src/follow-up-scanner.ts`
- Create: `src/follow-up-scanner.test.ts`

This module scans `groups/{name}/follow-ups/` for due items and creates one-shot tasks.

- [ ] **Step 1: Write the failing test for `scanFollowUps`**

```typescript
// src/follow-up-scanner.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanFollowUps } from './follow-up-scanner.js';

describe('scanFollowUps', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns due items when next_check is in the past', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    const item = {
      next_check: new Date(Date.now() - 60000).toISOString(),
      status: 'active',
      title: 'Test follow-up',
    };
    fs.writeFileSync(
      path.join(followUpsDir, 'test-item.json'),
      JSON.stringify(item),
    );

    const results = scanFollowUps(tempDir);

    expect(results).toHaveLength(1);
    expect(results[0].groupFolder).toBe('testgroup');
    expect(results[0].filename).toBe('test-item.json');
    expect(results[0].content.title).toBe('Test follow-up');
  });

  it('skips items with next_check in the future', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    const item = {
      next_check: new Date(Date.now() + 3600000).toISOString(),
      status: 'active',
      title: 'Future item',
    };
    fs.writeFileSync(
      path.join(followUpsDir, 'future.json'),
      JSON.stringify(item),
    );

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });

  it('skips items with status != active', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    const item = {
      next_check: new Date(Date.now() - 60000).toISOString(),
      status: 'completed',
      title: 'Done item',
    };
    fs.writeFileSync(
      path.join(followUpsDir, 'done.json'),
      JSON.stringify(item),
    );

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });

  it('handles missing follow-ups directory gracefully', () => {
    const groupDir = path.join(tempDir, 'emptygroup');
    fs.mkdirSync(groupDir, { recursive: true });

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    fs.writeFileSync(path.join(followUpsDir, 'bad.json'), 'not json{{{');

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/follow-up-scanner.test.ts`
Expected: FAIL — module `./follow-up-scanner.js` does not exist

- [ ] **Step 3: Implement `scanFollowUps`**

```typescript
// src/follow-up-scanner.ts
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface DueFollowUp {
  groupFolder: string;
  filename: string;
  filepath: string;
  content: Record<string, unknown>;
}

export function scanFollowUps(groupsDir: string): DueFollowUp[] {
  const due: DueFollowUp[] = [];
  const now = Date.now();

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(groupsDir).filter((f) => {
      try {
        return fs.statSync(path.join(groupsDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return due;
  }

  for (const groupFolder of groupFolders) {
    const followUpsDir = path.join(groupsDir, groupFolder, 'follow-ups');
    if (!fs.existsSync(followUpsDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(followUpsDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filepath = path.join(followUpsDir, file);
      try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        const content = JSON.parse(raw);

        if (content.status !== 'active') continue;
        if (!content.next_check) continue;

        const nextCheck = new Date(content.next_check).getTime();
        if (isNaN(nextCheck) || nextCheck > now) continue;

        due.push({ groupFolder, filename: file, filepath, content });
      } catch (err) {
        logger.warn({ file: filepath, err }, 'Skipping malformed follow-up file');
      }
    }
  }

  return due;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/follow-up-scanner.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/follow-up-scanner.ts src/follow-up-scanner.test.ts
git commit -m "feat: add follow-up scanner module"
```

---

### Task 2: Follow-Up Scheduler Loop

**Files:**
- Create: `src/follow-up-scheduler.ts`
- Modify: `src/index.ts` (add startup call)

This module runs a periodic loop (hourly) that calls `scanFollowUps` and creates one-shot tasks for each due item.

- [ ] **Step 1: Implement `startFollowUpLoop`**

```typescript
// src/follow-up-scheduler.ts
import { GROUPS_DIR } from './config.js';
import { createTask, getTaskById } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { scanFollowUps } from './follow-up-scanner.js';

const FOLLOW_UP_SCAN_INTERVAL = 3600000; // 1 hour

export interface FollowUpDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  onTasksChanged: () => void;
}

let loopRunning = false;

export function startFollowUpLoop(deps: FollowUpDeps): void {
  if (loopRunning) return;
  loopRunning = true;
  logger.info('Follow-up scanner loop started');

  const loop = () => {
    try {
      const dueItems = scanFollowUps(GROUPS_DIR);
      if (dueItems.length > 0) {
        logger.info({ count: dueItems.length }, 'Found due follow-up items');
      }

      const groups = deps.registeredGroups();

      for (const item of dueItems) {
        // Find the registered group and its chat JID
        const entry = Object.entries(groups).find(
          ([, g]) => g.folder === item.groupFolder,
        );
        if (!entry) {
          logger.warn(
            { groupFolder: item.groupFolder },
            'No registered group for follow-up item',
          );
          continue;
        }

        const [chatJid, group] = entry;

        // Build prompt with full follow-up context
        const prompt = buildFollowUpPrompt(item.filename, item.content);

        // Create a one-shot task
        const taskId = `followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Avoid duplicate: check if a task for this follow-up is already pending
        const existingId = `followup-${item.filename.replace('.json', '')}`;
        const existing = getTaskById(existingId);
        if (existing && existing.status === 'active') {
          continue;
        }

        createTask({
          id: taskId,
          group_folder: item.groupFolder,
          chat_jid: chatJid,
          prompt,
          schedule_type: 'once',
          schedule_value: new Date().toISOString(),
          context_mode: 'group',
          next_run: new Date().toISOString(),
          status: 'active',
          created_at: new Date().toISOString(),
        });

        logger.info(
          { taskId, groupFolder: item.groupFolder, file: item.filename },
          'Created follow-up task',
        );
        deps.onTasksChanged();
      }
    } catch (err) {
      logger.error({ err }, 'Error in follow-up scanner loop');
    }

    setTimeout(loop, FOLLOW_UP_SCAN_INTERVAL);
  };

  // Initial scan after 10s (let other systems initialize first)
  setTimeout(loop, 10000);
}

function buildFollowUpPrompt(
  filename: string,
  content: Record<string, unknown>,
): string {
  const json = JSON.stringify(content, null, 2);
  return `你有一个跟进项到期需要审视。

文件：follow-ups/${filename}
内容：
${json}

请判断：
1. 是否需要现在联系用户？如果需要，直接发送消息（用 send_progress_update）。消息应该自然、简洁、有行动指引。
2. 读取并更新这个文件：
   - 如果还需要继续跟进：更新 next_check 为下次检查时间
   - 如果事项已完成或过期：将 status 改为 "completed" 或 "expired"
   - 在 history 数组中追加本次审视记录

注意：你可以使用 web_search 等工具获取最新信息来辅助判断。`;
}

export function _resetFollowUpLoopForTests(): void {
  loopRunning = false;
}
```

- [ ] **Step 2: Wire into index.ts**

Add to `src/index.ts`, after the `startSchedulerLoop` call (around line 260-270 area where other loops start):

Find the line `startSchedulerLoop(schedulerDeps);` and add after it:

```typescript
import { startFollowUpLoop } from './follow-up-scheduler.js';
```

(add to imports at top)

And after `startSchedulerLoop(schedulerDeps);`:

```typescript
  startFollowUpLoop({
    registeredGroups: () => registeredGroups,
    onTasksChanged: () => {
      // Refresh tasks snapshot for containers
      const tasks = getAllTasks();
      for (const [jid, group] of Object.entries(registeredGroups)) {
        writeTasksSnapshot(
          group.folder,
          group.isMain === true,
          tasks.map((t) => ({
            id: t.id,
            groupFolder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
          })),
        );
      }
    },
  });
```

- [ ] **Step 3: Build to verify compilation**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/follow-up-scheduler.ts src/index.ts
git commit -m "feat: add follow-up scheduler loop"
```

---

### Task 3: Agent System Prompt — Follow-Up Behavior

**Files:**
- Create: `groups/feishu_main/.claude-fragments/proactive-follow-up.md` (or the equivalent instruction file)

Since the fragments are symlinks to container paths, we'll add instructions directly to the group's CLAUDE.local.md.

- [ ] **Step 1: Add follow-up instructions to CLAUDE.local.md**

Append to `groups/feishu_main/CLAUDE.local.md`:

```markdown
## 主动跟进能力

你具备"主动跟进"能力——能从对话中识别需要在未来某个时间点关注的事项，并在合适的时间点主动联系用户。

### 识别跟进项

当用户提到带有时间性的事项时（旅行计划、证件到期、定期检查、重要日期等），主动提议跟进：
- 用自然语言提议，不要机械地问"要不要设提醒"
- 必须等用户确认后才创建跟进项
- 示例："去日本的话签证要提前办，我可以帮你跟进这事——到时候提醒你准备材料，要不？"

### 创建跟进项

用户确认后，在 `/workspace/group/follow-ups/` 目录下创建 JSON 文件：

```json
{
  "next_check": "2026-06-01T09:00:00+08:00",
  "status": "active",
  "title": "日本旅行签证",
  "created_at": "2026-05-18T14:00:00+08:00",
  "context": {
    "事项描述": "...",
    "关键日期": "...",
    "备注": "..."
  },
  "history": [
    { "date": "2026-05-18", "action": "created", "note": "用户确认跟进" }
  ],
  "notify_count": 0
}
```

- 文件名用英文 kebab-case，描述事项（如 `japan-trip-visa.json`）
- `next_check`：你认为下次应该检查的时间（ISO 8601）
- `status`：必须是 `active`、`completed` 或 `expired`
- 其余字段自由定义，存储你需要的上下文

### 被唤醒审视

系统会定期检查你的 follow-ups 目录。当某个项的 next_check 到期，你会被唤醒并收到该项的完整内容。此时你应该：

1. **判断是否通知用户**：根据事项紧急程度、距关键日期的远近决定
2. **如果通知**：用 send_progress_update 发消息，内容要自然简洁有行动指引
3. **更新文件**：
   - 更新 next_check（你决定下次检查的时间）
   - 在 history 中记录本次行动
   - 如果事项已完成或过期，改 status

### 关闭跟进

两种方式：
- 用户说"办完了"/"不用跟了" → 你更新 status 为 completed
- 你从对话推断事项已完成 → 向用户确认后更新 status

### 查询跟进项

用户问"我有哪些事在跟进"时，读取 follow-ups/ 目录列出所有 active 项。

### 追踪策略（你自主决定）

- 普通事项：通知一次后，next_check 设为几天后
- 紧急事项（窗口期临近）：可以第二天再通知，加注紧急性
- 用户持续不回应：逐渐拉长间隔，不要打扰
- 事项过期且无意义：标记 expired
```

- [ ] **Step 2: Ensure follow-ups directory exists**

```bash
mkdir -p groups/feishu_main/follow-ups
```

- [ ] **Step 3: Commit**

```bash
git add groups/feishu_main/CLAUDE.local.md groups/feishu_main/follow-ups/.gitkeep
git commit -m "feat: add proactive follow-up agent instructions"
```

---

### Task 4: End-to-End Test with a Manual Follow-Up Item

**Files:**
- Create: `groups/feishu_main/follow-ups/test-reminder.json`

Create a test follow-up item that will trigger on next scan to verify the pipeline works.

- [ ] **Step 1: Create a test follow-up item due immediately**

```json
{
  "next_check": "2026-05-18T00:00:00+08:00",
  "status": "active",
  "title": "测试提醒 - 主动跟进功能验证",
  "created_at": "2026-05-18T15:00:00+08:00",
  "context": {
    "description": "这是一个测试跟进项，用于验证主动跟进功能是否正常工作",
    "expected_action": "Agent 应该发一条消息确认功能正常，然后将 status 改为 completed"
  },
  "history": [
    { "date": "2026-05-18", "action": "created", "note": "手动创建用于测试" }
  ],
  "notify_count": 0
}
```

- [ ] **Step 2: Build and run**

```bash
npm run build
npm run dev
```

Wait for the follow-up scanner to trigger (10 seconds after startup for first scan). Check logs for:
- "Found due follow-up items"
- "Created follow-up task"

Verify that the Agent gets triggered and sends a message to the chat.

- [ ] **Step 3: Verify and clean up**

After confirming it works, check that the Agent updated the test file (status should be `completed`). If the test item is still active, it means the Agent didn't process it — check container logs.

- [ ] **Step 4: Remove test file and commit**

```bash
rm groups/feishu_main/follow-ups/test-reminder.json
git add -A
git commit -m "test: verify follow-up end-to-end pipeline"
```

---

### Task 5: Ensure Container Mounts follow-ups Directory

**Files:**
- Modify: `src/container-runner.ts` (if needed — check if `groups/{name}/` is already mounted as `/workspace/group/`)

- [ ] **Step 1: Verify mount situation**

The container mounts `groups/{name}/` at `/workspace/group/`. Since `follow-ups/` lives inside `groups/{name}/follow-ups/`, it should already be accessible at `/workspace/group/follow-ups/` in the container. Verify by checking `buildVolumeMounts` in `container-runner.ts`.

If the group directory is mounted read-write (it should be for the agent to create/edit files), no changes needed.

- [ ] **Step 2: If mount is read-only, add write access for follow-ups**

Check if the group mount is already read-write. In NanoClaw, the group folder mount IS read-write by default (the agent writes conversations, artifacts, etc. there). No code change expected.

- [ ] **Step 3: Confirm by reading container-runner.ts mount logic**

The existing mount at line ~67 shows group dir is mounted writable. Confirm and skip this task if already correct.

- [ ] **Step 4: Commit (if any changes)**

```bash
git add src/container-runner.ts
git commit -m "fix: ensure follow-ups directory is writable in container"
```

(Skip if no changes needed)
