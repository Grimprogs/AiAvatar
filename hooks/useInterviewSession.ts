import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
 * Call `setLiveRefs()` inside a useEffect after the live hook initialises
 * to wire up live-connected state without creating a circular dependency.
 */
export function useInterviewSession({ apiKey }: UseInterviewSessionParams) {
  const [currentProblem, setCurrentProblem] = useState<InterviewProblem>(PROBLEMS[0]);
  const [language, setLanguage] = useState<InterviewLanguage>('python');
  const [code, setCode] = useState(PROBLEMS[0].starters.python);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoadingChat, setIsLoadingChat] = useState(false);

  // Refs for values read inside async callbacks — avoids stale closures
  // and keeps useCallback dependency arrays minimal.
  const isLiveConnectedRef = useRef(false);
  const liveServiceExtRef = useRef<LiveService | null>(null);
  const messagesRef = useRef(messages);
  const currentProblemRef = useRef(currentProblem);
  const languageRef = useRef(language);
  const codeRef = useRef(code);

  // Keep refs in sync with state
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { currentProblemRef.current = currentProblem; }, [currentProblem]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { codeRef.current = code; }, [code]);

  /**
   * Synchronise live-interview refs.
   * Must be called inside a useEffect in the parent component.
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
    // Filter out current problem so user always sees a different one
    const others = PROBLEMS.filter(p => p.id !== currentProblemRef.current.id);
    const pool = others.length > 0 ? others : PROBLEMS;
    const random = pool[Math.floor(Math.random() * pool.length)];
    setCurrentProblem(random);
    setCode(random.starters[languageRef.current]);
  }, []);

  const handleLanguageChange = useCallback(
    (lang: InterviewLanguage) => {
      if (lang === languageRef.current) return;
      setLanguage(lang);
      setCode(currentProblemRef.current.starters[lang]);
    },
    [],
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

      // Build history including the message we just added (fixes stale closure)
      const history = [...messagesRef.current, newUserMsg].map(m => ({
        role: m.role,
        text: m.text,
      }));

      const problem = currentProblemRef.current;
      const contextPrompt = `
      [Current Problem]
      Title: ${problem.title}
      Description: ${problem.description}
      Language: ${languageRef.current}
      `;

      setIsLoadingChat(true);
      try {
        const responseText = await generateChatMessage(
          apiKey,
          history,
          contextPrompt + '\n' + text,
          codeRef.current,
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
    [apiKey],
  );

  const latestModelText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'model' && messages[i].text.trim()) {
        return messages[i].text;
      }
    }
    return '';
  }, [messages]);

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
    latestModelText,
  } as const;
}
