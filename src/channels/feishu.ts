import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { resolveQuestionRender, type QuestionRender } from './question-render-registry.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  ConversationInfo,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const DEDUP_WINDOW_MS = 60_000;
const DEDUP_MAX_SIZE = 500;
const PROCESSING_EMOJI_TYPE = 'Typing';

const FEISHU_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

type FeishuChatType = 'p2p' | 'group' | 'topic_group';

type FeishuMention = {
  key: string;
  name: string;
  tenant_key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
};

type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    upper_message_id?: string;
    create_time?: string;
    chat_id: string;
    chat_type: FeishuChatType;
    message_type: string;
    content: string;
    mentions?: FeishuMention[];
  };
};

type ParsedFeishuMessage = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  chatType: FeishuChatType;
  content: string;
  rawContent: string;
  contentType: string;
  mentions: Array<{ key: string; openId: string; name: string; isBot: boolean }>;
  mentionAll: boolean;
  rootId?: string;
  parentId?: string;
  threadId?: string;
};

type FeishuSdkClient = {
  request(params: unknown): Promise<unknown>;
  im: {
    chat: {
      get(params: { path: { chat_id: string } }): Promise<{
        data?: {
          name?: string;
          chat_mode?: string;
          group_message_type?: string;
        };
      }>;
    };
    image: {
      create(params: {
        data: { image_type: string; image: Buffer };
      }): Promise<{ image_key?: string; data?: { image_key?: string } }>;
    };
    file: {
      create(params: {
        data: { file_type: string; file_name: string; file: Buffer };
      }): Promise<{ file_key?: string; data?: { file_key?: string } }>;
    };
    message: {
      get(params: { path: { message_id: string } }): Promise<{
        data?: {
          items?: Array<{
            sender?: { sender_type?: string };
            msg_type?: string;
            body?: { content?: string };
          }>;
        };
      }>;
      create(params: {
        params: { receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' };
        data: { receive_id: string; msg_type: string; content: string };
      }): Promise<unknown>;
      reply(params: {
        path: { message_id: string };
        data: { msg_type: string; content: string; reply_in_thread?: boolean };
      }): Promise<unknown>;
    };
    messageResource: {
      get(params: { path: { message_id: string; file_key: string }; params: { type: string } }): Promise<{
        getReadableStream(): NodeJS.ReadableStream;
        headers: Record<string, unknown>;
      }>;
    };
    messageReaction: {
      create(params: { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }): Promise<{
        data?: { reaction_id?: string };
      }>;
      delete(params: { path: { message_id: string; reaction_id: string } }): Promise<unknown>;
    };
  };
};

type TypingReaction = {
  messageId: string;
  reactionId: string;
};

type FeishuChatInfo = {
  name?: string;
  chatMode?: string;
  groupMessageType?: string;
  fetchedAt: number;
};

type FeishuAttachment = {
  type: string;
  name: string;
  mimeType?: string;
  size?: number;
  data: string;
  feishu: {
    messageId: string;
    fileKey: string;
    resourceType: string;
  };
};

type FeishuInboundReplayResult = {
  platformId: string;
  threadId: string | null;
  isGroup: boolean;
  parsed: ParsedFeishuMessage;
  message: InboundMessage;
};

type FeishuInboundReplayOptions = {
  threadSession?: boolean;
  chatInfo?: Pick<FeishuChatInfo, 'chatMode' | 'groupMessageType'> | null;
  quotedText?: string;
  botOpenId?: string;
  botName?: string;
};

function createFeishuAdapter(): ChannelAdapter | null {
  const env = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_THREAD_SESSION',
    'FEISHU_DOMAIN',
    'FEISHU_ENCRYPT_KEY',
    'FEISHU_VERIFICATION_TOKEN',
  ]);
  const appId = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;
  const threadSession = (process.env.FEISHU_THREAD_SESSION || env.FEISHU_THREAD_SESSION) !== 'false';
  const domain = process.env.FEISHU_DOMAIN || env.FEISHU_DOMAIN || 'feishu';
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY || env.FEISHU_ENCRYPT_KEY;
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN || env.FEISHU_VERIFICATION_TOKEN;

  if (!appId || !appSecret) return null;

  let connected = false;
  let setupRef: ChannelSetup | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;
  let botOpenId: string | undefined;
  let botName: string | undefined;
  const processed = new Map<string, number>();
  const typingByThread = new Map<string, TypingReaction>();
  const groupChats = new Map<string, boolean>();
  const topicChats = new Map<string, boolean>();
  const chatInfoCache = new Map<string, FeishuChatInfo>();

  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'fs',
    instance: 'fs',
    supportsThreads: threadSession,
    defaults: FEISHU_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      setupRef = config;
      client = new lark.Client({
        appId,
        appSecret,
        appType: lark.AppType.SelfBuild,
        domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      });
      const identity = await resolveBotIdentity(client);
      botOpenId = identity.botOpenId;
      botName = identity.botName;
      wsClient = new lark.WSClient({
        appId,
        appSecret,
        domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.warn,
      });
      patchCardEventForWsClient(wsClient);
      await wsClient.start({ eventDispatcher: buildDispatcher() });

      connected = true;
      startCleanup();
      log.info('Feishu channel connected via Lark official SDK WebSocket adapter', {
        botOpenId: botOpenId ?? null,
        botName: botName ?? null,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      setupRef = null;
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      try {
        wsClient?.close();
      } catch (err) {
        log.warn('Failed to close Feishu adapter client', { err });
      }
      wsClient = null;
      client = null;
      log.info('Feishu channel disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!client) return undefined;
      const text = extractOutboundText(message);
      const card = extractOutboundCard(message);
      const askQuestionCard = extractAskQuestionCard(message);
      if (text === null && !card && !askQuestionCard) return undefined;

      const chatId = stripFeishuPrefix(platformId);
      const replyToMessageId = threadSession
        ? resolveFeishuReplyMessageId(threadId, message.inReplyTo, topicChats.get(platformId) === true)
        : undefined;
      const reactionKey = typingKey(platformId, threadId);
      await clearTypingReaction(reactionKey);

      const result =
        card || askQuestionCard
          ? await sendFeishuMessage(
              client as unknown as FeishuSdkClient,
              chatId,
              'interactive',
              JSON.stringify(card ?? askQuestionCard),
              replyToMessageId,
            )
          : await sendFeishuMessage(
              client as unknown as FeishuSdkClient,
              chatId,
              'post',
              buildPostContent(text ?? ''),
              replyToMessageId,
            );

      await sendFiles(client as unknown as FeishuSdkClient, chatId, message, replyToMessageId);
      return result;
    },

    async setTyping(platformId: string, threadId: string | null): Promise<void> {
      if (!client || !threadId) return;
      if (topicChats.get(platformId) !== true) return;
      const key = typingKey(platformId, threadId);
      if (typingByThread.has(key)) return;
      try {
        const response = await client.im.messageReaction.create({
          path: { message_id: normalizeMessageId(threadId) },
          data: { reaction_type: { emoji_type: PROCESSING_EMOJI_TYPE } },
        });
        const reactionId = response.data?.reaction_id;
        if (reactionId) typingByThread.set(key, { messageId: normalizeMessageId(threadId), reactionId });
      } catch (err) {
        log.debug('Failed to add Feishu typing reaction', { platformId, threadId, err });
      }
    },

    async clearTyping(platformId: string, threadId: string | null): Promise<void> {
      await clearTypingReaction(typingKey(platformId, threadId));
    },

    async syncConversations(): Promise<ConversationInfo[]> {
      return [];
    },

    async resolveChannelName(platformId: string): Promise<string | null> {
      if (!client) return null;
      const chatId = stripFeishuPrefix(platformId);
      try {
        const response = await client.im.chat.get({ path: { chat_id: chatId } });
        return response.data?.name ?? null;
      } catch {
        return null;
      }
    },

    async openDM(userHandle: string): Promise<string> {
      return userHandle.startsWith('ou_') ? userHandle : stripFeishuPrefix(userHandle);
    },
  };

  function buildDispatcher(): lark.EventDispatcher {
    const dispatcher = new lark.EventDispatcher({
      encryptKey: encryptKey ?? '',
      verificationToken: verificationToken ?? '',
    });
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await handleMessage(data);
        } catch (err) {
          log.error('Error handling Feishu message', { err });
        }
      },
      'im.message.message_read_v1': async () => {},
      'im.message.reaction.created_v1': async () => {},
      'im.message.reaction.deleted_v1': async () => {},
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {},
      'im.chat.member.bot.added_v1': async () => {},
      'im.chat.member.bot.deleted_v1': async () => {},
      'vc.bot.meeting_invited_v1': async () => {},
      'drive.notice.comment_add_v1': async () => {},
      'card.action.trigger': async (data: unknown) => {
        try {
          return await handleCardAction(asRecord(data));
        } catch (err) {
          log.error('Error handling Feishu card action', { err });
          return {
            toast: { type: 'error', content: '操作失败，请重试' },
          };
        }
      },
      'application.bot.menu_v6': async (data: unknown) => {
        try {
          await handleBotMenu(asRecord(data));
        } catch (err) {
          log.error('Error handling Feishu bot menu', { err });
        }
      },
    } as Record<string, (data: unknown) => Promise<unknown>>);
    return dispatcher;
  }

  async function handleMessage(rawData: unknown): Promise<void> {
    if (!setupRef || !client) return;
    const event = normalizeMessageEvent(rawData);
    if (!event) return;

    const messageId = event.message.message_id;
    if (isDuplicate(messageId)) return;

    const parsed = parseMessageEvent(event);
    const isGroup = parsed.chatType !== 'p2p';
    const chatInfo = isGroup ? await resolveChatInfo(parsed.chatId) : null;
    const quoted = await resolveQuotedContent(parsed.parentId || event.message.upper_message_id);
    const inbound = buildFeishuInboundReplay(rawData, {
      threadSession,
      chatInfo,
      quotedText: quoted.text,
      botOpenId,
      botName,
    });
    if (!inbound) return;

    groupChats.set(inbound.platformId, inbound.isGroup);
    topicChats.set(
      inbound.platformId,
      inbound.isGroup && (inbound.parsed.chatType === 'topic_group' || isFeishuThreadCapableChat(chatInfo)),
    );
    if (inbound.message.isMention) {
      await addTypingReaction(typingKey(inbound.platformId, inbound.threadId), messageId);
    }
    const attachments = await downloadMessageAttachments(parsed);

    log.info('Feishu message received', {
      chatId: parsed.chatId,
      chatType: parsed.chatType,
      messageId,
      messageType: parsed.contentType,
      threadId: inbound.threadId,
      isMention: inbound.message.isMention,
      attachmentCount: attachments.length,
    });

    try {
      const chatName = inbound.isGroup ? chatInfo?.name || (await resolveChatName(parsed.chatId)) : undefined;
      setupRef.onMetadata(inbound.platformId, chatName ?? inbound.platformId, inbound.isGroup);
    } catch {
      setupRef.onMetadata(inbound.platformId, inbound.platformId, inbound.isGroup);
    }

    await setupRef.onInbound(inbound.platformId, inbound.threadId, {
      ...inbound.message,
      content: {
        ...(inbound.message.content as Record<string, unknown>),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });
  }

  async function handleCardAction(data: Record<string, unknown>): Promise<Record<string, unknown> | void> {
    if (!setupRef) return;
    const action = asRecord(data.action);
    const operator = asRecord(data.operator);
    const context = asRecord(data.context);
    const value = action.value;
    const actionValue = asRecord(value);
    const questionId = stringValue(actionValue.questionId);
    const selectedOption = stringValue(actionValue.selectedOption);
    if (questionId && selectedOption) {
      const senderId =
        stringValue(asRecord(operator.operator_id)?.open_id) || stringValue(operator.open_id) || 'card_action';
      const render = resolveQuestionRender(questionId);
      const response = buildFeishuQuestionActionResponse(render, selectedOption);
      log.info('Feishu question card action received', {
        questionId,
        selectedOption,
        hasRenderMetadata: Boolean(render),
      });
      setupRef.onAction(questionId, selectedOption, `fs:${senderId}`);
      return response;
    }
    const chatId = stringValue(context.open_chat_id) || stringValue(data.open_chat_id) || stringValue(data.chat_id);
    if (!chatId) return;
    const text = typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : '';
    if (!text) return;
    const senderId =
      stringValue(asRecord(operator.operator_id)?.open_id) || stringValue(operator.open_id) || 'card_action';
    await setupRef.onInbound(`fs:${chatId}`, null, {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
      content: {
        text: `@${ASSISTANT_NAME} ${text}`,
        sender: senderId,
        senderName: senderId,
        senderId: `fs:${senderId}`,
      },
    });
  }

  async function handleBotMenu(data: Record<string, unknown>): Promise<void> {
    if (!setupRef) return;
    const eventKey = stringValue(data.event_key);
    const chatId = stringValue(data.chat_id);
    if (!eventKey || !chatId) return;
    const operator = asRecord(data.operator);
    const senderId = stringValue(asRecord(operator.operator_id)?.open_id) || 'menu';
    await setupRef.onInbound(`fs:${chatId}`, null, {
      id: `menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
      content: {
        text: `@${ASSISTANT_NAME} /${eventKey}`,
        sender: senderId,
        senderName: senderId,
        senderId: `fs:${senderId}`,
      },
    });
  }

  async function resolveQuotedContent(messageId: string | undefined): Promise<{ text: string; isReplyToBot: boolean }> {
    if (!client || !messageId) return { text: '', isReplyToBot: false };
    try {
      const normalizedId = normalizeMessageId(messageId);
      const response = await client.im.message.get({ path: { message_id: normalizedId } });
      const item = response.data?.items?.[0];
      const isReplyToBot = item?.sender?.sender_type === 'app' || item?.sender?.sender_type === 'bot';
      const text = parseSimpleMessageContent(item?.msg_type ?? 'unknown', item?.body?.content ?? '', []);
      return { text, isReplyToBot };
    } catch (err) {
      log.debug('Failed to fetch Feishu quoted message', { messageId, err });
      return { text: '', isReplyToBot: false };
    }
  }

  async function resolveChatName(chatId: string): Promise<string | null> {
    return (await resolveChatInfo(chatId))?.name ?? null;
  }

  async function resolveChatInfo(chatId: string): Promise<FeishuChatInfo | null> {
    if (!client) return null;
    const cached = chatInfoCache.get(chatId);
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached;
    try {
      const response = await client.im.chat.get({ path: { chat_id: chatId } });
      const data = response.data ?? {};
      const info: FeishuChatInfo = {
        ...(data.name ? { name: data.name } : {}),
        ...(data.chat_mode ? { chatMode: data.chat_mode } : {}),
        ...(data.group_message_type ? { groupMessageType: data.group_message_type } : {}),
        fetchedAt: Date.now(),
      };
      chatInfoCache.set(chatId, info);
      return info;
    } catch (err) {
      log.debug('Failed to fetch Feishu chat info', { chatId, err });
      return null;
    }
  }

  async function downloadMessageAttachments(message: ParsedFeishuMessage): Promise<FeishuAttachment[]> {
    if (!client) return [];
    const specs = extractFeishuResourceSpecs(message.contentType, message.rawContent);
    const attachments: FeishuAttachment[] = [];

    for (const spec of specs) {
      try {
        const response = await (client as unknown as FeishuSdkClient).im.messageResource.get({
          path: {
            message_id: normalizeMessageId(message.messageId),
            file_key: spec.fileKey,
          },
          params: { type: spec.resourceType },
        });
        const buffer = await readableToBuffer(response.getReadableStream());
        if (buffer.length === 0) continue;
        attachments.push({
          type: spec.resourceType,
          name: spec.name,
          ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
          size: buffer.length,
          data: buffer.toString('base64'),
          feishu: {
            messageId: message.messageId,
            fileKey: spec.fileKey,
            resourceType: spec.resourceType,
          },
        });
      } catch (err) {
        log.warn('Failed to download Feishu message resource', {
          messageId: message.messageId,
          contentType: message.contentType,
          fileKey: spec.fileKey,
          resourceType: spec.resourceType,
          err,
        });
      }
    }
    return attachments;
  }

  function isDuplicate(messageId: string): boolean {
    if (processed.has(messageId)) return true;
    processed.set(messageId, Date.now());
    if (processed.size > DEDUP_MAX_SIZE) cleanupDedup();
    return false;
  }

  function cleanupDedup(): void {
    const now = Date.now();
    for (const [messageId, ts] of processed) {
      if (now - ts > DEDUP_WINDOW_MS) processed.delete(messageId);
    }
  }

  function startCleanup(): void {
    cleanupTimer = setInterval(cleanupDedup, DEDUP_WINDOW_MS);
  }

  async function clearTypingReaction(key: string): Promise<void> {
    if (!client) return;
    const reaction = typingByThread.get(key);
    if (!reaction) return;
    typingByThread.delete(key);
    try {
      await client.im.messageReaction.delete({
        path: { message_id: reaction.messageId, reaction_id: reaction.reactionId },
      });
    } catch (err) {
      log.debug('Failed to clear Feishu typing reaction', { key, err });
    }
  }

  async function addTypingReaction(key: string, messageId: string): Promise<void> {
    if (!client || typingByThread.has(key)) return;
    try {
      const normalizedId = normalizeMessageId(messageId);
      const response = await client.im.messageReaction.create({
        path: { message_id: normalizedId },
        data: { reaction_type: { emoji_type: PROCESSING_EMOJI_TYPE } },
      });
      const reactionId = response.data?.reaction_id;
      if (reactionId) typingByThread.set(key, { messageId: normalizedId, reactionId });
    } catch (err) {
      log.debug('Failed to add Feishu typing reaction', { messageId, err });
    }
  }

  return adapter;
}

async function resolveBotIdentity(client: lark.Client): Promise<{ botOpenId?: string; botName?: string }> {
  const request = client as unknown as { request(params: unknown): Promise<unknown> };
  try {
    const response = await request.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    const root = asRecord(response);
    const data = asRecord(asRecord(response).data);
    const bot = asRecord(root.bot ?? data.bot);
    return {
      botOpenId: stringValue(bot.open_id) || stringValue(data.open_id),
      botName: stringValue(bot.app_name) || stringValue(data.app_name) || stringValue(data.name),
    };
  } catch (err) {
    log.warn('Failed to resolve Feishu bot identity; falling back to mention-name heuristic', { err });
    return {};
  }
}

function patchCardEventForWsClient(wsClient: lark.WSClient): void {
  const target = wsClient as unknown as {
    handleEventData?: (data: { headers?: Array<{ key?: string; value?: string }> }) => unknown;
  };
  if (typeof target.handleEventData !== 'function') return;
  const original = target.handleEventData.bind(wsClient);
  target.handleEventData = (data) => {
    const msgType = data.headers?.find((header) => header.key === 'type')?.value;
    if (msgType !== 'card' || !Array.isArray(data.headers)) return original(data);
    return original({
      ...data,
      headers: data.headers.map((header) => (header.key === 'type' ? { ...header, value: 'event' } : header)),
    });
  };
}

function normalizeMessageId(messageId: string): string {
  return messageId.includes(':') ? messageId.split(':')[0] || messageId : messageId;
}

export function resolveFeishuReplyMessageId(
  threadId: string | null,
  inReplyTo?: string | null,
  isThreadCapable = true,
): string | undefined {
  if (!isThreadCapable) return undefined;

  const inboundMessageId = inReplyTo ? normalizeMessageId(inReplyTo) : undefined;
  if (inboundMessageId?.startsWith('om_')) return inboundMessageId;

  const normalizedThreadId = threadId ? normalizeMessageId(threadId) : undefined;
  return normalizedThreadId?.startsWith('om_') ? normalizedThreadId : undefined;
}

export function isFeishuThreadCapableChat(info: Pick<FeishuChatInfo, 'chatMode' | 'groupMessageType'> | null): boolean {
  return info?.chatMode === 'topic' || info?.groupMessageType === 'thread';
}

export function buildFeishuInboundReplay(
  data: unknown,
  options: FeishuInboundReplayOptions = {},
): FeishuInboundReplayResult | null {
  const event = normalizeMessageEvent(data);
  if (!event) return null;

  const parsed = parseMessageEvent(event);
  const isGroup = parsed.chatType !== 'p2p';
  const platformId = `fs:${parsed.chatId}`;
  const isTopicGroup = parsed.chatType === 'topic_group' || isFeishuThreadCapableChat(options.chatInfo ?? null);
  const threadId =
    options.threadSession !== false && isGroup && isTopicGroup ? parsed.threadId || parsed.rootId || null : null;
  const mentioned = !isGroup || mentionsBotIdentity(parsed, options);
  const senderName = parsed.senderName || parsed.senderId || event.sender.sender_id.user_id || 'unknown';

  let content = parsed.content || `[${parsed.contentType}]`;
  if (options.quotedText) content = `[引用消息] ${options.quotedText}\n\n${content}`;
  if (mentioned && !content.includes(`@${ASSISTANT_NAME}`)) {
    content = `@${ASSISTANT_NAME} ${content}`;
  }

  return {
    platformId,
    threadId,
    isGroup,
    parsed,
    message: {
      id: parsed.messageId,
      kind: 'chat',
      timestamp: timestampFromFeishu(event.message.create_time),
      isMention: mentioned,
      isGroup,
      content: {
        text: content,
        sender: senderName,
        senderName,
        senderId: `fs:${parsed.senderId || event.sender.sender_id.user_id || 'unknown'}`,
        feishu: {
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          threadId,
          contentType: parsed.contentType,
          mentions: parsed.mentions,
          mentionAll: parsed.mentionAll,
        },
      },
    },
  };
}

function mentionsBotIdentity(
  message: ParsedFeishuMessage,
  identity: Pick<FeishuInboundReplayOptions, 'botOpenId' | 'botName'>,
): boolean {
  if (message.mentionAll) return true;
  return message.mentions.some((mention) => {
    if (identity.botOpenId && mention.openId === identity.botOpenId) return true;
    if (identity.botName && mention.name === identity.botName) return true;
    return mention.name === ASSISTANT_NAME;
  });
}

function normalizeMessageEvent(data: unknown): FeishuMessageEvent | null {
  const event = asRecord(data);
  const sender = asRecord(event.sender);
  const senderId = asRecord(sender.sender_id);
  const message = asRecord(event.message);
  const messageId = stringValue(message.message_id);
  const chatId = stringValue(message.chat_id);
  if (!messageId || !chatId) return null;

  const chatType = normalizeFeishuChatType(message.chat_type);
  return {
    sender: {
      sender_id: {
        ...(stringValue(senderId.open_id) ? { open_id: stringValue(senderId.open_id) } : {}),
        ...(stringValue(senderId.user_id) ? { user_id: stringValue(senderId.user_id) } : {}),
        ...(stringValue(senderId.union_id) ? { union_id: stringValue(senderId.union_id) } : {}),
      },
      ...(stringValue(sender.sender_type) ? { sender_type: stringValue(sender.sender_type) } : {}),
      ...(stringValue(sender.tenant_key) ? { tenant_key: stringValue(sender.tenant_key) } : {}),
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: stringValue(message.message_type) ?? 'unknown',
      content: typeof message.content === 'string' ? message.content : '',
      ...(stringValue(message.root_id) ? { root_id: stringValue(message.root_id) } : {}),
      ...(stringValue(message.parent_id) ? { parent_id: stringValue(message.parent_id) } : {}),
      ...(stringValue(message.thread_id) ? { thread_id: stringValue(message.thread_id) } : {}),
      ...(stringValue(message.upper_message_id) ? { upper_message_id: stringValue(message.upper_message_id) } : {}),
      ...(stringValue(message.create_time) ? { create_time: stringValue(message.create_time) } : {}),
      mentions: normalizeMentions(message.mentions),
    },
  };
}

function normalizeFeishuChatType(value: unknown): FeishuChatType {
  if (value === 'p2p') return 'p2p';
  if (value === 'topic_group') return 'topic_group';
  return 'group';
}

function normalizeMentions(value: unknown): FeishuMention[] {
  if (!Array.isArray(value)) return [];
  const mentions: FeishuMention[] = [];
  for (const raw of value) {
    const mention = asRecord(raw);
    const id = asRecord(mention.id);
    const key = stringValue(mention.key);
    if (!key) continue;
    mentions.push({
      key,
      name: stringValue(mention.name) ?? 'user',
      ...(stringValue(mention.tenant_key) ? { tenant_key: stringValue(mention.tenant_key) } : {}),
      id: {
        ...(stringValue(id.open_id) ? { open_id: stringValue(id.open_id) } : {}),
        ...(stringValue(id.user_id) ? { user_id: stringValue(id.user_id) } : {}),
        ...(stringValue(id.union_id) ? { union_id: stringValue(id.union_id) } : {}),
      },
    });
  }
  return mentions;
}

function parseMessageEvent(event: FeishuMessageEvent): ParsedFeishuMessage {
  const mentions = (event.message.mentions ?? []).map((mention) => ({
    key: mention.key,
    openId: mention.id?.open_id ?? mention.id?.user_id ?? mention.id?.union_id ?? '',
    name: mention.name,
    isBot: mention.name === ASSISTANT_NAME,
  }));
  return {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId:
      event.sender.sender_id.open_id ?? event.sender.sender_id.user_id ?? event.sender.sender_id.union_id ?? 'unknown',
    chatType: event.message.chat_type,
    content: parseSimpleMessageContent(event.message.message_type, event.message.content, event.message.mentions ?? []),
    rawContent: event.message.content,
    contentType: event.message.message_type,
    mentions,
    mentionAll: mentions.some((mention) => mention.openId === 'all' || mention.key === '@_all'),
    ...(event.message.root_id ? { rootId: event.message.root_id } : {}),
    ...(event.message.parent_id ? { parentId: event.message.parent_id } : {}),
    ...(event.message.thread_id ? { threadId: event.message.thread_id } : {}),
  };
}

export function parseSimpleMessageContent(messageType: string, rawContent: string, mentions: FeishuMention[]): string {
  if (!rawContent) return `[${messageType}]`;
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    if (messageType === 'text') return substituteMentionKeys(String(parsed.text ?? '').trim(), mentions);
    if (messageType === 'post') {
      const post = optionalRecord(parsed.zh_cn) || optionalRecord(parsed.en_us) || parsed;
      const parts: string[] = [];
      const title = stringValue(post.title);
      if (title) parts.push(title);
      const paragraphs = Array.isArray(post.content) ? post.content : [];
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue;
        for (const element of paragraph) {
          const el = asRecord(element);
          const tag = stringValue(el.tag);
          if (tag === 'text' || tag === 'md') parts.push(postTextValue(el) ?? '');
          if (tag === 'a') {
            const text = postTextValue(el);
            const href = stringValue(el.href) || stringValue(el.url);
            if (text && href) parts.push(`[${text}](${href})`);
            else if (text || href) parts.push(text || href || '');
          }
          if (tag === 'at') parts.push(`@${stringValue(el.user_name) ?? 'user'}`);
          if (tag === 'img') parts.push('[图片]');
          if (tag === 'emotion') parts.push(`[表情:${stringValue(el.emoji_type) ?? ''}]`);
        }
        parts.push('\n');
      }
      return substituteMentionKeys(parts.join('').trim(), mentions) || '[富文本消息]';
    }
    if (messageType === 'image') return '[图片]';
    if (messageType === 'file') return `[文件: ${stringValue(parsed.file_name) ?? 'unknown'}]`;
    if (messageType === 'audio') return '[语音]';
    if (messageType === 'video') return '[视频]';
    if (messageType === 'merge_forward') return '[合并转发消息]';
    if (messageType === 'interactive') return '[交互卡片]';
    return `[${messageType}]`;
  } catch {
    return substituteMentionKeys(rawContent, mentions);
  }
}

function postTextValue(el: Record<string, unknown>): string | undefined {
  return stringValue(el.un_escape_text) || stringValue(el.text);
}

export function extractFeishuResourceSpecs(
  messageType: string,
  rawContent: string,
): Array<{
  fileKey: string;
  resourceType: string;
  name: string;
  mimeType?: string;
}> {
  const parsed = parseJsonObject(rawContent);
  if (!parsed) return [];

  if (messageType === 'post') {
    const post = optionalRecord(parsed.zh_cn) || optionalRecord(parsed.en_us) || parsed;
    const paragraphs = Array.isArray(post.content) ? post.content : [];
    const seen = new Set<string>();
    const specs: Array<{ fileKey: string; resourceType: string; name: string; mimeType: string }> = [];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        const el = asRecord(element);
        if (stringValue(el.tag) !== 'img') continue;
        const fileKey = stringValue(el.image_key) || stringValue(el.imageKey);
        if (!fileKey || seen.has(fileKey)) continue;
        seen.add(fileKey);
        specs.push({
          fileKey,
          resourceType: 'image',
          name: `inline-image-${specs.length + 1}.png`,
          mimeType: 'image/png',
        });
      }
    }
    return specs;
  }

  if (!['file', 'image', 'audio', 'video'].includes(messageType)) return [];

  const fileKey =
    stringValue(parsed.file_key) ||
    stringValue(parsed.fileKey) ||
    stringValue(parsed.image_key) ||
    stringValue(parsed.imageKey) ||
    stringValue(parsed.file_id) ||
    stringValue(parsed.fileId);
  if (!fileKey) return [];

  const name =
    stringValue(parsed.file_name) ||
    stringValue(parsed.fileName) ||
    stringValue(parsed.name) ||
    defaultFeishuResourceName(messageType);
  return [
    {
      fileKey,
      resourceType: messageType,
      name,
      ...(mimeTypeForFeishuResource(messageType, name)
        ? { mimeType: mimeTypeForFeishuResource(messageType, name) }
        : {}),
    },
  ];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function defaultFeishuResourceName(type: string): string {
  if (type === 'image') return `image-${Date.now()}.jpg`;
  if (type === 'audio') return `audio-${Date.now()}.ogg`;
  if (type === 'video') return `video-${Date.now()}.mp4`;
  return `file-${Date.now()}`;
}

function mimeTypeForFeishuResource(type: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (type === 'image') return 'image/jpeg';
  if (type === 'audio') return 'audio/ogg';
  if (type === 'video') return 'video/mp4';
  return undefined;
}

async function readableToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function substituteMentionKeys(text: string, mentions: FeishuMention[]): string {
  let result = text;
  for (const mention of mentions) {
    result = result.split(mention.key).join(`@${mention.name}`);
  }
  return result;
}

function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

async function sendFiles(
  client: FeishuSdkClient,
  chatId: string,
  message: OutboundMessage,
  replyToMessageId: string | undefined,
): Promise<void> {
  if (!message.files || message.files.length === 0) return;
  for (const file of message.files) {
    const ext = file.filename.toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].some((suffix) => ext.endsWith(suffix));
    if (isImage) {
      const upload = await client.im.image.create({ data: { image_type: 'message', image: file.data } });
      const imageKey = upload.image_key ?? upload.data?.image_key;
      if (!imageKey) continue;
      await sendFeishuMessage(client, chatId, 'image', JSON.stringify({ image_key: imageKey }), replyToMessageId);
      continue;
    }

    const upload = await client.im.file.create({
      data: { file_type: 'stream', file_name: file.filename, file: file.data },
    });
    const fileKey = upload.file_key ?? upload.data?.file_key;
    if (!fileKey) continue;
    await sendFeishuMessage(client, chatId, 'file', JSON.stringify({ file_key: fileKey }), replyToMessageId);
  }
}

async function sendFeishuMessage(
  client: FeishuSdkClient,
  chatId: string,
  msgType: string,
  content: string,
  replyToMessageId: string | undefined,
): Promise<string | undefined> {
  const response = replyToMessageId
    ? await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: msgType, content, reply_in_thread: true },
      })
    : await client.im.message.create({
        params: { receive_id_type: inferReceiveIdType(chatId) },
        data: { receive_id: chatId, msg_type: msgType, content },
      });
  return extractSentMessageId(response);
}

function inferReceiveIdType(receiveId: string): 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' {
  if (receiveId.startsWith('ou_')) return 'open_id';
  if (receiveId.startsWith('on_')) return 'union_id';
  if (receiveId.includes('@')) return 'email';
  return 'chat_id';
}

function extractSentMessageId(response: unknown): string | undefined {
  const data = asRecord(asRecord(response).data);
  return stringValue(data.message_id) || stringValue(data.messageId);
}

async function pushFeishuFollowUpsBestEffort(
  client: FeishuSdkClient,
  messageId: string,
  suggestions: string[],
): Promise<void> {
  try {
    await client.request({
      method: 'POST',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(normalizeMessageId(messageId))}/push_follow_up`,
      data: buildFeishuFollowUpPayload(suggestions),
    });
  } catch (err) {
    log.debug('Failed to push Feishu follow-up suggestions', { messageId, err });
  }
}

