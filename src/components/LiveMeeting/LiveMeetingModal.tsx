import { useState, useRef, useEffect, useCallback, lazy, Suspense, Component, type ReactNode } from "react";
import { GlassCard, GlassButton } from "@/components/Glass";
import {
  X,
  Phone,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Copy,
  Check,
  MessageSquare,
  Share2,
  MonitorOff,
  FileText,
  Users,
  LayoutGrid,
  User,
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { ChatPanel } from "./ChatPanel";
import { LiveTranscription } from "./LiveTranscription";
import { MeetingRecorder } from "./MeetingRecorder";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { useVirtualBackground } from "./useVirtualBackground";
import "./LiveMeetingModal.css";

const VirtualBackground = lazy(() =>
  import("./VirtualBackground").then((m) => ({ default: m.VirtualBackground }))
);

class VirtualBackgroundErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError = () => ({ hasError: true });
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

const DEFAULT_SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : "https://dreamwork-signaling.onrender.com");

function getSignalingUrl(override?: string): string {
  if (override) return override.replace(/\/$/, "");
  if (typeof window === "undefined") return DEFAULT_SIGNALING_URL;
  const params = new URLSearchParams(window.location.search);
  const paramOverride = params.get("signaling");
  if (paramOverride) return paramOverride.replace(/\/$/, "");
  return DEFAULT_SIGNALING_URL;
}

function generateRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

interface Participant {
  id: string;
  userName: string;
  stream?: MediaStream;
  isMuted?: boolean;
  isVideoOff?: boolean;
}

interface PeerDebugRow {
  id: string;
  userName: string;
  signalingState: RTCSignalingState | "n/a";
  connectionState: RTCPeerConnectionState | "n/a";
  iceConnectionState: RTCIceConnectionState | "n/a";
  pendingIce: number;
  makingOffer: boolean;
  ignoringOffer: boolean;
}

interface LiveMeetingModalProps {
  isOpen: boolean;
  onClose: () => void;
  inCallFromParent?: boolean;
  onEnterCall?: () => void;
  onLeaveCall?: () => void;
}

