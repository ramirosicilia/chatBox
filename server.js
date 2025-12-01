import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";

dotenv.config();

const app = express();

// ----------------------
// ⭐ CORS GLOBAL
// ----------------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

// ----------------------
// ⭐ RUTA PRINCIPAL
// ----------------------
app.get("/", (req, res) => {
  res.send("Servidor funcionando ✔️");
});

// ----------------------
// ⭐ CONEXIÓN MONGO
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
}

mongoose.connection.on("connected", () =>
  console.log("🟢 EVENTO: MongoDB connected()")
);
mongoose.connection.on("error", (err) =>
  console.log("🔴 EVENTO: MongoDB error:", err)
);
mongoose.connection.on("disconnected", () =>
  console.log("🟠 EVENTO: MongoDB disconnected()")
);

// ----------------------
// ⭐ MODELO MENSAJE
// ----------------------
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

// ----------------------
// ⭐ PUERTO
// ----------------------
const PORT = process.env.PORT || 3000;

const server = createServer(app);

// ----------------------
// ⭐ SOCKET.IO
// ----------------------
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

// ----------------------
// ⭐ SOCKETS
// ----------------------
io.on("connection", async (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  // -------------------------------------------
  // ⭐ RECIBIR NOMBRE DEL USUARIO
  // -------------------------------------------
  socket.on("setNombre", (nombre) => {
    socket.data.nombre = nombre;
    console.log(`🟢 Nombre seteado para ${socket.id}: ${nombre}`);
  });

  // -------------------------------------------
  // ⭐ HISTORIAL
  // -------------------------------------------
  try {
    const historialBruto = await Mensaje.find().sort({ createdAt: 1 });

    const historial = historialBruto.map((m) => ({
      tipo: m.tipo,
      texto: m.texto || null,
      audio: m.audio || null,
      hora: m.hora,
      emisor: m.emisor,
    }));

    setTimeout(() => {
      socket.emit("historial", historial);
    }, 300);
  } catch (err) {
    console.log("❌ Error obteniendo historial:", err);
  }

  // -------------------------------------------
  // 📩 MENSAJE DE TEXTO
  // -------------------------------------------
  socket.on("chat:mensaje", async (msg) => {
    console.log("💬 Evento chat:mensaje recibido:", msg);

    const nombre = socket.data.nombre || msg.emisor || socket.id;

    const mensajeCompleto = {
      tipo: "texto",
      texto: msg.texto,
      hora: msg.hora,
      emisor: nombre,
    };

    try {
      const guardado = await Mensaje.create(mensajeCompleto);

      io.emit("chat:mensaje", {
        tipo: "texto",
        texto: guardado.texto,
        hora: guardado.hora,
        emisor: guardado.emisor,
        audio: null,
      });
    } catch (err) {
      console.log("❌ Error guardando mensaje:", err);
    }
  });

  // -------------------------------------------
  // 🎤 MENSAJE DE AUDIO
  // -------------------------------------------
  socket.on("chat:audio", async (audioMsg) => {
    console.log("🎤 Evento chat:audio recibido");

    const nombre = socket.data.nombre || audioMsg.emisor || socket.id;

    const audioCompleto = {
      tipo: "audio",
      audio: audioMsg.audio,
      hora: audioMsg.hora,
      emisor: nombre,
    };

    try {
      const guardado = await Mensaje.create(audioCompleto);

      io.emit("chat:audio", {
        tipo: "audio",
        audio: guardado.audio,
        hora: guardado.hora,
        emisor: guardado.emisor,
        texto: null,
      });
    } catch (err) {
      console.log("❌ Error guardando audio:", err);
    }
  });

  //----------------------------
  // 🔌 DESCONECTAR
  //----------------------------
  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

// ----------------------
// 🟢 INICIAR SERVIDOR
// ----------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor escuchando correctamente en 0.0.0.0:${PORT}`);
});
