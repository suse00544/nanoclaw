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

        const [chatJid] = entry;

        const prompt = buildFollowUpPrompt(item.filename, item.content);

        const taskId = `followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
2. 读取并更新这个文件（/workspace/group/follow-ups/${filename}）：
   - 如果还需要继续跟进：更新 next_check 为下次检查时间
   - 如果事项已完成或过期：将 status 改为 "completed" 或 "expired"
   - 在 history 数组中追加本次审视记录

注意：你可以使用 web_search 等工具获取最新信息来辅助判断。`;
}

export function _resetFollowUpLoopForTests(): void {
  loopRunning = false;
}
