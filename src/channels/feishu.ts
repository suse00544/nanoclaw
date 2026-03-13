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

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
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
        logger.info(
          { event: 'im.message.receive_v1', data },
          'Received Feishu message event',
        );
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
      logger.info(
        { chatId, chatType, messageId, messageType, timestamp },
        'Extracted chat info',
      );

      // Build JID (Feishu format: fs:chat_id)
      const chatJid = `fs:${chatId}`;

      // Extract sender info
      const senderId = sender.sender_id.user_id || sender.sender_id.open_id;
      const senderName = sender.sender_id.user_id || 'Unknown';

      // Parse message content based on type
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
          logger.error(
            { err, messageContent: message.content },
            'Failed to parse Feishu text message',
          );
          content = message.content;
        }
      } else if (messageType === 'image') {
        try {
          const imageContent = JSON.parse(message.content);
          const imageKey = imageContent.image_key;

          if (imageKey && this.client) {
            // Download image using messageResource API
            const imageResp = await this.client.im.messageResource.get({
              path: {
                message_id: messageId,
                file_key: imageKey,
              },
              params: {
                type: 'image',
              },
            });

            const fs = await import('fs');
            const path = await import('path');

            const groupFolder = this.opts.registeredGroups()[chatJid]?.folder;

            if (groupFolder) {
              const groupPath = path.join(process.cwd(), 'groups', groupFolder);
              fs.mkdirSync(path.join(groupPath, 'images'), { recursive: true });
              const imagePath = path.join(
                groupPath,
                'images',
                `${messageId}.png`,
              );

              // Write image using SDK's writeFile method
              await imageResp.writeFile(imagePath);

              attachments.push({
                type: 'image' as const,
                path: imagePath,
                name: `${messageId}.png`,
              });

              content = '[图片]';
              logger.info(
                { messageId, imageKey, imagePath },
                'Image downloaded and saved',
              );
            }
          }
        } catch (err) {
          logger.error(
            { err, messageId, messageContent: message.content },
            'Failed to download image',
          );
          content = '[图片]';
        }
      } else if (messageType === 'post') {
        try {
          logger.info(
            { messageId, rawContent: message.content },
            'Processing post message',
          );
          const postContent = JSON.parse(message.content);
          logger.info({ postContent }, 'Parsed post content');
          // Post content might be nested under zh_cn/en_us, or directly at root
          const post = postContent.content
            ? postContent
            : postContent.zh_cn || postContent.en_us || postContent;
          logger.info({ post }, 'Selected post locale');

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
                      // Download image using messageResource API
                      const imageResp =
                        await this.client.im.messageResource.get({
                          path: {
                            message_id: messageId,
                            file_key: element.image_key,
                          },
                          params: {
                            type: 'image',
                          },
                        });

                      const fs = await import('fs');
                      const path = await import('path');

                      const groupFolder =
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
                          type: 'image' as const,
                          path: imagePath,
                          name: `${messageId}_${element.image_key}.png`,
                        });

                        logger.info(
                          {
                            messageId,
                            imageKey: element.image_key,
                            imagePath,
                          },
                          'Post image downloaded',
                        );
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
                  if (element.text && element.href) {
                    textParts.push(`[${element.text}](${element.href})`);
                  }
                  break;
                case 'at':
                  if (element.user_name) {
                    textParts.push(`@${element.user_name}`);
                  } else {
                    textParts.push('@user');
                  }
                  break;
              }
            }
            textParts.push('\n');
          }

          // Add image references from attachments into the text content
          for (const att of attachments) {
            if (att.type === 'image') {
              textParts.push(`\n<image path="${att.path}" />`);
            }
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

          logger.info(
            { messageId, fileName, fileKey },
            'Processing file message',
          );

          if (fileKey && this.client) {
            const groupFolder = this.opts.registeredGroups()[chatJid]?.folder;

            if (groupFolder) {
              const fs = await import('fs');
              const path = await import('path');
              const groupPath = path.join(process.cwd(), 'groups', groupFolder);

              // Create files directory
              const filesDir = path.join(groupPath, 'files');
              fs.mkdirSync(filesDir, { recursive: true });

              const filePath = path.join(filesDir, `${messageId}_${fileName}`);

              // Download file
              const fileResp = await this.client.im.messageResource.get({
                path: {
                  message_id: messageId,
                  file_key: fileKey,
                },
                params: {
                  type: 'file',
                },
              });

              await fileResp.writeFile(filePath);

              logger.info({ messageId, fileName, filePath }, 'File downloaded');

              // Add file as attachment
              attachments.push({
                type: 'file' as const,
                path: filePath,
                name: fileName,
              });

              content = `[文件: ${fileName}]\n<file path="${filePath}" />`;

              // Auto-extract ZIP files
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
                  logger.warn(
                    { err: extractErr },
                    'Failed to extract archive, file still available',
                  );
                }
              }
            }
          }

          if (!content || content === '[文件]') {
            content = `[文件: ${fileContent.file_name || 'unknown'}] (下载失败)`;
          }
        } catch (err) {
          logger.error(
            { err, messageContent: message.content },
            'Failed to process file message',
          );
          content = '[文件] (处理失败)';
        }
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
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Feishu chat',
        );
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
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Feishu message stored',
      );
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

      logger.info(
        { chatId, textLength: text.length, result },
        'Feishu message sent successfully',
      );
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
    const segments: Array<{ text: string; style?: string[]; href?: string }> =
      [];

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
    processedLine = processedLine.replace(
      /\[(.+?)\]\((.+?)\)/g,
      (match, text, href) => {
        segments.push({ text, href });
        return `__SEGMENT_${segments.length - 1}__`;
      },
    );

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

  /**
   * Send a file to a Feishu chat.
   * Supports images, PDFs, documents, and other file types.
   */
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

    // Extract chat_id from JID
    const chatId = jid.replace(/^fs:/, '');

    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Read file
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const fileExt = path.extname(filePath).toLowerCase();

      // Determine file type
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      const isImage = imageExts.includes(fileExt);

      // Upload file to Feishu
      logger.info({ filePath, fileName, isImage }, 'Uploading file to Feishu');

      let fileKey: string;
      let msgType: string;
      let messageContent: string;

      if (isImage) {
        // For images, use im.image.create to get image_key
        const uploadResult = await this.client.im.image.create({
          data: {
            image_type: 'message',
            image: fileBuffer,
          },
        });

        const imageKey =
          (uploadResult as any)?.data?.image_key || uploadResult?.image_key;
        if (!imageKey) {
          throw new Error('Failed to upload image: no image_key returned');
        }

        fileKey = imageKey;
        msgType = 'image';
        messageContent = JSON.stringify({ image_key: imageKey });
        logger.info({ imageKey, fileName }, 'Image uploaded successfully');
      } else {
        // For other files, use im.file.create to get file_key
        const uploadResult = await this.client.im.file.create({
          data: {
            file_type: 'stream',
            file_name: fileName,
            file: fileBuffer,
          },
        });

        const fKey =
          (uploadResult as any)?.data?.file_key || uploadResult?.file_key;
        if (!fKey) {
          throw new Error('Failed to upload file: no file_key returned');
        }

        fileKey = fKey;
        msgType = 'file';
        messageContent = JSON.stringify({ file_key: fKey });
        logger.info({ fileKey: fKey, fileName }, 'File uploaded successfully');
      }

      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content: messageContent,
        },
      });

      logger.info(
        { chatId, fileName, fileType: msgType },
        'File sent successfully',
      );

      // Send caption as a follow-up message if provided
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

    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }

    logger.info('Feishu channel disconnected');
  }
}

// Channel factory with self-registration
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
