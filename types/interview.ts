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