export function LiveMeetingModal({ isOpen, onClose, inCallFromParent = false, onEnterCall, onLeaveCall }: LiveMeetingModalProps) {
  const [step, setStep] = useState<"join" | "lobby" | "in-call">("join");
  const [userName, setUserName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showTranscription, setShowTranscription] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [viewMode, setViewMode] = useState<"gallery" | "speaker">("gallery");
  const [isRecording, setIsRecording] = useState(false);
  const [modalSize, setModalSize] = useState({ w: 960, h: 720 });
  const [controlsVisible, setControlsVisible] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [peerDebugRows, setPeerDebugRows] = useState<PeerDebugRow[]>([]);
  const [meetingMode, setMeetingMode] = useState<"cloud" | "local">("cloud");
  const [localRole, setLocalRole] = useState<"host" | "join">("host");
  const [localHostUrl, setLocalHostUrl] = useState("");
  const [embeddedSignalingUrl, setEmbeddedSignalingUrl] = useState<string | null>(null);
  const [embeddedSignalingLocalhost, setEmbeddedSignalingLocalhost] = useState<string | null>(null);
  const { mode: bgMode, setMode: setBgMode, color: bgColor, setColor: setBgColor } = useVirtualBackground();

  const isElectron = typeof window !== "undefined" && !!(window as unknown as { electronAPI?: unknown }).electronAPI;

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const streamsRef = useRef<Record<string, MediaStream>>({});
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const callAreaRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const joiningRef = useRef(false);
  const inCallRef = useRef(false);
  const isSharingScreenRef = useRef(false);
  const makingOfferRef = useRef<Record<string, boolean>>({});
  const ignoreOfferRef = useRef<Record<string, boolean>>({});
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({});

  const debugMeeting =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debugMeeting") === "1";

  const hasActiveCallContext =
    inCallRef.current || inCallFromParent || !!socketRef.current || !!localStreamRef.current;
  const showInCallView =
    step === "lobby" ||
    step === "in-call" ||
    hasActiveCallContext;
  const showJoinForm = step === "join" && !hasActiveCallContext;

  useEffect(() => {
    if (isOpen && step === "join") {
      nameInputRef.current?.focus();
    }
  }, [isOpen, step]);

  useEffect(() => {
    if (!isOpen) setConnectionError(null);
  }, [isOpen]);

  useEffect(() => {
    const stream = displayStream ?? localStream;
    if (!stream) return;
    const apply = (video: HTMLVideoElement | null) => {
      if (video && stream) {
        video.srcObject = stream;
        video.play().catch(() => {});
      }
    };
    apply(localVideoRef.current);
    const id = requestAnimationFrame(() => apply(localVideoRef.current));
    return () => cancelAnimationFrame(id);
  }, [displayStream, localStream]);

  useEffect(() => {
    isSharingScreenRef.current = isSharingScreen;
  }, [isSharingScreen]);

  const setLocalVideoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      (localVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
      const stream = displayStream ?? localStream;
      if (el && stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
    },
    [displayStream, localStream]
  );

  const replaceVideoTrack = (newTrack: MediaStreamTrack | null) => {
    const track = newTrack ?? cameraVideoTrackRef.current;
    if (!track) return;
    Object.values(peerConnectionsRef.current).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      sender?.replaceTrack(track);
    });
  };

  const clearPeerState = (remoteId: string) => {
    delete makingOfferRef.current[remoteId];
    delete ignoreOfferRef.current[remoteId];
    delete pendingIceRef.current[remoteId];
  };

  const isPolitePeer = (remoteId: string) => {
    const localId = socketRef.current?.id;
    if (!localId) return true;
    return localId > remoteId;
  };

  const flushPendingIceCandidates = async (remoteId: string, pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current[remoteId];
    if (!pending?.length) return;
    pendingIceRef.current[remoteId] = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore stale candidates if remote description changed while reconnecting
      }
    }
  };

  const sendOffer = async (remoteId: string) => {
    const socket = socketRef.current;
    const pc = peerConnectionsRef.current[remoteId];
    if (!socket || !pc) return;
    try {
      makingOfferRef.current[remoteId] = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.localDescription) {
        socket.emit("offer", { to: remoteId, offer: pc.localDescription });
      }
    } catch {
      // Ignore if peer leaves during offer creation
    } finally {
      makingOfferRef.current[remoteId] = false;
    }
  };

  const collectPeerDebugRows = useCallback(() => {
    const nameById = new Map(participants.map((p) => [p.id, p.userName]));
    const rows = Object.keys(peerConnectionsRef.current).map((id) => {
      const pc = peerConnectionsRef.current[id];
      return {
        id,
        userName: nameById.get(id) ?? "Unknown",
        signalingState: pc?.signalingState ?? "n/a",
        connectionState: pc?.connectionState ?? "n/a",
        iceConnectionState: pc?.iceConnectionState ?? "n/a",
        pendingIce: pendingIceRef.current[id]?.length ?? 0,
        makingOffer: !!makingOfferRef.current[id],
        ignoringOffer: !!ignoreOfferRef.current[id],
      } satisfies PeerDebugRow;
    });
    setPeerDebugRows(rows);
  }, [participants]);

  useEffect(() => {
    if (!debugMeeting || !showInCallView) return;
    collectPeerDebugRows();
    const id = window.setInterval(collectPeerDebugRows, 1000);
    return () => window.clearInterval(id);
  }, [debugMeeting, showInCallView, collectPeerDebugRows]);

  const createPeerConnection = (remoteId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const stream = localStreamRef.current ?? localStream;
    const videoTrack = screenStreamRef.current?.getVideoTracks()[0] ?? stream?.getVideoTracks()[0];
    const audioTrack = stream?.getAudioTracks()[0];
    if (videoTrack && stream) pc.addTrack(videoTrack, stream);
    if (audioTrack && stream) pc.addTrack(audioTrack, stream);

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) {
        streamsRef.current[remoteId] = stream;
        setParticipants((prev) =>
          prev.map((p) => (p.id === remoteId ? { ...p, stream } : p))
        );
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && socketRef.current) {
        socketRef.current.emit("ice-candidate", { to: remoteId, candidate: e.candidate });
      }
    };

    peerConnectionsRef.current[remoteId] = pc;
    return pc;
  };

  const joinRoom = async () => {
    if (!userName.trim() || !roomId.trim()) return;
    if (joiningRef.current) return;
    joiningRef.current = true;
    setConnectionError(null);
    setStep("lobby");

    let signalingUrl: string;
    if (meetingMode === "local") {
      const hostUrl = localHostUrl.trim();
      const isHost = localRole === "host";
      if (isHost && isElectron) {
        try {
          const api = (window as unknown as { electronAPI?: { startEmbeddedSignaling: () => Promise<{ port: number; localIP: string }> } }).electronAPI;
          const { port, localIP } = await api!.startEmbeddedSignaling();
          signalingUrl = `http://localhost:${port}`;
          setEmbeddedSignalingUrl(`http://${localIP}:${port}`);
          setEmbeddedSignalingLocalhost(`http://localhost:${port}`);
        } catch {
          setConnectionError("Failed to start local signaling. Try cloud mode.");
          joiningRef.current = false;
          setStep("join");
          return;
        }
      } else if (hostUrl) {
        signalingUrl = getSignalingUrl(hostUrl);
      } else {
        setConnectionError(
          isElectron
            ? "Create room: select Create room, click New, enter name, then Join. Join room: select Join room, enter host address from the host."
            : "Local meeting requires the desktop app. Run with npm run dev (Electron)."
        );
        joiningRef.current = false;
        setStep("join");
        return;
      }
    } else {
      signalingUrl = getSignalingUrl();
    }
    let stream: MediaStream | null = null;
    let socket: Socket | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const videoTrack = stream.getVideoTracks()[0];
      cameraVideoTrackRef.current = videoTrack ?? null;
      localStreamRef.current = stream;
      setLocalStream(stream);
      setDisplayStream(stream);

      socket = io(signalingUrl, {
        timeout: 60000, // Render free tier cold start can take 25–60s
        reconnectionAttempts: 5,
      });
      const connectedSocket = socket;
      socketRef.current = connectedSocket;

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error("Signaling server did not connect in time."));
        }, 25000);
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onConnectError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          window.clearTimeout(timer);
          connectedSocket.off("connect", onConnect);
          connectedSocket.off("connect_error", onConnectError);
        };
        connectedSocket.once("connect", onConnect);
        connectedSocket.once("connect_error", onConnectError);
      });

      connectedSocket.on("connect_error", (err) => {
        const msg = err.message || "Could not connect.";
        setConnectionError(
          meetingMode === "local"
            ? `${msg} Same WiFi + different VPN? Try cloud mode.`
            : `${msg} If using Render free tier, wait ~60s for cold start.`
        );
      });

      connectedSocket.emit("join-room", roomId, userName);

      connectedSocket.on("room-users", (users: { id: string; userName: string }[]) => {
        const others = users.filter((u) => u.id !== connectedSocket.id);
        setParticipants(
          others.map((u) => ({ id: u.id, userName: u.userName, stream: undefined }))
        );
        others.forEach((u) => {
          if (!peerConnectionsRef.current[u.id]) createPeerConnection(u.id);
        });
      });

      connectedSocket.on("user-joined", (data: { id: string; userName: string }) => {
        if (data.id === connectedSocket.id) return;
        setParticipants((prev) => {
          if (prev.some((p) => p.id === data.id)) return prev;
          return [...prev, { id: data.id, userName: data.userName, stream: undefined }];
        });
        if (!peerConnectionsRef.current[data.id]) createPeerConnection(data.id);
        sendOffer(data.id);
      });

      connectedSocket.on("offer", async (data: { from: string; offer: RTCSessionDescriptionInit }) => {
        let pc = peerConnectionsRef.current[data.from];
        if (!pc) pc = createPeerConnection(data.from);
        const offerCollision =
          data.offer.type === "offer" &&
          (makingOfferRef.current[data.from] || pc.signalingState !== "stable");
        const ignoreOffer = !isPolitePeer(data.from) && offerCollision;
        ignoreOfferRef.current[data.from] = ignoreOffer;
        if (ignoreOffer) return;
        if (offerCollision) {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await flushPendingIceCandidates(data.from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        connectedSocket.emit("answer", { to: data.from, answer });
      });

      connectedSocket.on("answer", async (data: { from: string; answer: RTCSessionDescriptionInit }) => {
        const pc = peerConnectionsRef.current[data.from];
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await flushPendingIceCandidates(data.from, pc);
      });

      connectedSocket.on("ice-candidate", async (data: { from: string; candidate: RTCIceCandidateInit }) => {
        let pc = peerConnectionsRef.current[data.from];
        if (!pc) pc = createPeerConnection(data.from);
        if (!data.candidate) return;
        if (ignoreOfferRef.current[data.from]) return;
        if (!pc.remoteDescription) {
          pendingIceRef.current[data.from] = [...(pendingIceRef.current[data.from] ?? []), data.candidate];
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch {
          pendingIceRef.current[data.from] = [...(pendingIceRef.current[data.from] ?? []), data.candidate];
        }
      });

      connectedSocket.on("user-left", (id: string) => {
        peerConnectionsRef.current[id]?.close();
        delete peerConnectionsRef.current[id];
        delete streamsRef.current[id];
        clearPeerState(id);
        setParticipants((prev) => prev.filter((p) => p.id !== id));
      });

      inCallRef.current = true;
      setStep("in-call");
      onEnterCall?.();
    } catch (err) {
      socket?.disconnect();
      socketRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
      peerConnectionsRef.current = {};
      streamsRef.current = {};
      makingOfferRef.current = {};
      ignoreOfferRef.current = {};
      pendingIceRef.current = {};
      setParticipants([]);
      localStreamRef.current = null;
      setLocalStream(null);
      setDisplayStream(null);
      setEmbeddedSignalingUrl(null);
      setEmbeddedSignalingLocalhost(null);
      if (isElectron && meetingMode === "local") {
        (window as unknown as { electronAPI?: { stopEmbeddedSignaling: () => Promise<void> } }).electronAPI?.stopEmbeddedSignaling?.();
      }
      const errMsg = err instanceof Error ? err.message : "Could not access camera or microphone.";
      const isConnectionErr = /connect|timeout|ECONNREFUSED|network/i.test(errMsg);
      setConnectionError(
        isConnectionErr && meetingMode === "local"
          ? `${errMsg} Same WiFi? Different VPN? Try cloud mode.`
          : isConnectionErr
            ? `${errMsg} If using Render free tier, wait ~60s for cold start.`
            : errMsg
      );
      setStep("join");
    } finally {
      joiningRef.current = false;
    }
  };

  const createRoom = () => {
    setRoomId(generateRoomId());
  };

  const copyRoomId = async () => {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    localStream?.getAudioTracks().forEach((t) => (t.enabled = !nextMuted));
    setIsMuted(nextMuted);
  };

  const toggleVideo = () => {
    const nextVideoOff = !isVideoOff;
    localStream?.getVideoTracks().forEach((t) => (t.enabled = !nextVideoOff));
    setIsVideoOff(nextVideoOff);
  };

  const stopScreenShare = () => {
    if (!screenStreamRef.current && !isSharingScreenRef.current) return;
    isSharingScreenRef.current = false;
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    replaceVideoTrack(cameraVideoTrackRef.current);
    setDisplayStream(localStream);
    setIsSharingScreen(false);
    socketRef.current?.emit("screen-sharing-stopped", { roomId });
  };

  const toggleScreenShare = async () => {
    if (isSharingScreenRef.current) {
      stopScreenShare();
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];
        screenTrack.onended = stopScreenShare;
        replaceVideoTrack(screenTrack);
        setDisplayStream(screenStream);
        isSharingScreenRef.current = true;
        setIsSharingScreen(true);
        socketRef.current?.emit("screen-sharing-started", { roomId });
      } catch {
        // User cancelled
      }
    }
  };

  const leaveCall = () => {
    inCallRef.current = false;
    setEmbeddedSignalingUrl(null);
    setEmbeddedSignalingLocalhost(null);
    if (isElectron && meetingMode === "local") {
      (window as unknown as { electronAPI?: { stopEmbeddedSignaling: () => Promise<void> } }).electronAPI?.stopEmbeddedSignaling?.();
    }
    onLeaveCall?.();
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStream?.getTracks().forEach((t) => t.stop());
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    streamsRef.current = {};
    makingOfferRef.current = {};
    ignoreOfferRef.current = {};
    pendingIceRef.current = {};
    socketRef.current?.disconnect();
    socketRef.current = null;
    localStreamRef.current = null;
    setLocalStream(null);
    setDisplayStream(null);
    setParticipants([]);
    setStep("join");
    onClose();
  };

  const remoteStreams = participants.reduce(
    (acc, p) => {
      if (p.stream) acc[p.id] = p.stream;
      return acc;
    },
    {} as Record<string, MediaStream>
  );

  const allTiles = [
    { id: "local", userName: userName || "You", stream: displayStream, isLocal: true },
    ...participants.map((p) => ({ ...p, isLocal: false })),
  ];

  const startRef = useRef({ w: 0, h: 0, x: 0, y: 0 });

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { w: modalSize.w, h: modalSize.h, x: e.clientX, y: e.clientY };
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startRef.current.x;
      const dy = ev.clientY - startRef.current.y;
      const w = Math.max(520, Math.min(window.innerWidth - 40, startRef.current.w + dx));
      const h = Math.max(400, Math.min(window.innerHeight - 40, startRef.current.h + dy));
      setModalSize({ w, h });
      startRef.current = { w, h, x: ev.clientX, y: ev.clientY };
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  if (!isOpen) return null;

  return (
    <div
      className="live-meeting-modal-overlay"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (showInCallView) leaveCall();
        else onClose();
      }}
    >
      <div
        className="live-meeting-modal-wrapper"
        style={
            showJoinForm
            ? { width: 420, height: "auto", minHeight: 320 }
            : { width: modalSize.w, height: modalSize.h }
        }
      >
      <GlassCard className="live-meeting-modal">
        <div className="live-meeting-modal-header">
          <h2>Live Video Meeting</h2>
          <button
            type="button"
            onClick={showInCallView ? leaveCall : onClose}
            className="live-meeting-close"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {showJoinForm && (
          <div className="live-meeting-join">
            <div className="live-meeting-join-title">Join a meeting</div>
            <div className="live-meeting-join-features">
              <span className="live-meeting-join-feature">Video</span>
              <span className="live-meeting-join-feature">Screen share</span>
              <span className="live-meeting-join-feature">Chat</span>
              <span className="live-meeting-join-feature">Recording</span>
            </div>
            {isElectron && (
              <div className="live-meeting-mode-row">
                <span className="live-meeting-mode-label">Mode:</span>
                <button
                  type="button"
                  className={`live-meeting-mode-btn ${meetingMode === "cloud" ? "active" : ""}`}
                  onClick={() => { setMeetingMode("cloud"); setConnectionError(null); }}
                >
                  Cloud
                </button>
                <button
                  type="button"
                  className={`live-meeting-mode-btn ${meetingMode === "local" ? "active" : ""}`}
                  onClick={() => { setMeetingMode("local"); setConnectionError(null); }}
                >
                  Local (same WiFi)
                </button>
              </div>
            )}
            {meetingMode === "local" && (
              <>
                <div className="live-meeting-mode-row">
                  <span className="live-meeting-mode-label">Role:</span>
                  <button
                    type="button"
                    className={`live-meeting-mode-btn ${localRole === "host" ? "active" : ""}`}
                    onClick={() => { setLocalRole("host"); setLocalHostUrl(""); setConnectionError(null); }}
                  >
                    Create room
                  </button>
                  <button
                    type="button"
                    className={`live-meeting-mode-btn ${localRole === "join" ? "active" : ""}`}
                    onClick={() => { setLocalRole("join"); setConnectionError(null); }}
                  >
                    Join room
                  </button>
                </div>
                {localRole === "host" && (
                  <span className="live-meeting-hint">Click New → enter name → Join Meeting. Share the URL shown after joining.</span>
                )}
                {localRole === "join" && (
                  <input
                    type="text"
                    placeholder="Host address (e.g. http://192.168.1.5:12345 or http://localhost:12345)"
                    value={localHostUrl}
                    onChange={(e) => { setLocalHostUrl(e.target.value); setConnectionError(null); }}
                    className="live-meeting-input"
                  />
                )}
              </>
            )}
            <input
              ref={nameInputRef}
              type="text"
              placeholder="Your name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && userName.trim() && roomId.trim() && joinRoom()}
              className="live-meeting-input"
            />
            <div className="live-meeting-room-row">
              <input
                type="text"
                placeholder="Room ID"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && userName.trim() && roomId.trim() && joinRoom()}
                className="live-meeting-input"
              />
              <GlassButton variant="secondary" size="sm" onClick={createRoom}>
                New
              </GlassButton>
              <GlassButton variant="secondary" size="sm" onClick={copyRoomId} disabled={!roomId}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </GlassButton>
            </div>
            {connectionError && (
              <div className="live-meeting-connection-error" style={{ marginBottom: 8 }}>
                {connectionError}
              </div>
            )}
            <button
              type="button"
              className="live-meeting-join-btn"
              onClick={joinRoom}
              disabled={
                !userName.trim() || !roomId.trim() ||
                (meetingMode === "local" && localRole === "join" && !localHostUrl.trim())
              }
            >
              <Phone size={18} />
              Join Meeting
            </button>
          </div>
        )}

        {showInCallView && (
          <div className="live-meeting-call" ref={callAreaRef}>
            <div className="live-meeting-call-inner">
              <div className="live-meeting-info-bar">
                {embeddedSignalingUrl && (
                  <div className="live-meeting-share-url">
                    <span>Share with participants: </span>
                    <code>{embeddedSignalingUrl}</code>
                    <button
                      type="button"
                      className="live-meeting-copy-url"
                      onClick={async () => {
                        await navigator.clipboard.writeText(embeddedSignalingUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    {embeddedSignalingLocalhost && (
                      <span className="live-meeting-share-hint">Same machine: {embeddedSignalingLocalhost}</span>
                    )}
                  </div>
                )}
                {connectionError && (
                  <div className="live-meeting-connection-error">
                    {connectionError}
                  </div>
                )}
                <div className="live-meeting-room-code">
                  <span>{roomId}</span>
                  <button
                    type="button"
                    onClick={copyRoomId}
                    className="live-meeting-control-btn"
                    title="Copy room ID"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <div className="live-meeting-view-toggle">
                  <button
                    type="button"
                    className={`live-meeting-view-btn ${viewMode === "gallery" ? "active" : ""}`}
                    onClick={() => setViewMode("gallery")}
                  >
                    <LayoutGrid size={12} />
                  </button>
                  <button
                    type="button"
                    className={`live-meeting-view-btn ${viewMode === "speaker" ? "active" : ""}`}
                    onClick={() => setViewMode("speaker")}
                  >
                    <User size={12} />
                  </button>
                </div>
                {isRecording && (
                  <div className="live-meeting-recording-badge">
                    <span />
                    REC
                  </div>
                )}
              </div>
              {debugMeeting && (
                <div className="live-meeting-connection-error" style={{ marginTop: 8, overflowX: "auto" }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    Debug Mode (socket: {socketRef.current?.id ?? "not connected"})
                  </div>
                  {peerDebugRows.length === 0 ? (
                    <div>No peers yet</div>
                  ) : (
                    peerDebugRows.map((row) => (
                      <div key={row.id} style={{ marginBottom: 4, fontSize: 12 }}>
                        [{row.userName}] {row.signalingState}/{row.connectionState}/{row.iceConnectionState} | pendingICE=
                        {row.pendingIce} | makingOffer={String(row.makingOffer)} | ignoringOffer={String(row.ignoringOffer)}
                      </div>
                    ))
                  )}
                </div>
              )}

              <div
                className={`live-meeting-main-row ${
                  !showChat && !showTranscription && !showParticipants ? "no-panels" : ""
                }`}
              >
                {(showChat || showTranscription) && (
                <div className="live-meeting-left-panels">
                  <ChatPanel
                    socket={socketRef.current}
                    roomId={roomId}
                    userName={userName}
                    isOpen={showChat}
                    onClose={() => setShowChat(false)}
                  />
                  <LiveTranscription
                    isOpen={showTranscription}
                    onClose={() => setShowTranscription(false)}
                    localStream={localStream}
                  />
                </div>
                )}
                <div className="live-meeting-video-section">
              <div className={`live-meeting-grid ${viewMode}`}>
                {allTiles.map((tile) => (
                  <div
                    key={tile.id}
                    className={`live-meeting-video-tile ${tile.isLocal ? "local" : ""}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {tile.isLocal ? (
                      <>
                        {!isVideoOff ? (
                          <>
                            <video
                              ref={setLocalVideoRef}
                              autoPlay
                              muted
                              playsInline
                              style={bgMode !== "none" ? { visibility: "hidden", position: "absolute", inset: 0, zIndex: 0, width: "100%", height: "100%", objectFit: "cover" } : undefined}
                            />
                            {bgMode !== "none" && (
                              <VirtualBackgroundErrorBoundary>
                                <Suspense fallback={null}>
                                  <VirtualBackground
                                    videoRef={localVideoRef}
                                    enabled
                                    mode={bgMode}
                                    color={bgColor}
                                  />
                                </Suspense>
                              </VirtualBackgroundErrorBoundary>
                            )}
                          </>
                        ) : (
                          <div className="live-meeting-placeholder">
                            <VideoOff size={48} />
                          </div>
                        )}
                      </>
                    ) : tile.stream ? (
                      <RemoteVideo stream={tile.stream} />
                    ) : (
                      <div className="live-meeting-placeholder">
                        <span>{tile.userName?.[0]?.toUpperCase() || "?"}</span>
                      </div>
                    )}
                    <span className="live-meeting-name">
                      {tile.userName}
                      {tile.isLocal && isSharingScreen && " (sharing)"}
                    </span>
                  </div>
                ))}
                </div>
                </div>

                {showParticipants && (
                  <div className="live-meeting-right-panel">
                    <ParticipantsPanel
                      participants={participants}
                      localName={userName}
                      isMuted={isMuted}
                      isVideoOff={isVideoOff}
                      isOpen={showParticipants}
                      onClose={() => setShowParticipants(false)}
                    />
                  </div>
                )}
              </div>
            </div>

            <div
              className="live-meeting-control-bar-zone"
              onMouseEnter={() => setControlsVisible(true)}
              onMouseLeave={() => setControlsVisible(false)}
            >
              <div className={`live-meeting-controls-wrap ${controlsVisible ? "" : "hidden"}`}>
              <div className="live-meeting-controls">
                <button
                  type="button"
                  className={`live-meeting-control-btn ${isMuted ? "danger" : ""}`}
                  onClick={toggleMute}
                  title={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
                <button
                  type="button"
                  className={`live-meeting-control-btn ${isVideoOff ? "danger" : ""}`}
                  onClick={toggleVideo}
                  title={isVideoOff ? "Start video" : "Stop video"}
                >
                  {isVideoOff ? <VideoOff size={18} /> : <Video size={18} />}
                </button>
                <button
                  type="button"
                  className={`live-meeting-control-btn ${isSharingScreen ? "active" : ""}`}
                  onClick={toggleScreenShare}
                  title={isSharingScreen ? "Stop sharing" : "Share screen"}
                >
                  {isSharingScreen ? <MonitorOff size={18} /> : <Share2 size={18} />}
                </button>
                <button
                  type="button"
                  className={`live-meeting-control-btn ${showChat ? "active" : ""}`}
                  onClick={() => setShowChat((v) => !v)}
                  title="Chat"
                >
                  <MessageSquare size={18} />
                </button>
                <button
                  type="button"
                  className={`live-meeting-control-btn ${showParticipants ? "active" : ""}`}
                  onClick={() => setShowParticipants((v) => !v)}
                  title="Participants"
                >
                  <Users size={18} />
                </button>
                <button
                  type="button"
                  className={`live-meeting-control-btn ${showTranscription ? "active" : ""}`}
                  onClick={() => setShowTranscription((v) => !v)}
                  title="Transcription"
                >
                  <FileText size={18} />
                </button>
                <select
                  value={bgMode}
                  onChange={(e) => setBgMode(e.target.value as "none" | "blur" | "color")}
                  className="live-meeting-bg-select"
                  title="Virtual background"
                >
                  <option value="none">Background</option>
                  <option value="blur">Blur</option>
                  <option value="color">Color</option>
                </select>
                {bgMode === "color" && (
                  <input
                    type="color"
                    value={bgColor}
                    onChange={(e) => setBgColor(e.target.value)}
                    className="live-meeting-bg-color-picker"
                    title="Change background color"
                  />
                )}
                <MeetingRecorder
                  localStream={displayStream}
                  remoteStreams={remoteStreams}
                  onRecordingChange={setIsRecording}
                />
                <button
                  type="button"
                  className="live-meeting-control-btn leave"
                  onClick={leaveCall}
                  title="Leave"
                >
                  <Phone size={18} />
                </button>
              </div>
            </div>
            </div>
          </div>
        )}
        {step !== "join" && (
        <div
          className="live-meeting-resize-handle"
          onMouseDown={onResizeStart}
          title="Drag to resize"
          aria-label="Resize meeting window"
        />
        )}
      </GlassCard>
      </div>
    </div>
  );
}

function RemoteVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (video && stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline />;
}
