# vitvid Torrent Seeder

Simple Torrent Seeder is a Node.js application that uses WebTorrent to seed torrents from the command line and provides a modern web interface to manage them. The app saves torrent metadata to a JSON file so that torrents can be resumed automatically when the server restarts. It supports adding, pausing/resuming, and removing torrents, and displays details such as progress, peer count, and upload/download amounts.

## Features

- **Add Torrents:** Enter a magnet link to add a new torrent.
- **Active/Paused View:** See a list of active torrents and paused ones.
- **Pause/Resume:** Pause a torrent (which removes it from active seeding) and resume it later.
- **Remove Torrents:** Remove a torrent from the client and delete its files.
- **Detailed Status:** View progress, peer count, downloaded, and uploaded amounts.
- **Persistent Storage:** Torrent metadata is saved to a JSON file for persistence.
- **Responsive UI:** A modern, desktop- and mobile-friendly interface built with Bootstrap.

## Prerequisites

- **Node.js** (v18 or later recommended)
- **npm** (comes with Node.js)

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/yourusername/simple-torrent-seeder.git
   cd simple-torrent-seeder
   ```

2. **Install Dependencies:**

   ```bash
   npm install
   ```

   This command installs the following packages:
   - express
   - webtorrent
   - express-rate-limit
   - winston

## Configuration

- The app uses a `config.json` file to store settings. If one does not exist, it will be created automatically with the default storage directory set to `./downloads`.
- You can change the storage directory either via the web interface under **Storage Settings** or by editing the `config.json` file directly.

## Running the App

Start the server with:

```bash
node server.js
```

Then open your web browser and navigate to [http://localhost:3000](http://localhost:3000).

## Usage

### Adding a Torrent

- Enter a magnet link into the **Add New Torrent** form and click **Add Torrent**.
- The torrent will be added and saved to the `torrents.json` file.

### Viewing Torrents

- The active torrents are displayed in a table that shows:
  - **Name**
  - **Progress**
  - **Peer Count**
  - **Downloaded** (in human-readable format)
  - **Uploaded** (in human-readable format)
  - **Status** (Active or Paused)
- The table refreshes automatically every 5 seconds.

### Pause/Resume

- **Pause:** Click the **Pause** button to stop seeding a torrent (its metadata remains saved).
- **Resume:** Click the **Resume** button to re-add a paused torrent (if files exist, it will be seeded).

### Removing a Torrent

- Click the **Remove** button to delete a torrent from the client and remove its files from disk.

### Changing Storage Settings

- Update the storage directory in the **Storage Settings** form and click **Update Storage Directory**.
- The current storage directory is displayed below the form.

## Graceful Shutdown

The application handles termination signals (SIGINT, SIGTERM) by closing the HTTP server and destroying the WebTorrent client, ensuring that all active processes are terminated properly.

## Troubleshooting

- **Max Listeners Warning:**  
  If you receive a "MaxListenersExceededWarning" message, the default maximum has been increased by setting:
  ```js
  import { EventEmitter } from 'events';
  EventEmitter.defaultMaxListeners = 50;
  ```
  at the top of the code.
  
- **Torrent Not Resuming:**  
  Ensure that the file/folder names in your downloads directory match the `name` property stored in the `torrents.json` file.

## License

This project is licensed under the MIT License.