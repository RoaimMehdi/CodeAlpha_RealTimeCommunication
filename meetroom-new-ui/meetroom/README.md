# MeetRoom - Real-Time Video Conferencing + Collaboration App

A modern, polished video-meeting web app with live whiteboard, shared files,
chat, active-speaker view and a production-grade Express + MySQL + Socket.io
backend. Run against `http://localhost:<PORT>` served by Express.

## Tech stack

- **Backend**: Node.js + Express, Socket.io, MySQL 8 (mysql2), bcryptjs, jsonwebtoken,
  multer, helmet, express-rate-limit, dotenv
- **Frontend**: plain HTML + CSS + vanilla JS (no build step) in `public/`
- **Real-time**: LiveKit SFU (audio, video, screen sharing, adaptive streaming,
  dynacast, simulcast) + Socket.io for chat, whiteboard and file sharing
- **Database**: MySQL 8 with `meetroom` schema (`users`, `rooms`, `room_participants`,
  `messages`, `files`, `strokes`)
- **Auth**: JWT + bcrypt password hashing

## Prerequisites

- Node.js (v18 or higher)
- MySQL 8+ server
- A modern web browser with WebRTC support

## Local development setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/your-username/meetroom.git
   cd meetroom
   ```

2. **Environment configuration**

   ```bash
   cp .env.example .env
   ```

   At minimum fill `JWT_SECRET`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `PORT`.
   For LiveKit production, also set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
   `LIVEKIT_API_SECRET`.

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Database setup**

   Run the schema in MySQL Workbench or from the command line:

   ```bash
   mysql -u root -p < schema.sql
   ```

   This creates the `meetroom` database with the following tables:

   - `users` - registered users with bcrypt-hashed passwords
   - `rooms` - meeting rooms owned by a user
   - `room_participants` - who's in each room
   - `messages` - in-room chat history
   - `files` - uploaded files per room
   - `strokes` - whiteboard drawing data persisted for late joiners

   A seed admin user is included in the schema:

   `admin@meetroom.local` / `admin123`

5. **Start the server**

   ```bash
   npm start
   ```

   The server runs on `http://localhost:3001`.

6. **Open the app**

   Open **http://localhost:3001** in your browser.
   Always use the Express-served URL, never VS Code Live Server.

## LiveKit (SFU) integration

1. Create a LiveKit project and copy the API key, API secret and WebSocket URL.
2. Add these to `.env`:

   ```env
   LIVEKIT_URL=https://your-livekit-domain.livekit.cloud
   LIVEKIT_API_KEY=your-livekit-api-key
   LIVEKIT_API_SECRET=your-livekit-api-secret
   ```

3. The backend exposes a short-lived, room-scoped LiveKit JWT:

   ```http
   GET /api/livekit/token?code=9f3a21bc
   Authorization: Bearer <JWT>
   ```

   The token grants video/audio publish and subscribe, dynacast, adaptive streaming,
   simulcast and up to 100 participants. The API secret stays on the backend only.

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Register a new user |
| POST | `/api/login` | Log in with email/password |
| GET | `/api/rooms` | Get a user's rooms |
| POST | `/api/rooms` | Create a new room |
| GET | `/api/rooms/:code` | Get room details by code |
| GET | `/api/rooms/:code/messages` | Chat history |
| POST | `/api/rooms/:code/messages` | Send a chat message |
| POST | `/api/rooms/:code/files` | Upload a file (multipart, 25MB max) |
| GET | `/api/files/:id` | Download a file |
| GET | `/api/livekit/token` | LiveKit room-scoped JWT (auth required) |

## Database schema

See `schema.sql` for the full `CREATE TABLE` statements.

## Production deployment

- **VPS + Nginx**: run behind an Nginx reverse proxy on port 3001.
- **HTTPS**: add Let's Encrypt / Certbot to the Nginx server block.
- **WSS**: the LiveKit client connects over `wss://`. Put Nginx in front so the
  browser reaches the server over HTTPS, and never expose the LiveKit API secret.
- **TURN**: run coturn (`docker-compose.yml`) for NAT-crossing; WebRTC mesh is
  limited to about 6 users, SFU (LiveKit) scales to 50-100.

## Migration checklist (WebRTC mesh -> LiveKit SFU)

- [ ] Install `livekit-server-sdk` and replace the `RTCPeerConnection` mesh code
- [ ] Remove `stun:stun.l.google.com:19302` ICE from `public/app.js`
- [ ] Add the `GET /api/livekit/token?code=` endpoint and keep secrets on the backend
- [ ] Fix `public/index.html` element ids (auth, lobby, room, authErr, nameWrap,
      name, email, password, roomName, roomCode, createRoom, joinRoom, lobbyErr,
      logout, who, grid, side, count, copyCode, roomTitle, mic, cam, share,
      toggleSide, leave, canvas, color, size, eraser, clearBoard, fileInput,
      fileList, fileErr)
- [ ] Swap `createPC`, `addTile`, `handleSignal`, `requestCamera`, `replaceOutgoingTrack`
      to LiveKit room + track subscriptions with active-speaker view
- [ ] Keep Socket.io for chat, whiteboard and files (no socket events insert file
      records; files only served after a membership check)
- [ ] Enforce 6-person limit server-side and mark `left_at` on last tab leave
- [ ] Add GET `/api/health` and friendly EADDRINUSE / Access denied / missing JWT_SECRET
      / 404-405 / Live Server error messages
- [ ] Load test toward 50+ participants and report actual bandwidth and server resources

## Known limitations

- LiveKit billing depends on your plan. The SDK token supports up to 100
  participants in the room config, but verify your LiveKit plan limits.
- Web Speech (live captions) mainly works in Chrome/Edge.
- TURN is needed across restrictive NATs; STUN alone is a fallback.
