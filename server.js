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
import JSONStream from "JSONStream";
import { lock, unlock } from "proper-lockfile";
import os from "os";
import multer from "multer"; // For file uploads

// Logger Setup
const logger = winston.createLogger({
  level: "info", // Changed from "debug" to "info" to reduce logging
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// Global Variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, "config.json");
let config = { storageDir: path.join(__dirname, "downloads") };
const TORRENTS_FILE = path.join(__dirname, "torrents.json");
let savedTorrents = [];

// Helper Functions
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

// Load Configuration
async function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      logger.info(
        "No config.json file found. Creating new default config file."
      );
      const defaultStorageDir = path.join(
        os.homedir(),
        "Documents",
        "bitvid-seeder"
      );
      const defaultConfig = {
        storageDir: defaultStorageDir,
        maxConns: 200,
        utp: false,
      };
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(defaultConfig, null, 2),
        "utf8"
      );
      config = defaultConfig;
    } else {
      const data = await fsPromises.readFile(CONFIG_FILE, "utf-8");
      config = JSON.parse(data);
      if (!config.maxConns) config.maxConns = 200;
      if (config.utp === undefined) config.utp = false;
      if (!config.storageDir || config.storageDir.trim() === "") {
        config.storageDir = path.join(
          os.homedir(),
          "Documents",
          "bitvid-seeder"
        );
      } else {
        config.storageDir = path.resolve(config.storageDir);
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    }
  } catch (err) {
    logger.error("Error reading config file, using default config: " + err);
    config = {
      storageDir: path.join(os.homedir(), "Documents", "bitvid-seeder"),
      maxConns: 200,
      utp: false,
    };
  }
}

// Load Torrents with Streaming and Migrate Old Entries
async function loadSavedTorrentsFromFile() {
  if (!fs.existsSync(TORRENTS_FILE)) {
    logger.info("No torrents.json file found. Creating new empty file.");
    fs.writeFileSync(TORRENTS_FILE, "[]", "utf8");
  }
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(TORRENTS_FILE, { encoding: "utf8" });
    const parser = JSONStream.parse("*");
    savedTorrents = [];
    parser.on("data", (torrent) => {
      // Migrate old 'paused' field to 'state'
      if (torrent.paused !== undefined) {
        torrent.state = torrent.paused ? "paused" : "active";
        delete torrent.paused;
      }
      savedTorrents.push(torrent);
    });
    parser.on("end", () => resolve());
    parser.on("error", (err) => reject(err));
    stream.pipe(parser);
  });
}

// Asynchronous Save Torrents with File Locking
async function saveTorrents() {
  await lock(TORRENTS_FILE);
  try {
    const uniqueTorrents = Array.from(
      new Set(savedTorrents.map((t) => t.infoHash))
    ).map((infoHash) => savedTorrents.find((t) => t.infoHash === infoHash));
    savedTorrents = uniqueTorrents;
    const stream = JSONStream.stringify("[\n", ",\n", "\n]");
    const fileStream = fs.createWriteStream(TORRENTS_FILE);
    stream.pipe(fileStream);
    savedTorrents.forEach((torrent) => stream.write(torrent));
    stream.end();
    await new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
    logger.info("Torrents saved to file");
  } catch (err) {
    logger.error("Error saving torrents: " + err);
  } finally {
    await unlock(TORRENTS_FILE);
  }
}

// Torrent Event Debugging (optional, can be removed if not needed)
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

// Resume Torrents on Startup
async function resumeActiveTorrents(client, STORAGE_DIR) {
  logger.info("Starting to resume torrents...");
  if (savedTorrents.length === 0) {
    logger.info("No saved torrents found in torrents.json.");
    return;
  }
  for (const torrentData of savedTorrents) {
    const { magnet, infoHash, name, state } = torrentData;
    if (magnet) {
      const torrent = await new Promise((resolve, reject) => {
        const t = client.add(magnet, { path: STORAGE_DIR }, resolve);
        t.on("error", reject);
      });
      if (state === "paused") {
        torrent.pause();
      }
      attachTorrentDebugEvents(torrent);
      logger.info(`Torrent ${infoHash} added with state: ${state}`);
    } else {
      // Handle seeding existing files
      const torrentPath = path.join(STORAGE_DIR, name);
      if (await pathExists(torrentPath)) {
        const torrent = await new Promise((resolve, reject) => {
          const t = client.seed(torrentPath, { name }, resolve);
          t.on("error", reject);
        });
        if (state === "paused") {
          torrent.pause();
        }
        attachTorrentDebugEvents(torrent);
        logger.info(`Torrent ${infoHash} seeded with state: ${state}`);
      } else {
        logger.warn(`File missing for torrent ${name}, cannot seed.`);
      }
    }
  }
}

