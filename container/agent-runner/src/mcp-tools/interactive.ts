/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateDisplayCard(card: Record<string, unknown>): string | undefined {
  if ('header' in card || 'elements' in card || 'i18n_elements' in card) {
    return 'send_card accepts only platform-neutral fields (title, description, children, actions), not native Feishu card JSON';
  }

  const hasTitle = typeof card.title === 'string' && card.title.trim().length > 0;
  const hasDescription = typeof card.description === 'string' && card.description.trim().length > 0;
  const hasChildren = Array.isArray(card.children) && card.children.length > 0;
  if (!hasTitle && !hasDescription && !hasChildren) {
    return 'card must include title, description, or children';
  }

  if (card.actions !== undefined) {
    if (!Array.isArray(card.actions)) return 'card.actions must be an array of URL actions';
    for (const raw of card.actions) {
      const action = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      if (typeof action.label !== 'string' || !action.label || typeof action.url !== 'string' || !action.url) {
        return 'send_card actions require label and url; use ask_user_question for choices or callback buttons';
      }
    }
  }

  return undefined;
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Write question card to outbound.db
    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.map((option) => option.label).join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional short card title' },
            description: { type: 'string', description: 'Optional card body' },
            children: {
              type: 'array',
              description: 'Optional additional text blocks',
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                    additionalProperties: false,
                  },
                ],
              },
            },
            actions: {
              type: 'array',
              description: 'Optional URL buttons. Choices must use ask_user_question instead.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  url: { type: 'string' },
                  style: { type: 'string', enum: ['primary', 'danger', 'default'] },
                },
                required: ['label', 'url'],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
          description: 'Platform-neutral display card. Never pass Feishu header/elements JSON.',
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');
    const validationError = validateDisplayCard(card);
    if (validationError) return err(validationError);

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    return ok(`Card queued for delivery (id: ${id}). Do not retry unless an explicit delivery error is returned.`);
  },
};

registerTools([askUserQuestion, sendCard]);
