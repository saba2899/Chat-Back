const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("./models/User");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://serene-waters-93778.herokuapp.com/",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(express.json());

// Upload
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, "uploads"),
  filename: (_, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// JWT
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

function generateToken(user) {
  return jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ message: "No token provided" });
  try {
    const token = auth.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

// MongoDB
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/ecommerce")
  .then(() => {
    // REMOVED: console.log("✅ MongoDB connected");
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Register
app.post("/api/register", async (req, res) => {
  const { username, password, firstName, lastName, birthDate, phone, email } =
    req.body;
  if (
    !username ||
    !password ||
    !firstName ||
    !lastName ||
    !birthDate ||
    !phone ||
    !email
  )
    return res.status(400).json({ message: "All fields are required" });

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser)
      return res.status(409).json({ message: "Username already exists" });

    const existingEmail = await User.findOne({ email });
    if (existingEmail)
      return res.status(409).json({ message: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      password: hashed,
      firstName,
      lastName,
      birthDate,
      phone,
      email,
    });

    const token = generateToken({ username });
    res.json({ token, username });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Registration failed", error: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    const token = generateToken({ username });
    res.json({ token, username });
  } catch (err) {
    res.status(500).json({ message: "Login failed", error: err.message });
  }
});

// Upload (auth only)
app.post("/api/upload", authMiddleware, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  res.json({
    fileUrl: `${req.protocol}://${req.get("host")}/uploads/${
      req.file.filename
    }`,
  });
});

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// ============================
// ✅ ACTIVE USERS TRACKING
// ============================

const activeUsers = {};
const activeSockets = {};

// ✅ JWT middleware for socket.io
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Authentication required"));
  try {
    const user = jwt.verify(token, JWT_SECRET);
    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  const username = socket.user.username;
  // REMOVED: console.log("🔌 User connected:", username);

  socket.nickname = username;

  // გაააქტიურე სოკეტი
  activeSockets[username] = (activeSockets[username] || 0) + 1;

  // მონიშნე როგორც ონლაინ
  activeUsers[username] = "online";

  // გაუშვი შეტყობინება
  io.emit("message", { system: true, text: `${username} შევიდა ჩათში` });

  // გადადო userStatus რამდენიმე მილიწამით
  setTimeout(() => {
    io.emit("userStatus", activeUsers);
  }, 100);

  // Chat message
  socket.on("chatMessage", (msg) => {
    io.emit("message", { nickname: socket.nickname, ...msg });
  });

  // Read receipt
  socket.on("messageRead", (msgId) => {
    io.emit("messageRead", { msgId, user: socket.nickname });
  });

  // Disconnect
  socket.on("disconnect", () => {
    // REMOVED: console.log("❌ Disconnected:", socket.nickname);
    const nickname = socket.nickname;
    if (activeSockets[nickname]) {
      activeSockets[nickname]--;
      if (activeSockets[nickname] <= 0) {
        activeUsers[nickname] = "offline";
        delete activeSockets[nickname];
        io.emit("message", {
          system: true,
          text: `${nickname} დატოვა ჩათი`,
        });
        io.emit("userStatus", activeUsers);
      }
    }

    console.log("🧮 Active sockets:", activeSockets);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
