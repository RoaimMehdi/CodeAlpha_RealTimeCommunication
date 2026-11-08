<p align="center">
  <img src="public/assets/logo.svg" alt="MeetRoom" width="72" height="72" />
</p>

<p align="center">
  Browser video meetings with chat, a shared whiteboard and file sharing.<br />
  No downloads, no installs — share a room code and you are in.
</p>

---

## What you get

- **Video calls** — WebRTC mesh, up to 6 participants, mic/camera toggles and screen sharing.
- **Room codes** — 8-character codes; hosts can end the meeting or remove a participant.
- **Chat** — persisted in MySQL, last 50 messages replayed to late joiners.
- **Whiteboard** — drawings are stored per room and replayed on join.
- **Files** — uploads up to 25 MB, stored on disk, downloadable by anyone in the room.
- **Branding** — one SVG logo mark (plus a light variant) used across every page and as the favicon.

## Stack

| Layer      | Choice                                                   |
| ---------- | -------------------------------------------------------- |
| Server     | Node.js 18+, Express 4, Socket.IO 4                      |
| Database   | MySQL 8 (`mysql2`)                                       |
| Media      | WebRTC mesh with Google STUN                             |
| Auth       | JWT (`jsonwebtoken`) + bcrypt password hashing           |
| Frontend   | Plain HTML, CSS and ES5-safe JavaScript in `public/`     |
| Hardening  | Helmet CSP, rate-limited auth routes, upload limits      |

## Project layout

```
.
├── server.js              Express API + Socket.IO signalling
├── schema.sql             MySQL schema (idempotent)
├── scripts/setup-db.js    npm run db:setup
├── public/                The application (served by Express)
│   ├── index.html         Sign in / create account
│   ├── home.html          Start or join a room
│   ├── call.html          The meeting room
│   ├── app.css            Design system
│   ├── js/core.js         Session, API client, formatters
│   ├── js/auth.js         Auth page behaviour
│   ├── js/home.js         Dashboard behaviour
│   ├── js/call.js         WebRTC, chat, whiteboard, files
│   └── assets/            SVG logo marks
├── design/                Original HTML design mockups (not served)
├── uploads/               Uploaded files (created at runtime)
├── Dockerfile             Production image
└── docker-compose.yml     App + MySQL
```

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    then set JWT_SECRET, DB_USER, DB_PASSWORD

# 3. Create the database and tables
npm run db:setup

# 4. Run
npm start           # http://localhost:9000
npm run dev         # same, with --watch reload
```

Open <http://localhost:9000>, create an account, start a room, then open the invite
link in a second browser (or an incognito window) to test the call.

### Environment variables

| Variable           | Default     | Notes                                                    |
| ------------------ | ----------- | -------------------------------------------------------- |
| `PORT`             | `3000`      | `.env.example` ships `9000`                              |
| `JWT_SECRET`       | —           | **Required**, 16+ characters                             |
| `JWT_EXPIRES_IN`   | `7d`        | Token lifetime                                           |
| `DB_HOST`          | `localhost` |                                                          |
| `DB_PORT`          | `3306`      |                                                          |
| `DB_USER`          | `root`      |                                                          |
| `DB_PASSWORD`      | empty       |                                                          |
| `DB_NAME`          | `meetroom`  |                                                          |
| `MAX_PARTICIPANTS` | `6`         | Mesh calls degrade past 6                                |
| `MAX_UPLOAD_MB`    | `25`        | Per-file limit                                           |
| `CORS_ORIGIN`      | empty       | Empty = same-origin only; comma-separate to allow more   |
| `TRUST_PROXY`      | `0`         | Set to `1` behind nginx/Caddy                            |

## npm scripts

| Script            | Purpose                                  |
| ----------------- | ---------------------------------------- |
| `npm start`       | Run the server                           |
| `npm run dev`     | Run with automatic restart on change     |
| `npm run db:setup`| Create the database and apply the schema |
| `npm run health`  | Print `/api/health` as JSON              |

## API

All `/api` routes except `health`, `register` and `login` require
`Authorization: Bearer <token>`.

| Method | Route                             | Description                              |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | `/api/health`                     | Liveness + database latency              |
| POST   | `/api/register`                   | Create an account                        |
| POST   | `/api/login`                      | Sign in                                  |
| GET    | `/api/me`                         | Current user                             |
| POST   | `/api/rooms`                      | Create a room (returns the code)         |
| GET    | `/api/rooms`                      | Rooms you own or have joined             |
| GET    | `/api/rooms/:code`                | Room details + live participants         |
| POST   | `/api/rooms/:code/end`            | Host only — end for everyone             |
| POST   | `/api/rooms/:code/participants`   | Host only — remove a participant         |
| GET    | `/api/rooms/:code/messages`       | Chat history                             |
| POST   | `/api/rooms/:code/messages`       | Send a message                           |
| POST   | `/api/rooms/:code/files`          | Upload (`multipart/form-data`, field `file`) |
| GET    | `/api/files/:id`                  | Download                                 |

Errors are always `{ "error": "message" }` with a matching HTTP status.

## Socket.IO protocol

Connect with `io({ auth: { token } })`.

**Client → server:** `join { code }` (ack with room state), `signal { to, data }`,
`peer-state { mic, cam, sharing }`, `stroke`, `clear-board`.

**Server → client:** `peer-joined`, `peer-left`, `peer-state`, `signal`,
`message`, `file`, `stroke`, `clear-board`, `room-ended`, `participant-removed`.

The newest participant creates the WebRTC offer for every peer already in the
room; existing peers answer. Media state (mute, camera off, sharing) travels
over `peer-state` because track enablement is local-only.

## Branding

| Asset                           | Use                                        |
| ------------------------------- | ------------------------------------------ |
| `public/assets/logo.svg`        | Page headers and the browser favicon       |
| `public/assets/logo-light.svg`  | Login hero tile (white tile, green glyph)  |

Brand colours: `#0A3D27` (deep green), `#0E7A4B` (action), `#E6F4EC` (mint),
`#F2F8F4` (page), plus `#0A120E` / `#121D17` for the call screen.
Both marks are plain SVG — edit them directly, no build step required.

## Docker

```bash
echo "DB_ROOT_PASSWORD=$(openssl rand -hex 16)" >> .env
docker compose up -d --build
```

Compose starts the app on port 9000 and a MySQL 8 database, applying
`schema.sql` on first boot. The app waits for the database healthcheck.

## Deployment notes

- Run behind HTTPS — browsers refuse camera/mic access on plain HTTP except on
  `localhost`. nginx/Caddy must forward `Upgrade`/`Connection` for Socket.IO.
- Set `TRUST_PROXY=1` behind a proxy so rate limiting sees real client IPs.
- Persist `uploads/` (volume) and back up the database.
- STUN-only works for most networks. For restrictive corporate NATs add a TURN
  server and extend `ICE` in `public/js/call.js` with its credentials.
- Scale beyond 6 participants per room by replacing the mesh with an SFU
  (LiveKit, mediasoup); the room/chat/whiteboard APIs stay the same.

## Troubleshooting

| Symptom                              | Check                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `Server error` on sign in            | `npm run health`; confirm DB creds in `.env`                   |
| `Port 9000 is already in use`        | Stop the other process or change `PORT`                        |
| Camera/mic never start               | Use `localhost` or HTTPS; check browser permissions            |
| Call connects but no video           | Both peers need a working STUN path; try another network       |
| `Cannot join this room`              | Room code typo, room full, or server restarted mid-join        |

## License

Internal project. No license granted for redistribution.
#   C o d e A l p h a _ R e a l T i m e C o m m u n i c a t i o n  
 