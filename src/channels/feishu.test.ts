import { describe, expect, it } from 'vitest';
import * as feishuModule from './feishu.js';

import {
  buildFeishuInboundReplay,
  buildFeishuDisplayCard,
  buildFeishuFollowUpPayload,
  buildFeishuQuestionActionResponse,
  buildFeishuQuestionCard,
  isFeishuThreadCapableChat,
  parseSimpleMessageContent,
  resolveFeishuReplyMessageId,
} from './feishu.js';

const BOT_OPEN_ID = 'ou_bot';

function feishuEvent(
  overrides: {
    messageId?: string;
    chatId?: string;
    chatType?: 'p2p' | 'group' | 'topic_group';
    messageType?: string;
    content?: string;
    mentions?: Array<Record<string, unknown>>;
    rootId?: string;
    threadId?: string;
    parentId?: string;
    senderOpenId?: string;
  } = {},
): Record<string, unknown> {
  return {
    sender: {
      sender_id: {
        open_id: overrides.senderOpenId ?? 'ou_sender',
      },
      sender_type: 'user',
    },
    message: {
      message_id: overrides.messageId ?? 'om_message',
      chat_id: overrides.chatId ?? 'oc_chat',
      chat_type: overrides.chatType ?? 'group',
      message_type: overrides.messageType ?? 'text',
      content: overrides.content ?? JSON.stringify({ text: 'hello' }),
      create_time: '1787562400000',
      ...(overrides.rootId ? { root_id: overrides.rootId } : {}),
      ...(overrides.threadId ? { thread_id: overrides.threadId } : {}),
      ...(overrides.parentId ? { parent_id: overrides.parentId } : {}),
      mentions: overrides.mentions ?? [],
    },
  };
}

function botMention(): Record<string, unknown> {
  return {
    key: '@_user_1',
    name: 'Beacon',
    id: { open_id: BOT_OPEN_ID },
  };
}

function inboundText(result: NonNullable<ReturnType<typeof buildFeishuInboundReplay>>): string {
  return (result.message.content as { text: string }).text;
}

