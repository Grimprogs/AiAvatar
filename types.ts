import { Modality } from "@google/genai";

export enum InterviewMode {
  LIVE = 'LIVE',
  CHAT = 'CHAT'
}

export type InterviewLanguage = 'typescript' | 'python';

export interface InterviewProblem {
  id: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  starters: Record<InterviewLanguage, string>;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  isThinking?: boolean;
}

export interface LiveConfig {
  model: string;
  systemInstruction?: string;
  voiceName?: string;
}

export interface AudioVisualizerState {
  volume: number; // 0-1
  isPlaying: boolean;
}

export const SYSTEM_INSTRUCTION_INTERVIEWER = `You are an expert Senior Software Engineer at Google conducting a technical coding interview. 
Your goal is to assess the candidate's problem-solving skills, coding proficiency, and communication.

Guidelines:
- Act exactly like a real interviewer. Be professional, polite, but rigorous.
- The candidate has selected a specific problem. You have access to the problem description and their code.
- Start by briefly introducing yourself and asking the candidate if they are familiar with the problem or how they plan to approach it.
- Do NOT give the solution away. If they are stuck, provide subtle hints (e.g., "Have you considered using a hash map here?" or "What is the time complexity of this approach?").
- If they make a syntax error, let them find it, or gently point it out if they struggle.
- Focus on Time and Space complexity analysis.
- When the candidate finishes, ask them to walk through test cases.
- Keep your voice responses concise (1-3 sentences) unless explaining a complex concept.`;