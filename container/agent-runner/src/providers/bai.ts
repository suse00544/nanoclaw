import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';

// B.AI exposes an Anthropic-compatible Messages endpoint. Keep a distinct
// provider name for per-group switching, but reuse the Claude Agent SDK
// runtime instead of reimplementing tools, vision, sessions, and compaction.
registerProvider('b.ai', (options) => new ClaudeProvider(options));
