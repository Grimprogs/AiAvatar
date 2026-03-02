export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  isThinking?: boolean;
  source?: 'text_chat' | 'live_audio' | 'system';
  status?: 'final' | 'partial';
}

export type LiveSessionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

export interface LiveConfig {
  model: string;
  systemInstruction?: string;
  voiceName?: string;
}

export interface AudioVisualizerState {
  volume: number; // 0-1
  isPlaying: boolean;
}
