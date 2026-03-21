import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef, lazy, Suspense, Component, type ReactNode } from "react";
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
  Paperclip,
  Users,
  LayoutGrid,
  User,
  PenSquare,
  Maximize2,
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { ChatPanel } from "./ChatPanel";
import { FileSharePanel } from "./FileSharePanel";
import { LiveTranscription } from "./LiveTranscription";
import { MeetingRecorder } from "./MeetingRecorder";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { useVirtualBackground } from "./useVirtualBackground";
import { getDisplayMediaPreferMonitor } from "@/lib/displayMedia";
import "./LiveMeetingModal.css";

const VirtualBackground = lazy(() =>
  import("./VirtualBackground").then((m) => {
    m.preloadSegmenter?.();
    return { default: m.VirtualBackground };
  })
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

/** Parse invite link like http://192.168.31.5:51697?room=2lc7l663 → { hostUrl, roomId } */
function parseInviteLink(input: string): { hostUrl: string; roomId: string } | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const url = s.startsWith("http") ? new URL(s) : new URL(`http://${s}`);
    const room = url.searchParams.get("room") ?? url.pathname.match(/\/room\/([a-z0-9]+)/i)?.[1];
    const hostUrl = `${url.protocol}//${url.host}`;
    if (room) return { hostUrl, roomId: room };
    if (url.host) return { hostUrl, roomId: "" };
  } catch {
    return null;
  }
  return null;
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

export interface LiveMeetingModalHandle {
  enterCompactMode: () => void;
}

