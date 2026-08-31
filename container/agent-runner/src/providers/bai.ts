import { exec as execCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';

import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { memoryContextForSessionStart } from '../memory/session-hook.js';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

const exec = promisify(execCallback);
const DEFAULT_SESSION_DIR = '/workspace/agent/conversations/bai';
const DEFAULT_MODEL = 'deepseek-v4-flash-vision-exp';
const DEFAULT_HISTORY_CHARS = 160_000;
const MAX_TOOL_TURNS = 24;
const MAX_TOOL_OUTPUT_CHARS = 60_000;

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

export interface BaiConfig {
  baseURL: string;
  model: string;
}

export interface ToolDirective {
  tool: string;
  arguments: Record<string, unknown>;
}

interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

function log(message: string): void {
  console.error(`[b.ai-provider] ${message}`);
}

export function resolveBaiConfig(options: ProviderOptions): BaiConfig {
  const baseURL = process.env.BAI_BASE_URL?.replace(/\/+$/, '');
  if (!baseURL) throw new Error('BAI_BASE_URL is required for provider b.ai');
  return {
    baseURL,
    model: options.model?.trim() || process.env.BAI_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export function parseToolDirective(text: string): ToolDirective | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'arguments,tool') return null;
    if (typeof value.tool !== 'string' || !value.tool.trim()) return null;
    if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) return null;
    return { tool: value.tool, arguments: value.arguments as Record<string, unknown> };
  } catch {
    return null;
  }
}

function messageChars(message: HistoryMessage): number {
  return message.content.length;
}

export function trimHistory(history: HistoryMessage[], maxChars: number): HistoryMessage[] {
  if (maxChars <= 0) return [];
  let used = 0;
  let start = history.length;
  while (start > 0) {
    const size = messageChars(history[start - 1]);
    if (used + size > maxChars) break;
    used += size;
    start -= 1;
  }
  return history.slice(start);
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const STAGED_INBOX = '/workspace/inbox';

function stagedImagePaths(text: string): string[] {
  const candidates = [
    ...Array.from(text.matchAll(/\bpath="(\/workspace\/inbox\/[^"\r\n]+)"/g), (match) => match[1]),
    ...Array.from(text.matchAll(/\bsaved to (\/workspace\/inbox\/[^\]\r\n]+)\]/g), (match) => match[1]),
  ];
  return candidates.filter((candidate) => path.resolve(candidate).startsWith(STAGED_INBOX + path.sep));
}

export function buildBaiUserContent(
  text: string,
  readFile: (filePath: string) => Buffer = (filePath) => fs.readFileSync(filePath),
): Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
> {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [{ type: 'text', text }];
  const seen = new Set<string>();
  const paths = stagedImagePaths(text);
  for (const filePath of paths) {
    const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
    if (!mime || seen.has(filePath)) continue;
    seen.add(filePath);
    try {
      const bytes = readFile(filePath);
      if (bytes.length > 20 * 1024 * 1024) continue;
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } });
    } catch (error) {
      log(`Unable to attach image ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return content;
}

export function buildBaiRequestMessages(
  history: HistoryMessage[],
  system: string,
  readFile: (filePath: string) => Buffer = (filePath) => fs.readFileSync(filePath),
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  let latestImageIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === 'user' && buildBaiUserContent(message.content, () => Buffer.alloc(0)).length > 1) {
      latestImageIndex = index;
      break;
    }
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  history.forEach((message, index) => {
    if (message.role === 'user') {
      const includeImages = index === history.length - 1 || index === latestImageIndex;
      messages.push({
        role: 'user',
        content: includeImages ? buildBaiUserContent(message.content, readFile) : message.content,
      });
    } else {
      messages.push({ role: 'assistant', content: message.content });
    }
  });
  return messages;
}

function safeSessionId(value: string | undefined): string {
  if (!value) return randomUUID();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new Error('Invalid b.ai session id');
  return value;
}

function sessionPath(sessionId: string): string {
  return path.join(process.env.BAI_SESSION_DIR || DEFAULT_SESSION_DIR, `${sessionId}.json`);
}

function loadHistory(sessionId: string): HistoryMessage[] {
  const file = sessionPath(sessionId);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Invalid b.ai session: ${sessionId}`);
  return parsed.filter(
    (item): item is HistoryMessage =>
      Boolean(
        item &&
          typeof item === 'object' &&
          ((item as HistoryMessage).role === 'user' || (item as HistoryMessage).role === 'assistant') &&
          typeof (item as HistoryMessage).content === 'string',
      ),
  );
}

function saveHistory(sessionId: string, history: HistoryMessage[]): void {
  fs.mkdirSync(process.env.BAI_SESSION_DIR || DEFAULT_SESSION_DIR, { recursive: true });
  const file = sessionPath(sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(history));
  fs.renameSync(temp, file);
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function toolProtocol(tools: RuntimeTool[]): string {
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  return [
    'You can use tools through a strict text protocol.',
    'When a tool is needed, output ONLY one compact JSON object with exactly two keys:',
    '{"tool":"tool_name","arguments":{...}}',
    'Do not wrap the object in Markdown. After a tool result, continue solving the task.',
    'When the task is complete, output the normal final answer, not JSON.',
    `Available tools:\n${JSON.stringify(catalog)}`,
  ].join('\n');
}

async function executeBash(args: Record<string, unknown>, cwd: string): Promise<unknown> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) throw new Error('bash requires a non-empty command');
  const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000;
  const timeout = Math.min(Math.max(Math.floor(requested), 1_000), 600_000);
  try {
    setContainerToolInFlight('bash', timeout);
  } catch {
    // Standalone provider tests do not initialize the session DB.
  }
  try {
    const result = await exec(command, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      shell: '/bin/bash',
    });
    return {
      stdout: result.stdout.slice(-MAX_TOOL_OUTPUT_CHARS),
      stderr: result.stderr.slice(-MAX_TOOL_OUTPUT_CHARS),
      exit_code: 0,
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: String(err.stdout ?? '').slice(-MAX_TOOL_OUTPUT_CHARS),
      stderr: String(err.stderr ?? err.message).slice(-MAX_TOOL_OUTPUT_CHARS),
      exit_code: err.code ?? 1,
    };
  } finally {
    try {
      clearContainerToolInFlight();
    } catch {
      // Standalone provider tests do not initialize the session DB.
    }
  }
}

