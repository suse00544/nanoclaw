import { describe, expect, it } from 'bun:test';

import './index.js';
import { createProvider } from './factory.js';
import { ClaudeProvider } from './claude.js';

describe('b.ai provider alias', () => {
  it('reuses the Claude Agent SDK provider', () => {
    expect(createProvider('b.ai')).toBeInstanceOf(ClaudeProvider);
  });
});
