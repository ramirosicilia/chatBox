// server.js
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv"
import cors from "cors";

const app = express();
app.use(cors());

dotenv.config()

const Port= process.env.PORT
const server = createServer(app);


// Permitir conexión desde tu React (localhost:5173 o 3000)
const io = new Server(server, {
  cors: {
    origin: "*",
  }
});

io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  // Recibir mensaje
  socket.on("chat:mensaje", (msg) => {
    console.log("Mensaje recibido:", msg);

    // reenviar a todos
    io.emit("chat:mensaje", msg);
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

server.listen(Port, () => {
  console.log(`Servidor Socket.IO funcionando en http://localhost:${Port}`);
});
