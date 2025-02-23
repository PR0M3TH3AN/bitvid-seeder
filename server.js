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
import JSONStream from "JSONStream";
import { lock, unlock } from "proper-lockfile";
import os from "os";
import multer from "multer"; // Added for file uploads

// **Logger Setup**
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

// **App and Client Initialization**
const app = express();
const port = process.env.PORT || 3000;
const client = new WebTorrent({ maxWebConns: 200, utp: false });
client.setMaxListeners(50);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// **Rate Limiting Middleware**
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});
app.use(limiter);
app.use(express.json());

// **Multer Configuration**
const upload = multer({ dest: "uploads/" }); // Temporary storage for uploaded files

// **Configuration and Global Variables**
const CONFIG_FILE = path.join(__dirname, "config.json");
let config = { storageDir: path.join(__dirname, "downloads") };

const TORRENTS_FILE = path.join(__dirname, "torrents.json");
let savedTorrents = [];

// **Helper Functions**
async function pathExists(p) {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

// **Load Configuration**
async function loadConfig() {
  try {
    if (await pathExists(CONFIG_FILE)) {
      const data = await fsPromises.readFile(CONFIG_FILE, "utf-8");
      config = JSON.parse(data);
      config.storageDir = path.resolve(config.storageDir); // Ensure absolute path
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

// **Load Torrents with Streaming**
async function loadSavedTorrentsFromFile() {
  if (!fs.existsSync(TORRENTS_FILE)) {
    logger.info("No torrents.json file found. Starting with an empty list.");
    return;
  }
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(TORRENTS_FILE, { encoding: "utf8" });
    const parser = JSONStream.parse("*");
    savedTorrents = [];
    parser.on("data", (torrent) => savedTorrents.push(torrent));
    parser.on("end", () => resolve());
    parser.on("error", (err) => reject(err));
    stream.pipe(parser);
  });
}
await loadSavedTorrentsFromFile();

// **Batch Save Torrents with File Locking**
let pendingChanges = false;

async function saveTorrents() {
  pendingChanges = true;
}

setInterval(async () => {
  if (pendingChanges) {
    await lock(TORRENTS_FILE);
    try {
      const stream = JSONStream.stringify("[\n", ",\n", "\n]");
      const fileStream = fs.createWriteStream(TORRENTS_FILE);
      stream.pipe(fileStream);
      savedTorrents.forEach((torrent) => stream.write(torrent));
      stream.end();
      await new Promise((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });
      pendingChanges = false;
      logger.info("Torrents saved to file");
    } catch (err) {
      logger.error("Error saving torrents: " + err);
    } finally {
      await unlock(TORRENTS_FILE);
    }
  }
}, 5000);

// **Ensure Storage Directory Exists**
let STORAGE_DIR = config.storageDir;
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// **Torrent Event Debugging**
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

// **Resume Active Torrents**
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
            { name: torrent.name },
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
            { path: STORAGE_DIR },
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

// **API Routes**

// Get configuration
app.get("/config", async (req, res) => {
  try {
    res.json({ storageDir: config.storageDir });
  } catch (err) {
    logger.error("Error getting config: " + err);
    res.status(500).json({ error: "Error reading config" });
  }
});

// List torrents with pagination
app.get("/torrents", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const start = (page - 1) * limit;
    const end = start + limit;

    const active = client.torrents.map((t) => ({
      infoHash: t.infoHash,
      name: t.name,
      progress: t.progress,
      numPeers: t.numPeers,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      paused: false,
      magnet: t.magnetURI, // Added
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
        magnet: s.magnet, // Added
      }));
    const allTorrents = [...active, ...paused];
    const paginatedTorrents = allTorrents.slice(start, end);

    res.json({
      torrents: paginatedTorrents,
      total: allTorrents.length,
      page,
      limit,
    });
  } catch (err) {
    logger.error("Error listing torrents: " + err.message);
    res.status(500).json({
      torrents: [],
      total: 0,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 10,
      error: "Error listing torrents",
      message: err.message,
    });
  }
});

// Add after existing routes in server.js
app.get("/download/:infoHash", async (req, res) => {
  const infoHash = req.params.infoHash;
  const savedData = savedTorrents.find((t) => t.infoHash === infoHash);
  if (!savedData) {
    return res.status(404).json({ error: "Torrent not found" });
  }
  const filePath = path.join(STORAGE_DIR, savedData.name);
  if (!(await pathExists(filePath))) {
    return res.status(404).json({ error: "File not found" });
  }
  res.download(filePath, savedData.name, (err) => {
    if (err) {
      logger.error("Error downloading file: " + err);
      res.status(500).json({ error: "Error downloading file" });
    }
  });
});

// Pause a torrent
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
    saveTorrents();
    res.json({ message: "Torrent paused" });
  });
});

