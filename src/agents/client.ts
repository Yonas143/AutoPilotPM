import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';

export interface AgentClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal | null }): Promise<Anthropic.Message>;
    stream?: Anthropic['messages']['stream'];
  };
}

type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  inlineData?: { mimeType: string; data: string };
};
type NativeBlock = Anthropic.ContentBlockParam & { geminiParts?: Part[] };
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export function getAgentProvider(): 'anthropic' | 'gemini' {
  const selected = process.env.AUTOPILOT_AI_PROVIDER;
  if (selected && selected !== 'anthropic' && selected !== 'gemini') {
    throw new Error('AUTOPILOT_AI_PROVIDER must be anthropic or gemini');
  }
  if (selected) return selected;
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'gemini';
}

export function validateAgentCredentials(): void {
  const key = getAgentProvider() === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[key]?.trim()) {
    throw new Error(`${key} is required for the selected AI provider. Set ANTHROPIC_API_KEY or GEMINI_API_KEY, and optionally AUTOPILOT_AI_PROVIDER.`);
  }
}

export function resolveAgentModel(requested?: string): string {
  if (getAgentProvider() === 'anthropic') return requested || 'claude-sonnet-4-6';
  return requested?.replace(/^models\//, '').startsWith('gemini-')
    ? requested.replace(/^models\//, '')
    : process.env.AUTOPILOT_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

/** Translate the existing agent tool loop without changing its risk/execution rules. */
export function createGeminiAgentClient(apiKey: string, fetcher: typeof fetch = fetch): AgentClient {
  return {
    messages: {
      async create(params, options) {
        const names = new Map<string, { name: string; id?: string }>();
        const contents = params.messages.map(message => {
          const blocks = typeof message.content === 'string'
            ? [{ type: 'text' as const, text: message.content }]
            : message.content;
          const parts: Part[] = [];
          for (const raw of blocks) {
            const block = raw as NativeBlock;
            if (block.type === 'tool_use') {
              names.set(block.id, { name: block.name, id: block.geminiParts?.find(p => p.functionCall)?.functionCall?.id });
            }
            // Preserve full native parts, including hidden thoughts and signatures, on replay.
            if (message.role === 'assistant' && block.geminiParts) {
              parts.push(...block.geminiParts);
            } else if (block.type === 'text') {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({ functionCall: { name: block.name, args: block.input as Record<string, unknown> } });
            } else if (block.type === 'tool_result') {
              const call = names.get(block.tool_use_id);
              if (!call) throw new Error('Gemini tool result has no matching tool call');
              const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
              parts.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: block.is_error ? { error: output } : { output } } });
            } else if (block.type === 'image' && block.source.type === 'base64') {
              parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
            } else {
              throw new Error(`Gemini agent does not support content block: ${block.type}`);
            }
          }
          return { role: message.role === 'assistant' ? 'model' : 'user', parts };
        });
        const system = typeof params.system === 'string'
          ? params.system : params.system?.map(b => b.text).join('\n\n');
        const model = params.model.replace(/^models\//, '').startsWith('gemini-')
          ? params.model.replace(/^models\//, '') : process.env.AUTOPILOT_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
        if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid Gemini model ID');
        const signal = options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000);
        const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          signal,
          body: JSON.stringify({
            contents,
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            generationConfig: { maxOutputTokens: Math.max(params.max_tokens, 4096), ...(model.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}), ...(params.temperature != null ? { temperature: params.temperature } : {}), ...(params.stop_sequences ? { stopSequences: params.stop_sequences } : {}) },
            ...(params.tools?.length ? { tools: [{ functionDeclarations: params.tools.map(tool => {
              if (!('input_schema' in tool)) throw new Error('Gemini requires custom function tools');
              return { name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema };
            }) }] } : {}),
          }),
        });
        if (!response.ok) {
          // Do not include request headers, URLs with credentials, or response bodies in logs.
          const error = new Error(`Gemini API request failed (HTTP ${response.status}). Check key, model access, quota and API billing.`) as Error & { status: number };
          error.status = response.status;
          throw error;
        }
        const data = await response.json() as {
          candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
        };
        const candidate = data.candidates?.[0];
        const nativeParts = candidate?.content?.parts;
        if (!nativeParts?.length) throw new Error('Gemini returned no content; the response may have been blocked');
        const content: Anthropic.ContentBlock[] = [];
        let pending: Part[] = [];
        for (const part of nativeParts) {
          pending.push(part);
          let block: Anthropic.ContentBlock | undefined;
          if (part.functionCall) {
            block = { type: 'tool_use', id: part.functionCall.id || randomUUID(), name: part.functionCall.name, input: part.functionCall.args || {} } as Anthropic.ToolUseBlock;
          } else if (part.text && !part.thought) {
            block = { type: 'text', text: part.text, citations: null };
          }
          if (block) {
            Object.assign(block, { geminiParts: pending });
            pending = [];
            content.push(block);
          }
        }
        if (!content.length) throw new Error('Gemini returned no visible text or tool calls');
        if (pending.length) {
          const last = content[content.length - 1] as unknown as { geminiParts: Part[] };
          last.geminiParts.push(...pending);
        }
        return {
          id: randomUUID(), type: 'message', role: 'assistant', model, content,
          stop_reason: candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: data.usageMetadata?.promptTokenCount || 0, output_tokens: (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0) },
        } as Anthropic.Message;
      },
    },
  };
}

export function createAgentClient(): AgentClient {
  validateAgentCredentials();
  return getAgentProvider() === 'gemini'
    ? createGeminiAgentClient(process.env.GEMINI_API_KEY!)
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
