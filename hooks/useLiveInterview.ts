import { useState, useRef, useCallback, useEffect } from 'react';
import { LiveService } from '@/services/liveService';
import type { CodeEditorHandle } from '@/components/CodeEditor';
import type { ChatMessage, InterviewLanguage, InterviewProblem } from '@/types';
import {
  SYSTEM_INSTRUCTION_INTERVIEWER,
  CODE_DEBOUNCE_MS,
  VIDEO_FRAME_INTERVAL_MS,
} from '@/constants';

interface UseLiveInterviewParams {
  apiKey: string;
  currentProblem: InterviewProblem;
  language: InterviewLanguage;
  code: string;
  editorRef: React.RefObject<CodeEditorHandle | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

/**
 * Manages the Gemini Live audio interview session.
 *
 * Handles:
 * - LiveService initialisation and volume binding
 * - Connect / disconnect lifecycle
 * - Periodic video-frame capture (1 s interval)
 * - Debounced code-context updates (3 s)
 */
export function useLiveInterview({
  apiKey,
  currentProblem,
  language,
  code,
  editorRef,
  setMessages,
}: UseLiveInterviewParams) {
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isConnectingLive, setIsConnectingLive] = useState(false);
  const [volume, setVolume] = useState(0);

  const liveServiceRef = useRef<LiveService | null>(null);
  const videoIntervalRef = useRef<number | null>(null);
  const lastSentCodeRef = useRef<string>('');

  // Initialise LiveService once when apiKey is available
  useEffect(() => {
    if (apiKey && !liveServiceRef.current) {
      liveServiceRef.current = new LiveService(apiKey);
      liveServiceRef.current.onVolumeChange = (vol) => setVolume(vol);
    }
  }, [apiKey]);

  // Debounced code watcher — sends code updates during live sessions
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isLiveConnected && liveServiceRef.current && code !== lastSentCodeRef.current) {
        liveServiceRef.current.sendCodeContext(code);
        lastSentCodeRef.current = code;
      }
    }, CODE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [code, isLiveConnected]);

  const handleConnectLive = useCallback(async () => {
    if (!apiKey || !liveServiceRef.current) return;

    try {
      setIsConnectingLive(true);

      const sessionInstruction = `
        ${SYSTEM_INSTRUCTION_INTERVIEWER}
        CONTEXT: Problem: ${currentProblem.title}, Difficulty: ${currentProblem.difficulty}, Lang: ${language}
        Description: ${currentProblem.description}
        IMPORTANT: Start the interview IMMEDIATELY. Speak first. Introduce yourself and the problem.
      `;

      await liveServiceRef.current.connect({
        systemInstruction: sessionInstruction,
        initialMessage: 'Hello, I am ready to start the interview.',
      });

      setIsLiveConnected(true);

      // Visual confirmation in the transcript
      setTimeout(() => {
        setMessages(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'user',
            text: 'Start Interview',
            timestamp: Date.now(),
          },
        ]);
      }, 1000);

      // Begin periodic video frame capture
      videoIntervalRef.current = window.setInterval(async () => {
        if (editorRef.current && liveServiceRef.current) {
          const base64Frame = await editorRef.current.captureFrame();
          if (base64Frame) await liveServiceRef.current.sendVideoFrame(base64Frame);
        }
      }, VIDEO_FRAME_INTERVAL_MS);
    } catch {
      // Connection failed — state resets in finally block
    } finally {
      setIsConnectingLive(false);
    }
  }, [apiKey, currentProblem, language, editorRef, setMessages]);

  const handleDisconnectLive = useCallback(async () => {
    if (liveServiceRef.current) await liveServiceRef.current.disconnect();
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    setIsLiveConnected(false);
    setVolume(0);
  }, []);

  return {
    isLiveConnected,
    isConnectingLive,
    volume,
    liveServiceRef,
    handleConnectLive,
    handleDisconnectLive,
  } as const;
}
