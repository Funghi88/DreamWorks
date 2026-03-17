import { useState, useRef, useEffect } from "react";
import { GlassCard } from "@/components/Glass";
import { Send, X } from "lucide-react";
import type { Socket } from "socket.io-client";
import "./ChatPanel.css";

interface Message {
  id: string;
  from: string;
  userName: string;
  text: string;
  ts: number;
  isOwn: boolean;
}

interface ChatPanelProps {
  socket: Socket | null;
  roomId: string;
  userName: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ChatPanel({ socket, roomId, userName: _userName, isOpen, onClose }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: { from: string; userName: string; text: string; ts: number }) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `${data.from}-${data.ts}`,
          from: data.from,
          userName: data.userName,
          text: data.text,
          ts: data.ts,
          isOwn: data.from === socket.id,
        },
      ]);
    };
    socket.on("chat-message", handler);
    return () => {
      socket.off("chat-message", handler);
    };
  }, [socket]);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const send = () => {
    const text = input.trim();
    if (!text || !socket || !roomId) return;
    socket.emit("chat-message", { roomId, text });
    setInput("");
  };

  if (!isOpen) return null;

  return (
    <GlassCard className="chat-panel">
      <div className="chat-panel-header">
        <span>Chat</span>
        <button type="button" onClick={onClose} className="chat-panel-close" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div ref={listRef} className="chat-panel-messages">
        {messages.length === 0 && (
          <div className="chat-panel-empty">No messages yet</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-message ${m.isOwn ? "own" : ""}`}>
            <span className="chat-message-sender">{m.userName}</span>
            <span className="chat-message-text">{m.text}</span>
          </div>
        ))}
      </div>
      <div className="chat-panel-input-row">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type a message..."
          className="chat-panel-input"
        />
        <button type="button" onClick={send} className="chat-panel-send" aria-label="Send">
          <Send size={16} />
        </button>
      </div>
    </GlassCard>
  );
}
