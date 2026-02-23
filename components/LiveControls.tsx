import React from 'react';
import { Mic, MicOff, Activity, X, Square } from 'lucide-react';

interface LiveControlsProps {
  isConnected: boolean;
  isConnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  volume: number; // 0-1
}

const LiveControls: React.FC<LiveControlsProps> = ({ 
  isConnected, 
  isConnecting, 
  onConnect, 
  onDisconnect,
  volume
}) => {
  if (isConnected) {
    return (
      <div className="flex items-center gap-4 px-5 py-2 bg-panel border border-subtle rounded-full shadow-lg animate-in fade-in zoom-in duration-300">
        {/* Audio Visualizer */}
        <div className="flex items-center gap-0.5 h-5 w-24">
          {Array.from({ length: 12 }).map((_, i) => {
              const activeHeight = Math.max(15, Math.min(100, volume * 100 * (1.5 + Math.sin(i * 0.5))));
              return (
                  <div 
                      key={i} 
                      className="w-1 rounded-full bg-primary transition-all duration-75 ease-out"
                      style={{ height: `${activeHeight}%`, opacity: 0.8 }}
                  />
              );
          })}
        </div>
        
        <div className="w-px h-4 bg-subtle"></div>

        <button
          onClick={onDisconnect}
          className="flex items-center justify-center w-6 h-6 rounded-full bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all"
          title="End Interview"
        >
          <Square className="w-3 h-3 fill-current" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onConnect}
      disabled={isConnecting}
      className={`
        group relative flex items-center gap-2.5 px-5 py-2 rounded-full 
        font-medium text-sm tracking-wide transition-all duration-300
        ${isConnecting 
            ? 'bg-panel border border-subtle text-secondary cursor-wait' 
            : 'bg-primary text-app hover:scale-105 shadow-lg shadow-primary/10'
        }
      `}
    >
      {isConnecting ? (
        <>
           <Activity className="w-4 h-4 animate-spin" />
           <span>Connecting...</span>
        </>
      ) : (
        <>
           <span>Start Interview</span>
           <Mic className="w-3.5 h-3.5" />
        </>
      )}
    </button>
  );
};

export default LiveControls;