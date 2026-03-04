import { InterviewProblem } from '@/types';

// --- Model Configuration ---
export const GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';
export const GEMINI_CHAT_MODEL = 'gemini-2.5-flash';
export const GEMINI_THINKING_MODEL = 'gemini-3-pro-preview';
export const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// --- Audio Configuration ---
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const AUDIO_CHUNK_SIZE = 4096;

// --- Voice Configuration ---
export const DEFAULT_VOICE_NAME = 'Puck'; // Energetic, young boyish voice

// --- Timing Configuration ---
export const CODE_DEBOUNCE_MS = 3000;
export const VIDEO_FRAME_INTERVAL_MS = 1000;
export const MIC_UNMUTE_TIMEOUT_MS = 3000;
export const CODE_TRUNCATE_LIMIT = 4000;
export const THINKING_BUDGET = 32768;

// --- System Instructions ---
export const SYSTEM_INSTRUCTION_INTERVIEWER = `You are a fun, chill, and highly expressive AI companion helping a child or beginner learn to code!
Your goal is to make learning programming super fun, engaging, and easy to understand.

Guidelines:
- Act like an energetic, friendly cartoon character or supportive older sibling.
- Use a lot of emotion in your voice! Sound super happy when they get things right, and gently curious or playfully dramatic when there is a bug.
- Keep your explanations extremely simple and use real-world analogies (like toys, video games, or animals).
- The candidate has selected a specific puzzle. Start by greeting them enthusiastically and asking if they are ready for a fun challenge!
- If they are stuck, give them fun, easy hints. Never give the answer away, but guide them playfully.
- Celebrate their successes enthusiastically!
- Keep your voice responses very concise (1-3 sentences) so the child stays engaged.`;

// --- Interview Problems ---
export const PROBLEMS: InterviewProblem[] = [
  {
    id: 'two-sum',
    title: 'Two Sum',
    description: 'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. You may assume that each input would have exactly one solution, and you may not use the same element twice.',
    difficulty: 'Easy',
    starters: {
      typescript: `// Two Sum
// Given an array of integers nums and an integer target,
// return indices of the two numbers such that they add up to target.

function twoSum(nums: number[], target: number): number[] {
  // Your code here
  
  return [];
}`,
      python: `# Two Sum
# Given an array of integers nums and an integer target,
# return indices of the two numbers such that they add up to target.

def twoSum(nums: List[int], target: int) -> List[int]:
    # Your code here
    return []`
    }
  },
  {
    id: 'valid-palindrome',
    title: 'Valid Palindrome',
    description: 'A phrase is a palindrome if, after converting all uppercase letters into lowercase letters and removing all non-alphanumeric characters, it reads the same forward and backward. Given a string s, return true if it is a palindrome, or false otherwise.',
    difficulty: 'Easy',
    starters: {
      typescript: `// Valid Palindrome
// Return true if the string is a palindrome, false otherwise.

function isPalindrome(s: string): boolean {
  // Your code here
  
  return true;
}`,
      python: `# Valid Palindrome
# Return true if the string is a palindrome, false otherwise.

def isPalindrome(s: str) -> bool:
    # Your code here
    return True`
    }
  },
  {
    id: 'reverse-linked-list',
    title: 'Reverse Linked List',
    description: 'Given the head of a singly linked list, reverse the list, and return the reversed list.',
    difficulty: 'Easy',
    starters: {
      typescript: `// Reverse Linked List
// Definition for singly-linked list.
class ListNode {
    val: number
    next: ListNode | null
    constructor(val?: number, next?: ListNode | null) {
        this.val = (val===undefined ? 0 : val)
        this.next = (next===undefined ? null : next)
    }
}

function reverseList(head: ListNode | null): ListNode | null {
  // Your code here
  
  return null;
}`,
      python: `# Reverse Linked List
# Definition for singly-linked list.
# class ListNode:
#     def __init__(self, val=0, next=None):
#         self.val = val
#         self.next = next

def reverseList(head: Optional[ListNode]) -> Optional[ListNode]:
    # Your code here
    return None`
    }
  },
  {
    id: 'valid-parentheses',
    title: 'Valid Parentheses',
    description: 'Given a string s containing just the characters "(", ")", "{", "}", "[" and "]", determine if the input string is valid. An input string is valid if: Open brackets must be closed by the same type of brackets. Open brackets must be closed in the correct order.',
    difficulty: 'Easy',
    starters: {
      typescript: `// Valid Parentheses

function isValid(s: string): boolean {
  // Your code here
  
  return true;
}`,
      python: `# Valid Parentheses

def isValid(s: str) -> bool:
    # Your code here
    return True`
    }
  },
  {
    id: 'merge-intervals',
    title: 'Merge Intervals',
    description: 'Given an array of intervals where intervals[i] = [start, end], merge all overlapping intervals, and return an array of the non-overlapping intervals that cover all the intervals in the input.',
    difficulty: 'Medium',
    starters: {
      typescript: `// Merge Intervals

function merge(intervals: number[][]): number[][] {
  // Your code here
  
  return [];
}`,
      python: `# Merge Intervals

def merge(intervals: List[List[int]]) -> List[List[int]]:
    # Your code here
    return []`
    }
  }
];