describe('Feishu cards', () => {
  it('renders ask_user_question choices with stable values', () => {
    const card = buildFeishuQuestionCard('q-1', '选择日期', '什么时候出发？', [
      { label: '周五', selectedLabel: '已选周五', value: 'fri', style: 'primary' },
    ]);

    expect(card).toMatchObject({
      header: { title: { content: '选择日期' } },
      elements: [
        { text: { content: '什么时候出发？' } },
        {
          actions: [
            {
              text: { content: '周五' },
              type: 'primary',
              value: { questionId: 'q-1', selectedOption: 'fri' },
            },
          ],
        },
      ],
    });
  });

  it('returns a raw terminal card with no buttons after selection', () => {
    const response = buildFeishuQuestionActionResponse(
      {
        title: '选择日期',
        question: '什么时候出发？',
        options: [{ label: '周五', selectedLabel: '已选周五', value: 'fri' }],
      },
      'fri',
    );

    expect(response).toMatchObject({
      toast: { type: 'success', content: '已提交' },
      card: {
        type: 'raw',
        data: {
          header: { template: 'green', title: { content: '选择日期' } },
          elements: [{ text: { content: '什么时候出发？' } }, { text: { content: '✅ **已选择：已选周五**' } }],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('"tag":"action"');
  });

  it('returns an expiry toast when the question is no longer pending', () => {
    expect(buildFeishuQuestionActionResponse(undefined, 'fri')).toEqual({
      toast: { type: 'warning', content: '该问题已处理或已过期' },
    });
  });

  it('converts generic display cards and only keeps URL actions', () => {
    const card = buildFeishuDisplayCard({
      title: '结果',
      description: '处理完成',
      children: ['详情一', { text: '详情二' }],
      actions: [
        { label: '打开文档', url: 'https://example.com', style: 'primary' },
        { label: '无回调按钮', value: 'ignored' },
      ],
    });

    expect(card).toMatchObject({
      header: { title: { content: '结果' } },
      elements: [
        { text: { content: '处理完成' } },
        { text: { content: '详情一' } },
        { text: { content: '详情二' } },
        { actions: [{ text: { content: '打开文档' }, url: 'https://example.com', type: 'primary' }] },
      ],
    });
    expect(JSON.stringify(card)).not.toContain('无回调按钮');
  });

  it('builds follow-up suggestion payloads within Feishu limits', () => {
    const long = 'x'.repeat(250);

    expect(buildFeishuFollowUpPayload(['  继续  ', '', '给我例子', long, 'ignored'])).toEqual({
      follow_ups: [{ content: '继续' }, { content: '给我例子' }, { content: 'x'.repeat(200) }],
    });
  });
});

describe('Feishu inbound message parsing', () => {
  it('extracts post text from un_escape_text and keeps links readable', () => {
    const rawContent = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: 'at', user_name: 'Beacon', user_id: 'ou_bot' },
            { tag: 'text', un_escape_text: ' 这个群里提的体验问题，你定期回捞，去重录入到这个多维表格' },
          ],
          [
            {
              tag: 'a',
              text: 'Tada 设计还原转测问题池-M8',
              href: 'https://example.feishu.cn/base/abc',
            },
          ],
          [{ tag: 'img', image_key: 'img_v3_123' }],
        ],
      },
    });

    expect(parseSimpleMessageContent('post', rawContent, [])).toBe(
      '@Beacon 这个群里提的体验问题，你定期回捞，去重录入到这个多维表格\n' +
        '[Tada 设计还原转测问题池-M8](https://example.feishu.cn/base/abc)\n' +
        '[图片]',
    );
  });

  it('does not drop post bodies that only use un_escape_text', () => {
    const rawContent = JSON.stringify({
      content: [[{ tag: 'text', un_escape_text: '富文本正文' }]],
    });

    expect(parseSimpleMessageContent('post', rawContent, [])).toBe('富文本正文');
  });

  it('extracts every distinct inline image resource from a rich post', () => {
    const extractResourceSpecs = (
      feishuModule as typeof feishuModule & {
        extractFeishuResourceSpecs?: (messageType: string, rawContent: string) => Array<Record<string, unknown>>;
      }
    ).extractFeishuResourceSpecs;
    expect(extractResourceSpecs).toBeTypeOf('function');

    const rawContent = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: 'text', text: '请看图' },
            { tag: 'img', image_key: 'img_v3_first' },
          ],
          [
            { tag: 'img', image_key: 'img_v3_second' },
            { tag: 'img', image_key: 'img_v3_first' },
          ],
        ],
      },
    });

    expect(extractResourceSpecs!('post', rawContent)).toEqual([
      {
        fileKey: 'img_v3_first',
        resourceType: 'image',
        name: 'inline-image-1.png',
        mimeType: 'image/png',
      },
      {
        fileKey: 'img_v3_second',
        resourceType: 'image',
        name: 'inline-image-2.png',
        mimeType: 'image/png',
      },
    ]);
  });
});

