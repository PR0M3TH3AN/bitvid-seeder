import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 50;

import express from 'express';
import WebTorrent from 'webtorrent';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import winston from 'winston';

// Set up Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

const app = express();
const port = process.env.PORT || 3000;
const client = new WebTorrent();

// Increase max listeners for our client (and all EventEmitters)
client.setMaxListeners(50);

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting middleware (100 requests per minute per IP)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});
app.use(limiter);

// Serve static files and parse JSON bodies
app.use(express.static('public'));
app.use(express.json());

// Load configuration from config.json
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = { storageDir: path.join(__dirname, 'downloads') };

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
    config = JSON.parse(configData);
    // Resolve storageDir relative to __dirname
    config.storageDir = path.resolve(__dirname, config.storageDir);
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ storageDir: './downloads' }, null, 2));
  }
} catch (err) {
  logger.error('Error reading config file, using default config: ' + err);
}

let STORAGE_DIR = config.storageDir;
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// JSON file to store torrent metadata
const TORRENTS_FILE = path.join(__dirname, 'torrents.json');
let savedTorrents = [];
try {
  if (fs.existsSync(TORRENTS_FILE)) {
    const data = fs.readFileSync(TORRENTS_FILE, 'utf-8');
    savedTorrents = JSON.parse(data);
    logger.info(`Loaded saved torrents: ${JSON.stringify(savedTorrents)}`);
  } else {
    logger.info('No torrents.json file found. Starting with an empty list.');
  }
} catch (err) {
  logger.error('Error loading torrents file: ' + err);
}

function saveTorrents() {
  try {
    fs.writeFileSync(TORRENTS_FILE, JSON.stringify(savedTorrents, null, 2));
  } catch (err) {
    logger.error('Error saving torrents file: ' + err);
  }
}

// Helper: Check if a path exists asynchronously
async function pathExists(p) {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Load saved torrents concurrently on startup.
// For each saved torrent, if the expected file/folder exists, we seed from that location;
// otherwise, we add the torrent to download.
async function loadSavedTorrents() {
  await Promise.all(
    savedTorrents.map(async torrentData => {
      const torrentPath = path.join(STORAGE_DIR, torrentData.name);
      const exists = await pathExists(torrentPath);
      try {
        if (exists) {
          client.seed(torrentPath, { name: torrentData.name, keepSeeding: true }, torrent => {
            logger.info(`Seeding torrent from existing files: ${torrent.infoHash}`);
          });
        } else {
          client.add(torrentData.magnet, { path: STORAGE_DIR, keepSeeding: true }, torrent => {
            logger.info(`Downloading torrent: ${torrent.infoHash}`);
          });
        }
      } catch (err) {
        logger.error('Error loading saved torrent on startup: ' + err);
      }
    })
  );
}
loadSavedTorrents();

// GET /config - Return current storage configuration
app.get('/config', (req, res) => {
  res.json({ storageDir: STORAGE_DIR });
});

// POST /config - Update storage directory (with input validation)
app.post('/config', (req, res) => {
  const { storageDir } = req.body;
  if (!storageDir || typeof storageDir !== 'string') {
    return res.status(400).json({ error: 'Invalid storageDir provided' });
  }
  try {
    STORAGE_DIR = path.resolve(__dirname, storageDir);
    config.storageDir = STORAGE_DIR;
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ storageDir }, null, 2));
    res.json({ message: 'Config updated', storageDir: STORAGE_DIR });
  } catch (err) {
    logger.error('Error updating config: ' + err);
    res.status(500).json({ error: 'Error updating config' });
  }
});

// POST /add - Add a new torrent (with basic validation and duplicate check)
app.post('/add', (req, res) => {
  const { magnet } = req.body;
  if (!magnet || typeof magnet !== 'string') {
    return res.status(400).json({ error: 'No valid magnet link provided' });
  }
  if (!magnet.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet link format' });
  }
  // Check if the torrent already exists in saved metadata.
  if (savedTorrents.some(t => t.magnet === magnet)) {
    logger.info('Attempted to add duplicate torrent.');
    return res.status(409).json({ error: 'Torrent already added.' });
  }
  try {
    client.add(magnet, { path: STORAGE_DIR, keepSeeding: true }, torrent => {
      logger.info(`Torrent added: ${torrent.infoHash}`);
      const torrentData = {
        magnet,
        infoHash: torrent.infoHash,
        name: torrent.name
      };
      savedTorrents.push(torrentData);
      saveTorrents();
      res.json(torrentData);
    });
  } catch (err) {
    logger.error('Error adding torrent: ' + err);
    res.status(500).json({ error: 'Error adding torrent' });
  }
});

