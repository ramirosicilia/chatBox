import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";

dotenv.config();

const app = express();
app.use(cors());

// ----------------------
// ⭐ CONEXIÓN MONGO (Render + Atlas)
// ----------------------
console.log("🔵 Intentando conectar a MongoDB...");
console.log("🔵 MONGO_URI es:", process.env.MONGO_URL);

await mongoose.connect(process.env.MONGO_URL, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
.then(() => console.log("✅ Conexión a MongoDB exitosa"))
.catch((err) => console.log("❌ Error al conectar a MongoDB:", err));

mongoose.connection.on("connected", () => {
  console.log("🟢 EVENTO: MongoDB connected()");
});

mongoose.connection.on("error", (err) => {
  console.log("🔴 EVENTO: MongoDB error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.log("🟠 EVENTO: MongoDB disconnected()");
});

// ----------------------
// ⭐ MODELO MENSAJE
// ----------------------
console.log("📦 Inicializando modelo Mensaje...");

const MensajeSchema = new mongoose.Schema(
  {
    tipo: String, 
    texto: String,
    audio: String,
    hora: String,
    emisor: String,
  },
  { timestamps: true }
);

const Mensaje = mongoose.model("Mensaje", MensajeSchema);

console.log("📦 Modelo Mensaje listo.");

// ----------------------
// ⭐ PUERTO (Render asigna uno)
// ----------------------
const Port = process.env.PORT || 3000;
console.log("🌍 Puerto configurado:", Port);

const server = createServer(app);

// ----------------------
// ⭐ SOCKET.IO con CORS
// ----------------------
console.log("⚡ Configurando Socket.IO...");

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

console.log("⚡ Socket.IO listo.");

// ----------------------
// ⭐ SOCKETS
// ----------------------
io.on("connection", async (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  try {
    console.log("📜 Buscando historial de mensajes...");
    const historial = await Mensaje.find().sort({ createdAt: 1 });
    console.log("📜 Historial encontrado:", historial.length, "mensajes.");
    socket.emit("historial", historial);
  } catch (err) {
    console.log("❌ Error obteniendo historial:", err);
  }

  // ---------------------------------------
  // 📩 MENSAJE DE TEXTO
  // ---------------------------------------
  socket.on("chat:mensaje", async (msg) => {
    console.log("💬 Evento chat:mensaje recibido:", msg);

    const mensajeCompleto = {
      ...msg,
      emisor: msg.emisor || socket.id,
    };

    try {
      console.log("💾 Guardando mensaje en MongoDB...", mensajeCompleto);
      const guardado = await Mensaje.create(mensajeCompleto);
      console.log("💾 Mensaje guardado:", guardado);
      io.emit("chat:mensaje", guardado);
    } catch (err) {
      console.log("❌ Error guardando mensaje:", err);
    }
  });

  // ---------------------------------------
  // 🎤 MENSAJE DE AUDIO
  // ---------------------------------------
  socket.on("chat:audio", async (audioMsg) => {
    console.log("🎤 Evento chat:audio recibido");

    const audioCompleto = {
      ...audioMsg,
      emisor: audioMsg.emisor || socket.id,
    };

    try {
      console.log("💾 Guardando audio en MongoDB...");
      const guardado = await Mensaje.create(audioCompleto);
      console.log("💾 Audio guardado:", guardado);
      io.emit("chat:audio", guardado);
    } catch (err) {
      console.log("❌ Error guardando audio:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

// ----------------------
// 🟢 INICIAR SERVIDOR
// ----------------------
server.listen(Port, () => {
  console.log(`🚀 Servidor funcionando en puerto ${Port}`);
});
