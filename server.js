/**
 * server.js
 * Backend con:
 * - rooms
 * - usuarios conectados
 * - typing on/off
 * - guardado de IP
 * - admins por token (ADMIN_TOKEN)
 * - logs en Mongo (colección Logs)
 * - mensajes con sala, soft-delete
 * - endpoints REST (rooms, mensajes por sala, usuarios online)
 *
 * Requisitos .env:
 * MONGO_URI=...
 * PORT=...
 * ADMIN_TOKEN=un-token-seguro-aqui
 */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";

dotenv.config();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE"],
  })
);

// ----------------------
// Logs simples en Mongo
// ----------------------
const LogSchema = new mongoose.Schema(
  {
    level: { type: String, default: "info" },
    msg: String,
    meta: Object,
  },
  { timestamps: true }
);
const Log = mongoose.model("Log", LogSchema);

// ----------------------
// Mensaje schema mejorado
// ----------------------
const MensajeSchema = new mongoose.Schema(
  {
    sala: { type: String, default: "global" }, // sala/room
    tipo: String,
    texto: String,
    audio: String,
    hora: String,
    emisor: String,
    nombre: String,
    usuarioId: String,
    ip: String,
    deleted: { type: Boolean, default: false }, // soft delete
  },
  { timestamps: true }
);

const Mensaje = mongoose.model("Mensaje", MensajeSchema);

// ----------------------
// Usuario conectado (no persistente): map socketId -> meta
// ----------------------
const onlineUsers = new Map(); // socketId => { nombre, sala, usuarioId, ip, isAdmin, socketId }

// ----------------------
// Conexión Mongo
// ----------------------
console.log("🔵 Intentando conectar a MongoDB...");
console.log("🔵 MONGO_URL es:", process.env.MONGO_URI);

try {
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    family: 4,
  });
  console.log("✅ Conexión a MongoDB exitosa");
} catch (err) {
  console.log("❌ Error al conectar a MongoDB:", err);
  await Log.create({ level: "error", msg: "Error conectar Mongo", meta: { err } }).catch(() => {});
}

mongoose.connection.on("connected", () => console.log("🟢 EVENTO: MongoDB connected()"));
mongoose.connection.on("error", (err) => console.log("🔴 EVENTO: MongoDB error:", err));
mongoose.connection.on("disconnected", () => console.log("🟠 EVENTO: MongoDB disconnected()"));

// ----------------------
// Rutas REST básicas
// ----------------------
app.get("/", (req, res) => res.send("Servidor funcionando ✔️"));

// GET rooms (desde mensajes guardados)
app.get("/api/rooms", async (req, res) => {
  try {
    const salas = await Mensaje.distinct("sala");
    res.json({ ok: true, salas });
  } catch (err) {
    await Log.create({ level: "error", msg: "GET /api/rooms error", meta: { err } }).catch(() => {});
    res.status(500).json({ ok: false, err: "error" });
  }
});

