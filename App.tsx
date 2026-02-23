import React, { useState, useEffect, useRef } from 'react';
import CodeEditor, { CodeEditorHandle } from './components/CodeEditor';
import ChatPanel from './components/ChatPanel';
import LiveControls from './components/LiveControls';
import { ChatMessage, InterviewLanguage, InterviewProblem, SYSTEM_INSTRUCTION_INTERVIEWER } from './types';
import { generateChatMessage } from './services/geminiService';
import { LiveService } from './services/liveService';
import { RefreshCw, Terminal } from 'lucide-react';
import { PROBLEMS } from './constants';

const API_KEY = process.env.API_KEY || '';

const App: React.FC = () => {
  const [currentProblem, setCurrentProblem] = useState<InterviewProblem>(PROBLEMS[0]);
  // Set Python as default
  const [language, setLanguage] = useState<InterviewLanguage>('python');
  const [code, setCode] = useState(currentProblem.starters.python);
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  
  // Live Service State
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isConnectingLive, setIsConnectingLive] = useState(false);
  const [volume, setVolume] = useState(0);

  const liveServiceRef = useRef<LiveService | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const videoIntervalRef = useRef<number | null>(null);
  const lastSentCodeRef = useRef<string>('');

  // Initialize LiveService on mount
  useEffect(() => {
    if (API_KEY && !liveServiceRef.current) {
        liveServiceRef.current = new LiveService(API_KEY);
        // Bind volume listener
        liveServiceRef.current.onVolumeChange = (vol) => setVolume(vol);
    }
    
    // Apply theme
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }, [theme]);

  // Debounced Code Watcher
  useEffect(() => {
    const timer = setTimeout(() => {
        // Only send if connected, code has changed significantly, and service is ready
        if (isLiveConnected && liveServiceRef.current && code !== lastSentCodeRef.current) {
             console.log("Auto-sending code update to Interviewer...");
             liveServiceRef.current.sendCodeContext(code);
             lastSentCodeRef.current = code;
        }
    }, 3000); // 3 second debounce

    return () => clearTimeout(timer);
  }, [code, isLiveConnected]);

  useEffect(() => {
    setMessages([{
        id: '1',
        role: 'model',
        text: `Hello. I am your AI Technical Interviewer. We will be working on "${currentProblem.title}".\n\nPlease let me know when you are ready to begin.`,
        timestamp: Date.now()
    }]);
  }, [currentProblem]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleRandomProblem = () => {
    const random = PROBLEMS[Math.floor(Math.random() * PROBLEMS.length)];
    setCurrentProblem(random);
    setCode(random.starters[language]);
  };

  const handleLanguageChange = (lang: InterviewLanguage) => {
    if (lang === language) return;
    setLanguage(lang);
    setCode(currentProblem.starters[lang]);
  };

  const handleSendMessage = async (text: string, useThinking: boolean) => {
    const newUserMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text, timestamp: Date.now() };
    setMessages(prev => [...prev, newUserMsg]);
    console.log("Handle Send Message: Live Connected?", isLiveConnected);

    // If Live Interview is active, send text to the voice model
    if (isLiveConnected && liveServiceRef.current) {
      await liveServiceRef.current.sendText(text);
      // The model will respond via audio, so we don't generate a text response bubble.
      return;
    }

    // Otherwise, standard text chat
    setIsLoadingChat(true);
    try {
      const history = messages.map(m => ({ role: m.role, text: m.text }));
      const contextPrompt = `
      [Current Problem]
      Title: ${currentProblem.title}
      Description: ${currentProblem.description}
      Language: ${language}
      `;

      const responseText = await generateChatMessage(API_KEY, history, contextPrompt + "\n" + text, code, useThinking);
      
      const newBotMsg: ChatMessage = { 
        id: (Date.now() + 1).toString(), 
        role: 'model', 
        text: responseText || "No response generated.", 
        timestamp: Date.now(),
        isThinking: useThinking
      };
      setMessages(prev => [...prev, newBotMsg]);

      // Speak the response using TTS
      if (liveServiceRef.current && responseText) {
         liveServiceRef.current.speak(responseText);
      }

    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsLoadingChat(false);
    }
  };

  const handleConnectLive = async () => {
    if (!API_KEY) { alert("API Key is missing!"); return; }
    if (!liveServiceRef.current) return;

    try {
        setIsConnectingLive(true);
        console.log("Connecting to Live Service...");

        const sessionInstruction = `
        ${SYSTEM_INSTRUCTION_INTERVIEWER}
        CONTEXT: Problem: ${currentProblem.title}, Difficulty: ${currentProblem.difficulty}, Lang: ${language}
        Description: ${currentProblem.description}
        IMPORTANT: Start the interview IMMEDIATELY. Speak first. Introduce yourself and the problem.
        `;

        await liveServiceRef.current.connect({ 
          systemInstruction: sessionInstruction,
          initialMessage: "Hello, I am ready to start the interview." 
        });
        
        setIsLiveConnected(true);

        // Add visual confirmation to chat after a delay
        setTimeout(() => {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'user',
                text: "Start Interview",
                timestamp: Date.now()
            }]);
        }, 1000);
        
        videoIntervalRef.current = window.setInterval(async () => {
            if (editorRef.current && liveServiceRef.current) {
                const base64Frame = await editorRef.current.captureFrame();
                if (base64Frame) await liveServiceRef.current.sendVideoFrame(base64Frame);
            }
        }, 1000); 

    } catch (error) {
        console.error("Failed to connect live:", error);
    } finally {
        setIsConnectingLive(false);
    }
  };

  const handleDisconnectLive = async () => {
    if (liveServiceRef.current) await liveServiceRef.current.disconnect();
    if (videoIntervalRef.current) { clearInterval(videoIntervalRef.current); videoIntervalRef.current = null; }
    setIsLiveConnected(false);
    setVolume(0);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-app text-primary font-sans overflow-hidden transition-colors duration-300">
        {/* Minimalist Header */}
        <header className="relative h-16 border-b border-subtle bg-app flex items-center justify-between px-6 shrink-0 z-50">
            {/* Left Section */}
            <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-primary">
                    <Terminal className="w-5 h-5 text-secondary" />
                    <span className="font-medium tracking-tight text-sm">DevInterview.AI</span>
                </div>
                
                <div className="h-4 w-px bg-subtle mx-2"></div>

                {/* Problem Selector - Clean */}
                <div className="flex items-center gap-3">
                   <span className="text-sm font-medium text-primary">{currentProblem.title}</span>
                   <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        currentProblem.difficulty === 'Easy' ? 'border-emerald-900/50 text-emerald-500' :
                        currentProblem.difficulty === 'Medium' ? 'border-amber-900/50 text-amber-500' :
                        'border-rose-900/50 text-rose-500'
                    } uppercase tracking-wider`}>
                        {currentProblem.difficulty}
                   </span>
                   <button 
                     onClick={handleRandomProblem}
                     className="p-1.5 text-secondary hover:text-primary transition-colors"
                     title="Next Problem"
                   >
                     <RefreshCw className="w-3.5 h-3.5" />
                   </button>
                </div>
            </div>

            {/* Center Section - Live Controls */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                <LiveControls 
                    isConnected={isLiveConnected}
                    isConnecting={isConnectingLive}
                    onConnect={handleConnectLive}
                    onDisconnect={handleDisconnectLive}
                    volume={volume}
                />
            </div>
        </header>

        {/* Main Workspace */}
        <main className="flex-1 flex overflow-hidden">
            {/* Left: Code Editor */}
            <div className="flex-1 flex flex-col relative min-w-0">
                {/* Description Banner */}
                <div className="px-8 py-6 border-b border-subtle bg-app transition-colors duration-300">
                   <p className="text-sm text-secondary leading-relaxed max-w-3xl">
                      {currentProblem.description}
                   </p>
                </div>
                
                <div className="flex-1 relative">
                    <CodeEditor 
                        ref={editorRef}
                        code={code} 
                        onChange={setCode}
                        language={language}
                        onLanguageChange={handleLanguageChange}
                        theme={theme}
                        onThemeToggle={toggleTheme}
                    />
                </div>
            </div>

            {/* Right: Chat Panel */}
            <div className="w-[400px] xl:w-[450px] flex-shrink-0 flex flex-col border-l border-subtle bg-panel z-10 shadow-2xl shadow-black/5 transition-colors duration-300">
                <ChatPanel 
                    messages={messages} 
                    onSendMessage={handleSendMessage}
                    isLoading={isLoadingChat}
                />
            </div>
        </main>
    </div>
  );
};

export default App;