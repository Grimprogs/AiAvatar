import type { ChatMessage } from '@/types';
import { generateChatMessage } from '@/services/geminiService';

/**
 * Abstraction layer for AI model calls.
 * Allows swapping between client-side (direct Gemini API) and
 * server-side (backend proxy) implementations.
 */
export interface ModelGateway {
  generateInterviewResponse(params: {
    apiKey: string;
    history: { role: 'user' | 'model'; text: string }[];
    contextPrompt: string;
    currentCode: string;
    useThinking: boolean;
  }): Promise<string | undefined>;
}

/** Calls the Gemini API directly from the browser. */
export class ClientModelGateway implements ModelGateway {
  public async generateInterviewResponse(params: {
    apiKey: string;
    history: { role: 'user' | 'model'; text: string }[];
    contextPrompt: string;
    currentCode: string;
    useThinking: boolean;
  }): Promise<string | undefined> {
    const { apiKey, history, contextPrompt, currentCode, useThinking } = params;
    return generateChatMessage(apiKey, history, contextPrompt, currentCode, useThinking);
  }
}

/**
 * Placeholder for a server-side implementation.
 * Swap this in once backend proxy endpoints are available.
 */
export class ServerModelGateway implements ModelGateway {
  public async generateInterviewResponse(_params: {
    apiKey: string;
    history: { role: 'user' | 'model'; text: string }[];
    contextPrompt: string;
    currentCode: string;
    useThinking: boolean;
  }): Promise<string | undefined> {
    throw new Error('ServerModelGateway is not configured yet.');
  }
}

/** Converts ChatMessage[] to the lightweight history format expected by services. */
export function toHistory(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role, text: m.text }));
}
