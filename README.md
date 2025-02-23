# bitvid Torrent Seeder

bitvid Torrent Seeder is a Node.js application that uses WebTorrent to seed torrents and provides a modern web interface for managing them. The app saves torrent metadata to a JSON file (`torrents.json`), allowing torrents to be resumed automatically when the server restarts. It supports adding, pausing/resuming, and removing torrents, and displays details such as progress, peer count, and upload/download amounts. The application can be run as a standalone server or packaged as a desktop application using Electron, providing a system tray icon for easy access.

## Features

- **Add Torrents:** Add torrents via magnet links or by uploading video files.
- **Active/Paused View:** View active and paused torrents in a paginated table.
- **Pause/Resume:** Pause active torrents to stop seeding or resume paused torrents.
- **Remove Torrents:** Remove torrents and delete associated files.
- **Detailed Status:** See real-time progress, peer count, and data transfer amounts.
- **Persistent Storage:** Torrent metadata is saved in `torrents.json` for persistence across restarts.
- **Responsive UI:** A modern, desktop- and mobile-friendly interface built with Bootstrap.
- **System Tray Support (Electron):** Run the app in the background with a tray icon for quick access to the UI.
- **Nostr Integration:** Manage user profiles and authentication via Nostr.

## Prerequisites

- **Node.js** (v18 or later recommended)
- **npm** (comes with Node.js)

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/yourusername/bitvid-seeder.git
   cd bitvid-seeder
   ```

2. **Install Dependencies:**

   ```bash
   npm install
   ```

   This command installs the necessary packages, including:

   - `express`
   - `webtorrent`
   - `express-rate-limit`
   - `winston`
   - `jsonstream`
   - `multer`
   - `proper-lockfile`

3. **Install Electron and Electron Builder for Packaging (Optional):**

   If you plan to package the app as a desktop application, install Electron and Electron Builder:

   ```bash
   npm install electron electron-builder --save-dev
   ```

## Configuration

- The app uses a `config.json` file to store settings, such as the storage directory for torrent files. If `config.json` does not exist, it will be created automatically with the default storage directory set to `./downloads`.
- You can change the storage directory via the web interface under **Storage Settings** or by editing `config.json` directly.

## Running the App

### Running as a Server

To run the app as a standalone server, use:

```bash
node server.js
```

Then, open your web browser and navigate to [http://localhost:3000](http://localhost:3000).

### Running with Electron (Tray Icon Support)

To run the app with Electron for system tray support:

1. Ensure you have installed Electron:

   ```bash
   npm install electron --save-dev
   ```

2. Start the app using:

   ```bash
   npm run electron
   ```

   - This will launch the app in the background with a tray icon.
   - Right-click the tray icon to open the UI or quit the app.
   - The UI will automatically open in your default browser on startup.

## Usage

### Adding a Torrent

- **Via Magnet Link:** Enter a magnet link into the **Add New Torrent** form and click **Add Torrent**.
- **Via File Upload:** Upload a video file to seed it directly.

### Viewing Torrents

- The active torrents are displayed in a table showing:
  - **Name**
  - **Progress** (percentage)
  - **Peer Count**
  - **Downloaded** (human-readable format)
  - **Uploaded** (human-readable format)
  - **Status** (Active or Paused)
- The table refreshes automatically every 5 seconds.

### Pause/Resume

- **Pause:** Click the **Pause** button to stop seeding a torrent (metadata remains saved).
- **Resume:** Click the **Resume** button to re-add a paused torrent (seeds if files exist).

### Removing a Torrent

- Click the **Remove** button to delete a torrent and remove its files from disk.

### Changing Storage Settings

- Update the storage directory in the **Storage Settings** modal and click **Update Storage Directory**.
- The current storage directory is displayed below the form.

### Nostr Profile Management

- Use the circular profile button in the top-right corner to log in via Nostr.
- Once logged in, your profile avatar and name will be displayed.

## Graceful Shutdown

The application handles termination signals (SIGINT, SIGTERM) by closing the HTTP server and destroying the WebTorrent client, ensuring all processes are terminated properly.

## Troubleshooting

- **Max Listeners Warning:**  
  If you receive a "MaxListenersExceededWarning" message, the default maximum has been increased by setting:
  ```js
  import { EventEmitter } from "events";
  EventEmitter.defaultMaxListeners = 50;
  ```
  at the top of the code.
- **Torrent Not Resuming:**  
  Ensure that the file/folder names in your storage directory match the `name` property stored in the `torrents.json` file.

## Packaging the Application as a Windows Executable (.exe)

To package the application as a standalone Windows executable with a system tray icon:

1. **Install Electron Builder:**

   ```bash
   npm install electron-builder --save-dev
   ```

2. **Run the Build Script:**

   - Open a command prompt or terminal **with administrative privileges**. On Windows, right-click Command Prompt or PowerShell and select "Run as administrator."
   - Navigate to your project directory:
     ```bash
     cd path\to\bitvid-seeder
     ```
   - Run the build command:
     ```bash
     npm run build
     ```

   This will create a `dist` folder containing the executable (`bitvid-seeder.exe`) and an installer (e.g., `bitvid-seeder Setup.exe`). The executable includes the system tray icon and opens the UI in the default browser on startup.

   **Note:** Running the build script with administrative privileges is necessary to handle symbolic link creation during the build process.

## License

This project is licensed under the MIT License.
