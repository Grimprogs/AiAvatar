import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, BrainCircuit, GripHorizontal } from 'lucide-react';
import { ChatMessage } from '../types';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (text: string, useThinking: boolean) => void;
  isLoading: boolean;
}

const ChatPanel: React.FC<ChatPanelProps> = ({ messages, onSendMessage, isLoading }) => {
  const [input, setInput] = useState('');
  const [useThinking, setUseThinking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    onSendMessage(input, useThinking);
    setInput('');
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-full bg-panel border-l border-subtle transition-colors duration-300">
      
      {/* Header */}
      <div className="h-14 px-6 flex items-center justify-between border-b border-subtle bg-panel-head transition-colors duration-300">
        <span className="text-xs font-medium text-secondary uppercase tracking-widest">Transcript</span>
        
        <button
          onClick={() => setUseThinking(!useThinking)}
          className={`group flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-medium uppercase tracking-wide transition-all border ${
            useThinking
              ? 'bg-subtle text-primary border-subtle'
              : 'bg-transparent text-secondary border-transparent hover:border-subtle'
          }`}
        >
          {useThinking ? (
            <BrainCircuit className="w-3 h-3 text-emerald-500" />
          ) : (
            <Sparkles className="w-3 h-3 group-hover:text-primary" />
          )}
          <span>Reasoning {useThinking ? 'On' : 'Off'}</span>
        </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 bg-panel transition-colors duration-300">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-secondary">
            <div className="w-12 h-12 rounded-2xl bg-app flex items-center justify-center mb-4 border border-subtle">
                <GripHorizontal className="w-5 h-5 opacity-50" />
            </div>
            <p className="text-sm">Ready to interview.</p>
          </div>
        )}
        
        {messages.map((msg) => (
          <div key={msg.id} className={`flex flex-col gap-2 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`text-[10px] font-medium tracking-wide uppercase ${msg.role === 'user' ? 'text-secondary' : 'text-secondary'}`}>
                {msg.role === 'user' ? 'Candidate' : 'Interviewer'}
            </div>
            <div
              className={`max-w-[90%] text-sm leading-7 ${
                msg.role === 'user'
                  ? 'text-primary bg-app px-5 py-3 rounded-2xl rounded-tr-sm border border-subtle shadow-sm'
                  : 'text-primary px-0 py-0'
              }`}
            >
              {msg.isThinking && msg.role === 'model' && (
                <div className="flex items-center gap-2 text-xs text-secondary mb-2 font-mono">
                    <BrainCircuit className="w-3 h-3" />
                    <span>Thought Process</span>
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.text}</div>
            </div>
          </div>
        ))}
        
        {isLoading && (
           <div className="flex flex-col items-start gap-2">
             <div className="text-[10px] font-medium tracking-wide uppercase text-secondary">Interviewer</div>
             <div className="flex items-center gap-1.5 px-1 h-6">
                 <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                 <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                 <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-bounce"></span>
             </div>
           </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-6 bg-panel border-t border-subtle transition-colors duration-300">
        <form onSubmit={handleSubmit} className="relative group">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your response..."
            className="w-full bg-app border border-subtle text-primary rounded-lg pl-4 pr-12 py-3.5 focus:border-secondary transition-all text-sm placeholder-secondary shadow-sm"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 top-2 p-1.5 text-secondary hover:text-primary disabled:opacity-30 disabled:hover:text-secondary transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatPanel;