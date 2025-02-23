import { createWindowsInstaller } from "electron-winstaller";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  try {
    await createWindowsInstaller({
      appDirectory: path.join(__dirname, "dist", "bitvid-seeder-win32-x64"),
      outputDirectory: path.join(__dirname, "dist", "installer"),
      authors: "thePR0M3TH3AN",
      exe: "bitvid-seeder.exe",
      setupExe: "bitvid-installer.exe",
      setupIcon: path.join(__dirname, "public", "assets", "favicon.ico"),
      noMsi: true,
      description: "A nostr and webtorrent torrent seeder application",
    });
    console.log("Installer created successfully!");
  } catch (error) {
    console.error(`Error creating installer: ${error.message}`);
    process.exit(1);
  }
}

main();