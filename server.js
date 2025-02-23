// server.js
import { EventEmitter } from "events";
EventEmitter.defaultMaxListeners = 50;

import express from "express";
import WebTorrent from "webtorrent";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import winston from "winston";
import { exec } from "child_process";

// Set up Winston logger (debug level)
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

const app = express();
const port = process.env.PORT || 3000;
const client = new WebTorrent();
client.setMaxListeners(50);

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});
app.use(limiter);
app.use(express.json());

// --- Global Variables and Helper Functions ---

// Configuration
const CONFIG_FILE = path.join(__dirname, "config.json");
let config = { storageDir: path.join(__dirname, "downloads") };

// Torrents data
const TORRENTS_FILE = path.join(__dirname, "torrents.json");
let savedTorrents = [];

// Helper: Check if a path exists
async function pathExists(p) {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Load configuration from file
async function loadConfig() {
  try {
    if (await pathExists(CONFIG_FILE)) {
      const data = await fsPromises.readFile(CONFIG_FILE, "utf-8");
      config = JSON.parse(data);
      config.storageDir = path.resolve(__dirname, config.storageDir);
    } else {
      await fsPromises.writeFile(
        CONFIG_FILE,
        JSON.stringify({ storageDir: "./downloads" }, null, 2)
      );
    }
  } catch (err) {
    logger.error("Error reading config file, using default config: " + err);
  }
}
await loadConfig();

// Load saved torrents from file
async function loadSavedTorrentsFromFile() {
  try {
    if (fs.existsSync(TORRENTS_FILE)) {
      const data = await fsPromises.readFile(TORRENTS_FILE, "utf-8");
      savedTorrents = JSON.parse(data);
      logger.info(`Loaded saved torrents: ${JSON.stringify(savedTorrents)}`);
    } else {
      logger.info("No torrents.json file found. Starting with an empty list.");
    }
  } catch (err) {
    logger.error("Error loading torrents file: " + err);
  }
}
await loadSavedTorrentsFromFile();

// Save torrents to file
async function saveTorrents() {
  try {
    await fsPromises.writeFile(
      TORRENTS_FILE,
      JSON.stringify(savedTorrents, null, 2)
    );
  } catch (err) {
    logger.error("Error saving torrents file: " + err);
  }
}

// Ensure storage directory exists
let STORAGE_DIR = config.storageDir;
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Attach torrent debug events
function attachTorrentDebugEvents(torrent) {
  torrent.on("wire", (wire, addr) => {
    logger.debug(`Torrent ${torrent.infoHash} connected to peer: ${addr}`);
  });
  torrent.on("upload", (bytes) => {
    logger.debug(`Torrent ${torrent.infoHash} uploaded ${bytes} bytes`);
  });
  torrent.on("download", (bytes) => {
    logger.debug(`Torrent ${torrent.infoHash} downloaded ${bytes} bytes`);
  });
}

// --- Resume Active Torrents on Startup ---
// For each saved torrent that is not paused, add (or seed) it.
async function resumeActiveTorrents() {
  logger.info("Resuming active torrents...");
  for (const torrent of savedTorrents) {
    if (!torrent.paused) {
      try {
        const torrentPath = path.join(STORAGE_DIR, torrent.name);
        const exists = await pathExists(torrentPath);
        if (exists) {
          client.seed(
            torrentPath,
            { name: torrent.name, keepSeeding: true },
            (torrentInstance) => {
              attachTorrentDebugEvents(torrentInstance);
              logger.info(
                `Resumed seeding torrent: ${torrentInstance.infoHash}`
              );
            }
          );
        } else {
          client.add(
            torrent.magnet,
            { path: STORAGE_DIR, keepSeeding: true },
            (torrentInstance) => {
              attachTorrentDebugEvents(torrentInstance);
              logger.info(
                `Resumed downloading torrent: ${torrentInstance.infoHash}`
              );
            }
          );
        }
      } catch (err) {
        logger.error(`Error resuming torrent ${torrent.name}: ${err}`);
      }
    }
  }
}
await resumeActiveTorrents();

// --- API Routes ---
// GET /config - Return current configuration as JSON
app.get("/config", async (req, res) => {
  try {
    res.json({ storageDir: config.storageDir });
  } catch (err) {
    logger.error("Error getting config: " + err);
    res.status(500).json({ error: "Error reading config" });
  }
});

// GET /torrents - Return both active and paused torrents
app.get("/torrents", (req, res) => {
  try {
    const active = client.torrents.map((t) => ({
      infoHash: t.infoHash,
      name: t.name,
      progress: t.progress,
      numPeers: t.numPeers,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      paused: false,
    }));
    const paused = savedTorrents
      .filter((s) => s.paused)
      .map((s) => ({
        infoHash: s.infoHash,
        name: s.name,
        progress: 1,
        numPeers: 0,
        downloaded: 0,
        uploaded: 0,
        paused: true,
      }));
    const torrents = [...active, ...paused];
    logger.info("GET /torrents returning: " + JSON.stringify(torrents));
    res.json(torrents);
  } catch (err) {
    logger.error("Error listing torrents: " + err);
    res.status(500).json({ error: "Error listing torrents" });
  }
});

// POST /pause/:infoHash - Pause a torrent
app.post("/pause/:infoHash", async (req, res) => {
  const infoHash = req.params.infoHash;
  const torrent = client.get(infoHash);
  if (!torrent) {
    return res
      .status(400)
      .json({ error: "Torrent not active or already paused" });
  }
  client.remove(infoHash, { destroyStore: false }, async (err) => {
    if (err) {
      logger.error("Error pausing torrent: " + err);
      return res.status(500).json({ error: "Error pausing torrent" });
    }
    const entry = savedTorrents.find((s) => s.infoHash === infoHash);
    if (entry) entry.paused = true;
    await saveTorrents();
    logger.info(`Torrent paused: ${infoHash}`);
    res.json({ message: "Torrent paused" });
  });
});

// POST /resume/:infoHash - Resume a paused torrent
app.post("/resume/:infoHash", async (req, res) => {
  const infoHash = req.params.infoHash;
  const entry = savedTorrents.find((s) => s.infoHash === infoHash);
  if (!entry) {
    return res.status(400).json({ error: "Torrent not found in saved data" });
  }
  entry.paused = false;
  await saveTorrents();
  const torrentPath = path.join(STORAGE_DIR, entry.name);
  const exists = await pathExists(torrentPath);
  try {
    if (exists) {
      client.seed(
        torrentPath,
        { name: entry.name, keepSeeding: true },
        (torrent) => {
          attachTorrentDebugEvents(torrent);
          logger.info(
            `Torrent resumed (seeding from file): ${torrent.infoHash}`
          );
          res.json({ message: "Torrent resumed" });
        }
      );
    } else {
      client.add(
        entry.magnet,
        { path: STORAGE_DIR, keepSeeding: true },
        (torrent) => {
          attachTorrentDebugEvents(torrent);
          logger.info(`Torrent resumed (downloading): ${torrent.infoHash}`);
          res.json({ message: "Torrent resumed" });
        }
      );
    }
  } catch (err) {
    logger.error("Error resuming torrent: " + err);
    res.status(500).json({ error: "Error resuming torrent" });
  }
});

// POST /config - Update storage directory
app.post("/config", async (req, res) => {
  const { storageDir } = req.body;
  if (!storageDir || typeof storageDir !== "string") {
    return res.status(400).json({ error: "Invalid storageDir provided" });
  }
  try {
    STORAGE_DIR = path.resolve(__dirname, storageDir);
    config.storageDir = STORAGE_DIR;
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    await fsPromises.writeFile(
      CONFIG_FILE,
      JSON.stringify({ storageDir }, null, 2)
    );
    res.json({ message: "Config updated", storageDir: STORAGE_DIR });
  } catch (err) {
    logger.error("Error updating config: " + err);
    res.status(500).json({ error: "Error updating config" });
  }
});

// POST /add - Add a new torrent
app.post("/add", (req, res) => {
  const { magnet } = req.body;
  if (!magnet || typeof magnet !== "string") {
    return res.status(400).json({ error: "No valid magnet link provided" });
  }
  if (!magnet.startsWith("magnet:?")) {
    return res.status(400).json({ error: "Invalid magnet link format" });
  }
  if (savedTorrents.some((t) => t.magnet === magnet)) {
    logger.info("Attempted to add duplicate torrent.");
    return res.status(409).json({ error: "Torrent already added." });
  }
  try {
    client.add(magnet, { path: STORAGE_DIR, keepSeeding: true }, (torrent) => {
      attachTorrentDebugEvents(torrent);
      logger.info(`Torrent added: ${torrent.infoHash}`);
      const torrentData = {
        magnet,
        infoHash: torrent.infoHash,
        name: torrent.name,
        paused: false,
      };
      savedTorrents.push(torrentData);
      saveTorrents();
      res.json(torrentData);
    });
  } catch (err) {
    logger.error("Error adding torrent: " + err);
    res.status(500).json({ error: "Error adding torrent" });
  }
});

// DELETE /remove/:infoHash - Remove a torrent completely.
app.delete("/remove/:infoHash", (req, res) => {
  const infoHash = req.params.infoHash;
  if (!infoHash || typeof infoHash !== "string") {
    return res.status(400).json({ error: "Invalid infoHash" });
  }
  const torrent = client.get(infoHash);
  const savedData = savedTorrents.find((t) => t.infoHash === infoHash);
  const torrentName =
    (torrent && torrent.name) || (savedData && savedData.name);
  if (!torrentName) {
    return res.status(400).json({ error: "Torrent name not found" });
  }
  try {
    client.remove(infoHash, { destroyStore: true }, async (err) => {
      if (err) {
        logger.error("Error removing torrent: " + err);
        return res.status(500).json({ error: "Error removing torrent" });
      }
      savedTorrents = savedTorrents.filter((t) => t.infoHash !== infoHash);
      await saveTorrents();
      const torrentPath = path.join(STORAGE_DIR, torrentName);
      if (await pathExists(torrentPath)) {
        try {
          await fsPromises.rm(torrentPath, { recursive: true, force: true });
        } catch (rmErr) {
          logger.error("Error removing torrent files: " + rmErr);
        }
      }
      logger.info(`Torrent removed: ${infoHash}`);
      res.json({ message: "Torrent removed" });
    });
  } catch (err) {
    logger.error("Error processing removal: " + err);
    res.status(500).json({ error: "Error processing removal" });
  }
});

// --- End API Routes ---

// Serve static files from "public"
app.use(express.static("public"));

// Log system limits periodically
function logSystemLimits() {
  const platform = process.platform;
  if (platform === "win32") {
    logger.info("Running on Windows.");
    const activeHandles = process._getActiveHandles
      ? process._getActiveHandles().length
      : "N/A";
    logger.info(`Active handles: ${activeHandles}`);
    exec("netsh int tcp show global", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error running netsh: ${err.message}`);
      } else {
        logger.info(`TCP Global Settings:\n${stdout}`);
      }
    });
  } else if (platform === "linux") {
    exec('bash -c "ulimit -n"', (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching file descriptor limit: ${err.message}`);
      } else {
        logger.info(`File descriptor limit: ${stdout.trim()}`);
      }
    });
    exec(`lsof -p ${process.pid} | wc -l`, (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error counting open file descriptors: ${err.message}`);
      } else {
        logger.info(`Current open file descriptors: ${stdout.trim()}`);
      }
    });
    exec("cat /proc/sys/net/core/rmem_max", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching rmem_max: ${err.message}`);
      } else {
        logger.info(`Receive buffer max (rmem_max): ${stdout.trim()}`);
      }
    });
    exec("cat /proc/sys/net/core/wmem_max", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching wmem_max: ${err.message}`);
      } else {
        logger.info(`Send buffer max (wmem_max): ${stdout.trim()}`);
      }
    });
  } else if (platform === "darwin") {
    exec("ulimit -n", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching file descriptor limit: ${err.message}`);
      } else {
        logger.info(`File descriptor limit: ${stdout.trim()}`);
      }
    });
    exec(`lsof -p ${process.pid} | wc -l`, (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error counting open file descriptors: ${err.message}`);
      } else {
        logger.info(`Current open file descriptors: ${stdout.trim()}`);
      }
    });
    exec("sysctl kern.ipc.maxsockbuf", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching kern.ipc.maxsockbuf: ${err.message}`);
      } else {
        logger.info(`kern.ipc.maxsockbuf: ${stdout.trim()}`);
      }
    });
    exec("sysctl net.inet.tcp.recvspace", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching net.inet.tcp.recvspace: ${err.message}`);
      } else {
        logger.info(`net.inet.tcp.recvspace: ${stdout.trim()}`);
      }
    });
    exec("sysctl net.inet.tcp.sendspace", (err, stdout, stderr) => {
      if (err) {
        logger.error(`Error fetching net.inet.tcp.sendspace: ${err.message}`);
      } else {
        logger.info(`net.inet.tcp.sendspace: ${stdout.trim()}`);
      }
    });
  } else {
    logger.info(
      `Platform ${platform} not specifically supported for system limits logging.`
    );
  }
}
logSystemLimits();
setInterval(logSystemLimits, 60000);

// Start the server
const server = app.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
});

// Graceful shutdown
function shutdown() {
  logger.info("Shutting down server...");
  server.close(() => {
    logger.info("HTTP server closed.");
    client.destroy((err) => {
      if (err) {
        logger.error("Error destroying WebTorrent client: " + err);
      } else {
        logger.info("WebTorrent client destroyed.");
      }
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