export function buildFeishuFollowUpPayload(suggestions: string[]): { follow_ups: Array<{ content: string }> } {
  return {
    follow_ups: normalizeFollowUpSuggestions(suggestions).map((content) => ({ content })),
  };
}

function extractFollowUpSuggestions(message: OutboundMessage): string[] {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  if (!Array.isArray(content.suggestions)) return [];
  return normalizeFollowUpSuggestions(content.suggestions);
}

function normalizeFollowUpSuggestions(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 200));
    if (out.length >= 3) break;
  }
  return out;
}

function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.markdown === 'string') return content.markdown;
  }
  return null;
}

function extractOutboundCard(message: OutboundMessage): Record<string, unknown> | null {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== 'object') return null;
  const card = content.card;
  return card && typeof card === 'object' && !Array.isArray(card)
    ? buildFeishuDisplayCard(card as Record<string, unknown>)
    : null;
}

function extractAskQuestionCard(message: OutboundMessage): Record<string, unknown> | null {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== 'object') return null;
  if (content.type !== 'ask_question') return null;
  const questionId = stringValue(content.questionId);
  const title = stringValue(content.title);
  const question = stringValue(content.question);
  if (!questionId || !title || !question || !Array.isArray(content.options)) return null;
  const options: NormalizedOption[] = normalizeOptions(content.options as never);
  return buildFeishuQuestionCard(questionId, title, question, options);
}

