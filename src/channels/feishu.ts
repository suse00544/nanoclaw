import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export interface FeishuChannelOpts extends ChannelOpts {}

interface PendingReaction {
  messageId: string;
  reactionId: string;
  emojiType: string;
}

const PROCESSING_EMOJI_TYPE = 'OneSecond';

/**
 * Feishu/Lark channel using WebSocket long connection.
 * Supports group chats and private chats.
 */
export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: any | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private connected = false;
  private lastEventTime = Date.now();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private pendingReactions = new Map<string, PendingReaction[]>();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  private async closeWsClient(): Promise<void> {
    if (!this.wsClient) return;
    try {
      await this.wsClient.close();
    } catch (err) {
      logger.warn({ err }, 'Failed to close Feishu WebSocket client');
    } finally {
      this.wsClient = null;
    }
  }

  private buildEventDispatcher(): lark.EventDispatcher {
    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        this.lastEventTime = Date.now();
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu message');
        }
      },
    });
    return dispatcher;
  }

  private enqueuePendingReaction(chatJid: string, reaction: PendingReaction): void {
    const queue = this.pendingReactions.get(chatJid) || [];
    queue.push(reaction);
    this.pendingReactions.set(chatJid, queue);
  }

  private async clearPendingReaction(chatJid: string): Promise<void> {
    if (!this.client) return;

    const queue = this.pendingReactions.get(chatJid);
    const reaction = queue?.shift();
    if (!reaction) return;

    if (queue && queue.length > 0) {
      this.pendingReactions.set(chatJid, queue);
    } else {
      this.pendingReactions.delete(chatJid);
    }

    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: reaction.messageId,
          reaction_id: reaction.reactionId,
        },
      });
      logger.debug(
        { chatJid, messageId: reaction.messageId, reactionId: reaction.reactionId },
        'Cleared Feishu processing reaction',
      );
    } catch (err) {
      logger.warn(
        { err, chatJid, messageId: reaction.messageId, reactionId: reaction.reactionId },
        'Failed to clear Feishu processing reaction',
      );
    }
  }

  async connect(): Promise<void> {
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher: this.buildEventDispatcher() });

    this.connected = true;
    this.lastEventTime = Date.now();
    logger.info('Feishu channel connected via WebSocket');

    // Reconnect if silent for 15 minutes — WebSocket can silently drop
    this.healthCheckTimer = setInterval(
      async () => {
        const silentMs = Date.now() - this.lastEventTime;
        if (silentMs > 15 * 60 * 1000) {
          logger.warn(
            { silentMin: Math.round(silentMs / 60000) },
            'No Feishu events for 15min, reconnecting WebSocket',
          );
          try {
            await this.closeWsClient();
            this.wsClient = new lark.WSClient({
              appId: this.appId,
              appSecret: this.appSecret,
              loggerLevel: lark.LoggerLevel.warn,
            });
            await this.wsClient.start({ eventDispatcher: this.buildEventDispatcher() });
            this.lastEventTime = Date.now();
            logger.info('Feishu WebSocket reconnected successfully');
          } catch (err) {
            logger.error({ err }, 'Failed to reconnect Feishu WebSocket');
          }
        }
      },
      5 * 60 * 1000,
    );
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      const sender = data.sender;

      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageId = message.message_id;
      const messageType = message.message_type;
      const timestamp = new Date(parseInt(message.create_time)).toISOString();

      logger.info({ chatId, chatType, messageId, messageType }, 'Feishu message received');

      const chatJid = `fs:${chatId}`;
      const senderId = sender.sender_id.user_id || sender.sender_id.open_id;
      const senderName = sender.sender_id.user_id || 'Unknown';

      // Fetch quoted message if this is a reply
      let quotedContext = '';
      const parentId = message.parent_id || message.upper_message_id;
      if (parentId && this.client) {
        try {
          const parentMsg = await this.client.im.message.get({
            path: { message_id: parentId },
          });
          const parentItem = parentMsg.data?.items?.[0];
          if (parentItem?.body?.content) {
            const parsed = JSON.parse(parentItem.body.content);
            let parentText = '';
            if (typeof parsed.text === 'string') {
              parentText = parsed.text;
            } else {
              // post message: extract text from nested structure
              const post = parsed.zh_cn || parsed.en_us || parsed;
              const paragraphs: any[][] = post.content || parsed.content || [];
              if (Array.isArray(paragraphs)) {
                parentText = paragraphs
                  .map((para: any[]) =>
                    Array.isArray(para) ? para.map((el: any) => el.text || '').join('') : '',
                  )
                  .join('\n')
                  .trim();
              }
            }
            if (parentText) {
              quotedContext = `[引用消息] ${parentText}\n\n`;
              logger.info({ parentId, parentText: parentText.slice(0, 100) }, 'Fetched quoted message');
            }
          }
        } catch (err) {
          logger.warn({ err, parentId }, 'Failed to fetch quoted message');
        }
      }

      let content = '';
      const attachments: Array<{
        type: 'image' | 'file' | 'video' | 'audio';
        path: string;
        name?: string;
      }> = [];

      if (messageType === 'text') {
        try {
          const textContent = JSON.parse(message.content);
          content = textContent.text || '';
        } catch (err) {
          logger.error({ err, messageContent: message.content }, 'Failed to parse Feishu text message');
          content = message.content;
        }
      } else if (messageType === 'image') {
        try {
          const imageContent = JSON.parse(message.content);
          const imageKey = imageContent.image_key;

          if (imageKey && this.client) {
            const imageResp = await this.client.im.messageResource.get({
              path: { message_id: messageId, file_key: imageKey },
              params: { type: 'image' },
            });

            const fs = await import('fs');
            const path = await import('path');
            const groupFolder = this.opts.registeredGroups()[chatJid]?.folder;

            if (groupFolder) {
              const groupPath = path.join(process.cwd(), 'groups', groupFolder);
              fs.mkdirSync(path.join(groupPath, 'images'), { recursive: true });
              const imagePath = path.join(groupPath, 'images', `${messageId}_${imageKey}.png`);
              await imageResp.writeFile(imagePath);
              attachments.push({ type: 'image', path: imagePath, name: `${messageId}_${imageKey}.png` });
              content = '[图片]';
              logger.info({ messageId, imageKey, imagePath }, 'Image downloaded and saved');
            }
          }
        } catch (err) {
          logger.error({ err, messageId, messageContent: message.content }, 'Failed to download image');
          content = '[图片]';
        }
      } else if (messageType === 'post') {
        try {
          const postContent = JSON.parse(message.content);
          // post content may be nested under zh_cn/en_us or directly at root
          const post = postContent.content ? postContent : postContent.zh_cn || postContent.en_us || postContent;
          const textParts: string[] = [];

          if (post.title) textParts.push(post.title);

          for (const paragraph of post.content || []) {
            for (const element of paragraph) {
              switch (element.tag) {
                case 'text':
                  if (element.text) textParts.push(element.text);
                  break;
                case 'img':
                  if (element.image_key && this.client) {
                    try {
                      const imageResp = await this.client.im.messageResource.get({
                        path: { message_id: messageId, file_key: element.image_key },
                        params: { type: 'image' },
                      });
                      const fs = await import('fs');
                      const path = await import('path');
                      const groupFolder = this.opts.registeredGroups()[chatJid]?.folder;
                      if (groupFolder) {
                        const groupPath = path.join(process.cwd(), 'groups', groupFolder);
                        fs.mkdirSync(path.join(groupPath, 'images'), { recursive: true });
                        const imagePath = path.join(groupPath, 'images', `${messageId}_${element.image_key}.png`);
                        await imageResp.writeFile(imagePath);
                        attachments.push({ type: 'image', path: imagePath, name: `${messageId}_${element.image_key}.png` });
                        logger.info({ messageId, imageKey: element.image_key, imagePath }, 'Post image downloaded');
                      }
                    } catch (err) {
                      logger.error({ err, messageId, imageKey: element.image_key }, 'Failed to download post image');
                    }
                  }
                  break;
                case 'a':
                  if (element.text && element.href) textParts.push(`[${element.text}](${element.href})`);
                  break;
                case 'at':
                  textParts.push(element.user_name ? `@${element.user_name}` : '@user');
                  break;
              }
            }
            textParts.push('\n');
          }

          for (const att of attachments) {
            if (att.type === 'image') textParts.push(`\n<image path="${att.path}" />`);
          }

          content = textParts.join('').trim();
          if (!content) content = '[富文本消息]';
        } catch (err) {
          logger.error({ err, messageContent: message.content }, 'Failed to parse post message');
          content = '[富文本消息]';
        }
      } else if (messageType === 'file') {
        try {
          const fileContent = JSON.parse(message.content);
          const fileKey = fileContent.file_key;
          const fileName = fileContent.file_name || 'unknown_file';

          logger.info({ messageId, fileName, fileKey }, 'Processing file message');

          if (fileKey && this.client) {
            const groupFolder = this.opts.registeredGroups()[chatJid]?.folder;
            if (groupFolder) {
              const fs = await import('fs');
              const path = await import('path');
              const groupPath = path.join(process.cwd(), 'groups', groupFolder);
              const filesDir = path.join(groupPath, 'files');
              fs.mkdirSync(filesDir, { recursive: true });
              const filePath = path.join(filesDir, `${messageId}_${fileName}`);

              const fileResp = await this.client.im.messageResource.get({
                path: { message_id: messageId, file_key: fileKey },
                params: { type: 'file' },
              });
              await fileResp.writeFile(filePath);
              logger.info({ messageId, fileName, filePath }, 'File downloaded');

              attachments.push({ type: 'file', path: filePath, name: fileName });
              content = `[文件: ${fileName}]\n<file path="${filePath}" />`;

              const ext = path.extname(fileName).toLowerCase();
              if (['.zip', '.tar', '.gz', '.tgz', '.tar.gz'].includes(ext)) {
                const extractDir = path.join(filesDir, `${messageId}_extracted`);
                fs.mkdirSync(extractDir, { recursive: true });
                try {
                  const { execSync } = await import('child_process');
                  if (ext === '.zip') {
                    execSync(`unzip -o "${filePath}" -d "${extractDir}"`);
                  } else {
                    execSync(`tar -xf "${filePath}" -C "${extractDir}"`);
                  }
                  content += `\n[已解压到: ${extractDir}]`;
                  logger.info({ extractDir }, 'Archive extracted');
                } catch (extractErr) {
                  logger.warn({ err: extractErr }, 'Failed to extract archive, file still available');
                }
              }
            }
          }

          if (!content) {
            content = `[文件: ${fileContent.file_name || 'unknown'}] (下载失败)`;
          }
        } catch (err) {
          logger.error({ err, messageContent: message.content }, 'Failed to process file message');
          content = '[文件] (处理失败)';
        }
      } else if (messageType === 'audio') {
        content = '[语音]';
      } else if (messageType === 'video') {
        content = '[视频]';
      } else {
        content = `[${messageType}]`;
      }

      if (quotedContext) content = quotedContext + content;

      let chatName = chatJid;
      try {
        if (chatType === 'p2p') {
          chatName = senderName;
        } else if (chatType === 'group' && this.client) {
          const chatInfo = await this.client.im.chat.get({ path: { chat_id: chatId } });
          chatName = chatInfo.data?.name || chatJid;
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Failed to fetch Feishu chat name');
      }

      const isGroup = chatType === 'group';
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

      // Auto-register unregistered chats
      let group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        const folder = `feishu_${chatId.slice(-8)}`;
        logger.info({ chatJid, chatName, folder }, 'Auto-registering new Feishu chat');
        this.opts.registerGroup(chatJid, {
          name: chatName || chatJid,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
        });
        group = this.opts.registeredGroups()[chatJid];
      }

      // Send processing reaction
      if (this.client) {
        try {
          const reactionResp = await this.client.im.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: PROCESSING_EMOJI_TYPE } },
          });
          const reactionId = reactionResp.data?.reaction_id;
          if (reactionId) {
            this.enqueuePendingReaction(chatJid, { messageId, reactionId, emojiType: PROCESSING_EMOJI_TYPE });
          }
        } catch (err) {
          logger.warn({ err, messageId }, 'Failed to send Feishu processing reaction');
        }
      }

      this.opts.onMessage(chatJid, {
        id: messageId,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      logger.info({ chatJid, chatName, sender: senderName }, 'Feishu message stored');
    } catch (err) {
      logger.error({ err }, 'Error in handleMessage');
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    const chatId = jid.replace(/^fs:/, '');

    try {
      await this.clearPendingReaction(jid);

      const processedText = this.normalizeFeishuMarkdown(text);

      if (this.shouldUseCard(processedText)) {
        try {
          await this.sendCard(chatId, processedText);
        } catch (cardErr) {
          // Card failed (e.g. table exceeds limit), fall back to post
          logger.warn({ err: cardErr, chatId }, 'Card send failed, falling back to post');
          await this.sendPost(chatId, processedText);
        }
      } else {
        await this.sendPost(chatId, processedText);
      }

      logger.info({ chatId, textLength: text.length }, 'Feishu message sent successfully');
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send Feishu message');
      throw err;
    }
  }

  private shouldUseCard(text: string): boolean {
    return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
  }

  private async sendPost(chatId: string, text: string): Promise<void> {
    await this.client!.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } }),
      },
    });
  }

  private async sendCard(chatId: string, text: string): Promise<void> {
    const MAX_SIZE = 28000;
    if (text.length > MAX_SIZE) {
      const chunks = this.splitTextIntoChunks(text, MAX_SIZE);
      for (const chunk of chunks) {
        await this.sendSingleCard(chatId, chunk);
      }
    } else {
      await this.sendSingleCard(chatId, text);
    }
  }

  private async sendSingleCard(chatId: string, text: string): Promise<void> {
    await this.client!.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          config: { wide_screen_mode: true },
          body: { elements: [{ tag: 'markdown', content: text }] },
        }),
      },
    });
  }

  private splitTextIntoChunks(text: string, maxSize: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxSize) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf('\n\n', maxSize);
      if (splitIdx < maxSize / 2) splitIdx = remaining.lastIndexOf('\n', maxSize);
      if (splitIdx < maxSize / 2) splitIdx = maxSize;
      chunks.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }
    return chunks;
  }

  private normalizeFeishuMarkdown(text: string): string {
    const parts = text.split(/(```[\s\S]*?```)/);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) return part;
        const inlineParts = part.split(/(`[^`]+`)/);
        return inlineParts
          .map((p, j) => {
            if (j % 2 === 1) return p;
            return p.replace(/(?<!\[.*?)(?<!\()https?:\/\/[^\s)\]>]+/g, (url) => {
              const safeUrl = url.replace(/_/g, '%5F').replace(/\(/g, '%28').replace(/\)/g, '%29');
              return `[${url}](${safeUrl})`;
            });
          })
          .join('');
      })
      .join('');
  }

  /**
   * Send a file or image to a Feishu chat.
   */
  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    const fs = await import('fs');
    const path = await import('path');
    const chatId = jid.replace(/^fs:/, '');

    try {
      await this.clearPendingReaction(jid);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const fileExt = path.extname(filePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      const isImage = imageExts.includes(fileExt);

      logger.info({ filePath, fileName, isImage }, 'Uploading file to Feishu');

      let msgType: string;
      let messageContent: string;

      if (isImage) {
        const uploadResult = await this.client.im.image.create({
          data: { image_type: 'message', image: fileBuffer },
        });
        const imageKey = (uploadResult as any)?.data?.image_key || uploadResult?.image_key;
        if (!imageKey) throw new Error('Failed to upload image: no image_key returned');
        msgType = 'image';
        messageContent = JSON.stringify({ image_key: imageKey });
        logger.info({ imageKey, fileName }, 'Image uploaded successfully');
      } else {
        const uploadResult = await this.client.im.file.create({
          data: { file_type: 'stream', file_name: fileName, file: fileBuffer },
        });
        const fKey = (uploadResult as any)?.data?.file_key || uploadResult?.file_key;
        if (!fKey) throw new Error('Failed to upload file: no file_key returned');
        msgType = 'file';
        messageContent = JSON.stringify({ file_key: fKey });
        logger.info({ fileKey: fKey, fileName }, 'File uploaded successfully');
      }

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content: messageContent },
      });

      logger.info({ chatId, fileName, fileType: msgType }, 'File sent successfully');

      if (caption) {
        await this.sendMessage(jid, caption);
      }
    } catch (err) {
      logger.error({ err, filePath, chatId }, 'Failed to send file');
      throw err;
    }
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

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    await this.closeWsClient();
    logger.info('Feishu channel disconnected');
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    logger.debug('Feishu credentials not found, skipping Feishu channel');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
