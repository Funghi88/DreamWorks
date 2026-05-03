/**
 * Mic → 16 kHz mono Int16 for Vosk.
 * Prefer MediaStreamTrackProcessor (continuous frames); ScriptProcessorNode often yields silence in modern Chromium/Electron.
 */

export function downsampleFloatTo16kMono(input: Float32Array, sampleRate: number): Int16Array {
  if (sampleRate === 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const j = Math.floor(srcPos);
    const frac = srcPos - j;
    const s = input[j]! * (1 - frac) + (input[j + 1] ?? 0) * frac;
    const c = Math.max(-1, Math.min(1, s));
    out[i] = c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
  }
  return out;
}

type AudioDataLike = {
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  copyTo: (destination: Float32Array, options: Record<string, unknown>) => void;
  close?: () => void;
};

function audioDataToMonoFloat32(ad: AudioDataLike): { mono: Float32Array; sampleRate: number } {
  const nFr = ad.numberOfFrames;
  const nCh = ad.numberOfChannels;
  const sr = ad.sampleRate;
  if (nFr === 0 || nCh < 1) return { mono: new Float32Array(0), sampleRate: sr };

  if (nCh === 1) {
    const mono = new Float32Array(nFr);
    try {
      ad.copyTo(mono, { format: "f32-planar", planeIndex: 0, frameCount: nFr });
    } catch {
      try {
        ad.copyTo(mono, { format: "f32", planeIndex: 0, frameCount: nFr });
      } catch {
        return { mono: new Float32Array(0), sampleRate: sr };
      }
    }
    return { mono, sampleRate: sr };
  }

  const inter = new Float32Array(nFr * nCh);
  try {
    ad.copyTo(inter, { format: "f32-interleaved", frameCount: nFr });
  } catch {
    return { mono: new Float32Array(0), sampleRate: sr };
  }
  const mono = new Float32Array(nFr);
  for (let i = 0; i < nFr; i++) {
    let s = 0;
    for (let c = 0; c < nCh; c++) s += inter[i * nCh + c]!;
    mono[i] = s / nCh;
  }
  return { mono, sampleRate: sr };
}

type MstpCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<unknown> };

function getMediaStreamTrackProcessor(): MstpCtor | undefined {
  return (globalThis as unknown as { MediaStreamTrackProcessor?: MstpCtor }).MediaStreamTrackProcessor;
}

export type TeleprompterMicCapture = {
  stop: () => void;
  /** If true, capture did not use `audioCtx`; caller may close it. */
  releasedAudioContext: boolean;
};

/**
 * @param audioCtx Used only for ScriptProcessor fallback; may be closed/released when MSLP wins.
 */
export function startTeleprompterMicPcm16k(
  mediaStream: MediaStream,
  audioCtx: AudioContext,
  onPcm: (pcm: Int16Array) => void
): TeleprompterMicCapture {
  const track = mediaStream.getAudioTracks()[0];
  if (!track) {
    return { stop: () => {}, releasedAudioContext: false };
  }

  const Mstp = getMediaStreamTrackProcessor();
  if (typeof Mstp === "function") {
    try {
      const processor = new Mstp({ track });
      const reader = processor.readable.getReader();
      let cancelled = false;

      const loop = async () => {
        while (!cancelled) {
          let ad: AudioDataLike | undefined;
          try {
            const step = await reader.read();
            if (step.done) break;
            ad = step.value as AudioDataLike;
            const { mono, sampleRate } = audioDataToMonoFloat32(ad);
            const pcm = downsampleFloatTo16kMono(mono, sampleRate);
            if (pcm.length > 0) onPcm(pcm);
          } catch {
            /* drop frame */
          } finally {
            try {
              ad?.close?.();
            } catch {
              /* ignore */
            }
          }
        }
      };
      void loop();

      return {
        stop: () => {
          cancelled = true;
          void reader.cancel().catch(() => {});
        },
        releasedAudioContext: true,
      };
    } catch {
      /* fall through to ScriptProcessor */
    }
  }

  const source = audioCtx.createMediaStreamSource(mediaStream);
  const bufferSize = 2048;
  const proc = audioCtx.createScriptProcessor(bufferSize, 1, 1);
  proc.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = downsampleFloatTo16kMono(input, audioCtx.sampleRate);
    if (pcm.length > 0) onPcm(pcm);
  };
  const zero = audioCtx.createGain();
  zero.gain.value = 0;
  source.connect(proc);
  proc.connect(zero);
  zero.connect(audioCtx.destination);

  return {
    stop: () => {
      try {
        proc.disconnect();
        source.disconnect();
        zero.disconnect();
      } catch {
        /* ignore */
      }
    },
    releasedAudioContext: false,
  };
}
