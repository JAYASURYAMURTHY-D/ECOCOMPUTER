import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import cookieParser from "cookie-parser";
import fs from "fs";

const PORT = 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const AUTH_COOKIE = "ecocompute_session";
const USERS_FILE = path.join(process.cwd(), "users.json");

// Initialize Database (for telemetry only)
const db = new Database("ecocompute.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    cpu REAL,
    gpu REAL,
    npu REAL,
    ram REAL,
    temp REAL,
    carbon REAL
  );
`);

// Migration: Ensure npu and temp columns exist (for existing databases)
const tableInfo = db.prepare("PRAGMA table_info(audit_history)").all() as any[];
const hasNpu = tableInfo.some(col => col.name === 'npu');
const hasTemp = tableInfo.some(col => col.name === 'temp');

if (!hasNpu) {
  db.exec("ALTER TABLE audit_history ADD COLUMN npu REAL DEFAULT 0");
}
if (!hasTemp) {
  db.exec("ALTER TABLE audit_history ADD COLUMN temp REAL DEFAULT 0");
}

// Helper to manage JSON users
const getUsers = () => {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const data = fs.readFileSync(USERS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
};

const saveUsers = (users: any[]) => {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
};

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());
  app.use(cookieParser());

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    if (req.cookies[AUTH_COOKIE]) {
      try {
        const sessionData = JSON.parse(req.cookies[AUTH_COOKIE]);
        req.user = sessionData;
        next();
      } catch (e) {
        res.status(401).json({ error: "Invalid session" });
      }
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
  };

  // Auth Routes
  app.post("/api/auth/signup", (req, res) => {
    let { username, email, contact, password } = req.body;
    username = username.trim();
    password = password.trim();
    
    // Contact validation: +91 followed by 10 digits
    const contactRegex = /^\+91\d{10}$/;
    if (!contactRegex.test(contact)) {
      return res.status(400).json({ error: "Contact must start with +91 followed by 10 digits" });
    }

    const users = getUsers();
    
    if (users.find((u: any) => u.username === username || u.email === email)) {
      return res.status(400).json({ error: "Username or Email already exists" });
    }

    const newUser = { id: Date.now(), username, email, contact, password };
    users.push(newUser);
    saveUsers(users);
    
    res.json({ success: true, userId: newUser.id });
  });

  app.post("/api/auth/login", (req, res) => {
    let { username, password } = req.body;
    username = username.trim();
    password = password.trim();

    const users = getUsers();
    const user = users.find((u: any) => u.username === username && u.password === password);
    
    if (user) {
      const sessionData = JSON.stringify({ id: user.id, username: user.username });
      res.cookie(AUTH_COOKIE, sessionData, { 
        httpOnly: true, 
        secure: true, 
        sameSite: 'none' 
      });
      res.json({ success: true, user: { username: user.username } });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(AUTH_COOKIE);
    res.json({ success: true });
  });

  app.get("/api/auth/me", (req, res) => {
    if (req.cookies[AUTH_COOKIE]) {
      const user = JSON.parse(req.cookies[AUTH_COOKIE]);
      res.json({ authenticated: true, user });
    } else {
      res.json({ authenticated: false });
    }
  });

  // API Routes (Protected)
  app.get("/api/history", authenticate, (req, res) => {
    const history = db.prepare("SELECT * FROM audit_history ORDER BY timestamp DESC LIMIT 50").all();
    res.json(history);
  });

  app.post("/api/audit", authenticate, (req, res) => {
    const { cpu, gpu, npu, ram, temp, carbon } = req.body;
    const info = db.prepare("INSERT INTO audit_history (cpu, gpu, npu, ram, temp, carbon) VALUES (?, ?, ?, ?, ?, ?)").run(cpu, gpu, npu, ram, temp, carbon);
    res.json({ id: info.lastInsertRowid });
  });

  // WebSocket Logic (Protected)
  wss.on("connection", (ws, req) => {
    // Basic cookie check for WS
    const cookies = req.headers.cookie;
    if (!cookies || !cookies.includes(AUTH_COOKIE)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    console.log("Client connected to telemetry stream");
    
    // Send simulated telemetry every 2 seconds
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const cpu = Math.max(10, Math.min(100, 30 + (Math.random() * 20 - 10)));
        const gpu = Math.max(5, Math.min(100, 20 + (Math.random() * 15 - 7)));
        const npu = Math.max(0, Math.min(100, 15 + (Math.random() * 10 - 5)));
        const ram = Math.max(30, Math.min(95, 60 + (Math.random() * 5 - 2)));
        const temp = 45 + (cpu * 0.2) + (Math.random() * 5);
        const carbon = (cpu * 0.4 + gpu * 0.6 + npu * 0.2 + ram * 0.05) * 0.02;

        ws.send(JSON.stringify({
          type: "TELEMETRY_UPDATE",
          data: {
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            cpu,
            gpu,
            npu,
            ram,
            temp,
            carbon,
            network: Math.random() * 5
          }
        }));
      }
    }, 2000);

    ws.on("close", () => {
      clearInterval(interval);
      console.log("Client disconnected");
    });
  });

  // Vite Integration
  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`EcoCompute Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