export function buildFeishuQuestionCard(
  questionId: string,
  title: string,
  question: string,
  options: NormalizedOption[],
): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: question,
        },
      },
      {
        tag: 'action',
        actions: options.map((option) => ({
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: option.label,
          },
          type: option.style === 'primary' ? 'primary' : option.style === 'danger' ? 'danger' : 'default',
          value: {
            questionId,
            selectedOption: option.value,
          },
        })),
      },
    ],
  };
}

/** Convert NanoClaw's platform-neutral display-card contract to Feishu JSON. */
export function buildFeishuDisplayCard(card: Record<string, unknown>): Record<string, unknown> {
  const title = stringValue(card.title) || stringValue(asRecord(card.header).title) || '';
  const description = stringValue(card.description) || '';
  const elements: Record<string, unknown>[] = [];

  if (description) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: description } });
  }
  if (Array.isArray(card.children)) {
    for (const child of card.children) {
      const text = typeof child === 'string' ? child : stringValue(asRecord(child).text);
      if (text) elements.push({ tag: 'div', text: { tag: 'lark_md', content: text } });
    }
  }

  if (Array.isArray(card.actions)) {
    const actions = card.actions.flatMap((raw) => {
      const action = asRecord(raw);
      const label = stringValue(action.label) || stringValue(action.text);
      const url = stringValue(action.url);
      if (!label || !url) return [];
      const style = action.style ?? action.type;
      return [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: label },
          type: style === 'primary' || style === 'danger' ? style : 'default',
          url,
        },
      ];
    });
    if (actions.length > 0) elements.push({ tag: 'action', actions });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: title || ' ' } });
  }

  return {
    config: { wide_screen_mode: true },
    ...(title
      ? {
          header: {
            template: 'blue',
            title: { tag: 'plain_text', content: title },
          },
        }
      : {}),
    elements,
  };
}