// GET /torrents - List active torrents
app.get('/torrents', (req, res) => {
  try {
    // Active torrents: those currently in the client.
    const active = client.torrents.map(t => ({
      infoHash: t.infoHash,
      name: t.name,
      progress: t.progress,
      numPeers: t.numPeers,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      paused: false
    }));
    // Paused torrents: in savedTorrents but not active.
    const paused = savedTorrents
      .filter(s => !client.get(s.infoHash))
      .map(s => ({
        infoHash: s.infoHash,
        name: s.name,
        progress: 1,
        numPeers: 0,
        downloaded: 0,
        uploaded: 0,
        paused: true
      }));
    const torrents = [...active, ...paused];
    logger.info('GET /torrents returning: ' + JSON.stringify(torrents));
    res.json(torrents);
  } catch (err) {
    logger.error('Error listing torrents: ' + err);
    res.status(500).json({ error: 'Error listing torrents' });
  }
});

// POST /pause/:infoHash - Pause a torrent by removing it from the active client.
// We do not remove its saved metadata.
app.post('/pause/:infoHash', (req, res) => {
  const infoHash = req.params.infoHash;
  const torrent = client.get(infoHash);
  if (!torrent) {
    return res.status(400).json({ error: 'Torrent not active or already paused' });
  }
  // Use client.remove to remove the torrent from active seeding.
  client.remove(infoHash, { destroyStore: false }, err => {
    if (err) {
      logger.error('Error pausing torrent: ' + err);
      return res.status(500).json({ error: 'Error pausing torrent' });
    }
    logger.info(`Torrent paused: ${infoHash}`);
    res.json({ message: 'Torrent paused' });
  });
});

// POST /resume/:infoHash - Resume a paused torrent (re-add it).
app.post('/resume/:infoHash', async (req, res) => {
  const infoHash = req.params.infoHash;
  const savedData = savedTorrents.find(s => s.infoHash === infoHash);
  if (!savedData) {
    return res.status(400).json({ error: 'Torrent not found in saved data' });
  }
  const torrentPath = path.join(STORAGE_DIR, savedData.name);
  const exists = await pathExists(torrentPath);
  try {
    if (exists) {
      client.seed(torrentPath, { name: savedData.name, keepSeeding: true }, torrent => {
        logger.info(`Torrent resumed (seeding from file): ${torrent.infoHash}`);
        res.json({ message: 'Torrent resumed' });
      });
    } else {
      client.add(savedData.magnet, { path: STORAGE_DIR, keepSeeding: true }, torrent => {
        logger.info(`Torrent resumed (downloading): ${torrent.infoHash}`);
        res.json({ message: 'Torrent resumed' });
      });
    }
  } catch (err) {
    logger.error('Error resuming torrent: ' + err);
    res.status(500).json({ error: 'Error resuming torrent' });
  }
});

// DELETE /remove/:infoHash - Remove a torrent completely.
app.delete('/remove/:infoHash', (req, res) => {
  const infoHash = req.params.infoHash;
  if (!infoHash || typeof infoHash !== 'string') {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const torrent = client.get(infoHash);
  const savedData = savedTorrents.find(t => t.infoHash === infoHash);
  const torrentName = (torrent && torrent.name) || (savedData && savedData.name);
  if (!torrentName) {
    return res.status(400).json({ error: 'Torrent name not found' });
  }
  try {
    client.remove(infoHash, { destroyStore: true }, async err => {
      if (err) {
        logger.error('Error removing torrent: ' + err);
        return res.status(500).json({ error: 'Error removing torrent' });
      }
      savedTorrents = savedTorrents.filter(t => t.infoHash !== infoHash);
      saveTorrents();
      const torrentPath = path.join(STORAGE_DIR, torrentName);
      if (await pathExists(torrentPath)) {
        try {
          await fsPromises.rm(torrentPath, { recursive: true, force: true });
        } catch (rmErr) {
          logger.error('Error removing torrent files: ' + rmErr);
        }
      }
      logger.info(`Torrent removed: ${infoHash}`);
      res.json({ message: 'Torrent removed' });
    });
  } catch (err) {
    logger.error('Error processing removal: ' + err);
    res.status(500).json({ error: 'Error processing removal' });
  }
});

// Start the server
const server = app.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
});

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down server...');
  server.close(() => {
    logger.info('HTTP server closed.');
    client.destroy(err => {
      if (err) {
        logger.error('Error destroying WebTorrent client: ' + err);
      } else {
        logger.info('WebTorrent client destroyed.');
      }
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
