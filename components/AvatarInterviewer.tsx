/**
 * AvatarInterviewer.tsx — v7
 * Audio       → useVRMVoice
 * Expressions → useVRMFace  (via VRMAvatarMesh)
 * Bone Pose   → useVRMPose  (via VRMAvatarMesh)
 */
import { useRef, useState, useCallback, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useMediaPipeTracking } from '../hooks/useMediaPipeTracking';
import { useVRMVoice } from '../hooks/useVRMVoice';
import { VRMAvatarMesh } from './VRMAvatarMesh';

// Re-export so external consumers keep the same import paths
export type { EmotionMode, BehaviorMode } from '../hooks/useVRMFace';
import type { EmotionMode, BehaviorMode } from '../hooks/useVRMFace';
import type { AudioMode } from '../hooks/useVRMVoice';



function LoadingSpinner() {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame((_, d) => { ref.current.rotation.x += d * 1.2; ref.current.rotation.y += d * 0.8; });
  return (
    <mesh ref={ref}>
      <torusGeometry args={[0.5, 0.1, 16, 60]} />
      <meshStandardMaterial color="#6366f1" wireframe />
    </mesh>
  );
}

const TRACK_BADGE: Record<string, { label: string; cls: string }> = {
  idle:    { label: '📷 Camera Off',   cls: 'text-slate-400  bg-slate-400/10  border-slate-400/30'   },
  loading: { label: '⏳ Loading MP…',  cls: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/40'  },
  ready:   { label: '📷 Camera Ready', cls: 'text-teal-400   bg-teal-400/10   border-teal-400/40'    },
  active:  { label: '🟢 Face Tracking',cls: 'text-lime-400   bg-lime-400/10   border-lime-400/40 animate-pulse' },
  error:   { label: '❌ Track Error',  cls: 'text-rose-400   bg-rose-400/10   border-rose-400/40'    },
};

const EMOTION_LABELS: Record<EmotionMode, string> = { neutral: '😐 Neutral', angry: '😡 Angry', happy: '😊 Happy', sad: '😢 Sad' };
const BEHAVIOR_LABELS: Record<BehaviorMode, string> = { neutral: '😐 Neutral', loudLaugh: '😂 Loud Laugh', shyGiggle: '🙈 Shy Giggle', guilty: '😔 Guilty', angry: '😡 Angry', blush: '☺️ Blush' };
const BEHAVIOR_COLOR: Record<BehaviorMode, BtnColor> = { neutral: 'violet', loudLaugh: 'amber', shyGiggle: 'sky', guilty: 'rose', angry: 'rose', blush: 'lime' };

const AUDIO_BADGE: Record<AudioMode, { label: string; cls: string } | null> = {
  off:   null,
  mic:   { label: '🎤 Mic Active',    cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' },
  synth: { label: '🔊 Neutral Voice', cls: 'text-violet-400  bg-violet-400/10  border-violet-400/40'  },
  angry: { label: '😡 Angry Voice',   cls: 'text-rose-400    bg-rose-400/10    border-rose-400/40'    },
  happy: { label: '😊 Happy Voice',   cls: 'text-yellow-400  bg-yellow-400/10  border-yellow-400/40'  },
  sad:   { label: '😢 Sad Voice',     cls: 'text-blue-400    bg-blue-400/10    border-blue-400/40'    },
};

export default function AvatarInterviewer() {
  const [emotionMode,  setEmotionMode]  = useState<EmotionMode>('neutral');
  const [behaviorMode, setBehaviorMode] = useState<BehaviorMode>('neutral');
  const [isNodding,    setIsNodding]    = useState(false);
  const [isShaking,    setIsShaking]    = useState(false);
  const [showCamera,   setShowCamera]   = useState(false);

  const { videoRef, trackingRef, status: trackStatus, statusMsg: trackMsg, startTracking, stopTracking } = useMediaPipeTracking();

  // ── Audio (mic / synth / TTS) ─────────────────────────────────────────────
  const voice = useVRMVoice({ onEmotionSuggested: setEmotionMode });
  const {
    analyserRef,
    audioMode, audioError,
    inputText, setInputText, isSpeakingText,
    handleMic, handleStop, handleSynth,
    handleAngryTest, handleHappyTest, handleSadTest,
    handleTTS,
  } = voice;

  const handleNod   = useCallback(() => { if (!isNodding) setIsNodding(true);  }, [isNodding]);
  const handleShake = useCallback(() => { if (!isShaking) setIsShaking(true);  }, [isShaking]);
  const onNodEnd    = useCallback(() => setIsNodding(false),  []);
  const onShakeEnd  = useCallback(() => setIsShaking(false), []);

  const audioBadge   = AUDIO_BADGE[audioMode];
  const trackBadge   = TRACK_BADGE[trackStatus];
  const isTrackActive = trackStatus === 'active';

  return (
    <div className="flex flex-col w-full h-full bg-gradient-to-br from-[#0f0f1a] to-[#1a1a2e]">
      <video ref={videoRef} playsInline muted className="absolute w-0 h-0 opacity-0 pointer-events-none" aria-hidden="true" />
      <div className="flex-1 relative">
        <Canvas camera={{ position: [0, 0.25, 2.4], fov: 38 }} style={{ background: 'transparent' }}>
          <ambientLight intensity={1.1} /> <directionalLight position={[2, 5, 3]} intensity={1.8} castShadow /> <directionalLight position={[-2, 2, -2]} intensity={0.6} color="#aabbff" />
          <Suspense fallback={<LoadingSpinner />}>
            <VRMAvatarMesh analyserRef={analyserRef} trackingRef={trackingRef} emotionMode={emotionMode} behaviorMode={behaviorMode} isNodding={isNodding} isShaking={isShaking} onNodEnd={onNodEnd} onShakeEnd={onShakeEnd} />
          </Suspense>
          <OrbitControls target={[0, 0.1, 0]} minDistance={0.8} maxDistance={6} enablePan={false} />
        </Canvas>
        {audioBadge && <div className={`absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${audioBadge.cls}`}><span className="w-2 h-2 rounded-full bg-current animate-pulse" />{audioBadge.label}</div>}
        <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border text-slate-300 bg-white/5 border-white/10">{EMOTION_LABELS[emotionMode]}</div>
        <div className={`absolute top-14 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${trackBadge.cls}`}>{trackBadge.label}{trackMsg && <span className="text-[10px] opacity-70 ml-1">— {trackMsg}</span>}</div>
        {isTrackActive && trackingRef.current.isBored && <div className="absolute bottom-14 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] text-slate-400 bg-slate-800/60 border border-slate-700/50">😴 Bored idle active</div>}
        {showCamera && isTrackActive && (
          <div className="absolute bottom-4 right-4 group">
            <video ref={node => { if (node && videoRef.current?.srcObject) { node.srcObject = videoRef.current.srcObject; node.play().catch(() => {}); } }} playsInline muted autoPlay className="w-36 h-auto rounded-2xl border-2 border-white/20 shadow-2xl object-cover" style={{ transform: 'scaleX(-1)' }} />
            <button onClick={() => setShowCamera(false)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" title="Hide camera">✕</button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/8 bg-white/[0.02] px-6 py-4 flex flex-col items-center gap-3">
        {audioError && <p className="text-rose-400 text-xs text-center">{audioError}</p>}
        <div className="flex flex-col items-center gap-2">
          <span className="text-slate-500 text-[10px] uppercase tracking-widest">Behavior</span>
          <div className="flex flex-wrap justify-center gap-1.5">
            {(Object.keys(BEHAVIOR_LABELS) as BehaviorMode[]).map(k => (
              <CtrlBtn key={k} onClick={() => setBehaviorMode(k)} active={behaviorMode === k} color={BEHAVIOR_COLOR[k]}>{BEHAVIOR_LABELS[k]}</CtrlBtn>
            ))}
          </div>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex items-center gap-3 flex-wrap justify-center">
          <span className="text-slate-400 text-xs">Emotion:</span>
          <select value={emotionMode} onChange={e => setEmotionMode(e.target.value as EmotionMode)} className="bg-white/5 border border-white/15 text-slate-200 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-violet-400 cursor-pointer">
            {(Object.keys(EMOTION_LABELS) as EmotionMode[]).map(k => <option key={k} value={k}>{EMOTION_LABELS[k]}</option>)}
          </select>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-col items-center gap-2 w-full max-w-md">
          <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Type a sentence here..." className="w-full bg-black/40 border border-white/20 text-white text-xs rounded-lg px-3 py-2 outline-none focus:border-sky-400" />
          <CtrlBtn onClick={handleTTS} active={isSpeakingText} color="sky">🗣️ Speak Text</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={isTrackActive ? stopTracking : startTracking} active={isTrackActive} color="lime">{isTrackActive ? '🟢 Stop Tracking' : '📷 Start Face Tracking'}</CtrlBtn>
          {isTrackActive && <CtrlBtn onClick={() => setShowCamera(v => !v)} active={showCamera} color="sky">{showCamera ? '📹 Hide Camera' : '📹 Show Me'}</CtrlBtn>}
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleMic} active={audioMode==='mic'} color="emerald">🎤 Mic</CtrlBtn>
          <CtrlBtn onClick={handleStop} active={false} color="rose" disabled={audioMode==='off'}>⏹ Stop Audio</CtrlBtn>
          <CtrlBtn onClick={handleSynth} active={audioMode==='synth'} color="violet">🔊 Normal</CtrlBtn>
          <CtrlBtn onClick={handleAngryTest} active={audioMode==='angry'} color="rose">😡 Angry</CtrlBtn>
          <CtrlBtn onClick={handleHappyTest} active={audioMode==='happy'} color="amber">😊 Happy</CtrlBtn>
          <CtrlBtn onClick={handleSadTest} active={audioMode==='sad'} color="sky">😢 Sad</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleNod} active={isNodding} color="sky" disabled={isNodding}>👍 Nod</CtrlBtn>
          <CtrlBtn onClick={handleShake} active={isShaking} color="amber" disabled={isShaking}>👎 Shake</CtrlBtn>
        </div>
      </div>
    </div>
  );
}

type BtnColor = 'emerald' | 'violet' | 'rose' | 'sky' | 'amber' | 'lime';
const CM: Record<BtnColor, { idle: string; active: string }> = { emerald: { idle: 'from-emerald-600 to-teal-600 shadow-emerald-500/25 hover:shadow-emerald-500/45', active: 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/40' }, violet: { idle: 'from-indigo-500 to-violet-500 shadow-indigo-500/25 hover:shadow-indigo-500/45', active: 'bg-violet-400/10 text-violet-400 border border-violet-400/40' }, rose: { idle: 'from-rose-600 to-pink-600 shadow-rose-500/25 hover:shadow-rose-500/45', active: 'bg-rose-400/10 text-rose-400 border border-rose-400/40' }, sky: { idle: 'from-sky-500 to-cyan-500 shadow-sky-500/25 hover:shadow-sky-500/45', active: 'bg-sky-400/10 text-sky-400 border border-sky-400/40' }, amber: { idle: 'from-amber-500 to-orange-500 shadow-amber-500/25 hover:shadow-amber-500/45', active: 'bg-amber-400/10 text-amber-400 border border-amber-400/40' }, lime: { idle: 'from-lime-500 to-green-500 shadow-lime-500/25 hover:shadow-lime-500/45', active: 'bg-lime-400/10 text-lime-400 border border-lime-400/40' } };
interface BtnProps { onClick:()=>void; active:boolean; color:BtnColor; disabled?:boolean; children:React.ReactNode }
function CtrlBtn({ onClick, active, color, disabled=false, children }: BtnProps) {
  const c = CM[color];
  return (
    <button onClick={onClick} disabled={disabled} className={`px-4 py-2 rounded-xl font-semibold text-xs tracking-wide transition-all duration-200 ${active ? c.active : disabled ? 'opacity-40 cursor-not-allowed bg-white/5 text-slate-500 border border-white/10' : `bg-gradient-to-r ${c.idle} text-white shadow-lg hover:scale-[1.03] active:scale-[0.97] cursor-pointer`}`}>
      {children}
    </button>
  );
}