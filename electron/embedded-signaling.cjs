"use strict";

const http = require("http");
const express = require("express");
const { Server: SocketIOServer } = require("socket.io");
const cors = require("cors");
const os = require("os");

let server = null;

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

function start() {
  if (server) return Promise.resolve({ port: server.address().port, localIP: getLocalIP() });
  const app = express();
  app.use(cors());
  app.get("/health", (_req, res) => res.send("ok"));
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    socket.on("join-room", (roomId, userName) => {
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.userName = userName;
      socket.to(roomId).emit("user-joined", { id: socket.id, userName });
      socket.emit("room-users", getRoomUsers(io, roomId));
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

    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      if (roomId) socket.to(roomId).emit("user-left", socket.id);
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "0.0.0.0", () => {
      server = httpServer;
      const port = server.address().port;
      const localIP = getLocalIP();
      console.log(`[DreamWork] Embedded signaling on http://${localIP}:${port}`);
      resolve({ port, localIP });
    });
  });
}

function getRoomUsers(io, roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return [];
  return Array.from(room)
    .map((id) => {
      const s = io.sockets.sockets.get(id);
      return s ? { id: s.id, userName: s.data.userName ?? "Unknown" } : null;
    })
    .filter(Boolean);
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { start, stop, getLocalIP };