/**
 * Feishu requires a card-action response within three seconds. Returning a
 * raw terminal card removes the buttons and prevents the client from
 * restoring its pre-click state while the agent resumes asynchronously.
 */
export function buildFeishuQuestionActionResponse(
  render: QuestionRender | undefined,
  selectedOption: string,
): Record<string, unknown> {
  if (!render) {
    return { toast: { type: 'warning', content: '该问题已处理或已过期' } };
  }

  const selected = render.options.find((option) => option.value === selectedOption);
  const selectedLabel = selected?.selectedLabel ?? selected?.label ?? selectedOption;
  const elements: Record<string, unknown>[] = [];
  if (render.question) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: render.question } });
  }
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `✅ **已选择：${selectedLabel}**` },
  });

  return {
    toast: { type: 'success', content: '已提交' },
    card: {
      type: 'raw',
      data: {
        config: { wide_screen_mode: true },
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: render.title },
        },
        elements,
      },
    },
  };
}

function timestampFromFeishu(raw: string | undefined): string {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isNaN(n) && n > 0) return new Date(n).toISOString();
  return new Date().toISOString();
}

function stripFeishuPrefix(platformId: string): string {
  return platformId.replace(/^fs:/, '').replace(/:thread:.*$/, '');
}

function typingKey(platformId: string, threadId: string | null): string {
  return `${platformId}:${threadId ?? ''}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

registerChannelAdapter('feishu', { factory: createFeishuAdapter, defaults: FEISHU_DEFAULTS });
