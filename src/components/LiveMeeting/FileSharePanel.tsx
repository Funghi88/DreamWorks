import { useState, useEffect, useRef } from "react";
import { GlassCard } from "@/components/Glass";
import { Upload, Download, X } from "lucide-react";
import type { Socket } from "socket.io-client";
import "./FileSharePanel.css";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

interface SharedFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  from: string;
  userName: string;
  ts: number;
  data?: string;
}

interface FileSharePanelProps {
  socket: Socket | null;
  roomId: string;
  userName: string;
  isOpen: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileSharePanel({ socket, roomId, userName, isOpen, onClose }: FileSharePanelProps) {
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: Omit<SharedFile, "data"> & { data?: string }) => {
      setFiles((prev) => {
        const exists = prev.some((f) => f.id === data.id);
        if (exists) return prev;
        return [
          ...prev,
          {
            id: data.id,
            fileName: data.fileName,
            mimeType: data.mimeType,
            size: data.size,
            from: data.from ?? "",
            userName: data.userName,
            ts: data.ts,
            data: data.data,
          },
        ];
      });
    };
    socket.on("file-share", handler);
    return () => {
      socket.off("file-share", handler);
    };
  }, [socket]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !socket || !roomId) return;
    if (file.size > MAX_FILE_SIZE) {
      setError(`File too large (max ${formatSize(MAX_FILE_SIZE)})`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
        r.onerror = () => reject(new Error("Read failed"));
        r.readAsDataURL(file);
      });
      const payload = {
        roomId,
        id: `${socket.id}-${Date.now()}`,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        userName,
        ts: Date.now(),
        data,
      };
      socket.emit("file-share", payload);
      setFiles((prev) => [
        ...prev,
        {
          id: payload.id,
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          size: payload.size,
          from: socket.id ?? "",
          userName,
          ts: payload.ts,
          data,
        },
      ]);
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const download = (f: SharedFile) => {
    if (!f.data) return;
    const bin = atob(f.data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: f.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <GlassCard className="file-share-panel">
      <div className="file-share-header">
        <span>Files</span>
        <button type="button" onClick={onClose} className="file-share-close" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="file-share-upload">
        <input
          ref={inputRef}
          type="file"
          onChange={handleUpload}
          disabled={uploading || !socket}
          className="file-share-input"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading || !socket}
          className="file-share-upload-btn"
        >
          <Upload size={16} />
          {uploading ? "Uploading..." : "Upload file"}
        </button>
        {error && <span className="file-share-error">{error}</span>}
      </div>
      <div className="file-share-list">
        {files.length === 0 && (
          <div className="file-share-empty">No files shared yet</div>
        )}
        {files.map((f) => (
          <div key={f.id} className="file-share-item">
            <span className="file-share-name" title={f.fileName}>
              {f.fileName}
            </span>
            <span className="file-share-meta">
              {f.userName} · {formatSize(f.size)}
            </span>
            <button
              type="button"
              onClick={() => download(f)}
              disabled={!f.data}
              className="file-share-download"
              title="Download"
            >
              <Download size={14} />
            </button>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
