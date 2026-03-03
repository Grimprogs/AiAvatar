import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { base64ToBytes, decodeAudioData, float32To16BitPCM, bytesToBase64 } from '@/utils/audioUtils';
import {
  SYSTEM_INSTRUCTION_INTERVIEWER,
  GEMINI_LIVE_MODEL,
  GEMINI_TTS_MODEL,
  DEFAULT_VOICE_NAME,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  AUDIO_CHUNK_SIZE,
  CODE_TRUNCATE_LIMIT,
  MIC_UNMUTE_TIMEOUT_MS,
} from '@/constants';

// Define LiveSession type locally as it is not exported from the SDK
type LiveSession = Awaited<ReturnType<GoogleGenAI['live']['connect']>>;

export interface LiveConnectOptions {
  onMessage?: (message: { text: string; partial?: boolean }) => void;
  onStateChange?: (state: 'connecting' | 'connected' | 'closed' | 'error') => void;
  systemInstruction?: string;
  initialMessage?: string;
}

/**
 * Manages a real-time voice interview session with the Gemini Live API.
 *
 * Responsibilities:
 * - Opens a WebSocket connection to Gemini Live (audio modality)
 * - Captures microphone input at 16 kHz PCM and streams it to the model
 * - Decodes and plays the model's 24 kHz audio responses in sequence
 * - Provides helpers for sending text turns, code context, and video frames
 * - Offers a standalone TTS method for text-chat responses
 */
export class LiveService {
  private ai: GoogleGenAI;
  private session: LiveSession | null = null;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private inputStream: MediaStream | null = null;
  private outputMixGain: GainNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputMeterData: Float32Array | null = null;
  private outputMeterRafId: number | null = null;
  private smoothedOutputLevel: number = 0;
  private nextStartTime: number = 0;
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private isConnected: boolean = false;
  private isMicrophoneMuted: boolean = false;

