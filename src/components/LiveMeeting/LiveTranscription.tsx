import { useEffect, useRef, useState } from "react";
import { GlassCard } from "@/components/Glass";
import { Mic, X } from "lucide-react";
import "./LiveTranscription.css";

interface TranscriptionEntry {
  id: string;
  text: string;
  ts: number;
}

interface LiveTranscriptionProps {
  isOpen: boolean;
  onClose: () => void;
  localStream?: MediaStream | null;
}

export function LiveTranscription({ isOpen, onClose }: LiveTranscriptionProps) {
  const [entries, setEntries] = useState<TranscriptionEntry[]>([]);
  const [interim, setInterim] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const SpeechRecognitionAPI =
      typeof window !== "undefined"
        ? (window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ||
          (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
        : null;

    if (!SpeechRecognitionAPI) {
      setApiAvailable(false);
      return;
    }
    setApiAvailable(true);

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = typeof navigator !== "undefined" && /^zh/i.test(navigator.language) ? "zh-CN" : "en-US";

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      let interimText = "";
      const ev = e as SpeechRecognitionEvent & { resultIndex: number };
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal && text.trim()) {
          setEntries((prev) => [...prev, { id: `${Date.now()}-${i}`, text, ts: Date.now() }]);
        } else {
          interimText += text;
        }
      }
      setInterim(interimText);
    };

    (recognition as unknown as { onerror: (e: { error: string }) => void }).onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const msg =
        e.error === "not-allowed"
          ? "Microphone permission denied"
          : e.error === "network"
          ? "Network error: Speech recognition needs internet. Check connection and try Start again."
          : `Error: ${e.error}`;
      setError(msg);
    };

    (recognition as unknown as { onend: () => void }).onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.abort();
      } catch {}
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [entries, interim]);

  useEffect(() => {
    if (isOpen && apiAvailable && !isListening && !error) {
      const t = setTimeout(() => {
        const rec = recognitionRef.current;
        if (rec) {
          try {
            rec.start();
            setIsListening(true);
            setError(null);
          } catch (err) {
            setError("Failed to start. Try clicking Start.");
          }
        }
      }, 100);
      return () => clearTimeout(t);
    }
  }, [isOpen, apiAvailable]);

  const toggleListening = () => {
    const rec = recognitionRef.current;
    if (!rec || apiAvailable === false) return;
    setError(null);

    if (isListening) {
      rec.stop();
      setIsListening(false);
    } else {
      try {
        rec.start();
        setIsListening(true);
      } catch {
        setError("Failed to start. Ensure microphone is allowed.");
      }
    }
  };

  if (!isOpen) return null;

  return (
    <GlassCard className="live-transcription-panel">
      <div className="live-transcription-header">
        <span>Live Transcription</span>
        <button type="button" onClick={onClose} className="live-transcription-close" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="live-transcription-control">
        <button
          type="button"
          onClick={toggleListening}
          disabled={apiAvailable === false}
          className={`live-transcription-mic ${isListening ? "active" : ""}`}
        >
          <Mic size={18} />
          {isListening ? "Listening..." : "Start"}
        </button>
      </div>
      {apiAvailable === false && (
        <div className="live-transcription-empty live-transcription-error">
          Speech recognition not supported.
        </div>
      )}
      {error && (
        <div className="live-transcription-empty live-transcription-error">
          {error}
        </div>
      )}
      <div ref={listRef} className="live-transcription-list">
        {apiAvailable !== false && !error && entries.length === 0 && !interim && (
          <div className="live-transcription-empty">
            {isListening ? "Speak now..." : "Click Start to transcribe."}
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="live-transcription-entry">
            {e.text}
          </div>
        ))}
        {interim && (
          <div className="live-transcription-entry live-transcription-interim">
            {interim}
          </div>
        )}
      </div>
    </GlassCard>
  );
}
