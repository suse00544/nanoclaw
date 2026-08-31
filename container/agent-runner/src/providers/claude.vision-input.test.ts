import { describe, expect, it } from 'bun:test';

import { buildClaudeUserContent } from './claude.js';

describe('Claude staged image input', () => {
  it('preserves plain text prompts as strings', () => {
    expect(buildClaudeUserContent('hello')).toBe('hello');
  });

  it('converts the channel formatter saved-to syntax into an image block', () => {
    const content = buildClaudeUserContent(
      '[image: photo.jpg — saved to /workspace/inbox/msg/photo.jpg]',
      () => Buffer.from('image-bytes'),
    );
    expect(content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from('image-bytes').toString('base64'),
        },
      },
      { type: 'text', text: '[image: photo.jpg — saved to /workspace/inbox/msg/photo.jpg]' },
    ]);
  });

  it('also supports explicit path attributes and ignores non-image files', () => {
    const content = buildClaudeUserContent(
      'image path="/workspace/inbox/photo.png" pdf path="/workspace/inbox/file.pdf"',
      () => Buffer.from('png'),
    );
    expect(Array.isArray(content) && content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png' },
    });
  });

  it('never auto-reads paths outside the channel-staged inbox', () => {
    let reads = 0;
    const text = 'path="/workspace/agent/private.png"';
    expect(
      buildClaudeUserContent(text, () => {
        reads += 1;
        return Buffer.from('private');
      }),
    ).toBe(text);
    expect(reads).toBe(0);
  });
});