// Resume a torrent
app.post("/resume/:infoHash", async (req, res) => {
  const infoHash = req.params.infoHash;
  const entry = savedTorrents.find((s) => s.infoHash === infoHash);
  if (!entry) {
    return res.status(400).json({ error: "Torrent not found in saved data" });
  }
  entry.paused = false;
  saveTorrents();
  const torrentPath = path.join(STORAGE_DIR, entry.name);
  const exists = await pathExists(torrentPath);
  try {
    if (exists) {
      client.seed(torrentPath, { name: entry.name }, (torrent) => {
        attachTorrentDebugEvents(torrent);
        logger.info(`Torrent resumed (seeding from file): ${torrent.infoHash}`);
        res.json({ message: "Torrent resumed" });
      });
    } else {
      client.add(torrent.magnet, { path: STORAGE_DIR }, (torrent) => {
        attachTorrentDebugEvents(torrent);
        logger.info(`Torrent resumed (downloading): ${torrent.infoHash}`);
        res.json({ message: "Torrent resumed" });
      });
    }
  } catch (err) {
    logger.error("Error resuming torrent: " + err);
    res.status(500).json({ error: "Error resuming torrent" });
  }
});

// Update configuration with path validation
app.post("/config", async (req, res) => {
  const { storageDir } = req.body;
  if (!storageDir || typeof storageDir !== "string") {
    return res.status(400).json({ error: "Invalid storageDir provided" });
  }
  try {
    const resolvedPath = path.resolve(storageDir);
    if (!path.isAbsolute(resolvedPath)) {
      throw new Error("Path must be absolute");
    }
    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }
    STORAGE_DIR = resolvedPath;
    config.storageDir = resolvedPath;
    await fsPromises.writeFile(
      CONFIG_FILE,
      JSON.stringify({ storageDir: resolvedPath }, null, 2)
    );
    res.json({ message: "Config updated", storageDir: resolvedPath });
  } catch (err) {
    logger.error("Error updating config: " + err.message);
    res.status(500).json({ error: "Error updating config" });
  }
});

// Add a new torrent
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
    client.add(magnet, { path: STORAGE_DIR }, (torrent) => {
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

// Upload and seed a video file
app.post("/upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file provided" });
  }

  try {
    const tempFilePath = req.file.path; // Temporary file path (e.g., uploads/...)
    const fileName = req.file.originalname;
    const destPath = path.join(STORAGE_DIR, fileName);

    // Ensure the destination directory exists
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }

    // Copy the file to STORAGE_DIR (works across file systems)
    await fsPromises.copyFile(tempFilePath, destPath);

    // Delete the temporary file
    await fsPromises.unlink(tempFilePath);

    // Wait for the file to be accessible
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      try {
        await fsPromises.access(destPath, fs.constants.R_OK);
        break; // File is accessible, exit the loop
      } catch (err) {
        if (err.code === "EBUSY") {
          attempts++;
          logger.info(
            `File ${destPath} is busy, retrying (${attempts}/${maxAttempts})...`
          );
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
        } else {
          throw err; // Throw other errors (e.g., permissions)
        }
      }
    }
    if (attempts === maxAttempts) {
      throw new Error(
        `File ${destPath} remained locked after ${maxAttempts} attempts`
      );
    }

    // Seed the file with WebTorrent
    client.seed(destPath, { name: fileName }, (torrent) => {
      attachTorrentDebugEvents(torrent);
      logger.info(`Torrent added from file upload: ${torrent.infoHash}`);

      // Generate magnet link and torrent data
      const magnet = torrent.magnetURI;
      const torrentData = {
        magnet,
        infoHash: torrent.infoHash,
        name: fileName,
        paused: false,
        dateAdded: new Date().toISOString(),
        size: torrent.length,
      };

      savedTorrents.push(torrentData);
      saveTorrents();
      res.json(torrentData);
    });
  } catch (err) {
    logger.error("Error uploading file: " + err.message);
    res
      .status(500)
      .json({ error: "Error uploading file", message: err.message });
  }
});

// Remove a torrent
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
      saveTorrents();
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

// **Serve Static Files**
app.use(express.static("public"));

// **Resource Usage Monitoring**
setInterval(() => {
  const cpuUsage = os.loadavg()[0]; // 1-minute load average
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const memUsage = ((totalMem - freeMem) / totalMem) * 100;
  logger.info(
    `CPU Load: ${cpuUsage.toFixed(2)}%, Memory Usage: ${memUsage.toFixed(2)}%`
  );

  const mem = process.memoryUsage();
  logger.info(
    `Memory: RSS=${formatBytes(mem.rss)}, Heap=${formatBytes(
      mem.heapUsed
    )}/${formatBytes(mem.heapTotal)}`
  );
  logger.info(
    `Active torrents: ${client.torrents.length}, Paused torrents: ${
      savedTorrents.filter((t) => t.paused).length
    }`
  );
}, 60000); // Log every minute

// **Start Server**
const server = app.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
});

// **Graceful Shutdown**
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