describe('Feishu inbound replay', () => {
  it('treats private chats as engaged without an explicit mention', () => {
    const replay = buildFeishuInboundReplay(
      feishuEvent({
        chatType: 'p2p',
        chatId: 'ou_sender',
        content: JSON.stringify({ text: '在吗' }),
      }),
      { botOpenId: BOT_OPEN_ID, botName: 'Beacon' },
    );

    expect(replay).toMatchObject({
      platformId: 'fs:ou_sender',
      threadId: null,
      isGroup: false,
      message: { isMention: true, isGroup: false },
    });
    expect(inboundText(replay!)).toBe('@Beacon 在吗');
  });

  it('keeps normal group messages in context without engaging when the bot is not mentioned', () => {
    const replay = buildFeishuInboundReplay(
      feishuEvent({
        chatType: 'group',
        content: JSON.stringify({ text: '这条只进入上下文' }),
      }),
      { botOpenId: BOT_OPEN_ID, botName: 'Beacon' },
    );

    expect(replay).toMatchObject({
      platformId: 'fs:oc_chat',
      threadId: null,
      isGroup: true,
      message: { isMention: false, isGroup: true },
    });
    expect(inboundText(replay!)).toBe('这条只进入上下文');
  });

  it('engages normal group messages when Feishu reports a bot mention', () => {
    const replay = buildFeishuInboundReplay(
      feishuEvent({
        chatType: 'group',
        content: JSON.stringify({ text: '@_user_1 帮我看看' }),
        mentions: [botMention()],
      }),
      { botOpenId: BOT_OPEN_ID, botName: 'Beacon' },
    );

    expect(replay?.threadId).toBeNull();
    expect(replay?.message.isMention).toBe(true);
    expect(inboundText(replay!)).toBe('@Beacon 帮我看看');
  });

  it('preserves topic group thread identity for per-topic isolation', () => {
    const replay = buildFeishuInboundReplay(
      feishuEvent({
        chatType: 'topic_group',
        rootId: 'om_root',
        threadId: 'omt_topic',
        content: JSON.stringify({ text: '@_user_1 这个话题继续' }),
        mentions: [botMention()],
      }),
      { botOpenId: BOT_OPEN_ID, botName: 'Beacon' },
    );

    expect(replay).toMatchObject({
      platformId: 'fs:oc_chat',
      threadId: 'omt_topic',
      isGroup: true,
      message: { isMention: true, isGroup: true },
    });
  });

  it('replays quoted rich posts without dropping either body to placeholders', () => {
    const replay = buildFeishuInboundReplay(
      feishuEvent({
        chatType: 'group',
        messageType: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: 'at', user_name: 'Beacon' },
                { tag: 'text', un_escape_text: ' 请回捞这个问题' },
              ],
            ],
          },
        }),
        mentions: [botMention()],
        parentId: 'om_parent',
      }),
      {
        botOpenId: BOT_OPEN_ID,
        botName: 'Beacon',
        quotedText: '[Tada 设计还原转测问题池-M8](https://example.feishu.cn/base/abc)',
      },
    );

    expect(inboundText(replay!)).toBe(
      '[引用消息] [Tada 设计还原转测问题池-M8](https://example.feishu.cn/base/abc)\n\n@Beacon 请回捞这个问题',
    );
  });
});

describe('Feishu topic replies', () => {
  it('matches official thread-capable chat detection', () => {
    expect(isFeishuThreadCapableChat({ chatMode: 'topic' })).toBe(true);
    expect(isFeishuThreadCapableChat({ groupMessageType: 'thread' })).toBe(true);
    expect(isFeishuThreadCapableChat({ chatMode: 'group', groupMessageType: 'chat' })).toBe(false);
    expect(isFeishuThreadCapableChat(null)).toBe(false);
  });

  it('uses the inbound open_message_id instead of a topic thread id for topic groups', () => {
    expect(resolveFeishuReplyMessageId('omt_191877fd1c4f1a45', 'om_x100b68de221d40a0b26b04410864076:ag-1', true)).toBe(
      'om_x100b68de221d40a0b26b04410864076',
    );
  });

  it('does not send omt_* to the reply API when no inbound message id is available', () => {
    expect(resolveFeishuReplyMessageId('omt_191877fd1c4f1a45', null)).toBeUndefined();
  });

  it('does not thread-reply in private chats even when Feishu sends an omt_* thread id', () => {
    expect(
      resolveFeishuReplyMessageId('omt_191aba77094f1cbd', 'om_x100b68c76028d8a4b3b759a2927f1f3:ag-1', false),
    ).toBeUndefined();
  });

  it('does not thread-reply in normal groups even when an inbound message id is available', () => {
    expect(resolveFeishuReplyMessageId(null, 'om_x100b68c76028d8a4b3b759a2927f1f3:ag-1', false)).toBeUndefined();
  });
});
