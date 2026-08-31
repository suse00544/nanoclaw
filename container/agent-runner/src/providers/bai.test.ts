import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildBaiRequestMessages,
  buildBaiUserContent,
  parseToolDirective,
  resolveBaiConfig,
  trimHistory,
} from './bai.js';

const originalBaseUrl = process.env.BAI_BASE_URL;
const originalModel = process.env.BAI_MODEL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.BAI_BASE_URL;
  else process.env.BAI_BASE_URL = originalBaseUrl;
  if (originalModel === undefined) delete process.env.BAI_MODEL;
  else process.env.BAI_MODEL = originalModel;
});

describe('b.ai configuration', () => {
  it('prefers the group model and requires an independent endpoint', () => {
    process.env.BAI_BASE_URL = 'https://api.b.ai/v1';
    process.env.BAI_MODEL = 'global-model';
    expect(resolveBaiConfig({ model: 'group-model' })).toEqual({
      baseURL: 'https://api.b.ai/v1',
      model: 'group-model',
    });
  });
});

describe('b.ai text tool protocol', () => {
  it('accepts one strict tool directive', () => {
    expect(parseToolDirective('{"tool":"bash","arguments":{"command":"pwd"}}')).toEqual({
      tool: 'bash',
      arguments: { command: 'pwd' },
    });
  });

  it('treats normal prose and fenced JSON as final output', () => {
    expect(parseToolDirective('done')).toBeNull();
    expect(parseToolDirective('```json\n{"tool":"bash","arguments":{}}\n```')).toBeNull();
  });
});

describe('b.ai history bounds', () => {
  it('keeps the newest complete messages inside the configured character budget', () => {
    const history = [
      { role: 'user' as const, content: 'old-user' },
      { role: 'assistant' as const, content: 'old-assistant' },
      { role: 'user' as const, content: 'new-user' },
      { role: 'assistant' as const, content: 'new-assistant' },
    ];
    expect(trimHistory(history, 24)).toEqual(history.slice(2));
  });
});

describe('b.ai vision input', () => {
  it('turns staged image attachments into image_url parts', () => {
    const content = buildBaiUserContent(
      '<message>inspect this<attachment type="image" path="/workspace/inbox/red.png" /></message>',
      () => Buffer.from('png-bytes'),
    );
    expect(content).toEqual([
      {
        type: 'text',
        text: '<message>inspect this<attachment type="image" path="/workspace/inbox/red.png" /></message>',
      },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5nLWJ5dGVz' } },
    ]);
  });

  it('recognizes NanoClaw staged attachment text', () => {
    const text = '<message>[图片]\n[image: photo.jpg — saved to /workspace/inbox/message/photo.jpg]</message>';
    expect(buildBaiUserContent(text, () => Buffer.from('photo'))).toEqual([
      { type: 'text', text },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,cGhvdG8=' } },
    ]);
  });

  it('ignores image-looking paths outside the staged inbox', () => {
    const readPaths: string[] = [];
    const text = [
      '<attachment type="image" path="/workspace/agent/secret.png" />',
      '[image: escape.jpg — saved to /workspace/inbox/../agent/escape.jpg]',
    ].join('\n');

    expect(
      buildBaiUserContent(text, (filePath) => {
        readPaths.push(filePath);
        return Buffer.from('secret');
      }),
    ).toEqual([{ type: 'text', text }]);
    expect(readPaths).toEqual([]);
  });

  it('keeps the latest image available when the question arrives in the next message', () => {
    const imageText = '[image: photo.jpg — saved to /workspace/inbox/message/photo.jpg]';
    const messages = buildBaiRequestMessages(
      [
        { role: 'user', content: imageText },
        { role: 'assistant', content: 'Image received.' },
        { role: 'user', content: 'What is in that image?' },
      ],
      'system',
      () => Buffer.from('photo'),
    );
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: imageText },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,cGhvdG8=' } },
      ],
    });
  });
});
