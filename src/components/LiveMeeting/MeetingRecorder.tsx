import { useRef, useState } from "react";
import { Square, Circle } from "lucide-react";

interface MeetingRecorderProps {
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  remoteSharingParticipantId?: string | null;
  onRecordingChange?: (isRecording: boolean) => void;
  canRecord?: boolean;
}

export function MeetingRecorder({ localStream, remoteStreams, remoteSharingParticipantId = null, onRecordingChange, canRecord = true }: MeetingRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [converting, setConverting] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const download = (blob: Blob, ext: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setRecordedBlob(null);
  };

  const handleSaveWebm = () => {
    if (!recordedBlob) return;
    download(recordedBlob, "webm");
  };

  const handleSaveMp4 = async () => {
    if (!recordedBlob) return;
    if (recordedBlob.type.includes("mp4")) {
      download(recordedBlob, "mp4");
      return;
    }
    setConverting(true);
    try {
      const { webmToMp4 } = await import("@/lib/convertToMp4");
      const mp4 = await webmToMp4(recordedBlob);
      if (mp4) download(mp4, "mp4");
    } finally {
      setConverting(false);
    }
  };

  const startRecording = async () => {
    if (!canRecord) return;
    const streams = [localStream, ...Object.values(remoteStreams)].filter(Boolean) as MediaStream[];
    if (streams.length === 0) return;

    // Prefer remote participant's shared screen (e.g. whiteboard), else local (host's camera/screen)
    const sharingStream = remoteSharingParticipantId ? remoteStreams[remoteSharingParticipantId] : null;
    const videoTrack =
      sharingStream?.getVideoTracks()[0] ??
      localStream?.getVideoTracks()[0] ??
      streams[0]?.getVideoTracks()[0];
    const audioTracks = streams.flatMap((s) => s.getAudioTracks()).filter(Boolean);

    const combined = new MediaStream();
    if (videoTrack) combined.addTrack(videoTrack);
    audioTracks.forEach((t) => combined.addTrack(t));

    const mime = MediaRecorder.isTypeSupported("video/mp4")
      ? "video/mp4"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
        ? "video/webm;codecs=vp8"
        : "video/webm";
    const recorder = new MediaRecorder(combined, { mimeType: mime });
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      setRecordedBlob(blob);
      onRecordingChange?.(false);
    };

    recorder.start(1000);
    setIsRecording(true);
    onRecordingChange?.(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecording(false);
    onRecordingChange?.(false);
  };

  return (
    <>
      {!isRecording && !recordedBlob && (
        <button
          type="button"
          className={`live-meeting-control-btn ${canRecord ? "danger" : ""}`}
          onClick={startRecording}
          disabled={!canRecord}
          title={canRecord ? "Record" : "Recording disabled by host"}
        >
          <Circle size={16} fill="currentColor" />
        </button>
      )}
      {isRecording && (
        <button type="button" className="live-meeting-control-btn danger" onClick={stopRecording} title="Stop recording">
          <Square size={16} />
        </button>
      )}
      {recordedBlob && (
        <>
          <button type="button" className="live-meeting-control-btn" onClick={handleSaveWebm} title="Save WebM">
            WebM
          </button>
          <button type="button" className="live-meeting-control-btn" onClick={handleSaveMp4} disabled={converting} title="Save MP4">
            {converting ? "…" : "MP4"}
          </button>
        </>
      )}
    </>
  );
}
