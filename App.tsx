import React, { useRef } from 'react';
import CodeEditor, { type CodeEditorHandle } from '@/components/CodeEditor';
import ChatPanel from '@/components/ChatPanel';
import LiveControls from '@/components/LiveControls';
import { useTheme } from '@/hooks/useTheme';
import { useLiveInterview } from '@/hooks/useLiveInterview';
import { useInterviewSession } from '@/hooks/useInterviewSession';
import { RefreshCw, Terminal } from 'lucide-react';

const API_KEY = process.env.API_KEY || '';

/**
 * Root application component.
 * Composes the code editor, chat transcript, and live interview controls
 * into a single-page interview workspace.
 */
const App: React.FC = () => {
  const editorRef = useRef<CodeEditorHandle>(null);
  const { theme, toggleTheme } = useTheme();

  const session = useInterviewSession({ apiKey: API_KEY });

  const live = useLiveInterview({
    apiKey: API_KEY,
    currentProblem: session.currentProblem,
    language: session.language,
    code: session.code,
    editorRef,
    setMessages: session.setMessages,
  });

  // Wire live refs into session for message routing
  session.setLiveRefs(live.isLiveConnected, live.liveServiceRef);

  return (
    <div className="h-screen w-full flex flex-col bg-app text-primary font-sans overflow-hidden transition-colors duration-300">
      <Header
        currentProblem={session.currentProblem}
        onRandomProblem={session.handleRandomProblem}
        live={live}
      />

      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col relative min-w-0">
          <DescriptionBanner description={session.currentProblem.description} />
          <div className="flex-1 relative">
            <CodeEditor
              ref={editorRef}
              code={session.code}
              onChange={session.setCode}
              language={session.language}
              onLanguageChange={session.handleLanguageChange}
              theme={theme}
              onThemeToggle={toggleTheme}
            />
          </div>
        </div>

        <div className="w-[400px] xl:w-[450px] flex-shrink-0 flex flex-col border-l border-subtle bg-panel z-10 shadow-2xl shadow-black/5 transition-colors duration-300">
          <ChatPanel
            messages={session.messages}
            onSendMessage={session.handleSendMessage}
            isLoading={session.isLoadingChat}
          />
        </div>
      </main>
    </div>
  );
};

export default App;

// --- Sub-components extracted from the layout ---

interface HeaderProps {
  currentProblem: { title: string; difficulty: 'Easy' | 'Medium' | 'Hard' };
  onRandomProblem: () => void;
  live: {
    isLiveConnected: boolean;
    isConnectingLive: boolean;
    volume: number;
    handleConnectLive: () => void;
    handleDisconnectLive: () => void;
  };
}

function Header({ currentProblem, onRandomProblem, live }: HeaderProps) {
  const difficultyClass =
    currentProblem.difficulty === 'Easy'
      ? 'border-emerald-900/50 text-emerald-500'
      : currentProblem.difficulty === 'Medium'
        ? 'border-amber-900/50 text-amber-500'
        : 'border-rose-900/50 text-rose-500';

  return (
    <header className="relative h-16 border-b border-subtle bg-app flex items-center justify-between px-6 shrink-0 z-50">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-primary">
          <Terminal className="w-5 h-5 text-secondary" />
          <span className="font-medium tracking-tight text-sm">DevInterview.AI</span>
        </div>
        <div className="h-4 w-px bg-subtle mx-2" />
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-primary">{currentProblem.title}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${difficultyClass} uppercase tracking-wider`}>
            {currentProblem.difficulty}
          </span>
          <button onClick={onRandomProblem} className="p-1.5 text-secondary hover:text-primary transition-colors" title="Next Problem">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <LiveControls
          isConnected={live.isLiveConnected}
          isConnecting={live.isConnectingLive}
          onConnect={live.handleConnectLive}
          onDisconnect={live.handleDisconnectLive}
          volume={live.volume}
        />
      </div>
    </header>
  );
}

function DescriptionBanner({ description }: { description: string }) {
  return (
    <div className="px-8 py-6 border-b border-subtle bg-app transition-colors duration-300">
      <p className="text-sm text-secondary leading-relaxed max-w-3xl">{description}</p>
    </div>
  );
}