  public onVolumeChange: ((volume: number) => void) | null = null;
  public onOutputLevelChange: ((level: number) => void) | null = null;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Opens a live session, acquires the microphone, and begins streaming. */
  public async connect(options?: LiveConnectOptions): Promise<void> {
    if (this.isConnected) return;
    options?.onStateChange?.('connecting');

    await this.ensureAudioContexts();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.inputStream = stream;

    this.session = await this.ai.live.connect({
      model: GEMINI_LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE_NAME } },
        },
        systemInstruction: options?.systemInstruction || SYSTEM_INSTRUCTION_INTERVIEWER,
      },
      callbacks: {
        onopen: async () => {
          this.isConnected = true;
          options?.onStateChange?.('connected');
        },
        onmessage: async (msg: LiveServerMessage) => {
          this.handleServerMessage(msg, options?.onMessage);
        },
        onclose: () => {
          this.isConnected = false;
          options?.onStateChange?.('closed');
        },
        onerror: () => {
          this.isConnected = false;
          options?.onStateChange?.('error');
        },
      },
    });

    // Send initial trigger BEFORE audio so the model responds to the text prompt
    // rather than ambient silence.
    if (options?.initialMessage) {
      await this.sendText(options.initialMessage);
      // Brief pause so the backend registers the text turn before audio floods in
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.startAudioInput(stream);
  }

  // --- Audio Context Helpers ---

  /**
   * Ensures both input and output AudioContexts exist and are active.
   * Recreates closed contexts and resumes suspended ones (browser autoplay policy).
   */
  private async ensureAudioContexts() {
    this.inputAudioContext = await this.ensureSingleContext(this.inputAudioContext, INPUT_SAMPLE_RATE);
    this.outputAudioContext = await this.ensureSingleContext(this.outputAudioContext, OUTPUT_SAMPLE_RATE);
    this.ensureOutputNodes();
  }

  /**
   * Creates or resumes a single AudioContext at the given sample rate.
   * Returns the ready-to-use context.
   */
  private async ensureSingleContext(
    ctx: AudioContext | null,
    sampleRate: number,
  ): Promise<AudioContext> {
    if (!ctx || ctx.state === 'closed') {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
    }
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  /** Creates shared output nodes for audio playback + level metering. */
  private ensureOutputNodes() {
    if (!this.outputAudioContext) return;

    const outputCtx = this.outputAudioContext;
    if (
      this.outputMixGain &&
      this.outputAnalyser &&
      this.outputMixGain.context === outputCtx &&
      this.outputAnalyser.context === outputCtx
    ) {
      this.startOutputMetering();
      return;
    }

    this.stopOutputMetering();

    this.outputMixGain = outputCtx.createGain();
    this.outputMixGain.gain.value = 1;

    this.outputAnalyser = outputCtx.createAnalyser();
    this.outputAnalyser.fftSize = 1024;
    this.outputAnalyser.smoothingTimeConstant = 0.75;
    this.outputMeterData = new Float32Array(this.outputAnalyser.fftSize);

    this.outputMixGain.connect(this.outputAnalyser);
    this.outputAnalyser.connect(outputCtx.destination);
    this.startOutputMetering();
  }

  private startOutputMetering() {
    if (!this.outputAnalyser || this.outputMeterRafId !== null) return;

    const tick = () => {
      if (!this.outputAnalyser || !this.outputMeterData) {
        this.outputMeterRafId = null;
        return;
      }

      this.outputAnalyser.getFloatTimeDomainData(this.outputMeterData);

      let sum = 0;
      const len = this.outputMeterData.length;
      for (let i = 0; i < len; i++) {
        const v = this.outputMeterData[i];
        sum += v * v;
      }

      const rms = Math.sqrt(sum / len);
      const normalized = Math.min(1, rms * 4);
      const attack = 0.55;
      const release = 0.15;
      const smoothing = normalized > this.smoothedOutputLevel ? attack : release;
      this.smoothedOutputLevel += (normalized - this.smoothedOutputLevel) * smoothing;

      if (this.onOutputLevelChange) {
        this.onOutputLevelChange(this.smoothedOutputLevel);
      }

      this.outputMeterRafId = requestAnimationFrame(tick);
    };

    this.outputMeterRafId = requestAnimationFrame(tick);
  }

  private stopOutputMetering() {
    if (this.outputMeterRafId !== null) {
      cancelAnimationFrame(this.outputMeterRafId);
      this.outputMeterRafId = null;
    }
    this.smoothedOutputLevel = 0;
    if (this.onOutputLevelChange) this.onOutputLevelChange(0);
  }

  // --- Microphone Input ---

  private startAudioInput(stream: MediaStream) {
    if (!this.inputAudioContext || !this.session) return;

    this.inputSource = this.inputAudioContext.createMediaStreamSource(stream);
    this.processor = this.inputAudioContext.createScriptProcessor(AUDIO_CHUNK_SIZE, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.session) return;

      // CRITICAL: While processing a text turn, do NOT send any audio data.
      // Even silence frames signal "user is speaking" and cancel the text turn.
      if (this.isMicrophoneMuted) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // RMS volume for the UI visualiser
      if (this.onVolumeChange) {
        let sum = 0;
        const len = inputData.length;
        for (let i = 0; i < len; i++) {
          sum += inputData[i] * inputData[i];
        }
        this.onVolumeChange(Math.sqrt(sum / len));
      }

      const pcmData = float32To16BitPCM(inputData);
      const base64 = bytesToBase64(new Uint8Array(pcmData));

      try {
        this.session.sendRealtimeInput({
          media: { mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`, data: base64 },
        });
      } catch {
        // Ignore transient WebSocket send errors
      }
    };

    this.inputSource.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  // --- Server Message Handling ---

  private async handleServerMessage(
    message: LiveServerMessage,
    onTextMessage?: (message: { text: string; partial?: boolean }) => void,
  ) {
    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.stopAudioPlayback();
    }

    if (serverContent.modelTurn?.parts?.[0]?.inlineData) {
      const audioData = serverContent.modelTurn.parts[0].inlineData.data;
      if (audioData) {
        // Unmute microphone when the model starts speaking so the user can interrupt
        if (this.isMicrophoneMuted) {
          this.isMicrophoneMuted = false;
        }
        this.playAudioChunk(audioData);
      }
    }

    // Collect any text parts for the optional text callback
    const textParts: string[] = [];
    const parts = serverContent.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.text) textParts.push(part.text);
      }
    }
    if (textParts.length > 0 && onTextMessage) {
      onTextMessage({
        text: textParts.join('\n'),
        partial: !serverContent.turnComplete,
      });
    }
  }

  // --- Audio Playback ---

  private async playAudioChunk(base64Audio: string) {
    // Ensure output context is ready (also needed for standalone TTS outside live session)
    this.outputAudioContext = await this.ensureSingleContext(this.outputAudioContext, OUTPUT_SAMPLE_RATE);
    this.ensureOutputNodes();

    if (!this.outputAudioContext || !this.outputMixGain) return;

    try {
      const audioBuffer = await decodeAudioData(
        base64ToBytes(base64Audio),
        this.outputAudioContext,
      );

      this.nextStartTime = Math.max(this.outputAudioContext.currentTime, this.nextStartTime);

      const source = this.outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputMixGain);
      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;

      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
      };
    } catch {
      // Decoding failure — skip this chunk silently
    }
  }

  private stopAudioPlayback() {
    this.activeSources.forEach(source => {
      try { source.stop(); } catch { /* already stopped */ }
    });
    this.activeSources.clear();
    if (this.outputAudioContext) {
      this.nextStartTime = this.outputAudioContext.currentTime;
    }
    this.smoothedOutputLevel = 0;
    if (this.onOutputLevelChange) this.onOutputLevelChange(0);
  }

  // --- Public Messaging API ---

  /** Sends a JPEG frame of the code editor for the model's vision input. */
  public async sendVideoFrame(base64Image: string) {
    if (!this.session) return;

    try {
      await this.session.sendRealtimeInput({
        media: { mimeType: 'image/jpeg', data: base64Image },
      });
    } catch {
      // Transient send error — skip frame
    }
  }

  /**
   * Sends the candidate's current code as a text context update.
   * Truncates to CODE_TRUNCATE_LIMIT to stay within token limits.
   */
  public async sendCodeContext(code: string) {
    const safeCode =
      code.length > CODE_TRUNCATE_LIMIT
        ? code.substring(0, CODE_TRUNCATE_LIMIT) + '\n...[truncated]'
        : code;

    const prompt = `[SYSTEM UPDATE] The user has updated their code:\n\`\`\`${safeCode}\`\`\`\nReview the code silently. Only speak if you see a critical error or if you were waiting for this code to answer a question.`;
    await this.sendText(prompt);
  }

  /**
   * Sends a text turn to the live session.
   * Mutes the microphone during transmission so the backend treats this
   * as a clean text-only turn rather than an audio interruption.
   */
  public async sendText(text: string) {
    if (!this.session) return;

    // Mute mic so audio frames don't conflict with the text turn
    this.isMicrophoneMuted = true;

    try {
      await (this.session as any).send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      });
    } catch {
      this.isMicrophoneMuted = false;
      return;
    }

    // Safety: unmute after timeout if model doesn't respond with audio
    // (handleServerMessage usually unmutes earlier when audio arrives)
    setTimeout(() => {
      if (this.isMicrophoneMuted) {
        this.isMicrophoneMuted = false;
      }
    }, MIC_UNMUTE_TIMEOUT_MS);
  }

  /** Generates speech from text using the Gemini TTS model and plays it. */
  public async speak(text: string) {
    try {
      const response = await this.ai.models.generateContent({
        model: GEMINI_TTS_MODEL,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE_NAME },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        await this.playAudioChunk(base64Audio);
      }
    } catch {
      // TTS generation failed — fail silently
    }
  }

  /** Tears down the live session, releases microphone, and closes audio contexts. */
  public async disconnect() {
    this.stopAudioPlayback();

    // Close the WebSocket session before dropping the reference
    if (this.session) {
      try { await (this.session as any).close(); } catch { /* already closed */ }
      this.session = null;
    }

    if (this.inputSource) this.inputSource.disconnect();
    if (this.processor) this.processor.disconnect();
    if (this.inputStream) {
      this.inputStream.getTracks().forEach((track) => track.stop());
      this.inputStream = null;
    }

    if (this.inputAudioContext) await this.inputAudioContext.close();
    if (this.outputAudioContext) await this.outputAudioContext.close();

    this.stopOutputMetering();
    this.outputMixGain = null;
    this.outputAnalyser = null;
    this.outputMeterData = null;
    this.inputAudioContext = null;
    this.outputAudioContext = null;
    this.isConnected = false;
    this.isMicrophoneMuted = false;
  }
}