export class BaiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private readonly clients: Client[] = [];
  private toolsPromise?: Promise<RuntimeTool[]>;
  private memoryHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memoryHook = hook;
  }

  isSessionInvalid(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Invalid b\.ai session|b\.ai session.*not found/i.test(message);
  }

  private async loadTools(cwd: string): Promise<RuntimeTool[]> {
    if (this.toolsPromise) return this.toolsPromise;
    this.toolsPromise = (async () => {
      const tools: RuntimeTool[] = [
        {
          name: 'bash',
          description: 'Run a shell command inside the isolated agent container workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              timeout_ms: { type: 'number', minimum: 1000, maximum: 600000 },
            },
            required: ['command'],
            additionalProperties: false,
          },
          execute: (args) => executeBash(args, cwd),
        },
      ];

      const names = new Set(['bash']);
      for (const [serverName, config] of Object.entries(this.options.mcpServers ?? {})) {
        const client = new Client({ name: `nanoclaw-bai-${serverName}`, version: '1.0.0' });
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: cleanEnv(config.env),
          cwd,
        });
        await client.connect(transport);
        this.clients.push(client);
        const listed = await client.listTools();
        for (const definition of listed.tools) {
          const exposedName = names.has(definition.name) ? `${serverName}__${definition.name}` : definition.name;
          names.add(exposedName);
          tools.push({
            name: exposedName,
            description: definition.description ?? `Tool ${definition.name} from ${serverName}`,
            inputSchema: (definition.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            execute: async (args) => client.callTool({ name: definition.name, arguments: args }),
          });
        }
      }
      return tools;
    })();
    return this.toolsPromise;
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memoryHook) throw new Error('b.ai memory session hook was not registered');
    const sessionId = safeSessionId(input.continuation);
    const pending = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let activeAbort: AbortController | null = null;
    const self = this;

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'activity' };
      yield { type: 'init', continuation: sessionId };
      const config = resolveBaiConfig(self.options);
      const client = new OpenAI({
        baseURL: config.baseURL,
        apiKey: process.env.BAI_API_KEY || 'onecli-placeholder',
      });
      const tools = await self.loadTools(input.cwd);
      yield { type: 'activity' };

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
        if (aborted || (pending.length === 0 && ended)) return;

        const prompt = pending.shift()!;
        const maxChars = Number(process.env.BAI_HISTORY_MAX_CHARS) || DEFAULT_HISTORY_CHARS;
        const history = trimHistory(loadHistory(sessionId), maxChars);
        history.push({ role: 'user', content: prompt });

        let finalText: string | null = null;
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
          const memory = memoryContextForSessionStart(input.continuation ? 'resume' : 'startup');
          const system = [input.systemContext?.instructions, memory, toolProtocol(tools)].filter(Boolean).join('\n\n');
          activeAbort = new AbortController();
          const requestMessages = buildBaiRequestMessages(history, system);
          const stream = await client.chat.completions.create(
            {
              model: config.model,
              stream: true,
              messages: requestMessages,
            },
            { signal: activeAbort.signal },
          );

          let text = '';
          for await (const chunk of stream) {
            if (aborted) return;
            text += chunk.choices[0]?.delta?.content ?? '';
            yield { type: 'activity' };
          }
          activeAbort = null;

          const directive = parseToolDirective(text);
          if (!directive) {
            finalText = text.trim() || null;
            history.push({ role: 'assistant', content: text });
            break;
          }

          const tool = tools.find((candidate) => candidate.name === directive.tool);
          if (!tool) {
            history.push({ role: 'assistant', content: text });
            history.push({
              role: 'user',
              content: `<tool_result name="${directive.tool}" error="true">Unknown tool</tool_result>`,
            });
            continue;
          }

          yield { type: 'activity' };
          let output: unknown;
          try {
            output = await tool.execute(directive.arguments);
          } catch (error) {
            output = { error: error instanceof Error ? error.message : String(error) };
          }
          history.push({ role: 'assistant', content: text });
          history.push({
            role: 'user',
            content: `<tool_result name="${directive.tool}">${JSON.stringify(output).slice(0, MAX_TOOL_OUTPUT_CHARS)}</tool_result>`,
          });
          saveHistory(sessionId, trimHistory(history, maxChars));
          yield { type: 'activity' };
        }

        if (finalText === null) throw new Error(`b.ai exceeded ${MAX_TOOL_TURNS} tool turns`);
        saveHistory(sessionId, trimHistory(history, maxChars));
        yield { type: 'result', text: finalText };
      }
    }

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events: events(),
      abort() {
        aborted = true;
        activeAbort?.abort();
        waiting?.();
      },
    };
  }
}

registerProvider('b.ai', (options) => new BaiProvider(options));
