import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { base64ToBytes, decodeAudioData, float32To16BitPCM, bytesToBase64, blobToBase64 } from "../utils/audioUtils";
import { SYSTEM_INSTRUCTION_INTERVIEWER } from "../types";

// Define LiveSession type locally as it is not exported
type LiveSession = Awaited<ReturnType<GoogleGenAI["live"]["connect"]>>;

export interface LiveConnectOptions {
  onMessage?: (text: string) => void;
  systemInstruction?: string;
  initialMessage?: string;
}

export class LiveService {
  private ai: GoogleGenAI;
  private session: LiveSession | null = null;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private nextStartTime: number = 0;
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private isConnected: boolean = false;
  private isMicrophoneMuted: boolean = false;
  
  public onVolumeChange: ((volume: number) => void) | null = null;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  public async connect(options?: LiveConnectOptions): Promise<void> {
    if (this.isConnected) return;

    // Ensure audio contexts are ready (or recreate if closed)
    await this.ensureAudioContexts();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Connect to Gemini Live
    this.session = await this.ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        systemInstruction: options?.systemInstruction || SYSTEM_INSTRUCTION_INTERVIEWER,
      },
      callbacks: {
        onopen: async () => {
          console.log('Gemini Live Connected');
          this.isConnected = true;
        },
        onmessage: async (msg: LiveServerMessage) => {
           this.handleServerMessage(msg, options?.onMessage);
        },
        onclose: () => {
          console.log('Gemini Live Closed');
          this.isConnected = false;
        },
        onerror: (err) => {
          console.error('Gemini Live Error', err);
          this.isConnected = false;
        }
      }
    });

    // Session is fully initialized.
    
    // Send initial trigger message BEFORE starting audio stream.
    if (options?.initialMessage) {
        console.log("Sending initial message:", options.initialMessage);
        await this.sendText(options.initialMessage);
        
        // CRITICAL: Wait for the model to process the text turn before flooding it with audio.
        // This prevents silence/ambient noise from overriding the text trigger.
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Start audio streaming
    console.log("Starting audio input stream...");
    this.startAudioInput(stream);
  }

  private async ensureAudioContexts() {
    if (!this.inputAudioContext || this.inputAudioContext.state === 'closed') {
       this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
    if (!this.outputAudioContext || this.outputAudioContext.state === 'closed') {
       this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    // Resume contexts if they are suspended (browser policy)
    if (this.inputAudioContext?.state === 'suspended') await this.inputAudioContext.resume();
    if (this.outputAudioContext?.state === 'suspended') await this.outputAudioContext.resume();
  }

  private startAudioInput(stream: MediaStream) {
    if (!this.inputAudioContext || !this.session) return;

    this.inputSource = this.inputAudioContext.createMediaStreamSource(stream);
    this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      // If session is null, stop processing
      if (!this.session) return;

      // CRITICAL: If muted (processing text turn), DO NOT send any data.
      // Even sending silence frames can be interpreted as a "User is still speaking" signal 
      // which cancels the text turn processing on the backend.
      if (this.isMicrophoneMuted) return;

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Calculate volume for visualizer
      if (this.onVolumeChange) {
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        this.onVolumeChange(Math.sqrt(sum / inputData.length));
      }

      const pcmData = float32To16BitPCM(inputData);
      const uint8Pcm = new Uint8Array(pcmData);
      const base64 = bytesToBase64(uint8Pcm);

      try {
        this.session.sendRealtimeInput({
          media: {
            mimeType: 'audio/pcm;rate=16000',
            data: base64
          }
        });
      } catch(err) {
          // Ignore transient send errors
      }
    };

    this.inputSource.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  private async handleServerMessage(message: LiveServerMessage, onTextMessage?: (text: string) => void) {
    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      console.log("Model interrupted user/playback");
      this.stopAudioPlayback();
    }

    if (serverContent.turnComplete) {
        console.log("Model turn complete");
    }

    if (serverContent.modelTurn?.parts?.[0]?.inlineData) {
      const audioData = serverContent.modelTurn.parts[0].inlineData.data;
      if (audioData) {
        // If the model starts speaking, ensure we unmute the mic so the user can reply/interrupt.
        if (this.isMicrophoneMuted) {
            console.log("Model started speaking, unmuting microphone.");
            this.isMicrophoneMuted = false;
        }
        this.playAudioChunk(audioData);
      }
    }
  }

  private async playAudioChunk(base64Audio: string) {
    // Ensure output context is ready even if not fully connected to Live session (for TTS)
    if (!this.outputAudioContext || this.outputAudioContext.state === 'closed') {
        this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (this.outputAudioContext.state === 'suspended') await this.outputAudioContext.resume();

    try {
      const audioBuffer = await decodeAudioData(
        base64ToBytes(base64Audio),
        this.outputAudioContext
      );

      this.nextStartTime = Math.max(this.outputAudioContext.currentTime, this.nextStartTime);
      
      const source = this.outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputAudioContext.destination);
      
      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      
      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
      };
    } catch (e) {
      console.error("Error decoding audio", e);
    }
  }

  private stopAudioPlayback() {
    this.activeSources.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    this.activeSources.clear();
    if(this.outputAudioContext) {
        this.nextStartTime = this.outputAudioContext.currentTime;
    }
  }

  public async sendVideoFrame(base64Image: string) {
    if (!this.session) return;
    
    try {
        await this.session.sendRealtimeInput({
            media: {
                mimeType: 'image/jpeg',
                data: base64Image
            }
        });
    } catch (e) {
        console.error("Failed to send video frame", e);
    }
  }

  public async sendCodeContext(code: string) {
      const TRUNCATE_LIMIT = 4000;
      const safeCode = code.length > TRUNCATE_LIMIT ? code.substring(0, TRUNCATE_LIMIT) + "\n...[truncated]" : code;
      
      // Use a subtle system update format
      const prompt = `[SYSTEM UPDATE] The user has updated their code:\n\`\`\`${safeCode}\`\`\`\nReview the code silently. Only speak if you see a critical error or if you were waiting for this code to answer a question.`;
      
      console.log("Sending code context update...");
      await this.sendText(prompt);
  }

  public async sendText(text: string) {
      if (!this.session) {
          console.warn("Attempted to send text without active session");
          return;
      }
      
      console.log("Sending text turn:", text);
      
      // STOP sending audio frames entirely.
      // This guarantees the backend sees this as a clean "Text Turn".
      this.isMicrophoneMuted = true;

      try {
        await (this.session as any).send({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text }]
                }],
                turnComplete: true
            }
        });
      } catch (e) {
        console.error("Failed to send text trigger. Ensure session is ready.", e);
        this.isMicrophoneMuted = false;
        return;
      }

      // Safety: Unmute after 3 seconds if the model doesn't respond 
      // (usually handleServerMessage unmutes sooner when audio arrives)
      setTimeout(() => {
          if (this.isMicrophoneMuted) {
            console.log("Microphone unmuted by timeout (no immediate audio response).");
            this.isMicrophoneMuted = false;
          }
      }, 3000);
  }

  // New method to speak arbitrary text using TTS
  public async speak(text: string) {
    try {
        const response = await this.ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Kore' },
                    },
                },
            },
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
            await this.playAudioChunk(base64Audio);
        }
    } catch (e) {
        console.error("TTS Error:", e);
    }
  }

  public async disconnect() {
    this.stopAudioPlayback();
    if (this.session) {
      this.session = null;
    }
    
    if (this.inputSource) this.inputSource.disconnect();
    if (this.processor) this.processor.disconnect();
    
    if (this.inputAudioContext) await this.inputAudioContext.close();
    if (this.outputAudioContext) await this.outputAudioContext.close();

    this.inputAudioContext = null;
    this.outputAudioContext = null;
    this.isConnected = false;
    this.isMicrophoneMuted = false;
    console.log("Disconnected Live Service");
  }
}