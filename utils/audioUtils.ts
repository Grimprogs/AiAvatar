/** Decodes a base64 string into a Uint8Array of raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Encodes a Uint8Array into a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes raw 16-bit PCM bytes into a Web Audio API AudioBuffer.
 *
 * Each sample is a signed 16-bit integer normalised to the [-1, 1] float range.
 * Supports multi-channel audio (defaults to mono at 24 kHz).
 */
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

/**
 * Converts a Float32Array (Web Audio format) to 16-bit signed PCM.
 * Used for encoding microphone input before sending to the Gemini Live API.
 */
export function float32To16BitPCM(float32Arr: Float32Array): ArrayBuffer {
  const len = float32Arr.length;
  const int16 = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    int16[i] = float32Arr[i] * 32768;
  }
  return int16.buffer;
}

/** Reads a Blob as a base64-encoded data URL and returns only the base64 payload. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