// Main Initialization Function
async function initialize() {
  // Load configuration first
  await loadConfig();

  // Ensure storage directory exists
  let STORAGE_DIR = config.storageDir;
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  // Initialize Express app and WebTorrent client
  const app = express();
  const port = process.env.PORT || 3000;
  const client = new WebTorrent({
    maxConns: config.maxConns,
    utp: config.utp,
    utpOpts: { port: 6881 }, // Specify a different port for UTP
  });
  client.setMaxListeners(50);

  // Rate Limiting Middleware
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
  });
  app.use(limiter);
  app.use(express.json());

  // Multer configuration for file uploads
  const upload = multer({ dest: "uploads/" });

  // Load saved torrents
  await loadSavedTorrentsFromFile();

  // API Routes

  // Get configuration
  app.get("/config", async (req, res) => {
    try {
      res.json({
        storageDir: config.storageDir,
        maxConns: config.maxConns,
        utp: config.utp,
      });
    } catch (err) {
      logger.error("Error getting config: " + err);
      res.status(500).json({ error: "Error reading config" });
    }
  });

  // List torrents with pagination
  app.get("/torrents", (req, res) => {
    try {
      logger.info(`Listing torrents: ${JSON.stringify(savedTorrents)}`);
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const start = (page - 1) * limit;
      const end = start + limit;

      const allTorrents = savedTorrents.map((saved) => {
        const torrent = client.get(saved.infoHash);
        if (torrent) {
          logger.info(
            `Active torrent ${saved.infoHash}: ${JSON.stringify({
              progress: torrent.progress,
              numPeers: torrent.numPeers,
              downloaded: torrent.downloaded,
              uploaded: torrent.uploaded,
              status: saved.state,
            })}`
          );
          return {
            infoHash: saved.infoHash,
            name: saved.name,
            progress: torrent.progress,
            numPeers: torrent.numPeers,
            downloaded: torrent.downloaded,
            uploaded: torrent.uploaded,
            status: saved.state,
            magnet: saved.magnet,
          };
        } else {
          logger.info(
            `Paused torrent ${saved.infoHash}: ${JSON.stringify({
              progress: 1,
              numPeers: 0,
              downloaded: 0,
              uploaded: 0,
              status: saved.state,
            })}`
          );
          return {
            infoHash: saved.infoHash,
            name: saved.name,
            progress: 1,
            numPeers: 0,
            downloaded: 0,
            uploaded: 0,
            status: saved.state,
            magnet: saved.magnet,
          };
        }
      });
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

  // Download route
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
    let torrent = client.get(infoHash);
    // If the torrent isn't currently in the client, try re-adding it from savedTorrents.
    if (!torrent) {
      const savedEntry = savedTorrents.find((s) => s.infoHash === infoHash);
      if (savedEntry && savedEntry.magnet) {
        try {
          torrent = await new Promise((resolve, reject) => {
            const t = client.add(
              savedEntry.magnet,
              { path: STORAGE_DIR },
              resolve
            );
            t.on("error", reject);
          });
        } catch (err) {
          logger.error("Error re-adding torrent for pause: " + err.message);
          return res.status(500).json({ error: "Error pausing torrent" });
        }
      }
    }
    if (torrent) {
      torrent.pause();
      const entry = savedTorrents.find((s) => s.infoHash === infoHash);
      if (entry) entry.state = "paused";
      await saveTorrents();
      res.json({ message: "Torrent paused" });
    } else {
      res.status(400).json({ error: "Torrent not found" });
    }
  });

  // Resume a torrent
  app.post("/resume/:infoHash", async (req, res) => {
    const infoHash = req.params.infoHash;
    let torrent = client.get(infoHash);
    // If the torrent isn't in the client, re-add it from the saved torrents
    if (!torrent) {
      const savedEntry = savedTorrents.find((s) => s.infoHash === infoHash);
      if (savedEntry && savedEntry.magnet) {
        try {
          torrent = await new Promise((resolve, reject) => {
            const t = client.add(
              savedEntry.magnet,
              { path: STORAGE_DIR },
              resolve
            );
            t.on("error", reject);
          });
        } catch (err) {
          logger.error("Error re-adding torrent for resume: " + err.message);
          return res.status(500).json({ error: "Error resuming torrent" });
        }
      }
    }
    if (torrent) {
      torrent.resume();
      const entry = savedTorrents.find((s) => s.infoHash === infoHash);
      if (entry) entry.state = "active";
      await saveTorrents();
      res.json({ message: "Torrent resumed" });
    } else {
      res.status(400).json({ error: "Torrent not found" });
    }
  });

  // Update configuration with path validation
  app.post("/config", async (req, res) => {
    const { storageDir, maxConns, utp } = req.body;
    try {
      if (storageDir) {
        const resolvedPath = path.resolve(storageDir);
        if (!path.isAbsolute(resolvedPath)) {
          throw new Error("Path must be absolute");
        }
        if (!fs.existsSync(resolvedPath)) {
          fs.mkdirSync(resolvedPath, { recursive: true });
        }
        config.storageDir = resolvedPath;
        STORAGE_DIR = resolvedPath;
      }
      if (maxConns !== undefined) {
        if (!Number.isInteger(maxConns) || maxConns <= 0) {
          throw new Error("maxConns must be a positive integer");
        }
        config.maxConns = maxConns;
      }
      if (utp !== undefined) {
        if (typeof utp !== "boolean") {
          throw new Error("utp must be a boolean");
        }
        config.utp = utp;
      }
      await fsPromises.writeFile(
        CONFIG_FILE,
        JSON.stringify(config, null, 2),
        "utf8"
      );
      res.json({ message: "Config updated", config });
    } catch (err) {
      logger.error("Error updating config: " + err.message);
      res
        .status(500)
        .json({ error: "Error updating config", message: err.message });
    }
  });

  // Add a new torrent
  app.post("/add", async (req, res) => {
    const { magnet } = req.body;
    if (!magnet || typeof magnet !== "string") {
      return res.status(400).json({ error: "No valid magnet link provided" });
    }
    if (!magnet.startsWith("magnet:?")) {
      return res.status(400).json({ error: "Invalid magnet link format" });
    }
    if (savedTorrents.some((t) => t.magnet === magnet)) {
      return res.status(409).json({ error: "Torrent already added." });
    }
    try {
      const torrent = await new Promise((resolve, reject) => {
        const t = client.add(magnet, { path: STORAGE_DIR }, resolve);
        t.on("error", reject);
      });
      attachTorrentDebugEvents(torrent);
      const torrentData = {
        magnet,
        infoHash: torrent.infoHash,
        name: torrent.name,
        state: "active",
      };
      savedTorrents.push(torrentData);
      await saveTorrents();
      res.json(torrentData);
    } catch (err) {
      logger.error(`Error adding torrent: ${err.message}`);
      res
        .status(500)
        .json({ error: "Error adding torrent", details: err.message });
    }
  });

  // Upload and seed a video file
  app.post("/upload", upload.single("video"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }
    try {
      const tempFilePath = req.file.path;
      const fileName = req.file.originalname;
      const destPath = path.join(STORAGE_DIR, fileName);
      if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
      }
      await fsPromises.copyFile(tempFilePath, destPath);
      await fsPromises.unlink(tempFilePath);
      let attempts = 0;
      const maxAttempts = 5;
      while (attempts < maxAttempts) {
        try {
          await fsPromises.access(destPath, fs.constants.R_OK);
          break;
        } catch (err) {
          if (err.code === "EBUSY") {
            attempts++;
            logger.info(
              `File ${destPath} is busy, retrying (${attempts}/${maxAttempts})...`
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } else {
            throw err;
          }
        }
      }
      if (attempts === maxAttempts) {
        throw new Error(
          `File ${destPath} remained locked after ${maxAttempts} attempts`
        );
      }
      client.seed(destPath, { name: fileName }, (torrent) => {
        attachTorrentDebugEvents(torrent);
        const torrentData = {
          magnet: torrent.magnetURI,
          infoHash: torrent.infoHash,
          name: fileName,
          state: "active",
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
        await saveTorrents();
        const torrentPath = path.join(STORAGE_DIR, torrentName);
        if (await pathExists(torrentPath)) {
          try {
            await fsPromises.rm(torrentPath, { recursive: true, force: true });
          } catch (rmErr) {
            logger.error("Error removing torrent files: " + rmErr);
          }
        }
        res.json({ message: "Torrent removed" });
      });
    } catch (err) {
      logger.error("Error processing removal: " + err);
      res.status(500).json({ error: "Error processing removal" });
    }
  });

  // Serve static files from the "public" folder
  app.use(express.static("public"));

  // Resource Usage Monitoring
  setInterval(() => {
    const cpuUsage = os.loadavg()[0];
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
        savedTorrents.filter((t) => t.state === "paused").length
      }`
    );
  }, 60000);

  // Function to launch the HTTP server
  function launchServer() {
    const server = app.listen(port, async () => {
      logger.info(`Server running on http://localhost:${port}`);
      await resumeActiveTorrents(client, STORAGE_DIR);
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

    return port;
  }

  return launchServer();
}

// Exported startServer function for external usage
async function startServer() {
  return initialize();
}

// Conditionally start the server if this module is the entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}

export { startServer };
