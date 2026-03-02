import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import type { InterviewLanguage } from '@/types';
import { Sun, Moon } from 'lucide-react';

interface CodeEditorProps {
  code: string;
  onChange: (code: string) => void;
  language: InterviewLanguage;
  onLanguageChange: (lang: InterviewLanguage) => void;
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
  className?: string;
}

export interface CodeEditorHandle {
  captureFrame: () => Promise<string | null>;
}

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(({ 
  code, 
  onChange, 
  language, 
  onLanguageChange,
  theme,
  onThemeToggle,
  className 
}, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Sync scrolling between textarea and line numbers
  const handleScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Expose a method to capture the editor as an image
  useImperativeHandle(ref, () => ({
    captureFrame: async () => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Draw background
      // Use raw colors for canvas since it needs explicit hex
      // We'll stick to dark mode for the vision model as it's standard for code
      ctx.fillStyle = '#09090b'; 
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw text
      ctx.fillStyle = '#e4e4e7';
      ctx.font = '14px "JetBrains Mono"';
      ctx.textBaseline = 'top';
      
      const lines = code.split('\n');
      const lineHeight = 24;
      const x = 20;
      let y = 20;

      lines.forEach((line, index) => {
        // Draw line number
        ctx.fillStyle = '#52525b';
        ctx.fillText((index + 1).toString(), 5, y);
        
        // Draw code
        ctx.fillStyle = '#e4e4e7';
        const cleanLine = line.length > 80 ? line.substring(0, 77) + '...' : line;
        ctx.fillText(cleanLine, 40, y);
        y += lineHeight;
      });

      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    }
  }));

  useEffect(() => {
    if (canvasRef.current) {
        canvasRef.current.width = 800;
        canvasRef.current.height = 600;
    }
  }, []);

  const lineCount = code.split('\n').length;

  return (
    <div className={`relative w-full h-full flex flex-col bg-app transition-colors duration-300 ${className}`}>
      {/* Hidden canvas for AI vision */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Main Editor Area */}
      <div className="flex-1 flex overflow-hidden relative">
        
        {/* Line Numbers Column */}
        <div 
            ref={lineNumbersRef}
            className="w-12 pt-4 pb-4 text-right pr-3 bg-app border-r border-subtle text-secondary font-mono text-sm leading-6 select-none overflow-hidden"
            style={{ fontFamily: '"JetBrains Mono", monospace', lineHeight: '1.5rem' }}
        >
            {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                <div key={i}>{i + 1}</div>
            ))}
        </div>

        {/* Code Textarea */}
        <textarea
          ref={textareaRef}
          value={code}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
          className="flex-1 w-full h-full bg-transparent text-primary font-mono text-sm leading-6 p-4 resize-none focus:outline-none placeholder-secondary/50 selection:bg-subtle selection:text-primary whitespace-pre transition-colors duration-300"
          style={{ fontFamily: '"JetBrains Mono", monospace', lineHeight: '1.5rem', tabSize: 4 }}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          placeholder="// Write your solution here..."
        />
      </div>

      {/* Status Bar & Controls */}
      <div className="h-10 border-t border-subtle bg-app flex items-center justify-between px-6 text-[11px] font-medium text-secondary uppercase select-none transition-colors duration-300 shrink-0">
        
        {/* Left: Stats */}
        <div className="flex items-center gap-6 tracking-wide">
            <span>UTF-8</span>
            <span>{code.length} chars</span>
        </div>

        {/* Right: Controls */}
        <div className="flex items-center gap-4">
            {/* Theme Toggle Button */}
            <button
                onClick={onThemeToggle}
                className="p-1.5 text-secondary hover:text-primary transition-colors rounded hover:bg-subtle/30"
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
                {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>

            <div className="w-px h-3 bg-subtle"></div>

            {/* Language Selector */}
            <div className="flex items-center gap-1 bg-subtle/20 p-0.5 rounded">
                <button 
                    onClick={() => onLanguageChange('python')}
                    className={`px-2 py-0.5 rounded-sm transition-all ${language === 'python' ? 'bg-panel text-primary shadow-sm' : 'text-secondary hover:text-primary'}`}
                >
                    Python
                </button>
                <button 
                    onClick={() => onLanguageChange('typescript')}
                    className={`px-2 py-0.5 rounded-sm transition-all ${language === 'typescript' ? 'bg-panel text-primary shadow-sm' : 'text-secondary hover:text-primary'}`}
                >
                    TypeScript
                </button>
            </div>
        </div>
      </div>
    </div>
  );
});

export default CodeEditor;