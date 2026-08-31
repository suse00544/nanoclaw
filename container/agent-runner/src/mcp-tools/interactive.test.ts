import { describe, expect, test } from 'bun:test';

import { validateDisplayCard } from './interactive';

describe('send_card validation', () => {
  test('accepts platform-neutral display cards and URL buttons', () => {
    expect(
      validateDisplayCard({
        title: '结果',
        description: '处理完成',
        actions: [{ label: '打开文档', url: 'https://example.com' }],
      }),
    ).toBeUndefined();
  });

  test('rejects native Feishu card JSON', () => {
    expect(validateDisplayCard({ header: {}, elements: [] })).toContain('not native Feishu card JSON');
  });

  test('rejects callback-like buttons and points to ask_user_question', () => {
    expect(validateDisplayCard({ title: '选择', actions: [{ label: 'A', value: 'a' }] })).toContain(
      'use ask_user_question',
    );
  });

  test('rejects empty cards', () => {
    expect(validateDisplayCard({})).toBe('card must include title, description, or children');
  });
});
