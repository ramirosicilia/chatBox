// server.js
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());

// Puerto con fallback
const Port = process.env.PORT || 3000;

const server = createServer(app);

// Socket.IO con CORS correcto
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  socket.on("chat:mensaje", (msg) => {
    console.log("Mensaje recibido:", msg);

    // ⭐ AGREGO EMISOR SI NO VIENE DEL FRONT
    const mensajeCompleto = { ...msg, emisor: msg.emisor || socket.id };

    io.emit("chat:mensaje", mensajeCompleto);
  });

  // ⭐ NUEVO: recibir y reenviar audio (base64)
  socket.on("chat:audio", (audioMsg) => {
    console.log("Audio recibido");

    const audioCompleto = { ...audioMsg, emisor: audioMsg.emisor || socket.id };

    io.emit("chat:audio", audioCompleto);
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

server.listen(Port, () => {
  console.log(`Servidor Socket.IO funcionando en http://localhost:${Port}`);
});
