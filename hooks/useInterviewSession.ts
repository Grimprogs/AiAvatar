import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatMessage, InterviewLanguage, InterviewProblem } from '@/types';
import type { LiveService } from '@/services/liveService';
import { generateChatMessage } from '@/services/geminiService';
import { PROBLEMS } from '@/constants';

interface UseInterviewSessionParams {
  apiKey: string;
}

/**
 * Manages the interview session state: problem selection, language,
 * code editor content, chat messages, and message sending (text or live).
 *
 * Call `setLiveRefs()` after the live hook initialises to wire up
 * live-connected state without creating a circular dependency.
 */
export function useInterviewSession({ apiKey }: UseInterviewSessionParams) {
  const [currentProblem, setCurrentProblem] = useState<InterviewProblem>(PROBLEMS[0]);
  const [language, setLanguage] = useState<InterviewLanguage>('python');
  const [code, setCode] = useState(PROBLEMS[0].starters.python);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoadingChat, setIsLoadingChat] = useState(false);

  // Live state refs — updated externally via setLiveRefs()
  const isLiveConnectedRef = useRef(false);
  const liveServiceExtRef = useRef<LiveService | null>(null);

  /**
   * Synchronise live-interview refs each render.
   * Called from App after both hooks are initialised.
   */
  const setLiveRefs = useCallback(
    (connected: boolean, service: React.RefObject<LiveService | null>) => {
      isLiveConnectedRef.current = connected;
      liveServiceExtRef.current = service.current;
    },
    [],
  );

  // Reset messages when problem changes
  useEffect(() => {
    setMessages([
      {
        id: '1',
        role: 'model',
        text: `Hello. I am your AI Technical Interviewer. We will be working on "${currentProblem.title}".\n\nPlease let me know when you are ready to begin.`,
        timestamp: Date.now(),
      },
    ]);
  }, [currentProblem.title]);

  const handleRandomProblem = useCallback(() => {
    const random = PROBLEMS[Math.floor(Math.random() * PROBLEMS.length)];
    setCurrentProblem(random);
    setCode(random.starters[language]);
  }, [language]);

  const handleLanguageChange = useCallback(
    (lang: InterviewLanguage) => {
      if (lang === language) return;
      setLanguage(lang);
      setCode(currentProblem.starters[lang]);
    },
    [language, currentProblem],
  );

  const handleSendMessage = useCallback(
    async (text: string, useThinking: boolean) => {
      const newUserMsg: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        text,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, newUserMsg]);

      // If live interview is active, route text to the voice model
      if (isLiveConnectedRef.current && liveServiceExtRef.current) {
        await liveServiceExtRef.current.sendText(text);
        return;
      }

      // Standard text chat path
      setIsLoadingChat(true);
      try {
        const history = messages.map(m => ({ role: m.role, text: m.text }));
        const contextPrompt = `
        [Current Problem]
        Title: ${currentProblem.title}
        Description: ${currentProblem.description}
        Language: ${language}
        `;

        const responseText = await generateChatMessage(
          apiKey,
          history,
          contextPrompt + '\n' + text,
          code,
          useThinking,
        );

        const newBotMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'model',
          text: responseText || 'No response generated.',
          timestamp: Date.now(),
          isThinking: useThinking,
        };
        setMessages(prev => [...prev, newBotMsg]);

        // Speak the response via TTS
        if (liveServiceExtRef.current && responseText) {
          liveServiceExtRef.current.speak(responseText);
        }
      } catch {
        const errorMsg: ChatMessage = {
          id: (Date.now() + 2).toString(),
          role: 'model',
          text: 'An error occurred while generating a response. Please try again.',
          timestamp: Date.now(),
        };
        setMessages(prev => [...prev, errorMsg]);
      } finally {
        setIsLoadingChat(false);
      }
    },
    [apiKey, messages, currentProblem, language, code],
  );

  return {
    currentProblem,
    language,
    code,
    setCode,
    messages,
    setMessages,
    isLoadingChat,
    handleRandomProblem,
    handleLanguageChange,
    handleSendMessage,
    setLiveRefs,
  } as const;
}
