# Nightfall Chess

## Stockfish licensing and source

This application ships the single-threaded Lite Stockfish.js 19.0.1 WebAssembly engine in `assets/stockfish/`. The matching `.js` and `.wasm` files are distributed under GPL-3.0; the license text is included as `assets/stockfish/Copying.txt`.

Corresponding upstream source is available from the tagged Stockfish.js 19.0.1 release at <https://github.com/nmrugg/stockfish.js/tree/v19.0.1> and the Stockfish 19 source at <https://github.com/official-stockfish/Stockfish/tree/sf_19>. The Stockfish.js project documents its build process at <https://github.com/nmrugg/stockfish.js>. The bundled engine assets are `stockfish-19-lite-single.js` and `stockfish-19-lite-single.wasm`.

The bundled ECO opening data comes from Lichess's `chess-openings` project and is dedicated to the public domain under CC0 1.0: <https://github.com/lichess-org/chess-openings>.

## Lichess puzzle collection

The included `lichess_db_puzzle.csv.zst` archive is indexed on the first puzzle request. Node.js streams and validates the compressed CSV into a disk-backed JSONL cache plus a sparse offset index under the operating-system temporary directory; the six-million-record collection is never loaded into memory at once. The cache is keyed by the archive size and modification time, so replacing the archive creates a fresh index.

The first index build can take about a minute. Check readiness and the accepted/rejected row counts with `GET /api/puzzles/status`, then request bounded pages with `GET /api/puzzles?offset=0&limit=16` (maximum page size: 50). Puzzle pages preserve dataset order. The client stores a completed-puzzle cursor locally and skips malformed or illegal positions without repeating completed puzzles.

## Run locally

Use Node.js 22.15 or newer (required for the built-in streaming Zstandard decompressor). In PowerShell, run:

```powershell
.\start-chess.ps1
```

Or double-click `start-chess.cmd` in File Explorer. Then open <http://127.0.0.1:4173>. Keep the terminal open while playing; it serves both the app and puzzle API. Alternatively, run `npm start`. No package install, account, CDN, or other external service is required to play. The bundled single-threaded engine is loaded locally and needs no cross-origin isolation headers.

## Run with VS Code Live Server

Live Server serves static files only; it cannot build the puzzle index or answer `/api/puzzles` requests by itself. Start the local backend in a VS Code terminal and leave that terminal running:

```powershell
.\start-chess.ps1
```

Use **Open with Live Server** on `index.html` and open the page at `http://127.0.0.1:5500/index.html`. The page automatically sends puzzle requests to the loopback backend on port `4173`; both servers must remain running. You can also double-click `start-chess.cmd` to launch the backend. Live Server can use its usual port if it differs from `5500`.

The page automatically uses the API on port `4173` when it is served from `localhost` or `127.0.0.1` on another port. To use a different API port in PowerShell, run `$env:PORT=4174; npm start`, then pass its origin in the page URL, for example `http://127.0.0.1:5500/index.html?apiBase=http://127.0.0.1:4174/`. The API allows cross-origin puzzle requests only from loopback HTTP pages. If it is stopped or unreachable, the puzzle view reports that `npm start` is required and provides a retry action.

The first puzzle request streams the full 309 MB compressed Lichess archive into a disk-backed index; the browser receives only small pages of puzzles. The first index can take about a minute. Check `http://127.0.0.1:4173/api/puzzles/status` for readiness and the total indexed count. Puzzle data and Stockfish are served locally; neither feature depends on a CDN or cross-origin isolation.

## Classroom rooms

Classroom uses the same Node server as the game and puzzle API. Run `npm start` (or `.\start-chess.ps1`) and open the app from that server, or use VS Code Live Server alongside it. On localhost, the Classroom WebSocket automatically connects to the API server on port `4173`. When the server uses another address, set `?classroomServer=wss://chess.example.com` in the app URL; the browser connects to the `/classroom` WebSocket path on that origin.

For production, serve the Node backend behind HTTPS and a reverse proxy that supports WebSocket upgrades, and set `CLASSROOM_ALLOWED_ORIGINS` to a comma-separated list of trusted app origins (for example, `https://chess.example.com`). Do not expose a production Classroom connection over unencrypted `ws://`. GitHub Pages and Live Server are static hosts and cannot host the room service themselves; they must connect to a running Node backend.

Room state is authoritative and validated on the server, but is currently held in memory: rooms are lost when the Node process restarts, and inactive rooms expire. Refresh/reconnect credentials are saved in the current browser profile; invitation links contain the room ID, not a participant token or room password. A room password can add access control, and the host can lock an active room to prevent new guests from joining. Do not treat the current in-memory service as durable classroom storage.