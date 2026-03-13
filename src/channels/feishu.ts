import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export interface FeishuChannelOpts extends ChannelOpts {}

/**
 * Feishu/Lark channel implementation using WebSocket long connection.
 * Supports both group chats and private chats.
 */
export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: any | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private connected = false;

  constructor(
    appId: string,
    appSecret: string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Initialize Lark client
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu, // Use Lark for international, Feishu for China
    });

    // Create event dispatcher for handling incoming events
    const eventDispatcher = new lark.EventDispatcher({});

    // Register message receive event handler
    eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        logger.info({ event: 'im.message.receive_v1', data }, 'Received Feishu message event');
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu message');
        }
      },
    });

    // Initialize WebSocket client for long connection
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    // Start WebSocket connection with event dispatcher
    await this.wsClient.start({ eventDispatcher });

    this.connected = true;
    logger.info('Feishu channel connected via WebSocket');
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      logger.info({ data }, 'handleMessage called with data');

      const message = data.message;
      const sender = data.sender;
      logger.info({ message, sender }, 'Extracted message and sender');

      // Extract chat info
      const chatId = message.chat_id;
      const chatType = message.chat_type; // 'p2p' or 'group'
      const messageId = message.message_id;
      const messageType = message.message_type; // 'text', 'image', 'file', etc.
      const timestamp = new Date(parseInt(message.create_time)).toISOString();
      logger.info({ chatId, chatType, messageId, messageType, timestamp }, 'Extracted chat info');

    // Build JID (Feishu format: fs:chat_id)
    const chatJid = `fs:${chatId}`;

    // Extract sender info
    const senderId = sender.sender_id.user_id || sender.sender_id.open_id;
    const senderName = sender.sender_id.user_id || 'Unknown';

    // Parse message content based on type
    let content = '';
    if (messageType === 'text') {
      try {
        const textContent = JSON.parse(message.content);
        content = textContent.text || '';
      } catch (err) {
        logger.error({ err, messageContent: message.content }, 'Failed to parse Feishu text message');
        content = message.content;
      }
    } else if (messageType === 'image') {
      content = '[图片]';
    } else if (messageType === 'file') {
      content = '[文件]';
    } else if (messageType === 'audio') {
      content = '[语音]';
    } else if (messageType === 'video') {
      content = '[视频]';
    } else {
      content = `[${messageType}]`;
    }

    // Get chat name
    let chatName = chatJid;
    try {
      if (chatType === 'p2p') {
        chatName = senderName;
      } else if (chatType === 'group' && this.client) {
        // Fetch group name
        const chatInfo = await this.client.im.chat.get({
          path: { chat_id: chatId },
        });
        chatName = chatInfo.data?.name || chatJid;
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to fetch Feishu chat name');
    }

    // Store chat metadata
    const isGroup = chatType === 'group';
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Check if this chat is registered
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered Feishu chat');
      return;
    }

    // Send OK emoji reaction to indicate message received and processing
    if (this.client) {
      try {
        await this.client.im.messageReaction.create({
          path: {
            message_id: messageId,
          },
          data: {
            reaction_type: {
              emoji_type: 'OK',
            },
          },
        });
        logger.debug({ messageId }, 'Sent OK reaction');
      } catch (err) {
        logger.warn({ err, messageId }, 'Failed to send OK reaction');
      }
    }

    // Deliver message to processing loop
    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, chatName, sender: senderName }, 'Feishu message stored');
    } catch (err) {
      logger.error({ err, data }, 'Error in handleMessage');
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    logger.info({ jid, text }, 'sendMessage called');

    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    // Extract chat_id from JID (format: fs:chat_id)
    const chatId = jid.replace(/^fs:/, '');
    logger.info({ chatId }, 'Sending to chat_id');

    try {
      // Convert Markdown to Feishu post format for rich text rendering
      const postContent = this.convertMarkdownToPost(text);

      const result = await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: postContent,
          }),
        },
      });

      logger.info({ chatId, textLength: text.length, result }, 'Feishu message sent successfully');
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send Feishu message');
      throw err;
    }
  }

  /**
   * Convert Markdown text to Feishu post format.
   * Supports basic Markdown: bold, italic, code, code blocks, links.
   */
  private convertMarkdownToPost(text: string): any {
    const lines = text.split('\n');
    const content: any[][] = [];
    let inCodeBlock = false;
    let codeBlockLines: string[] = [];

    for (const line of lines) {
      // Handle code blocks
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          // End of code block
          content.push([
            {
              tag: 'text',
              text: codeBlockLines.join('\n'),
              style: ['code_inline'],
            },
          ]);
          codeBlockLines = [];
          inCodeBlock = false;
        } else {
          // Start of code block
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockLines.push(line);
        continue;
      }

      // Parse inline Markdown in the line
      const lineElements = this.parseInlineMarkdown(line);
      if (lineElements.length > 0) {
        content.push(lineElements);
      }
    }

    return {
      title: '',
      content,
    };
  }

  /**
   * Parse inline Markdown (bold, italic, code, links) in a line.
   */
  private parseInlineMarkdown(line: string): any[] {
    const elements: any[] = [];
    let remaining = line;

    // Simple regex-based parsing
    // This is a basic implementation - can be enhanced for more complex cases
    const patterns = [
      { regex: /\*\*(.+?)\*\*/g, tag: 'text', style: ['bold'] },
      { regex: /__(.+?)__/g, tag: 'text', style: ['bold'] },
      { regex: /\*(.+?)\*/g, tag: 'text', style: ['italic'] },
      { regex: /_(.+?)_/g, tag: 'text', style: ['italic'] },
      { regex: /`(.+?)`/g, tag: 'text', style: ['code_inline'] },
      { regex: /\[(.+?)\]\((.+?)\)/g, tag: 'a', isLink: true },
    ];

    // For simplicity, we'll process the entire line as segments
    // A more robust solution would use a proper Markdown parser
    let processedLine = line;
    const segments: Array<{ text: string; style?: string[]; href?: string }> = [];

    // Replace bold
    processedLine = processedLine.replace(/\*\*(.+?)\*\*/g, (match, p1) => {
      segments.push({ text: p1, style: ['bold'] });
      return `__SEGMENT_${segments.length - 1}__`;
    });

    // Replace italic
    processedLine = processedLine.replace(/\*(.+?)\*/g, (match, p1) => {
      segments.push({ text: p1, style: ['italic'] });
      return `__SEGMENT_${segments.length - 1}__`;
    });

    // Replace code
    processedLine = processedLine.replace(/`(.+?)`/g, (match, p1) => {
      segments.push({ text: p1, style: ['code_inline'] });
      return `__SEGMENT_${segments.length - 1}__`;
    });

    // Replace links
    processedLine = processedLine.replace(/\[(.+?)\]\((.+?)\)/g, (match, text, href) => {
      segments.push({ text, href });
      return `__SEGMENT_${segments.length - 1}__`;
    });

    // Split by segment markers and reconstruct
    const parts = processedLine.split(/(__SEGMENT_\d+__)/);
    for (const part of parts) {
      const segmentMatch = part.match(/__SEGMENT_(\d+)__/);
      if (segmentMatch) {
        const segment = segments[parseInt(segmentMatch[1])];
        if (segment.href) {
          elements.push({
            tag: 'a',
            text: segment.text,
            href: segment.href,
          });
        } else {
          elements.push({
            tag: 'text',
            text: segment.text,
            style: segment.style,
          });
        }
      } else if (part) {
        elements.push({
          tag: 'text',
          text: part,
        });
      }
    }

    return elements.length > 0 ? elements : [{ tag: 'text', text: line }];
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client = null;

    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }

    logger.info('Feishu channel disconnected');
  }
}

// Channel factory with self-registration
registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
  ]);

  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    logger.debug('Feishu credentials not found, skipping Feishu channel');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
