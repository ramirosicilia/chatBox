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

// 🔥 AGREGADO → Función para borrar físicamente lo marcado como deleted
async function purgeDeletedMessages() {
  try {
    await Mensaje.deleteMany({ deleted: true });
    console.log("🗑️ purgeDeletedMessages: eliminados definitivamente todos los deleted=true");
  } catch (err) {
    console.error("Error purgeDeletedMessages", err);
  }
}

// ----------------------
// Usuario conectado
// ----------------------
const onlineUsers = new Map();

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

// GET rooms
app.get("/api/rooms", async (req, res) => {
  try {
    const salas = await Mensaje.distinct("sala");
    res.json({ ok: true, salas });
  } catch (err) {
    await Log.create({ level: "error", msg: "GET /api/rooms error", meta: { err } }).catch(() => {});
    res.status(500).json({ ok: false, err: "error" });
  }
});

// GET mensajes de sala
app.get("/api/mensajes/:sala", async (req, res) => {
  const { sala } = req.params;
  try {
    // traemos solo mensajes no borrados
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

// admin check
const checkAdminReq = (req) => {
  const token = req.headers["x-admin-token"] || req.query.admin_token;
  return token && token === process.env.ADMIN_TOKEN;
};

// GET usuarios online
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

// DELETE mensaje soft-delete (REST) -> ahora vacía texto/audio y limpia físicamente
app.delete("/api/mensajes/:id", async (req, res) => {
  if (!checkAdminReq(req)) return res.status(403).json({ ok: false, msg: "admin token required" });
  try {
    const { id } = req.params;
    const m = await Mensaje.findByIdAndUpdate(
      id,
      { deleted: true, texto: null, audio: null },
      { new: true }
    );
    if (m) io.to(m.sala).emit("messageDeleted", { id: m._id });
    res.json({ ok: true });

    // 🔥 AGREGADO: limpiar deleted físicos
    await purgeDeletedMessages();
  } catch (err) {
    await Log.create({ level: "error", msg: "DELETE /api/mensajes/:id error", meta: { err } }).catch(() => {});
    res.status(500).json({ ok: false });
  }
});

// 🔥 AGREGADO → DELETE HARD (borrado físico)
app.delete("/api/mensajes/:id/hard", async (req, res) => {
  if (!checkAdminReq(req)) return res.status(403).json({ ok: false, msg: "admin token required" });

  try {
    await Mensaje.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------
// SERVER + SOCKET.IO
// ----------------------
const PORT = process.env.PORT || 3000;
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  transports: ["websocket", "polling"],
});

// lista de usuarios a admins
const broadcastUsuarios = () => {
  const lista = Array.from(onlineUsers.entries()).map(([socketId, u]) => ({
    socketId,
    nombre: u.nombre,
    sala: u.sala,
    usuarioId: u.usuarioId,
    ip: u.ip,
    isAdmin: !!u.isAdmin,
  }));

  io.sockets.sockets.forEach((s) => {
    const meta = onlineUsers.get(s.id);
    if (meta?.isAdmin) s.emit("usuarios:lista", lista);
  });
};

io.on("connection", async (socket) => {
  try {
    const ip = socket.handshake.address || socket.conn?.remoteAddress || "unknown";
    console.log(`🟢 Conexión: ${socket.id} - IP: ${ip}`);
    await Log.create({ level: "info", msg: "socket connect", meta: { socketId: socket.id, ip } }).catch(() => {});

    // 🔧 Guardar usuarioId que envía el cliente en la query (si existe)
    const usuarioIdFromQuery = (socket.handshake?.query && socket.handshake.query.usuarioId) || null;

    onlineUsers.set(socket.id, {
      socketId: socket.id,
      nombre: "Anon",
      sala: "global",
      usuarioId: usuarioIdFromQuery,
      ip,
      isAdmin: false,
    });

    // también lo guardamos en socket.data para validaciones rápidas
    socket.data.usuarioId = usuarioIdFromQuery || null;

    broadcastUsuarios();

    // auth admin
    socket.on("authAdmin", ({ token }) => {
      const valid = token === process.env.ADMIN_TOKEN;
      if (valid) {
        const meta = onlineUsers.get(socket.id) || {};
        meta.isAdmin = true;
        onlineUsers.set(socket.id, meta);
        socket.data.isAdmin = true;
        socket.emit("authAdmin:ok");
        broadcastUsuarios();
      } else {
        socket.emit("authAdmin:fail");
      }
    });

    // setNombre
    socket.on("setNombre", (nombre) => {
      const meta = onlineUsers.get(socket.id) || {};
      meta.nombre = nombre || meta.nombre;
      onlineUsers.set(socket.id, meta);
      socket.data.nombre = nombre;
      broadcastUsuarios();
    });

    // joinRoom
    socket.on("joinRoom", async (sala) => {
      try {
        socket.join(sala);
        const meta = onlineUsers.get(socket.id) || {};
        meta.sala = sala;
        onlineUsers.set(socket.id, meta);

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

    // typing
    socket.on("typing", (data) => {
      if (data?.sala)
        socket.to(data.sala).emit("typing", { usuarioId: data.usuarioId, nombre: data.nombre });
    });
    socket.on("stopTyping", (data) => {
      if (data?.sala) socket.to(data.sala).emit("stopTyping", { usuarioId: data.usuarioId });
    });

    // chat mensaje
    socket.on("chat:mensaje", async (msg) => {
      try {
        const meta = onlineUsers.get(socket.id) || {};
        const nombre = socket.data.nombre || msg.nombre || meta.nombre;
        const usuarioId = msg.emisor || meta.usuarioId;
        const sala = msg.sala || "global";

        const guardado = await Mensaje.create({
          sala,
          tipo: "texto",
          texto: msg.texto,
          hora: msg.hora,
          emisor: msg.emisor || socket.id,
          nombre,
          usuarioId,
          ip: meta.ip,
        });

        io.to(sala).emit("chat:mensaje", {
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
        });
      } catch (err) {
        console.error("chat:mensaje error", err);
      }
    });

    // chat audio
    socket.on("chat:audio", async (audioMsg) => {
      try {
        const meta = onlineUsers.get(socket.id) || {};
        const nombre = socket.data.nombre || audioMsg.nombre || meta.nombre;
        const usuarioId = audioMsg.emisor || meta.usuarioId;
        const sala = audioMsg.sala || "global";

        const guardado = await Mensaje.create({
          sala,
          tipo: "audio",
          audio: audioMsg.audio,
          hora: audioMsg.hora,
          emisor: audioMsg.emisor || socket.id,
          nombre,
          usuarioId,
          ip: meta.ip,
        });

        io.to(sala).emit("chat:audio", {
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
        });
      } catch (err) {
        console.error("chat:audio error", err);
      }
    });

    // 🔧 clearMyHistory: borra TODOS los mensajes del usuario (o de la sala que pases)
    // payload: { sala? }  -> si no viene sala, borra en todas las salas para ese usuario
    socket.on("clearMyHistory", async ({ sala } = {}) => {
      try {
        const meta = onlineUsers.get(socket.id) || {};
        const requesterUid = meta?.usuarioId || socket.data?.usuarioId;
        if (!requesterUid) return socket.emit("error", { msg: "usuarioId requerido para clearMyHistory" });

        const condicion = { usuarioId: requesterUid };
        if (sala) condicion.sala = sala;

        // borrado físico directo para que NO vuelvan
        await Mensaje.deleteMany(condicion);

        // emitir historial actualizado a la sala (o a "global") para que clientes se sincronicen
        const targetSala = sala || "global";
        const historialRaw = await Mensaje.find({ sala: targetSala, deleted: false }).sort({ createdAt: 1 });
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

        // emitimos historial actualizado
        io.to(targetSala).emit("historial", historial);
      } catch (err) {
        console.error("clearMyHistory error", err);
      }
    });

    // clearHistory (admin required) -> ahora vacía texto/audio y luego purga
    socket.on("clearHistory", async ({ sala }) => {
      try {
        const meta = onlineUsers.get(socket.id);
        if (!meta?.isAdmin) return socket.emit("error", { msg: "admin required for clearHistory" });

        await Mensaje.updateMany(
          { sala },
          { deleted: true, texto: null, audio: null }
        );
        io.to(sala).emit("historial", []);

        // 🔥 AGREGADO → limpieza física
        await purgeDeletedMessages();
      } catch (err) {
        console.error("clearHistory error", err);
      }
    });

    // deleteMessage (por id) -> admin o autor del mensaje
    socket.on("deleteMessage", async ({ id }) => {
      try {
        const meta = onlineUsers.get(socket.id) || {};
        const m = await Mensaje.findById(id);
        if (!m) return socket.emit("error", { msg: "mensaje no encontrado" });

        const isAdmin = !!meta?.isAdmin;
        const isOwner = meta?.usuarioId && String(meta.usuarioId) === String(m.usuarioId);

        if (!isAdmin && !isOwner) {
          return socket.emit("error", { msg: "solo admin o autor pueden borrar este mensaje" });
        }

        const updated = await Mensaje.findByIdAndUpdate(
          id,
          { deleted: true, texto: null, audio: null },
          { new: true }
        );
        if (updated) {
          io.to(updated.sala).emit("messageDeleted", { id: updated._id });
          Log.create({ level: "info", msg: "messageDeleted", meta: { id: updated._id, by: socket.id } }).catch(() => {});
        }

        // 🔥 AGREGADO → limpieza física automática
        await purgeDeletedMessages();
      } catch (err) {
        console.error("deleteMessage error", err);
      }
    });

    // 🔥 AGREGADO → deleteMessageHard (borrado físico)
    socket.on("deleteMessageHard", async ({ id }) => {
      try {
        const meta = onlineUsers.get(socket.id);
        if (!meta?.isAdmin)
          return socket.emit("error", { msg: "admin required for deleteMessageHard" });

        await Mensaje.findByIdAndDelete(id);
        socket.emit("messageHardDeleted", { id });
      } catch (err) {
        console.error("deleteMessageHard error", err);
      }
    });

    // disconnect
    socket.on("disconnect", () => {
      const meta = onlineUsers.get(socket.id);
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
