import { afterEach, describe, expect, it } from 'bun:test';

import { buildBaiUserContent, parseToolDirective, resolveBaiConfig, trimHistory } from './bai.js';

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
});
