# CamKnock Operations & Support Management Portal

The dedicated administrative and customer support operations control center for **CamKnock**.

## 📁 Directory Structure
```
portal/
├── index.html     # Operations & Support Management Dashboard (A-to-Z controls)
├── login.html     # Staff Authentication Portal
├── portal.js      # Real-time WebRTC socket controls, telemetry, and API actions
└── README.md      # Documentation & Credentials
```

## 🚀 Live Access Routes
* **Portal Dashboard:** `http://localhost:9000/portal`
* **Staff Login:** `http://localhost:9000/portal/login`

## 🔐 Default Staff Accounts
| Role | Email | Password |
|---|---|---|
| **Admin** | `demo@camknock.app` | `password123` |
| **Admin** | `admin@meetroom.local` | `password123` |
| **Support Team** | `codenexra@gmail.com` | `password123` |
| **Support Team** | `admin@autovexo.com` | `password123` |

## 🛠️ Features & Controls (A to Z)
1. **Platform Executive Overview:**
   * Real-time metrics: Total Users, Active Hosts, All-time Meetings, Joined Participants, Live Calls Now, Support Inquiries.
   * Host Breakdown: Which host created how many rooms, how many participants they added via Join Meeting code, and last meeting hosted date.
2. **Live Calls Monitor & Terminate:**
   * Scan active WebRTC socket rooms in real-time.
   * 1-click **Join Call / Spectate** for customer support.
   * 1-click **Force End Room** to terminate rogue sessions via socket broadcast.
3. **Room Audit Inspection Drawer:**
   * Full attendance records (joined/left times).
   * In-meeting chat logs.
   * Shared files and downloads.
4. **Hosts & User Directory:**
   * Search users by name/email and filter by role.
   * Change roles (`Admin`, `Support`, `Host`, `User`).
   * Delete user accounts.
   * Create new User/Host directly with custom role.
5. **Scheduled Meetings Calendar:**
   * View upcoming scheduled meetings.
   * Schedule new meeting (Date, Time, Duration, Description).
   * Cancel scheduled meetings.
6. **Support Desk & Helpline:**
   * Incoming inquiries from helpline (`+1 201-685-2107`).
   * Priority management (`Urgent`, `High`, `Medium`, `Low`).
   * Ticket status lifecycle (`Open`, `In Progress`, `Resolved`, `Closed`).
   * Direct customer reply and internal staff notes.
7. **Website Settings & Helpline:**
   * Live edit top announcement bar.
   * Update support phone number (`+1 201-685-2107`).
   * Update support email (`camknock@gmail.com`).
   * Max participants limit and guest access toggle.

