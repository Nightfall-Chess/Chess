# Nightfall Chess

## Stockfish licensing and source

This application ships the single-threaded Lite Stockfish.js 19.0.1 WebAssembly engine in `assets/stockfish/`. The matching `.js` and `.wasm` files are distributed under GPL-3.0; the license text is included as `assets/stockfish/Copying.txt`.

Corresponding upstream source is available from the tagged Stockfish.js 19.0.1 release at <https://github.com/nmrugg/stockfish.js/tree/v19.0.1> and the Stockfish 19 source at <https://github.com/official-stockfish/Stockfish/tree/sf_19>. The Stockfish.js project documents its build process at <https://github.com/nmrugg/stockfish.js>. The bundled engine assets are `stockfish-19-lite-single.js` and `stockfish-19-lite-single.wasm`.

The bundled ECO opening data comes from Lichess's `chess-openings` project and is dedicated to the public domain under CC0 1.0: <https://github.com/lichess-org/chess-openings>.

## Lichess puzzle collection

The official `lichess_db_puzzle.csv.zst` archive is a large external download and is not stored in this GitHub repository. Download it from the [Lichess puzzle database](https://database.lichess.org/#puzzles) and place the file in the repository root next to `server.mjs`. The server reports a clear setup error if the archive is missing. You can override its location with the `CHESS_PUZZLE_ARCHIVE` environment variable.

The archive is indexed on the first puzzle request. Node.js streams and validates the compressed CSV into a disk-backed JSONL cache plus a sparse offset index under the operating-system temporary directory; the six-million-record collection is never loaded into memory at once. The cache is keyed by the archive size and modification time, so replacing the archive creates a fresh index.

The first index build can take about a minute. Check readiness and the accepted/rejected row counts with `GET /api/puzzles/status`, then request bounded pages with `GET /api/puzzles?offset=0&limit=16` (maximum page size: 50). Puzzle pages preserve dataset order. The client stores a completed-puzzle cursor locally and skips malformed or illegal positions without repeating completed puzzles.

## Run locally

Use Node.js 22.15 or newer (required for the built-in streaming Zstandard decompressor). After checkout, install the server dependencies once with `npm install`. In PowerShell, run:

```powershell
.\start-chess.ps1
```

Or double-click `start-chess.cmd` in File Explorer. Then open <http://127.0.0.1:4173>. Keep the terminal open while playing; it serves both the app and puzzle API. Alternatively, run `npm start`. The bundled single-threaded engine is loaded locally and needs no cross-origin isolation headers.

## Self-hosted online games

The Online screen defaults to **Self-hosted WebSocket**. This mode uses the Node server in this repository and does not require Supabase. The server assigns White to the room creator and Black to the first guest, rejects a third player, validates every move with `chess.js`, owns both clocks, and broadcasts authoritative positions. A per-seat resume token is saved in that browser so a player can reconnect to the same room. Rooms are retained for 24 hours after every player disconnects.

The normal Windows launch is:

```powershell
.\start-chess.ps1
```

For friends outside your local network, expose port `4173` with Cloudflare Tunnel. Keep the Node server window open and start the tunnel in a second PowerShell window:

```powershell
cloudflared tunnel --url http://127.0.0.1:4173
```

Set the browser site's origin on the server before starting it. For the GitHub Pages site:

```powershell
$env:ONLINE_ALLOWED_ORIGINS = "https://nightfall-chess.github.io"
.\start-chess.ps1
```

If you serve the website from a stable Cloudflare hostname instead, include that exact `https://...` origin as well. In the Online screen, enter the public tunnel base URL in **WebSocket server URL** (for example `https://your-tunnel.example.com`); the app converts it to the secure WebSocket endpoint. Share the generated invite link or seven-character room code. The invite link includes the server URL for the guest. Keep the Node window running for the whole game. Do not share the resume token; it is local to each browser. This mode has no account system, so only share your server URL and room code with people you intend to play.

`HOST` defaults to `0.0.0.0` so a tunnel can reach the server. `ONLINE_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist for browser WebSocket handshakes; local loopback pages are allowed automatically. The separate **Supabase rooms** option remains available and continues to use the existing Supabase configuration.

## Run with VS Code Live Server

Live Server serves static files only; it cannot build the puzzle index or answer `/api/puzzles` requests by itself. Start the local backend in a VS Code terminal and leave that terminal running:

```powershell
.\start-chess.ps1
```

Use **Open with Live Server** on `index.html` and open the page at `http://127.0.0.1:5500/index.html`. The page automatically sends puzzle requests to the loopback backend on port `4173`; both servers must remain running. You can also double-click `start-chess.cmd` to launch the backend. Live Server can use its usual port if it differs from `5500`.

The page automatically uses the API on port `4173` when it is served from `localhost` or `127.0.0.1` on another port. To use a different API port in PowerShell, run `$env:PORT=4174; npm start`, then pass its origin in the page URL, for example `http://127.0.0.1:5500/index.html?apiBase=http://127.0.0.1:4174/`. The API allows cross-origin puzzle requests only from loopback HTTP pages. If it is stopped or unreachable, the puzzle view reports that `npm start` is required and provides a retry action.

The first puzzle request streams the full 309 MB compressed Lichess archive into a disk-backed index; the browser receives only small pages of puzzles. The first index can take about a minute. Check `http://127.0.0.1:4173/api/puzzles/status` for readiness and the total indexed count. Puzzle data and Stockfish are served locally; neither feature depends on a CDN or cross-origin isolation.

## Game archive and review

Completed games, imported PGNs, and saved Chess Moments are stored in browser IndexedDB on the current device. Use **Import PGN** from the main menu to choose a `.pgn` file or paste PGN text; Nightfall validates and replays its moves, stores the full source and position history in the Game Archive, and opens it in Game Review. The archive supports replay, review, PGN download, result/date filters, favorites, and confirmed deletion. Stockfish review results are cached with each archived game so later reviews can reuse completed analysis. Daily challenge completion is stored locally; the featured position is selected from the included rated puzzle sample. These records are device-local and are not synchronized between browsers.

AI move searches run in the existing local Stockfish worker. The engine can calculate while the player sees the thinking indicator; the reply waits at least 2.7 seconds from the player's move before animating, unless calculation takes longer. Reduced-motion preferences intentionally disable piece animations.

## Supabase online rooms and Classroom

Supabase rooms and Classroom are static-site features backed by Supabase; neither uses the Node WebSocket server. Configure the required Supabase services, then publish the static files to GitHub Pages (including a repository site deployed beneath `/Chess/`).

### Online multiplayer

The **Supabase rooms** transport uses the `online` Edge Function and private Realtime notifications. Enable Anonymous Sign-Ins, apply the migrations in `supabase/migrations/` in order (or run `supabase db push`), then deploy with `supabase functions deploy online`. The latest online migration adds atomic room creation, serialized guest joins, version-checked move commits, and resignation; move results and room completion are committed together. Notifications are only hints: each browser fetches and applies the server-owned room snapshot.

The Supabase transport currently does not offer clocks. Select **Self-hosted WebSocket** for timed games; it supports authoritative clocks and reconnects through the Node server. Live Server only serves static assets, so self-hosted online games still require the Node backend described above.

### Supabase setup

1. Create a Supabase project and enable **Anonymous Sign-Ins** under **Authentication → Providers → Anonymous**. Anonymous Auth gives each browser a persistent Supabase user identity; it is not a custom account system.
2. Apply [`supabase/migrations/202606110001_classroom.sql`](./supabase/migrations/202606110001_classroom.sql) in the Supabase SQL Editor, or run `supabase link --project-ref YOUR_PROJECT_REF` followed by `supabase db push` from the repository root.
3. Deploy the secure Edge Function from the repository root with `supabase functions deploy classroom`. The hosted Edge Function provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` automatically. Do not copy the service-role key into this repository, the browser configuration, or GitHub Pages.
4. Keep Supabase Realtime enabled. The migration installs private-channel authorization policies; only active room members can subscribe to `classroom:<room-uuid>`. Clients can publish presence and untrusted signals, but the app never accepts a broadcast as authoritative state.
5. Add the project URL and its **public publishable key** (the legacy `anon` key is also public) to [`supabase-config.js`](./supabase-config.js):

   ```js
   window.NIGHTFALL_SUPABASE_CONFIG = Object.freeze({
     url: "https://YOUR-PROJECT-REF.supabase.co",
     publishableKey: "YOUR_PUBLIC_PUBLISHABLE_KEY"
   });
   ```

   A public browser key is expected to be visible. Never put a service-role key, secret key, database password, or Edge Function secret in this file.    The file must contain the project URL and public browser key. These values are public; never put a service-role key, secret key, database password, or Edge Function secret in the browser or GitHub Pages.

The migration creates rooms, memberships, saved games, shared state, private room secrets, and chat messages. RLS allows member-only reads; client writes are revoked. Invitation codes and optional passwords are stored as hashes in a table that is not readable by browser roles. The Edge Function verifies the Supabase user, checks membership and room access, validates chess moves using `chess.js`, and calls restricted SQL functions. State commits lock and compare the room version, so simultaneous or stale moves cannot overwrite a newer position. A rejected operation does not change the stored state.

Realtime Broadcast carries versioned state-change notifications and chat updates; clients fetch the saved snapshot from the Edge Function instead of trusting broadcast payloads. Supabase Presence supplies online status. High-frequency move events are not stored as event rows. Room state has a 30-day expiry, and expired rooms are rejected by the Edge Function and private-channel policies; remove expired rows periodically if long-term storage cleanup is needed.

### Local Stockfish and privacy

Stockfish 19 Lite continues to run in the existing single-threaded Web Worker in each browser. It starts in the background when the browser is idle after the page has loaded (or as soon as the AI mode is hovered or chosen), unless the browser's data-saver mode is on, and reuses the existing engine worker and search queue. If the engine is not ready within 2.5 seconds, or cannot be loaded, the built-in engine plays that move so the game never waits; Stockfish takes over once it is ready. The worker URL is relative to the app document (`./assets/stockfish/stockfish-19-lite-single.js`), and the worker loads its matching WASM beside that script, so a GitHub Pages URL such as `https://OWNER.github.io/Chess/` resolves under `/Chess/assets/`. The build does not require `SharedArrayBuffer` or cross-origin isolation headers. 

Classroom engine analysis is private to the browser that ran it. Students can run independent local analysis. Only the Host’s explicit **Publish to room** action stores and shares the selected evaluation and lines; private engine results are never sent to Supabase.

### GitHub Pages and local use

The app loads the Supabase JS client lazily from a version-pinned public CDN only when Classroom is opened; other local games, the AI, Stockfish, themes, Academy, and review screens do not require that client. GitHub Pages needs only the configured static app files, Supabase project URL, and public key.

The Node server remains available for the existing local puzzle API and development workflow. GitHub Pages and Live Server do not host that puzzle API; use the documented `npm start` setup if you need the Lichess puzzle collection. This puzzle service is separate from Classroom and is not part of the Supabase deployment.

Before deploying, test in two separate browser profiles: create a room in one, join with its invitation link in the other, verify moves and annotations synchronize, test denied student actions and reconnection, and confirm private analysis appears only in its originating browser until the Host publishes it. This checkout's automated tests do not contact a live Supabase project; verify migration application, Edge Function deployment, and two-device operation in the target project before claiming those workflows are available.