// GET mensajes de una sala (incluye deleted=false) -> devuelve mensajes "limpios"
app.get("/api/mensajes/:sala", async (req, res) => {
  const { sala } = req.params;
  try {
    const msgs = await Mensaje.find({ sala, deleted: false }).sort({ createdAt: 1 });
    const clean = msgs.map((m) => ({
      id: m._id,
      sala: m.sala,
      tipo: m.tipo,
      texto: m.texto,
      audio: m.audio,
      hora: m.hora,
      emisor: m.emisor,
      nombre: m.nombre,
      usuarioId: m.usuarioId,
      ip: m.ip,
      deleted: m.deleted,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
    res.json({ ok: true, mensajes: clean });
  } catch (err) {
    await Log.create({ level: "error", msg: "GET /api/mensajes/:sala error", meta: { err } }).catch(() => {});
    res.status(500).json({ ok: false });
  }
});

// GET usuarios online -> solo admin con token en header "x-admin-token" o query ?admin_token=
const checkAdminReq = (req) => {
  const token = req.headers["x-admin-token"] || req.query.admin_token;
  return token && token === process.env.ADMIN_TOKEN;
};

app.get("/api/usuarios", (req, res) => {
  if (!checkAdminReq(req)) return res.status(403).json({ ok: false, msg: "admin token required" });
  const usuarios = Array.from(onlineUsers.values()).map((u) => ({
    nombre: u.nombre,
    sala: u.sala,
    usuarioId: u.usuarioId,
    ip: u.ip,
    socketId: u.socketId,
    isAdmin: !!u.isAdmin,
  }));
  res.json({ ok: true, usuarios });
});

// DELETE mensaje por id -> admin required (soft delete) - además emitimos update a la sala
app.delete("/api/mensajes/:id", async (req, res) => {
  if (!checkAdminReq(req)) return res.status(403).json({ ok: false, msg: "admin token required" });
  try {
    const { id } = req.params;
    const m = await Mensaje.findByIdAndUpdate(id, { deleted: true }, { new: true });
    if (m) {
      // notificar a la sala correspondiente
      io.to(m.sala).emit("messageDeleted", { id: m._id });
    }
    res.json({ ok: true });
  } catch (err) {
    await Log.create({ level: "error", msg: "DELETE /api/mensajes/:id error", meta: { err } }).catch(() => {});
    res.status(500).json({ ok: false });
  }
});

// ----------------------
// Iniciar server + socket.io
// ----------------------
const PORT = process.env.PORT || 3000;
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  transports: ["websocket", "polling"],
});

// Helper: enviar lista de usuarios a admins (o a todos si querés)
const broadcastUsuarios = () => {
  const lista = Array.from(onlineUsers.entries()).map(([socketId, u]) => ({
    socketId,
    nombre: u.nombre,
    sala: u.sala,
    usuarioId: u.usuarioId,
    ip: u.ip,
    isAdmin: !!u.isAdmin,
  }));
  // enviar solo a sockets que sean admins
  io.sockets.sockets.forEach((s) => {
    const meta = onlineUsers.get(s.id);
    if (meta?.isAdmin) {
      s.emit("usuarios:lista", lista);
    }
  });
};

io.on("connection", async (socket) => {
  try {
    const ip = socket.handshake.address || socket.conn?.remoteAddress || "unknown";
    console.log(`🟢 Conexión: ${socket.id} - IP: ${ip}`);
    await Log.create({ level: "info", msg: "socket connect", meta: { socketId: socket.id, ip } }).catch(() => {});

    // default user meta (puede setearse desde el front)
    onlineUsers.set(socket.id, { socketId: socket.id, nombre: "Anon", sala: "global", usuarioId: null, ip, isAdmin: false });

    // informar admins la lista actualizada
    broadcastUsuarios();

    // --------------------------
    // AUTH ADMIN (en cualquier momento)
    // --------------------------
    socket.on("authAdmin", ({ token }) => {
      const valid = token && token === process.env.ADMIN_TOKEN;
      if (valid) {
        const meta = onlineUsers.get(socket.id) || {};
        meta.isAdmin = true;
        onlineUsers.set(socket.id, meta);
        socket.data.isAdmin = true;
        socket.emit("authAdmin:ok");
        broadcastUsuarios();
        Log.create({ level: "info", msg: "admin auth success", meta: { socketId: socket.id } }).catch(() => {});
        console.log(`🔐 ${socket.id} autenticado como ADMIN`);
      } else {
        socket.emit("authAdmin:fail");
        Log.create({ level: "warn", msg: "admin auth fail", meta: { socketId: socket.id } }).catch(() => {});
        console.log(`🔒 Intento admin fallido ${socket.id}`);
      }
    });

    // --------------------------
    // setNombre
    // --------------------------
    socket.on("setNombre", (nombre) => {
      const meta = onlineUsers.get(socket.id) || {};
      meta.nombre = nombre || meta.nombre;
      onlineUsers.set(socket.id, meta);
      socket.data.nombre = nombre;
      broadcastUsuarios();
    });

    // --------------------------
    // joinRoom
    // --------------------------
    socket.on("joinRoom", async (sala) => {
      try {
        socket.join(sala);
        const meta = onlineUsers.get(socket.id) || {};
        meta.sala = sala;
        onlineUsers.set(socket.id, meta);
        Log.create({ level: "info", msg: "joinRoom", meta: { socketId: socket.id, sala } }).catch(() => {});
        // enviar historial de esa sala (sin deleted) y en formato limpio
        const historialRaw = await Mensaje.find({ sala, deleted: false }).sort({ createdAt: 1 });
        const historial = historialRaw.map((m) => ({
          id: m._id,
          sala: m.sala,
          tipo: m.tipo,
          texto: m.texto,
          audio: m.audio,
          hora: m.hora,
          emisor: m.emisor,
          nombre: m.nombre,
          usuarioId: m.usuarioId,
          ip: m.ip,
          deleted: m.deleted,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }));
        socket.emit("historial", historial);
        broadcastUsuarios();
      } catch (err) {
        console.error("joinRoom error", err);
      }
    });

    // --------------------------
    // TYPING
    // --------------------------
    socket.on("typing", (data) => {
      // data: { sala, nombre, usuarioId }
      if (data?.sala) {
        socket.to(data.sala).emit("typing", { usuarioId: data.usuarioId, nombre: data.nombre });
      }
    });

    socket.on("stopTyping", (data) => {
      if (data?.sala) {
        socket.to(data.sala).emit("stopTyping", { usuarioId: data.usuarioId });
      }
    });

    // --------------------------
    // chat:mensaje (guardar con sala)
    // --------------------------
    socket.on("chat:mensaje", async (msg) => {
      try {
        const meta = onlineUsers.get(socket.id) || {};
        const nombre = socket.data.nombre || msg.nombre || meta.nombre || socket.id;
        const usuarioId = msg.emisor || meta.usuarioId || null;
        const sala = msg.sala || "global";

        const mensajeCompleto = {
          sala,
          tipo: "texto",
          texto: msg.texto,
          hora: msg.hora,
          emisor: msg.emisor || socket.id,
          nombre,
          usuarioId,
          ip: meta.ip,
        };

        const guardado = await Mensaje.create(mensajeCompleto);
        Log.create({ level: "info", msg: "mensaje creado", meta: { id: guardado._id, sala } }).catch(() => {});

        // Emitir mensaje limpio (sin objetos mongoose) solo a la sala
        const emitMsg = {
          id: guardado._id,
          sala: guardado.sala,
          tipo: guardado.tipo,
          texto: guardado.texto,
          audio: guardado.audio || null,
          hora: guardado.hora,
          emisor: guardado.emisor,
          nombre: guardado.nombre,
          usuarioId: guardado.usuarioId,
          ip: guardado.ip,
          deleted: guardado.deleted,
          createdAt: guardado.createdAt,
          updatedAt: guardado.updatedAt,
        };

        io.to(sala).emit("chat:mensaje", emitMsg);
      } catch (err) {
        console.error("chat:mensaje error", err);
        await Log.create({ level: "error", msg: "chat:mensaje error", meta: { err } }).catch(() => {});
      }
    });

    // --------------------------
    // chat:audio
    // --------------------------
    socket.on("chat:audio", async (audioMsg) => {
      try {
        const meta = onlineUsers.get(socket.id) || {};
        const nombre = socket.data.nombre || audioMsg.nombre || meta.nombre || socket.id;
        const usuarioId = audioMsg.emisor || meta.usuarioId || null;
        const sala = audioMsg.sala || "global";

        const audioCompleto = {
          sala,
          tipo: "audio",
          audio: audioMsg.audio,
          hora: audioMsg.hora,
          emisor: audioMsg.emisor || socket.id,
          nombre,
          usuarioId,
          ip: meta.ip,
        };

        const guardado = await Mensaje.create(audioCompleto);

        // Emitir audio limpio solo a la sala
        const emitAudio = {
          id: guardado._id,
          sala: guardado.sala,
          tipo: guardado.tipo,
          texto: guardado.texto || null,
          audio: guardado.audio,
          hora: guardado.hora,
          emisor: guardado.emisor,
          nombre: guardado.nombre,
          usuarioId: guardado.usuarioId,
          ip: guardado.ip,
          deleted: guardado.deleted,
          createdAt: guardado.createdAt,
          updatedAt: guardado.updatedAt,
        };

        io.to(sala).emit("chat:audio", emitAudio);
      } catch (err) {
        console.error("chat:audio error", err);
        await Log.create({ level: "error", msg: "chat:audio error", meta: { err } }).catch(() => {});
      }
    });

    // --------------------------
    // clearHistory (admin required)
    // --------------------------
    socket.on("clearHistory", async ({ sala }) => {
      try {
        const meta = onlineUsers.get(socket.id);
        if (!meta?.isAdmin) return socket.emit("error", { msg: "admin required for clearHistory" });

        await Mensaje.updateMany({ sala }, { deleted: true });
        // notificar a la sala con historial vacío (formato limpio)
        io.to(sala).emit("historial", []);
        Log.create({ level: "info", msg: "clearHistory", meta: { by: socket.id, sala } }).catch(() => {});
      } catch (err) {
        console.error("clearHistory error", err);
      }
    });

    // --------------------------
    // deleteMessage (por id) (admin required)
    // --------------------------
    socket.on("deleteMessage", async ({ id }) => {
      try {
        const meta = onlineUsers.get(socket.id);
        if (!meta?.isAdmin) return socket.emit("error", { msg: "admin required for deleteMessage" });
        const m = await Mensaje.findByIdAndUpdate(id, { deleted: true }, { new: true });
        if (m) {
          io.to(m.sala).emit("messageDeleted", { id: m._id });
          Log.create({ level: "info", msg: "messageDeleted", meta: { id: m._id, by: socket.id } }).catch(() => {});
        }
      } catch (err) {
        console.error("deleteMessage error", err);
      }
    });

    // --------------------------
    // Disconnect
    // --------------------------
    socket.on("disconnect", () => {
      const meta = onlineUsers.get(socket.id);
      console.log(`🔴 Desconectado: ${socket.id}`, meta || "");
      onlineUsers.delete(socket.id);
      broadcastUsuarios();
    });
  } catch (err) {
    console.error("connection handler error", err);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor escuchando correctamente en 0.0.0.0:${PORT}`);
});