export const LiveMeetingModal = forwardRef<LiveMeetingModalHandle, LiveMeetingModalProps>(function LiveMeetingModal(
  { isOpen, onClose, inCallFromParent = false, onEnterCall, onLeaveCall },
  ref
) {
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
  const [showFiles, setShowFiles] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [remoteSharingParticipantId, setRemoteSharingParticipantId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"gallery" | "speaker">("gallery");
  const [isRecording, setIsRecording] = useState(false);
  const [modalSize, setModalSize] = useState({ w: 960, h: 720 });
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [peerDebugRows, setPeerDebugRows] = useState<PeerDebugRow[]>([]);
  const [meetingMode, setMeetingMode] = useState<"cloud" | "local">("cloud");
  const [localRole, setLocalRole] = useState<"host" | "join">("host");
  const [localHostUrl, setLocalHostUrl] = useState("");
  const [inviteLinkInput, setInviteLinkInput] = useState("");
  const [embeddedSignalingUrl, setEmbeddedSignalingUrl] = useState<string | null>(null);
  const [embeddedSignalingLocalhost, setEmbeddedSignalingLocalhost] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [recordingPermission, setRecordingPermission] = useState<"host" | "all" | string[]>("host");
  const [showRecordingPermissionPopover, setShowRecordingPermissionPopover] = useState(false);
  const [showBackgroundPopover, setShowBackgroundPopover] = useState(false);
  const bgPopoverRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    enterCompactMode: () => setCompactMode(true),
  }));

  const PRESET_COLORS = [
    "#e0f2fe",
    "#e9d5ff",
    "#fce7f3",
    "#fed7aa",
    "#fef3c7",
    "#d1fae5",
    "#f5f5f5",
    "#1e293b",
  ];
  const { mode: bgMode, setMode: setBgMode, color: bgColor, setColor: setBgColor, imageUrl: bgImageUrl, setImageUrl: setBgImageUrl } = useVirtualBackground();

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
  const createdRoomIdRef = useRef<string | null>(null);
  const recordingPermissionRef = useRef<"host" | "all" | string[]>("host");

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

  useEffect(() => () => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
  }, []);

  useEffect(() => {
    recordingPermissionRef.current = recordingPermission;
  }, [recordingPermission]);

  useEffect(() => {
    if (!showBackgroundPopover) return;
    const onOutside = (e: MouseEvent) => {
      if (bgPopoverRef.current && !bgPopoverRef.current.contains(e.target as Node)) {
        setShowBackgroundPopover(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [showBackgroundPopover]);

  useEffect(() => {
    if (meetingMode === "local" && !isElectron && localRole === "host") {
      setLocalRole("join");
    }
  }, [meetingMode, isElectron, localRole]);

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
        const isConn = /connect|timeout|ECONNREFUSED|network|xhr poll|websocket/i.test(msg);
        if (isConn && meetingMode === "cloud" && import.meta.env.DEV) {
          setConnectionError("Cloud 模式需先启动 signaling：在另一终端运行 npm run signaling，再点 Join。");
        } else if (isConn && meetingMode === "local") {
          setConnectionError("连接失败。同一 WiFi？关闭 VPN 再试。或改用 Cloud 模式。");
        } else if (isConn) {
          setConnectionError("连接失败。云服务冷启动约需 60 秒，请稍候重试。或改用 Local 模式（同一 WiFi）。");
        } else {
          setConnectionError(msg);
        }
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
        if (roomId === createdRoomIdRef.current) {
          connectedSocket.emit("recording-permission", {
            roomId,
            allowed: recordingPermissionRef.current,
          });
        }
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

      connectedSocket.on("recording-permission", (data: { from: string; allowed: "host" | "all" | string[] }) => {
        setRecordingPermission(data.allowed);
      });

      connectedSocket.on("screen-sharing-started", (data: { userId: string }) => {
        setRemoteSharingParticipantId(data.userId);
      });
      connectedSocket.on("screen-sharing-stopped", (data: { userId: string }) => {
        setRemoteSharingParticipantId((prev) => (prev === data.userId ? null : prev));
      });

      const host = roomId === createdRoomIdRef.current;
      setIsHost(host);
      setRecordingPermission("host");
      if (host) {
        connectedSocket.emit("recording-permission", { roomId, allowed: "host" });
      }
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
      const isConnectionErr = /connect|timeout|ECONNREFUSED|network|xhr poll|websocket/i.test(errMsg);
      let hint = errMsg;
      if (isConnectionErr) {
        if (meetingMode === "local") {
          hint = "连接失败。同一 WiFi？关闭 VPN 再试。或改用 Cloud 模式。";
        } else if (import.meta.env.DEV) {
          hint = "Cloud 模式需先启动 signaling：在另一终端运行 npm run signaling，再点 Join。";
        } else {
          hint = "连接失败。云服务冷启动约需 60 秒，请稍候重试。或改用 Local 模式（同一 WiFi）。";
        }
      }
      setConnectionError(hint);
      setStep("join");
    } finally {
      joiningRef.current = false;
    }
  };

  const createRoom = () => {
    const id = generateRoomId();
    setRoomId(id);
    createdRoomIdRef.current = id;
  };

  const copyRoomId = async () => {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyFullInvite = async () => {
    const text =
      embeddedSignalingUrl && roomId
        ? `${embeddedSignalingUrl}?room=${roomId}`
        : embeddedSignalingUrl
          ? `Join at ${embeddedSignalingUrl}\nRoom ID: ${roomId}`
          : `Room ID: ${roomId}`;
    await navigator.clipboard.writeText(text);
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
        const screenStream = await getDisplayMediaPreferMonitor(false);
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
    setIsHost(false);
    setRecordingPermission("host");
    setRemoteSharingParticipantId(null);
    createdRoomIdRef.current = null;
    if (bgImageUrl) URL.revokeObjectURL(bgImageUrl);
    setBgImageUrl(null);
    onClose();
  };

  const localSocketId = socketRef.current?.id ?? "";
  const canRecord =
    isHost ||
    recordingPermission === "all" ||
    (Array.isArray(recordingPermission) && recordingPermission.includes(localSocketId));

  const setRecordingPermissionAndEmit = (allowed: "host" | "all" | string[]) => {
    setRecordingPermission(allowed);
    if (isHost && socketRef.current) {
      socketRef.current.emit("recording-permission", { roomId, allowed });
    }
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

  const onResizeStart = (fromRight: boolean) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { w: modalSize.w, h: modalSize.h, x: e.clientX, y: e.clientY };
    document.body.style.cursor = fromRight ? "nwse-resize" : "nesw-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startRef.current.x;
      const dy = ev.clientY - startRef.current.y;
      const dw = fromRight ? dx : -dx;
      const maxH = window.innerHeight - 140; /* 100px header + 40px margin */
      const w = Math.max(520, Math.min(window.innerWidth - 40, startRef.current.w + dw));
      const h = Math.max(400, Math.min(maxH, startRef.current.h + dy));
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
    <div className={`live-meeting-modal-overlay ${compactMode ? "compact" : ""}`}>
      {/* Backdrop for click-outside-to-close; overlay has pointer-events:none so header stays clickable */}
      <div
        className="live-meeting-modal-backdrop"
        aria-hidden
        onClick={() => {
          if (compactMode) return;
          if (showInCallView) leaveCall();
          else onClose();
        }}
      />
      <div
        className="live-meeting-modal-wrapper"
        style={
            showJoinForm
            ? { width: 420, height: "auto", minHeight: 320 }
            : compactMode
            ? { width: "100%", maxWidth: 900, height: 180 }
            : { width: modalSize.w, height: modalSize.h, maxHeight: "calc(100vh - 120px)" }
        }
      >
      <GlassCard className={`live-meeting-modal ${compactMode ? "compact" : ""}`}>
        <div className="live-meeting-modal-header">
          <h2>Live Video Meeting</h2>
          <div className="live-meeting-header-actions">
            {showInCallView && (
              <>
                <button
                  type="button"
                  className={`live-meeting-control-btn ${compactMode ? "active" : ""}`}
                  onClick={() => {
                    setCompactMode((v) => !v);
                    if (!compactMode) {
                      setShowChat(false);
                      setShowFiles(false);
                      setShowParticipants(false);
                      setShowTranscription(false);
                    }
                  }}
                  title={compactMode ? "Expand meeting" : "Share whiteboard (minimize to show whiteboard)"}
                >
                  {compactMode ? <Maximize2 size={18} /> : <PenSquare size={18} />}
                </button>
                <button
                  type="button"
                  onClick={showInCallView ? leaveCall : onClose}
                  className="live-meeting-close"
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </>
            )}
            {!showInCallView && (
              <button
                type="button"
                onClick={onClose}
                className="live-meeting-close"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            )}
          </div>
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
            {meetingMode === "local" && (
              <>
                <div className="live-meeting-mode-row">
                  <span className="live-meeting-mode-label">Role:</span>
                  {isElectron && (
                  <button
                    type="button"
                    className={`live-meeting-mode-btn ${localRole === "host" ? "active" : ""}`}
                    onClick={() => { setLocalRole("host"); setLocalHostUrl(""); setInviteLinkInput(""); setConnectionError(null); }}
                  >
                    Create room
                  </button>
                  )}
                  <button
                    type="button"
                    className={`live-meeting-mode-btn ${localRole === "join" ? "active" : ""}`}
                    onClick={() => { setLocalRole("join"); setInviteLinkInput(""); setConnectionError(null); }}
                  >
                    Join room
                  </button>
                </div>
                {localRole === "host" && (
                  <span className="live-meeting-hint">Click New → enter name → Join Meeting. Share the invite link (one link has both) shown after joining.</span>
                )}
                {localRole === "join" && (
                  <>
                    <input
                      type="text"
                      placeholder="Paste invite link (e.g. http://192.168.1.5:12345?room=abc123)"
                      value={inviteLinkInput}
                      onChange={(e) => {
                        const v = e.target.value;
                        setInviteLinkInput(v);
                        setConnectionError(null);
                        if (!v.trim()) {
                          setLocalHostUrl("");
                          return;
                        }
                        const parsed = parseInviteLink(v);
                        if (parsed) {
                          setLocalHostUrl(parsed.hostUrl);
                          if (parsed.roomId) setRoomId(parsed.roomId);
                        }
                      }}
                      className="live-meeting-input"
                    />
                    <span className="live-meeting-hint">Paste the invite link from the host (one link has both address and room).</span>
                  </>
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
              {localRole !== "join" && (
                <GlassButton variant="secondary" size="sm" onClick={createRoom}>
                  New
                </GlassButton>
              )}
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
          <div className={`live-meeting-call ${compactMode ? "compact" : ""}`} ref={callAreaRef}>
            <div className="live-meeting-call-inner">
              {!compactMode && (
              <>
              <div className="live-meeting-info-bar">
                <div className="live-meeting-info-bar-inner">
                  {embeddedSignalingUrl ? (
                    <div className="live-meeting-invite-section">
                      <div className="live-meeting-invite-section-header">Invite</div>
                      <div className="live-meeting-invite-row">
                        <code className="live-meeting-invite-url">{embeddedSignalingUrl}?room={roomId}</code>
                        <button
                          type="button"
                          className="live-meeting-copy-invite-btn"
                          onClick={copyFullInvite}
                          title="Copy invite link"
                        >
                          Copy invite
                        </button>
                      </div>
                      {embeddedSignalingLocalhost && (
                        <div className="live-meeting-share-hint">Same machine: {embeddedSignalingLocalhost}?room={roomId}</div>
                      )}
                    </div>
                  ) : (
                    <div className="live-meeting-invite-section">
                      <div className="live-meeting-invite-section-header">Room</div>
                      <div className="live-meeting-invite-row">
                        <code className="live-meeting-invite-url">{roomId}</code>
                        <button
                          type="button"
                          className="live-meeting-copy-invite-btn"
                          onClick={copyRoomId}
                          title="Copy room ID"
                        >
                          {copied ? <Check size={14} /> : "Copy"}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="live-meeting-info-actions">
                    {embeddedSignalingUrl && (
                      <div className="live-meeting-room-code">
                        <span className="live-meeting-room-code-label">Room</span>
                        <span className="live-meeting-room-code-value">{roomId}</span>
                        <button
                          type="button"
                          onClick={copyRoomId}
                          className="live-meeting-copy-btn"
                          title="Copy room ID"
                        >
                          {copied ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                    )}
                    <div className="live-meeting-view-toggle">
                      <button
                        type="button"
                        className={`live-meeting-view-btn ${viewMode === "gallery" ? "active" : ""}`}
                        onClick={() => setViewMode("gallery")}
                        title="Gallery"
                      >
                        <LayoutGrid size={12} />
                      </button>
                      <button
                        type="button"
                        className={`live-meeting-view-btn ${viewMode === "speaker" ? "active" : ""}`}
                        onClick={() => setViewMode("speaker")}
                        title="Speaker"
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
                </div>
                {connectionError && (
                  <div className="live-meeting-connection-error">
                    {connectionError}
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
              </>
              )}
              {compactMode && (
                <div className="live-meeting-compact-hint">
                  <span>Whiteboard visible above.</span>
                  <button
                    type="button"
                    className="live-meeting-compact-share-btn"
                    onClick={toggleScreenShare}
                    disabled={isSharingScreen}
                  >
                    <Share2 size={14} />
                    {isSharingScreen ? "Stop sharing" : "Share screen"}
                  </button>
                  <span>to share with participants.</span>
                </div>
              )}

              <div
                className={`live-meeting-main-row ${
                  !showChat && !showTranscription && !showParticipants && !showFiles ? "no-panels" : ""
                }`}
              >
                {(showChat || showFiles) && (
                <div className="live-meeting-left-panels">
                  <ChatPanel
                    socket={socketRef.current}
                    roomId={roomId}
                    userName={userName}
                    isOpen={showChat}
                    onClose={() => setShowChat(false)}
                  />
                  <FileSharePanel
                    socket={socketRef.current}
                    roomId={roomId}
                    userName={userName}
                    isOpen={showFiles}
                    onClose={() => setShowFiles(false)}
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
                              style={bgMode !== "none" && !(bgMode === "image" && !bgImageUrl) ? { visibility: "hidden", position: "absolute", inset: 0, zIndex: 0, width: "100%", height: "100%", objectFit: "cover" } : undefined}
                            />
                            {bgMode !== "none" && !(bgMode === "image" && !bgImageUrl) && (
                              <VirtualBackgroundErrorBoundary>
                                <Suspense fallback={null}>
                                  <VirtualBackground
                                    videoRef={localVideoRef}
                                    enabled
                                    mode={bgMode}
                                    color={bgColor}
                                    imageUrl={bgImageUrl}
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

                {(showParticipants || showTranscription) && (
                  <div className="live-meeting-right-panels">
                    {showParticipants && (
                      <ParticipantsPanel
                        participants={participants}
                        localName={userName}
                        isMuted={isMuted}
                        isVideoOff={isVideoOff}
                        isOpen={showParticipants}
                        onClose={() => setShowParticipants(false)}
                      />
                    )}
                    {showTranscription && (
                      <LiveTranscription
                        isOpen={showTranscription}
                        onClose={() => setShowTranscription(false)}
                        localStream={localStream}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div
              className="live-meeting-control-bar-zone"
              onMouseEnter={() => {
                if (hideControlsTimerRef.current) {
                  clearTimeout(hideControlsTimerRef.current);
                  hideControlsTimerRef.current = null;
                }
                setControlsVisible(true);
              }}
              onMouseLeave={() => {
                hideControlsTimerRef.current = setTimeout(() => {
                  hideControlsTimerRef.current = null;
                  setControlsVisible(false);
                }, 400);
              }}
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
                  className={`live-meeting-control-btn ${showFiles ? "active" : ""}`}
                  onClick={() => setShowFiles((v) => !v)}
                  title="Files"
                >
                  <Paperclip size={18} />
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
                <div className="live-meeting-bg-wrap" ref={bgPopoverRef}>
                  <button
                    type="button"
                    className="live-meeting-bg-select"
                    onClick={() => setShowBackgroundPopover((v) => !v)}
                    title="Virtual background"
                  >
                    Background
                  </button>
                  {showBackgroundPopover && (
                    <div className="live-meeting-bg-popover">
                      <div className="live-meeting-bg-tabs">
                        <button
                          type="button"
                          className={bgMode === "none" ? "active" : ""}
                          onClick={() => { setBgMode("none"); setShowBackgroundPopover(false); }}
                        >
                          None
                        </button>
                        <button
                          type="button"
                          className={bgMode === "blur" ? "active" : ""}
                          onClick={() => { setBgMode("blur"); setShowBackgroundPopover(false); }}
                        >
                          Blur
                        </button>
                        <button
                          type="button"
                          className={bgMode === "color" ? "active" : ""}
                          onClick={() => setBgMode("color")}
                        >
                          Color
                        </button>
                        <button
                          type="button"
                          className={bgMode === "image" ? "active" : ""}
                          onClick={() => setBgMode("image")}
                        >
                          Image
                        </button>
                      </div>
                      {bgMode === "color" && (
                        <div className="live-meeting-bg-grid">
                          {PRESET_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              className={`live-meeting-bg-swatch ${bgColor === c ? "active" : ""}`}
                              style={{ background: c }}
                              onClick={() => { setBgColor(c); setShowBackgroundPopover(false); }}
                              title={c}
                            />
                          ))}
                          <button
                            type="button"
                            className="live-meeting-bg-swatch live-meeting-bg-custom"
                            title="Custom color"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="color"
                              value={bgColor}
                              onChange={(e) => setBgColor(e.target.value)}
                              className="live-meeting-bg-color-input"
                            />
                          </button>
                        </div>
                      )}
                      {bgMode === "image" && (
                        <div className="live-meeting-bg-image-row">
                          <label className="live-meeting-bg-image-btn">
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) setBgImageUrl(URL.createObjectURL(f));
                                e.target.value = "";
                              }}
                              className="live-meeting-bg-file-input"
                            />
                            Choose image
                          </label>
                          {bgImageUrl && (
                            <button
                              type="button"
                              className="live-meeting-bg-clear-btn"
                              onClick={() => {
                                URL.revokeObjectURL(bgImageUrl);
                                setBgImageUrl(null);
                                setBgMode("none");
                                setShowBackgroundPopover(false);
                              }}
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {isHost && (
                  <div className="live-meeting-recording-permission-wrap">
                    <select
                      value={Array.isArray(recordingPermission) ? "custom" : recordingPermission}
                      onChange={(e) => {
                        const v = e.target.value as "host" | "all" | "custom";
                        if (v === "custom") {
                          setShowRecordingPermissionPopover(true);
                          const initial =
                            recordingPermission === "all"
                              ? participants.map((p) => p.id)
                              : Array.isArray(recordingPermission)
                                ? recordingPermission
                                : [];
                          setRecordingPermissionAndEmit(initial);
                        } else {
                          setShowRecordingPermissionPopover(false);
                          setRecordingPermissionAndEmit(v);
                        }
                      }}
                      className="live-meeting-bg-select"
                      title="Who can record"
                    >
                      <option value="host">Only host</option>
                      <option value="all">All</option>
                      <option value="custom">Select...</option>
                    </select>
                    {showRecordingPermissionPopover && (
                      <div className="live-meeting-recording-popover">
                        <div className="live-meeting-recording-popover-header">Allow recording</div>
                        {participants.map((p) => {
                          const allowed = Array.isArray(recordingPermission) && recordingPermission.includes(p.id);
                          return (
                            <label key={p.id} className="live-meeting-recording-popover-item">
                              <input
                                type="checkbox"
                                checked={allowed}
                                onChange={(e) => {
                                  const next = Array.isArray(recordingPermission)
                                    ? [...recordingPermission]
                                    : [];
                                  if (e.target.checked) {
                                    if (!next.includes(p.id)) next.push(p.id);
                                  } else {
                                    const i = next.indexOf(p.id);
                                    if (i >= 0) next.splice(i, 1);
                                  }
                                  setRecordingPermissionAndEmit(next);
                                }}
                              />
                              <span>{p.userName}</span>
                            </label>
                          );
                        })}
                        {participants.length === 0 && (
                          <div className="live-meeting-recording-popover-empty">No participants yet</div>
                        )}
                        <button
                          type="button"
                          className="live-meeting-recording-popover-close"
                          onClick={() => setShowRecordingPermissionPopover(false)}
                        >
                          Done
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <MeetingRecorder
                  localStream={displayStream}
                  remoteStreams={remoteStreams}
                  remoteSharingParticipantId={remoteSharingParticipantId}
                  onRecordingChange={setIsRecording}
                  canRecord={canRecord}
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
        {step !== "join" && !compactMode && (
        <>
          <div
            className="live-meeting-resize-handle live-meeting-resize-handle-right"
            onMouseDown={onResizeStart(true)}
            title="Drag to resize"
            aria-label="Resize meeting window"
          />
          <div
            className="live-meeting-resize-handle live-meeting-resize-handle-left"
            onMouseDown={onResizeStart(false)}
            title="Drag to resize"
            aria-label="Resize meeting window"
          />
        </>
        )}
      </GlassCard>
      </div>
    </div>
  );
});

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
