import { GoogleGenAI } from '@google/genai';
import {
  SYSTEM_INSTRUCTION_INTERVIEWER,
  GEMINI_CHAT_MODEL,
  GEMINI_THINKING_MODEL,
  THINKING_BUDGET,
} from '@/constants';

/**
 * Sends a single chat message to the Gemini API and returns the response text.
 *
 * Creates a fresh chat session each call (stateless wrapper). The current code
 * is injected as context alongside the user's message so the interviewer model
 * can reference what the candidate has written.
 *
 * @param apiKey         - Gemini API key
 * @param history        - Prior conversation turns
 * @param currentMessage - The new user message (may include a context prefix)
 * @param currentCode    - The candidate's current editor contents
 * @param useThinking    - When true, uses the thinking-capable model with an extended budget
 */
export const generateChatMessage = async (
  apiKey: string,
  history: { role: 'user' | 'model'; text: string }[],
  currentMessage: string,
  currentCode: string,
  useThinking: boolean = false,
) => {
  const ai = new GoogleGenAI({ apiKey });

  const fullMessage = `
[CURRENT CODE CONTEXT]
${currentCode}
[END CODE CONTEXT]

${currentMessage}
`;

  const modelName = useThinking ? GEMINI_THINKING_MODEL : GEMINI_CHAT_MODEL;

  const config: Record<string, unknown> = {
    systemInstruction: SYSTEM_INSTRUCTION_INTERVIEWER,
  };

  if (useThinking) {
    config.thinkingConfig = { thinkingBudget: THINKING_BUDGET };
  }

  const chat = ai.chats.create({
    model: modelName,
    config,
    history: history.map(h => ({
      role: h.role,
      parts: [{ text: h.text }],
    })),
  });

  const result = await chat.sendMessage({ message: fullMessage });
  return result.text;
};
