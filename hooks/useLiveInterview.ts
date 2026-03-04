import { useState, useRef, useCallback, useEffect } from 'react';
import { LiveService } from '@/services/liveService';
import type { CodeEditorHandle } from '@/components/CodeEditor';
import type { AvatarInterviewerHandle } from '@/components/AvatarInterviewer';
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
  avatarRef: React.RefObject<AvatarInterviewerHandle | null>;
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
  avatarRef,
  setMessages,
}: UseLiveInterviewParams) {
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isConnectingLive, setIsConnectingLive] = useState(false);
  const [volume, setVolume] = useState(0);
  const [speechLevel, setSpeechLevel] = useState(0);

  const liveServiceRef = useRef<LiveService | null>(null);
  const videoIntervalRef = useRef<number | null>(null);
  const frameAlternatorRef = useRef(false);
  const lastSentCodeRef = useRef<string>('');

  // Refs for values read inside async callbacks — avoids stale closures
  const currentProblemRef = useRef(currentProblem);
  const languageRef = useRef(language);
  useEffect(() => { currentProblemRef.current = currentProblem; }, [currentProblem]);
  useEffect(() => { languageRef.current = language; }, [language]);

  // Initialise LiveService once when apiKey is available
  useEffect(() => {
    if (apiKey && !liveServiceRef.current) {
      liveServiceRef.current = new LiveService(apiKey);
      liveServiceRef.current.onVolumeChange = (vol) => setVolume(vol);
      liveServiceRef.current.onOutputLevelChange = (level) => setSpeechLevel(level);
    }
  }, [apiKey]);

  // Cleanup on unmount — disconnect WebSocket and release microphone
  useEffect(() => {
    return () => {
      if (liveServiceRef.current) liveServiceRef.current.disconnect();
      if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
    };
  }, []);

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

    const problem = currentProblemRef.current;
    const lang = languageRef.current;

    try {
      setIsConnectingLive(true);

      const sessionInstruction = `
        ${SYSTEM_INSTRUCTION_INTERVIEWER}
        CONTEXT: Problem: ${problem.title}, Difficulty: ${problem.difficulty}, Lang: ${lang}
        Description: ${problem.description}
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
            role: 'user' as const,
            text: 'Start Interview',
            timestamp: Date.now(),
          },
        ]);
      }, 1000);

      // Begin periodic video frame capture alternating between Code Editor and WebCam
      videoIntervalRef.current = window.setInterval(async () => {
        if (liveServiceRef.current) {
          let base64Frame: string | null = null;
          frameAlternatorRef.current = !frameAlternatorRef.current;

          if (frameAlternatorRef.current && avatarRef.current) {
            base64Frame = avatarRef.current.captureWebcamFrame();
          }
          if (!base64Frame && editorRef.current) {
            base64Frame = await editorRef.current.captureFrame();
          }

          if (base64Frame) await liveServiceRef.current.sendVideoFrame(base64Frame);
        }
      }, VIDEO_FRAME_INTERVAL_MS);
    } catch {
      // Connection failed — state resets in finally block
    } finally {
      setIsConnectingLive(false);
    }
  }, [apiKey, editorRef, setMessages]);

  const handleDisconnectLive = useCallback(async () => {
    if (liveServiceRef.current) await liveServiceRef.current.disconnect();
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    setIsLiveConnected(false);
    setVolume(0);
    setSpeechLevel(0);
  }, []);

  return {
    isLiveConnected,
    isConnectingLive,
    volume,
    speechLevel,
    liveServiceRef,
    handleConnectLive,
    handleDisconnectLive,
  } as const;
}
