// main.js
import { app, Tray, Menu, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "./server.js"; // Import your server with a modification

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tray = null;
let serverPort = null;

app.on("ready", () => {
  // Start the Express server and get the port
  serverPort = startServer();

  // Create the tray icon
  tray = new Tray(path.join(__dirname, "public", "assets", "favicon.ico")); // Use your app icon
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open UI",
      click: () => {
        shell.openExternal(`http://localhost:${serverPort}`);
      },
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setToolTip("bitvid-seeder");
  tray.setContextMenu(contextMenu);

  // Optional: Open the UI in the default browser on startup
  shell.openExternal(`http://localhost:${serverPort}`);
});

// Handle app quit
app.on("window-all-closed", () => {
  // Do nothing; keep the app running in the tray
});

app.on("quit", () => {
  // Perform any cleanup if needed
});
