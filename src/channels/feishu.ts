import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
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

interface StreamingCardState {
  cardId: string;
  messageId: string;
  sequence: number;
  lastUpdateAt: number;
}

const PROCESSING_EMOJI_TYPE = 'OneSecond';
const STREAMING_UPDATE_THROTTLE_MS = 200;
const DEDUP_WINDOW_MS = 60_000;
const DEDUP_MAX_SIZE = 500;

/**
 * Feishu/Lark channel using WebSocket long connection.
 * Supports group chats and private chats with streaming card output,
 * thread isolation, card interactions, message dedup, and bot menu.
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
  private streamingCards = new Map<string, StreamingCardState>();
  private processedMessageIds = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  // --- Message Deduplication ---

  private isDuplicate(messageId: string): boolean {
    if (this.processedMessageIds.has(messageId)) return true;
    this.processedMessageIds.set(messageId, Date.now());
    // Evict old entries
    if (this.processedMessageIds.size > DEDUP_MAX_SIZE) {
      const now = Date.now();
      for (const [id, ts] of this.processedMessageIds) {
        if (now - ts > DEDUP_WINDOW_MS) this.processedMessageIds.delete(id);
      }
    }
    return false;
  }

  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.processedMessageIds) {
        if (now - ts > DEDUP_WINDOW_MS) this.processedMessageIds.delete(id);
      }
    }, DEDUP_WINDOW_MS);
  }

  // --- WebSocket Connection ---

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
      'im.message.receive_v1': async (data: any) => {
        this.lastEventTime = Date.now();
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu message');
        }
      },
      'card.action.trigger': async (data: any) => {
        this.lastEventTime = Date.now();
        try {
          await this.handleCardAction(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu card action');
        }
      },
      'application.bot.menu_v6': async (data: any) => {
        this.lastEventTime = Date.now();
        try {
          await this.handleBotMenu(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu bot menu');
        }
      },
    } as any);
    return dispatcher;
  }

  private enqueuePendingReaction(
    chatJid: string,
    reaction: PendingReaction,
  ): void {
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
    } catch (err) {
      logger.warn(
        { err, chatJid, messageId: reaction.messageId },
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
    this.startDedupCleanup();
    logger.info('Feishu channel connected via WebSocket');

    // Reconnect if silent for 15 minutes
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
            await this.wsClient.start({
              eventDispatcher: this.buildEventDispatcher(),
            });
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

  // --- Card Interaction Handler ---

  private async handleCardAction(data: any): Promise<void> {
    const action = data?.action;
    const operator = data?.operator;
    const chatId =
      data?.context?.open_chat_id || data?.open_chat_id || data?.chat_id;
    if (!action || !chatId) return;

    const actionValue = action.value;
    if (!actionValue) return;

    // Card button clicks become text messages with the action value
    const text =
      typeof actionValue === 'string'
        ? actionValue
        : actionValue.text || actionValue.action || JSON.stringify(actionValue);

    const chatJid = `fs:${chatId}`;
    const senderId = operator?.open_id || 'card_action';
    const timestamp = new Date().toISOString();

    logger.info({ chatJid, action: text }, 'Card action received');

    this.opts.onMessage(chatJid, {
      id: `card_${Date.now()}`,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: operator?.open_id || 'User',
      sender_open_id: operator?.open_id || '',
      content: `@${ASSISTANT_NAME} ${text}`,
      timestamp,
      is_from_me: false,
    });
  }

  // --- Bot Menu Handler ---

  private async handleBotMenu(data: any): Promise<void> {
    const eventKey = data?.event_key;
    const operator = data?.operator;
    const chatId = data?.chat_id;
    if (!eventKey) return;

    const chatJid = chatId ? `fs:${chatId}` : undefined;
    if (!chatJid) return;

    const senderId = operator?.operator_id?.open_id || 'menu';
    const timestamp = new Date().toISOString();

    logger.info({ chatJid, eventKey }, 'Bot menu clicked');

    this.opts.onMessage(chatJid, {
      id: `menu_${Date.now()}`,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderId,
      sender_open_id: senderId,
      content: `@${ASSISTANT_NAME} /${eventKey}`,
      timestamp,
      is_from_me: false,
    });
  }

  // --- Message Handler ---

  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      const sender = data.sender;

      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageId = message.message_id;
      const messageType = message.message_type;
      const timestamp = new Date(parseInt(message.create_time)).toISOString();

      // Deduplication check
      if (this.isDuplicate(messageId)) {
        logger.debug({ messageId }, 'Skipping duplicate Feishu message');
        return;
      }

      logger.info(
        { chatId, chatType, messageId, messageType },
        'Feishu message received',
      );

      const chatJid = `fs:${chatId}`;
      const senderId = sender.sender_id.user_id || sender.sender_id.open_id;
      const senderOpenId = sender.sender_id.open_id || '';
      const senderName = sender.sender_id.user_id || 'Unknown';

      // Thread/topic isolation: use root_id or thread_id as conversation key
      const threadId = message.root_id || message.thread_id;
      const effectiveChatJid = threadId
        ? `fs:${chatId}:thread:${threadId}`
        : chatJid;

      // Fetch quoted message if this is a reply
      let quotedContext = '';
      let isReplyToBot = false;
      const parentId = message.parent_id || message.upper_message_id;
      if (parentId && this.client) {
        try {
          const parentMsg = await this.client.im.message.get({
            path: { message_id: parentId },
          });
          const parentItem = parentMsg.data?.items?.[0];
          if (parentItem?.sender?.sender_type === 'app') {
            isReplyToBot = true;
          }
          if (parentItem?.body?.content) {
            const parsed = JSON.parse(parentItem.body.content);
            let parentText = '';
            if (typeof parsed.text === 'string') {
              parentText = parsed.text;
            } else {
              const post = parsed.zh_cn || parsed.en_us || parsed;
              const paragraphs: any[][] = post.content || parsed.content || [];
              if (Array.isArray(paragraphs)) {
                parentText = paragraphs
                  .map((para: any[]) =>
                    Array.isArray(para)
                      ? para.map((el: any) => el.text || '').join('')
                      : '',
                  )
                  .join('\n')
                  .trim();
              }
            }
            if (parentText) {
              quotedContext = `[引用消息] ${parentText}\n\n`;
            }
          }
        } catch (err) {
          logger.warn({ err, parentId }, 'Failed to fetch quoted message');
        }
      }

      // Resolve @mentions
      const mentions: Array<{
        key: string;
        name: string;
        tenant_key?: string;
        id?: { user_id?: string };
      }> = message.mentions || [];

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
          for (const m of mentions) {
            if (!m.key) continue;
            const isBotMention = !m.tenant_key;
            const replaceName = isBotMention ? ASSISTANT_NAME : m.name;
            content = content.replace(m.key, `@${replaceName}`);
          }
        } catch (err) {
          logger.error(
            { err, messageContent: message.content },
            'Failed to parse Feishu text message',
          );
          content = message.content;
        }
      } else if (messageType === 'merge_forward') {
        content = this.parseMergeForward(message.content);
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
            const groupFolder =
              this.opts.registeredGroups()[effectiveChatJid]?.folder ||
              this.opts.registeredGroups()[chatJid]?.folder;

            if (groupFolder) {
              const groupPath = path.join(process.cwd(), 'groups', groupFolder);
              fs.mkdirSync(path.join(groupPath, 'images'), { recursive: true });
              const imagePath = path.join(
                groupPath,
                'images',
                `${messageId}_${imageKey}.png`,
              );
              await imageResp.writeFile(imagePath);
              attachments.push({
                type: 'image',
                path: imagePath,
                name: `${messageId}_${imageKey}.png`,
              });
              content = '[图片]';
            }
          }
        } catch (err) {
          logger.error({ err, messageId }, 'Failed to download image');
          content = '[图片]';
        }
      } else if (messageType === 'post') {
        try {
          const postContent = JSON.parse(message.content);
          const post = postContent.content
            ? postContent
            : postContent.zh_cn || postContent.en_us || postContent;
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
                      const imageResp =
                        await this.client.im.messageResource.get({
                          path: {
                            message_id: messageId,
                            file_key: element.image_key,
                          },
                          params: { type: 'image' },
                        });
                      const fs = await import('fs');
                      const path = await import('path');
                      const groupFolder =
                        this.opts.registeredGroups()[effectiveChatJid]
                          ?.folder ||
                        this.opts.registeredGroups()[chatJid]?.folder;
                      if (groupFolder) {
                        const groupPath = path.join(
                          process.cwd(),
                          'groups',
                          groupFolder,
                        );
                        fs.mkdirSync(path.join(groupPath, 'images'), {
                          recursive: true,
                        });
                        const imagePath = path.join(
                          groupPath,
                          'images',
                          `${messageId}_${element.image_key}.png`,
                        );
                        await imageResp.writeFile(imagePath);
                        attachments.push({
                          type: 'image',
                          path: imagePath,
                          name: `${messageId}_${element.image_key}.png`,
                        });
                      }
                    } catch (err) {
                      logger.error(
                        { err, messageId, imageKey: element.image_key },
                        'Failed to download post image',
                      );
                    }
                  }
                  break;
                case 'a':
                  if (element.text && element.href)
                    textParts.push(`[${element.text}](${element.href})`);
                  break;
                case 'at':
                  textParts.push(
                    element.user_name ? `@${element.user_name}` : '@user',
                  );
                  break;
              }
            }
            textParts.push('\n');
          }

          for (const att of attachments) {
            if (att.type === 'image')
              textParts.push(`\n<image path="${att.path}" />`);
          }

          content = textParts.join('').trim();
          if (!content) content = '[富文本消息]';
        } catch (err) {
          logger.error(
            { err, messageContent: message.content },
            'Failed to parse post message',
          );
          content = '[富文本消息]';
        }
      } else if (messageType === 'file') {
        try {
          const fileContent = JSON.parse(message.content);
          const fileKey = fileContent.file_key;
          const fileName = fileContent.file_name || 'unknown_file';

          if (fileKey && this.client) {
            const groupFolder =
              this.opts.registeredGroups()[effectiveChatJid]?.folder ||
              this.opts.registeredGroups()[chatJid]?.folder;
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

              attachments.push({
                type: 'file',
                path: filePath,
                name: fileName,
              });
              content = `[文件: ${fileName}]\n<file path="${filePath}" />`;

              const ext = path.extname(fileName).toLowerCase();
              if (['.zip', '.tar', '.gz', '.tgz', '.tar.gz'].includes(ext)) {
                const extractDir = path.join(
                  filesDir,
                  `${messageId}_extracted`,
                );
                fs.mkdirSync(extractDir, { recursive: true });
                try {
                  const { execSync } = await import('child_process');
                  if (ext === '.zip') {
                    execSync(`unzip -o "${filePath}" -d "${extractDir}"`);
                  } else {
                    execSync(`tar -xf "${filePath}" -C "${extractDir}"`);
                  }
                  content += `\n[已解压到: ${extractDir}]`;
                } catch (extractErr) {
                  logger.warn(
                    { err: extractErr },
                    'Failed to extract archive',
                  );
                }
              }
            }
          }

          if (!content) {
            content = `[文件: ${fileContent.file_name || 'unknown'}] (下载失败)`;
          }
        } catch (err) {
          logger.error({ err }, 'Failed to process file message');
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

      // Reply to bot counts as trigger
      if (isReplyToBot && !TRIGGER_PATTERN.test(content.trim())) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      let chatName = chatJid;
      try {
        if (chatType === 'p2p') {
          chatName = senderName;
        } else if (chatType === 'group' && this.client) {
          const chatInfo = await this.client.im.chat.get({
            path: { chat_id: chatId },
          });
          chatName = chatInfo.data?.name || chatJid;
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Failed to fetch Feishu chat name');
      }

      const isGroup = chatType === 'group';
      // Report metadata on the base chatJid (not thread-specific)
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

      // Auto-register: use base chatJid for group registration
      let group =
        this.opts.registeredGroups()[effectiveChatJid] ||
        this.opts.registeredGroups()[chatJid];
      if (!group) {
        const folder = `feishu_${chatId.slice(-8)}`;
        logger.info(
          { chatJid, chatName, folder },
          'Auto-registering new Feishu chat',
        );
        this.opts.registerGroup(chatJid, {
          name: chatName || chatJid,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: isGroup,
          isMain: false,
        });
        group = this.opts.registeredGroups()[chatJid];

        this.backfillHistory(chatId, chatJid).catch((err) =>
          logger.warn({ err, chatJid }, 'Failed to backfill history'),
        );
      }

      // Send processing reaction
      const willTrigger =
        !group?.requiresTrigger ||
        TRIGGER_PATTERN.test(content.trim()) ||
        isReplyToBot;
      if (this.client && willTrigger) {
        try {
          const reactionResp = await this.client.im.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: PROCESSING_EMOJI_TYPE } },
          });
          const reactionId = reactionResp.data?.reaction_id;
          if (reactionId) {
            this.enqueuePendingReaction(effectiveChatJid, {
              messageId,
              reactionId,
              emojiType: PROCESSING_EMOJI_TYPE,
            });
          }
        } catch (err) {
          logger.warn({ err, messageId }, 'Failed to send processing reaction');
        }
      }

      // Deliver message using effective JID (thread-specific if applicable)
      this.opts.onMessage(effectiveChatJid, {
        id: messageId,
        chat_jid: effectiveChatJid,
        sender: senderId,
        sender_name: senderName,
        sender_open_id: senderOpenId,
        content,
        timestamp,
        is_from_me: false,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    } catch (err) {
      logger.error({ err }, 'Error in handleMessage');
      throw err;
    }
  }

  // --- Merge Forward Parsing ---

  private parseMergeForward(rawContent: string): string {
    try {
      const parsed = JSON.parse(rawContent);
      // merge_forward messages have a "messages" array of forwarded messages
      const messages: any[] =
        parsed.messages || parsed.combine?.messages || [];
      if (messages.length === 0) return '[合并转发]';

      const parts: string[] = ['[合并转发消息]'];
      for (const msg of messages) {
        const senderName = msg.sender_name || msg.sender?.name || '未知';
        let text = '';
        if (msg.msg_type === 'text') {
          try {
            const body = JSON.parse(msg.content || '{}');
            text = body.text || '';
          } catch {
            text = msg.content || '';
          }
        } else if (msg.msg_type === 'post') {
          try {
            const body = JSON.parse(msg.content || '{}');
            const post = body.zh_cn || body.en_us || body;
            const paragraphs: any[][] = post?.content || [];
            text = paragraphs
              .map((para) =>
                Array.isArray(para)
                  ? para.map((el) => el.text || '').join('')
                  : '',
              )
              .join('\n')
              .trim();
          } catch {
            text = '[富文本]';
          }
        } else if (msg.msg_type === 'image') {
          text = '[图片]';
        } else {
          text = `[${msg.msg_type || '未知类型'}]`;
        }
        if (text) parts.push(`  ${senderName}: ${text}`);
      }
      return parts.join('\n');
    } catch (err) {
      logger.warn({ err }, 'Failed to parse merge_forward message');
      return '[合并转发]';
    }
  }

  // --- History Backfill ---

  private async backfillHistory(
    chatId: string,
    chatJid: string,
  ): Promise<void> {
    if (!this.client) return;

    const MAX_PAGES = 3;
    const PAGE_SIZE = 50;
    let pageToken: string | undefined;
    let totalStored = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await this.client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: 'ByCreateTimeAsc',
          page_size: PAGE_SIZE,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });

      const items = resp.data?.items || [];
      for (const item of items) {
        if (item.deleted || !item.body?.content) continue;
        if (item.sender?.sender_type === 'app') continue;

        let text = '';
        try {
          const parsed = JSON.parse(item.body.content);
          if (item.msg_type === 'text') {
            text = parsed.text || '';
            for (const m of item.mentions || []) {
              if (!m.key) continue;
              const isBotMention = !m.tenant_key;
              const replaceName = isBotMention ? ASSISTANT_NAME : m.name;
              text = text.replace(m.key, `@${replaceName}`);
            }
          } else if (item.msg_type === 'post') {
            const post = parsed.zh_cn || parsed.en_us || parsed;
            const paragraphs: any[][] = post?.content || parsed.content || [];
            if (Array.isArray(paragraphs)) {
              text = paragraphs
                .map((para: any[]) =>
                  Array.isArray(para)
                    ? para
                        .map((el: any) => {
                          if (el.tag === 'at')
                            return el.user_name ? `@${el.user_name}` : '';
                          return el.text || '';
                        })
                        .join('')
                    : '',
                )
                .join('\n')
                .trim();
            }
          } else {
            continue;
          }
        } catch {
          continue;
        }

        if (!text.trim()) continue;

        const senderId = item.sender?.id || 'unknown';
        const ts = new Date(parseInt(item.create_time || '0')).toISOString();

        this.opts.onMessage(chatJid, {
          id: item.message_id || `backfill_${Date.now()}_${totalStored}`,
          chat_jid: chatJid,
          sender: senderId,
          sender_name: senderId,
          content: text,
          timestamp: ts,
          is_from_me: false,
        });
        totalStored++;
      }

      if (!resp.data?.has_more) break;
      pageToken = resp.data?.page_token;
    }

    logger.info({ chatJid, totalStored }, 'Backfilled history for new chat');
  }

  // --- Streaming Card ---

  async startStreamingCard(jid: string): Promise<string | null> {
    if (!this.client) return null;
    const chatId = jid.replace(/^fs:/, '').replace(/:thread:.*$/, '');

    try {
      await this.clearPendingReaction(jid);

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            schema: '2.0',
            config: { wide_screen_mode: true, update_multi: true },
            body: {
              elements: [{ tag: 'markdown', content: '...' }],
            },
          }),
        },
      });

      const messageId = resp.data?.message_id;
      if (!messageId) return null;

      const cardId = `stream_${messageId}`;
      this.streamingCards.set(jid, {
        cardId,
        messageId,
        sequence: 0,
        lastUpdateAt: Date.now(),
      });

      return cardId;
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to create streaming card');
      return null;
    }
  }

  async updateStreamingCard(
    jid: string,
    cardId: string,
    text: string,
  ): Promise<void> {
    const state = this.streamingCards.get(jid);
    if (!state || !this.client) return;

    // Throttle updates
    const now = Date.now();
    if (now - state.lastUpdateAt < STREAMING_UPDATE_THROTTLE_MS) return;

    state.sequence++;
    state.lastUpdateAt = now;

    const processedText = this.normalizeFeishuMarkdown(text);

    try {
      await this.client.im.message.patch({
        path: { message_id: state.messageId },
        data: {
          content: JSON.stringify({
            schema: '2.0',
            config: { wide_screen_mode: true, update_multi: true },
            body: {
              elements: [
                { tag: 'markdown', content: processedText },
                {
                  tag: 'note',
                  elements: [
                    { tag: 'plain_text', content: '⏳ 生成中...' },
                  ],
                },
              ],
            },
          }),
        },
      });
    } catch (err) {
      logger.warn({ err, jid, seq: state.sequence }, 'Failed to update card');
    }
  }

  async finalizeStreamingCard(
    jid: string,
    cardId: string,
    text: string,
  ): Promise<void> {
    const state = this.streamingCards.get(jid);
    if (!state || !this.client) return;

    const processedText = this.normalizeFeishuMarkdown(text);

    try {
      await this.client.im.message.patch({
        path: { message_id: state.messageId },
        data: {
          content: JSON.stringify({
            schema: '2.0',
            config: { wide_screen_mode: true },
            body: {
              elements: [{ tag: 'markdown', content: processedText }],
            },
          }),
        },
      });
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to finalize streaming card');
      // Fallback: send as new message
      try {
        await this.sendPost(
          jid.replace(/^fs:/, '').replace(/:thread:.*$/, ''),
          processedText,
        );
      } catch {
        // give up
      }
    } finally {
      this.streamingCards.delete(jid);
    }
  }

  // --- Send Message ---

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    const chatId = jid.replace(/^fs:/, '').replace(/:thread:.*$/, '');

    try {
      await this.clearPendingReaction(jid);

      const processedText = this.normalizeFeishuMarkdown(text);

      if (this.shouldUseCard(processedText)) {
        try {
          await this.sendCard(chatId, processedText);
        } catch (cardErr) {
          logger.warn(
            { err: cardErr, chatId },
            'Card send failed, falling back to post',
          );
          await this.sendPost(chatId, processedText);
        }
      } else {
        await this.sendPost(chatId, processedText);
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send Feishu message');
      throw err;
    }
  }

  private shouldUseCard(text: string): boolean {
    return (
      /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)
    );
  }

  private async sendPost(chatId: string, text: string): Promise<void> {
    await this.client!.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: 'md', text }]] },
        }),
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
      if (splitIdx < maxSize / 2)
        splitIdx = remaining.lastIndexOf('\n', maxSize);
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
            return p.replace(
              /(?<!\[.*?)(?<!\()https?:\/\/[^\s)\]>]+/g,
              (url) => {
                const safeUrl = url
                  .replace(/_/g, '%5F')
                  .replace(/\(/g, '%28')
                  .replace(/\)/g, '%29');
                return `[${url}](${safeUrl})`;
              },
            );
          })
          .join('');
      })
      .join('');
  }

  // --- Send File ---

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    const fs = await import('fs');
    const path = await import('path');
    const chatId = jid.replace(/^fs:/, '').replace(/:thread:.*$/, '');

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

      let msgType: string;
      let messageContent: string;

      if (isImage) {
        const uploadResult = await this.client.im.image.create({
          data: { image_type: 'message', image: fileBuffer },
        });
        const imageKey =
          (uploadResult as any)?.data?.image_key || uploadResult?.image_key;
        if (!imageKey)
          throw new Error('Failed to upload image: no image_key returned');
        msgType = 'image';
        messageContent = JSON.stringify({ image_key: imageKey });
      } else {
        const uploadResult = await this.client.im.file.create({
          data: { file_type: 'stream', file_name: fileName, file: fileBuffer },
        });
        const fKey =
          (uploadResult as any)?.data?.file_key || uploadResult?.file_key;
        if (!fKey)
          throw new Error('Failed to upload file: no file_key returned');
        msgType = 'file';
        messageContent = JSON.stringify({ file_key: fKey });
      }

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content: messageContent,
        },
      });

      if (caption) {
        await this.sendMessage(jid, caption);
      }
    } catch (err) {
      logger.error({ err, filePath, chatId }, 'Failed to send file');
      throw err;
    }
  }

  // --- Channel Interface ---

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
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
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
