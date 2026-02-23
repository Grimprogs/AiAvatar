import { GoogleGenAI, Type } from "@google/genai";
import { SYSTEM_INSTRUCTION_INTERVIEWER } from "../types";

export const generateChatMessage = async (
  apiKey: string,
  history: { role: 'user' | 'model'; text: string }[],
  currentMessage: string,
  currentCode: string,
  useThinking: boolean = false
) => {
  const ai = new GoogleGenAI({ apiKey });
  
  // Construct the prompt with context
  const fullMessage = `
[CURRENT CODE CONTEXT]
${currentCode}
[END CODE CONTEXT]

${currentMessage}
`;

  const modelName = useThinking ? 'gemini-3-pro-preview' : 'gemini-2.5-flash';
  
  const config: any = {
    systemInstruction: SYSTEM_INSTRUCTION_INTERVIEWER,
  };

  if (useThinking) {
    config.thinkingConfig = { thinkingBudget: 32768 };
  }

  // We are not using chat session persistence in this simple service wrapper to keep it stateless/flexible
  // but in a real app you might want to use ai.chats.create()
  // Here we just use generateContent for simplicity with history injection if needed, 
  // but for the best "Chat" experience with history, let's use ai.chats.create.
  
  const chat = ai.chats.create({
    model: modelName,
    config: config,
    history: history.map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
    }))
  });

  const result = await chat.sendMessage({
    message: fullMessage
  });

  return result.text;
};
