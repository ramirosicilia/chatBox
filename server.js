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
// ⭐ CONEXIÓN MONGO
// ----------------------
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB conectado"))
  .catch((err) => console.log("❌ Error MongoDB:", err));

// ----------------------
// ⭐ MODELO MENSAJE
// ----------------------
const MensajeSchema = new mongoose.Schema(
  {
    tipo: String, // "texto" o "audio"
    texto: String,
    audio: String,
    hora: String,
    emisor: String,
  },
  { timestamps: true }
);

const Mensaje = mongoose.model("Mensaje", MensajeSchema);

// Puerto
const Port = process.env.PORT || 3000;

const server = createServer(app);

// Socket.IO con CORS correcto
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ----------------------
// ⭐ SOCKETS
// ----------------------
io.on("connection", async (socket) => {
  console.log("Usuario conectado:", socket.id);

  // 👉 Enviar historial al conectarse
  const historial = await Mensaje.find().sort({ createdAt: 1 });
  socket.emit("historial", historial);

  // ---------------------------------------
  // 📩 MENSAJE DE TEXTO
  // ---------------------------------------
  socket.on("chat:mensaje", async (msg) => {
    console.log("Mensaje recibido:", msg);

    const mensajeCompleto = {
      ...msg,
      emisor: msg.emisor || socket.id,
    };

    // ⭐ Guardar en Mongo
    const guardado = await Mensaje.create(mensajeCompleto);

    // ⭐ Enviar a todos los clientes
    io.emit("chat:mensaje", guardado);
  });

  // ---------------------------------------
  // 🎤 MENSAJE DE AUDIO
  // ---------------------------------------
  socket.on("chat:audio", async (audioMsg) => {
    console.log("Audio recibido");

    const audioCompleto = {
      ...audioMsg,
      emisor: audioMsg.emisor || socket.id,
    };

    // ⭐ Guardar en Mongo
    const guardado = await Mensaje.create(audioCompleto);

    // ⭐ Enviar a todos
    io.emit("chat:audio", guardado);
  });

  // cuando se va
  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

server.listen(Port, () => {
  console.log(`Servidor Socket.IO funcionando en http://localhost:${Port}`);
});
