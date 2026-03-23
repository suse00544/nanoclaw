import path from 'path';
import { Channel, NewMessage } from './types.js';
import { GROUPS_DIR } from './config.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a host-side image path to the corresponding container path.
 * Host: {cwd}/groups/{folder}/images/xxx.png
 * Container mount: groups/{folder} -> /workspace/group
 * Container: /workspace/group/images/xxx.png
 */
function toContainerPath(hostPath: string, groupFolder: string): string {
  const hostGroupDir = path.join(GROUPS_DIR, groupFolder);
  const relPath = path.relative(hostGroupDir, hostPath);
  return path.posix.join('/workspace/group', relPath);
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  groupFolder?: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    let messageContent = escapeXml(m.content);

    // Add image attachments if present
    if (m.attachments && m.attachments.length > 0) {
      const imageAttachments = m.attachments
        .filter((att) => att.type === 'image')
        .map((att) => {
          const containerPath = groupFolder
            ? toContainerPath(att.path, groupFolder)
            : att.path;
          return `<image path="${escapeXml(containerPath)}" />`;
        })
        .join('');
      if (imageAttachments) {
        messageContent = `${messageContent}${imageAttachments}`;
      }
    }

    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${messageContent}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
