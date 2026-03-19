import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7,
});

const PORT = process.env.PORT ?? 3001;

io.on("connection", (socket) => {
  socket.on("join-room", (roomId, userName) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName;
    socket.to(roomId).emit("user-joined", { id: socket.id, userName });
    socket.emit("room-users", getRoomUsers(roomId));
  });

  socket.on("offer", (data) => {
    io.to(data.to).emit("offer", { from: socket.id, offer: data.offer });
  });

  socket.on("answer", (data) => {
    io.to(data.to).emit("answer", { from: socket.id, answer: data.answer });
  });

  socket.on("ice-candidate", (data) => {
    io.to(data.to).emit("ice-candidate", { from: socket.id, candidate: data.candidate });
  });

  socket.on("chat-message", (data) => {
    io.to(data.roomId).emit("chat-message", {
      from: socket.id,
      userName: socket.data.userName ?? "Unknown",
      text: data.text,
      ts: Date.now(),
    });
  });

  socket.on("screen-sharing-started", (data) => {
    socket.to(data.roomId).emit("screen-sharing-started", {
      userId: socket.id,
      userName: socket.data.userName ?? "Unknown",
    });
  });

  socket.on("screen-sharing-stopped", (data) => {
    socket.to(data.roomId).emit("screen-sharing-stopped", { userId: socket.id });
  });

  socket.on("recording-permission", (data) => {
    io.to(data.roomId).emit("recording-permission", {
      from: socket.id,
      allowed: data.allowed,
    });
  });

  socket.on("file-share", (data) => {
    io.to(data.roomId).emit("file-share", {
      from: socket.id,
      userName: socket.data.userName ?? "Unknown",
      ...data,
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("user-left", socket.id);
    }
  });
});

function getRoomUsers(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return [];
  return Array.from(room)
    .map((id) => {
      const s = io.sockets.sockets.get(id);
      return s ? { id: s.id, userName: s.data.userName ?? "Unknown" } : null;
    })
    .filter(Boolean);
}

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
