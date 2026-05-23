# KVM Backup Manager

> **Enterprise-grade backup and restore solution for KVM/QEMU virtual machines with incremental backups, centralized management, and real-time monitoring**

A comprehensive, open-source backup management system designed for KVM virtualization environments. Built with Node.js, React, and powered by [virtnbdbackup](https://github.com/abbbi/virtnbdbackup), this solution provides automated backup scheduling, incremental backups, offsite replication, and complete disaster recovery capabilities for virtual machines.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Linux-lightgrey.svg)](https://www.linux.org/)
[![virtnbdbackup](https://img.shields.io/badge/powered%20by-virtnbdbackup-orange.svg)](https://github.com/abbbi/virtnbdbackup)

**Keywords**: KVM backup, QEMU backup, virtual machine backup, incremental backup, VM restore, libvirt backup, Linux virtualization backup, automated backup solution, disaster recovery, backup management system

## 📋 Table of Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Recommended Architecture](#-recommended-architecture)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Deployment](#-deployment)
- [Usage](#-usage)
- [API Documentation](#-api-documentation)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [Author](#-author)
- [License](#-license)
- [Acknowledgments](#-acknowledgments)

## ✨ Features

### Core Backup Technology
- **Powered by virtnbdbackup**: Built on top of the robust [virtnbdbackup](https://github.com/abbbi/virtnbdbackup) open-source project by [@abbbi](https://github.com/abbbi)
- **Incremental Backups**: Efficient block-level incremental backups using NBD (Network Block Device) protocol
- **Live VM Backup**: Backup running VMs without downtime using libvirt's backup API
- **Multiple Backup Methods**: Daily, Weekly, Monthly, Custom Days, Interval, and One-time backups
- **Flexible Scheduling**: Cron-based scheduling with multiple schedule types
- **Backup Verification**: Optional backup verification after completion
- **Compression Support**: Configurable compression levels (0-9)
- **Offsite Backup**: Automatic sync to multiple offsite locations

### Restore Capabilities
- **Full VM Restore**: Complete VM restoration from backups
- **Flexible Restore Options**: Restore to different storage pools
- **Progress Tracking**: Real-time restore progress monitoring
- **Restore History**: Complete restore job history and logs

### Reliability & Recovery
- **Missed Schedule Recovery**: When the controller is down during a scheduled backup, missed runs are automatically replayed when it comes back online. Configurable per-schedule policy (immediate/most-recent/skip) with grace period.
- **Active Job Recovery**: If the agent crashes mid-backup, the controller reconciles job states by querying the agent's live-status endpoint (inspects tmux sessions, processes, lock files, progress files).
- **Accurate Exit Code Handling**: Killed/interrupted jobs are correctly reported as failed (not success). Exit codes written to file for reliable detection.
- **Automatic Cleanup**: Stale lock files, orphaned tmux sessions, and leftover progress files are cleaned on agent startup, periodically (every 10 min), and lazily before new jobs.
- **Health-Check Debounce**: Requires 2 consecutive failures before marking a host offline, preventing false-offline from transient network blips.
- **Fresh-on-Open**: When the panel is opened, a health check is triggered immediately so users always see current status.

### Management Features
- **Centralized Dashboard**: Web-based UI for managing all backups
- **Multi-Agent Support**: Manage multiple backup hosts from single controller
- **Storage Pool Management**: Configure and monitor storage pools
- **Health Monitoring**: Real-time agent health checks with debounce
- **Resource Metrics**: CPU, memory, and disk usage monitoring
- **Backup Reports**: Comprehensive enriched reports with per-VM rollups, success rates, trending, and downloadable formats (PDF, JSON, CSV)

### Security & Access Control (RBAC)
- **Three Roles**: Admin (full access), User (read all, write on granted hosts), Viewer (read-only)
- **Per-Host Access Grants**: Users can only trigger backups/restores on hosts they're granted access to
- **Comprehensive Audit Trail**: All significant actions logged with actor, timestamp, target, and IP. Rotated at 5MB, retained 90 days.
- **Disabled User Support**: Accounts can be disabled without deletion
- **Login Auditing**: Successful and failed login attempts recorded

### Modern UI
- **Glass Morphism Design**: Backdrop-blur cards, gradient borders, hover-shine effects
- **Command Palette**: Cmd/Ctrl+K for quick navigation across all pages
- **Notification Center**: Real-time in-app notifications from WebSocket events with unread badge
- **Grouped Navigation**: Infrastructure / Jobs / Operations / Settings sidebar groups
- **Phase-Aware Job Visualization**: Progress bars change color based on phase (backup=blue, rsync=purple, restore=green)
- **Settings Hub**: General config, User management, Audit log viewer, Notification settings (RocketChat + SMS)

### Advanced Features
- **Concurrent Backup Control**: Per-host concurrent backup limits
- **Schedule Conflict Detection**: Prevents conflicting backup schedules
- **Automatic Job Recovery**: Recovers stuck jobs on service restart
- **Live Log Streaming**: Real-time backup/restore log viewing
- **RocketChat Integration**: Notifications for critical events
- **Retention Management**: Automatic backup retention and cleanup

## 🏗 Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │Dashboard │  │Schedules │  │  Backups │  │ Resources│       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS/WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Controller Backend (Node.js)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Scheduler   │  │  Monitoring  │  │ Health Check │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   Storage    │  │   Metrics    │  │ Notifications│         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└────────────────────────┬────────────────────────────────────────┘
                         │ JWT Auth + Static Token
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Backend (Node.js)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │Backup Executor│ │Restore Executor│ │Report Service│         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Retention   │  │   Metrics    │  │  SSH Service │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└────────────────────────┬────────────────────────────────────────┘
                         │ SSH
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    KVM Hypervisors (libvirt)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │   VM 1   │  │   VM 2   │  │   VM 3   │  │   VM N   │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### Communication Flow

1. **Frontend ↔ Controller**: HTTPS + WebSocket (JWT authentication)
2. **Controller → Agent**: HTTPS (Dynamic JWT tokens)
3. **Agent → Controller**: HTTPS (Static token)
4. **Agent → Hypervisor**: SSH (Key-based authentication)

### Authentication Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 1: User Authentication (Frontend → Controller)         │
│ - JWT tokens with JWT_SECRET                                 │
│ - Login/logout functionality                                 │
│ - Token expiration and refresh                               │
└──────────────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ Layer 2: Controller → Agent (Dynamic JWT)                    │
│ - AGENT_JWT_SECRET (shared secret)                           │
│ - Controller generates JWT per request                       │
│ - Agent verifies JWT signature                               │
└──────────────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ Layer 3: Agent → Controller (Static Token)                   │
│ - AGENT_STATIC_TOKEN / AGENT_JWT_TOKEN                       │
│ - Simple string comparison                                   │
│ - Used for agent-initiated requests                          │
└──────────────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ Layer 4: Agent → Hypervisor (SSH Keys)                       │
│ - SSH key-based authentication                               │
│ - No password required                                       │
│ - Root access to hypervisors                                 │
└──────────────────────────────────────────────────────────────┘
```

## 🏛 Recommended Architecture

For best performance, reliability, and remove-backup safety, follow this layout:

### One Backup Host per Datacenter
Deploy a dedicated backup-host (agent server) **inside each datacenter** where
your hypervisors live. This gives you:
- **Lower latency** for SSH-driven backup operations
- **Less WAN traffic** (backup transfers stay within the local network)
- **Failure isolation** — a network issue in one datacenter doesn't block
  backups in others
- **Faster restores** — restoring a VM from a local backup host is far quicker
  than pulling backup data across the WAN

### Dedicated Storage as a Standard Storage Pool
On each backup host, attach a **separate storage device or LVM volume**
mounted under a dedicated path (e.g., `/opt/kvm_pool/backup`) and register it
as a Standard Storage Pool in the panel. Reasons:
- **Isolation** — backups never compete with the OS for I/O or fill up `/`
- **Predictable capacity** — you size the volume specifically for your retention needs
- **Safe remove-backup operations** — when you delete or archive a backup,
  there's zero risk of touching system files
- **Easier monitoring** — disk usage metrics in the panel reflect only backup
  data, making capacity planning straightforward

### Recommended pattern

```
Datacenter A                        Datacenter B
┌────────────────────────┐          ┌────────────────────────┐
│ Backup Host A          │          │ Backup Host B          │
│  └─ Storage Pool       │          │  └─ Storage Pool       │
│     /opt/kvm_pool/...  │          │     /opt/kvm_pool/...  │
│  └─ Hypervisors A1..An │          │  └─ Hypervisors B1..Bn │
└──────────┬─────────────┘          └──────────┬─────────────┘
           │                                   │
           └───────────────┬───────────────────┘
                           ▼
                ┌────────────────────┐
                │ Controller         │
                │ (single instance,  │
                │  any datacenter)   │
                └────────────────────┘
```

### Offsite Hosts (Optional but Recommended)
For disaster recovery, configure at least one **offsite host** in a different
datacenter (or cloud region). The agent will rsync completed backups there
asynchronously, so a datacenter failure won't take both your VMs and their
backups at the same time.

## 📦 Prerequisites

### Controller Server
- **OS**: Debian 11+ (recommended) / Ubuntu 22.04+ / any modern Linux
- **Node.js**: 18.x or higher (LTS recommended)
- **RAM**: 2GB minimum, 4GB recommended
- **Disk**: 20GB minimum (for logs, audit trail, daily report snapshots)
- **Network**: Access to all backup hosts on their HTTP/HTTPS port

### Backup Host (Agent Server)
**One per datacenter is strongly recommended.** Each backup host should have:
- **OS**: **Debian 11 or above (Bookworm or newer recommended)** — required for
  the version of libvirt/QEMU that supports virtnbdbackup's checkpoint API.
  Debian 10 and older Ubuntu LTS versions ship with libvirt versions that lack
  the required NBD/checkpoint features.
- **Node.js**: 18.x or higher
- **Python**: 3.9+ with pip3
- **RAM**: 4GB minimum, 8GB recommended (more for parallel backups)
- **Storage**: A **dedicated storage device or volume** mounted as the backup
  pool (e.g., `/opt/kvm_pool/backup`). Size to fit your retention policy
  (typically 1.5–3× the total live VM disk size depending on incremental ratio).
- **Network**: SSH (port 22) access to all hypervisors in the same datacenter
- **Packages**:
  - `virtnbdbackup` (provides `virtnbdbackup` and `virtnbdrestore` binaries)
  - `python3-libnbd`
  - `nbdkit`
  - `tmux` (used to manage long-running backup sessions resilient to agent restarts)
  - `rsync` (used for offsite replication)
  - `jq` (used by helper scripts)

### KVM Hypervisors
- **OS**: Any Linux with KVM/QEMU and a recent libvirt (Debian 11+ recommended
  for hypervisors as well — older versions may lack required QEMU monitor commands)
- **libvirt**: 7.0+ recommended (ships with Debian 11+)
- **SSH**: Root SSH key authentication from the backup host
- **Network**: Reachable on port 22 from the backup host
- **QEMU features**: Persistent dirty bitmaps and incremental backup support
  (these come with Debian 11's QEMU build by default)

## 🚀 Installation

### Step 1: Clone Repository

```bash
git clone https://github.com/aminhashemi1994/kvm-backup-manager.git
cd kvm-backup-manager
```

### Step 2: Generate JWT Secrets

**IMPORTANT**: Generate secure secrets before deployment!

```bash
chmod +x generate-jwt-secrets.sh
./generate-jwt-secrets.sh
```

This script generates three secrets:
- `JWT_SECRET`: User authentication (Frontend ↔ Controller)
- `AGENT_JWT_SECRET`: Controller → Agent communication
- `AGENT_STATIC_TOKEN`: Agent → Controller communication

**Save these secrets** - you'll need them in the next steps!

### Step 3: Install Controller Backend

```bash
cd controller-backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env file
nano .env
```

**Required .env variables**:
```env
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# Frontend URL (for CORS)
FRONTEND_URL=https://your-domain.com

# JWT Secrets (from generate-jwt-secrets.sh)
JWT_SECRET=<your-jwt-secret>
AGENT_JWT_SECRET=<your-agent-jwt-secret>
AGENT_STATIC_TOKEN=<your-agent-static-token>

# Optional: RocketChat Webhook
ROCKETCHAT_WEBHOOK_URL=https://your-rocketchat.com/hooks/xxx
```

### Step 4: Install Agent Backend

```bash
cd ../agent-backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env file
nano .env
```

**Required .env variables**:
```env
# Server Configuration
PORT=3001
HOST=0.0.0.0
NODE_ENV=production

# Controller URL
CONTROLLER_URL=https://controller-server:3000

# JWT Secrets (from generate-jwt-secrets.sh)
AGENT_JWT_SECRET=<your-agent-jwt-secret>  # MUST match controller!
AGENT_JWT_TOKEN=<your-agent-static-token>  # Same as AGENT_STATIC_TOKEN

# Backup Configuration
BACKUP_PATH=/opt/kvm_pool/backup
RESTORE_PATH=/opt/kvm_pool/restore
MAX_CONCURRENT_BACKUPS=2
```

**CRITICAL**: 
- `AGENT_JWT_SECRET` must be **IDENTICAL** in both controller and agent
- `AGENT_JWT_TOKEN` (agent) must equal `AGENT_STATIC_TOKEN` (controller)

### Step 5: Install Frontend

```bash
cd ../frontend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env file
nano .env
```

**Required .env variables**:
```env
VITE_BACKEND_URL=https://your-domain.com/api-backup
```

### Step 6: Install virtnbdbackup on Agent

This project uses **[virtnbdbackup](https://github.com/abbbi/virtnbdbackup)** - an open-source backup utility for KVM/QEMU virtual machines developed by [@abbbi](https://github.com/abbbi). The virtnbdbackup tool provides efficient incremental backups using the NBD protocol and libvirt's backup API.

**Installation Methods**:

**Option 1: From Package (Recommended)**
```bash
# Debian/Ubuntu
sudo apt-get install virtnbdbackup python3-libnbd nbdkit

# Or using pip
pip3 install virtnbdbackup
```

**Option 2: From Local Archive**
If you have a local virtnbdbackup.tar file:
```bash
# Copy your virtnbdbackup.tar to agent-backend/
cp /path/to/virtnbdbackup.tar agent-backend/

# Run initialization script
cd agent-backend/scripts
sudo bash Init_Host.sh
```

The initialization script will:
- Install required system packages (python3-libnbd, nbdkit, tmux, rsync, jq)
- Install virtnbdbackup from local tar file or package manager
- Configure AppArmor permissions for libvirt
- Set up backup directories
- Verify installation

**Verify Installation**:
```bash
virtnbdbackup --version
virtnbdrestore --version
```

**Learn More**: Visit the [virtnbdbackup GitHub repository](https://github.com/abbbi/virtnbdbackup) for detailed documentation, features, and community support.

### Step 7: Build Frontend

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`.

## ⚙️ Configuration

### SSH Key Setup (Agent → Hypervisors)

The agent needs passwordless SSH access to all hypervisors:

```bash
# On agent server, generate SSH key (if not exists)
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""

# Copy public key to each hypervisor
ssh-copy-id root@hypervisor-ip

# Test connection
ssh root@hypervisor-ip "virsh list --all"
```

### Storage Pool Configuration

> **⚠️ Important**: Use a **dedicated storage device or LVM volume** for your
> backup pool — never use the OS root partition. This isolates backup I/O,
> prevents fill-ups from breaking the agent, and makes remove-backup operations
> safer.

#### 1. Mount a dedicated storage device

Format and mount your backup disk (example with `/dev/sdb1`):

```bash
# Format (only on a fresh disk!)
sudo mkfs.ext4 -L kvm_backup /dev/sdb1

# Create the mount point
sudo mkdir -p /opt/kvm_pool

# Add to /etc/fstab for auto-mount on boot
echo "LABEL=kvm_backup /opt/kvm_pool ext4 defaults,noatime 0 2" | sudo tee -a /etc/fstab
sudo mount -a

# Verify
df -h /opt/kvm_pool
```

#### 2. Create backup and restore directories

```bash
sudo mkdir -p /opt/kvm_pool/backup
sudo mkdir -p /opt/kvm_pool/restore
sudo chown -R $(whoami):$(whoami) /opt/kvm_pool
```

#### 3. Register as a Standard Storage Pool in the panel

   - Navigate to **Infrastructure → Storage Pools**
   - Click **Add Storage Pool**
   - Set **Type**: Standard
   - Enter **Path**: `/opt/kvm_pool/backup`
   - Set **Concurrent Backup Limit** (typically 2–3 depending on disk speed)
   - The panel will validate the path is writable on the backup host

This pattern ensures:
- Backups never compete with the OS for disk I/O
- The OS root partition stays clean
- Capacity planning is straightforward (the pool size = backup size)
- **Remove-backup operations are safe** — only files inside the pool are touched

### Offsite Host Configuration (Optional)

For offsite backups:

1. Set up SSH keys to offsite server:
```bash
ssh-copy-id root@offsite-server-ip
```

2. Create offsite directories:
```bash
ssh root@offsite-server-ip "mkdir -p /backup/offsite"
```

3. Add offsite host in web UI:
   - Navigate to **Backup Hosts** → **Offsite Hosts**
   - Click **Add Offsite Host**
   - Enter IP, username, and storage pool paths

## 🚢 Deployment

### Option 1: PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start controller
cd controller-backend
pm2 start server.js --name "backup-controller"

# Start agent
cd ../agent-backend
pm2 start server.js --name "backup-agent"

# Save PM2 configuration
pm2 save

# Set PM2 to start on boot
pm2 startup
```

### Option 2: Systemd Services

**Controller Service** (`/etc/systemd/system/backup-controller.service`):
```ini
[Unit]
Description=KVM Backup Manager - Controller
After=network.target

[Service]
Type=simple
User=backup
WorkingDirectory=/opt/backup-manager/controller-backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Agent Service** (`/etc/systemd/system/backup-agent.service`):
```ini
[Unit]
Description=KVM Backup Manager - Agent
After=network.target

[Service]
Type=simple
User=backup
WorkingDirectory=/opt/backup-manager/agent-backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start services:
```bash
sudo systemctl daemon-reload
sudo systemctl enable backup-controller backup-agent
sudo systemctl start backup-controller backup-agent
```

### Option 3: Nginx Reverse Proxy

**Nginx Configuration** (`/etc/nginx/sites-available/backup-manager`):
```nginx
# Frontend
server {
    listen 80;
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    root /opt/backup-manager/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Controller Backend API
    location /api-backup/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /socket.io/ {
        proxy_pass http://localhost:3000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/backup-manager /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 📖 Usage

### 🔐 First-Time Login (Default Credentials)

When the controller starts for the first time, it auto-creates a default admin
user. Use these credentials to log in:

| Field    | Value      |
|----------|------------|
| Username | `admin`    |
| Password | `admin123` |

> **⚠️ SECURITY: Change the password immediately after your first login.**
> Go to **Settings → Users & Access**, click **Edit** on the admin user, set a
> new strong password, and save. The default credentials are publicly known
> and must not be left active in any environment that's reachable from the
> internet or any untrusted network.

The default admin user has:
- Role: **admin** (full access to everything)
- Access grants: implicit all-hosts (admins always have full access)
- Status: active

After the first password change, the credentials are persisted in
`controller-backend/data/users.json` (bcrypt-hashed). To create additional
users with limited roles, see [Settings → Users & Access](#-rbac--access-control)
once logged in.

### Initial Setup

1. **Access Web UI**: Navigate to `https://your-domain.com`

2. **Login**: Use the default credentials above (`admin` / `admin123`).
   **Change the password before doing anything else.**

3. **Add Backup Host**:
   - Go to **Infrastructure → Backup Hosts** → **Add Backup Host**
   - Enter agent URL: `http://agent-server-ip:3001`
   - System will verify connection

4. **Add Hypervisor**:
   - Go to **Backup Hosts** → Select host → **Add Hypervisor**
   - Enter hypervisor IP and credentials
   - System will fetch VM list

5. **Configure Storage Pool**:
   - Go to **Storage Pools** → **Add Storage Pool**
   - Enter path and configure settings

6. **Create Backup Schedule**:
   - Go to **Schedules** → **Create Schedule**
   - Select VM, storage pool, and schedule type
   - Configure backup options

### Backup Types

#### Daily Backup
- Runs at specified time every day
- 1 full backup + N incremental backups
- Automatic retention management

#### Weekly Backup
- Runs on selected days of week
- One day for full backup, others incremental
- Flexible day selection

#### Monthly Backup
- Runs on 1st of each month
- No conflicts with other schedules
- Long-term retention

#### Custom Days
- Select specific dates on calendar
- First date is always full backup
- Perfect for one-time or irregular schedules

#### Interval
- Runs every N hours or days
- Continuous backup protection
- Configurable incremental count

#### Once
- One-time backup at specified time
- No conflicts with other schedules
- Automatically disabled after execution

### Manual Backup

1. Go to **Backup Management**
2. Click **Trigger Backup**
3. Select VM, method (full/incremental), and options
4. Click **Start Backup**
5. Monitor progress in **Active Backups**

### Restore VM

1. Go to **Backup Management**
2. Find VM in backup list
3. Click **Restore**
4. Select restore storage pool
5. Click **Start Restore**
6. Monitor progress in **Active Restores**

### View Logs

- **Live Logs**: Click **View Logs** on active job
- **Historical Logs**: Click **View Logs** on completed job
- **Download Logs**: Click download icon in log viewer

## 📚 API Documentation

### Authentication

All API requests require authentication:

```bash
# Login
curl -X POST https://your-domain.com/api-backup/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Response
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {"username":"admin","role":"admin"}
}

# Use token in subsequent requests
curl -X GET https://your-domain.com/api-backup/backups/jobs \
  -H "Authorization: Bearer <token>"
```

### Key Endpoints

#### Backup Management
- `POST /api/backups/trigger` - Trigger manual backup
- `GET /api/backups/jobs` - List all backup jobs
- `GET /api/backups/jobs/active` - List active backups
- `DELETE /api/backups/jobs/:id/force` - Force remove job

#### Schedule Management
- `GET /api/schedules` - List all schedules
- `POST /api/schedules` - Create schedule
- `PUT /api/schedules/:id` - Update schedule
- `DELETE /api/schedules/:id` - Delete schedule

#### Storage Pools
- `GET /api/storage-pools` - List storage pools
- `POST /api/storage-pools` - Create storage pool
- `PUT /api/storage-pools/:id` - Update storage pool

#### Metrics
- `GET /api/metrics/backup-hosts` - Get backup host metrics
- `GET /api/metrics/hypervisors` - Get hypervisor metrics
- `GET /api/metrics/offsite/all` - Get offsite host metrics

## 🔧 Troubleshooting

### Common Issues

#### 1. Agent Connection Failed

**Symptom**: "Agent is offline" or connection timeout

**Solutions**:
```bash
# Check agent is running
pm2 status backup-agent

# Check agent logs
pm2 logs backup-agent

# Verify network connectivity
curl http://agent-ip:3001/api/health

# Check firewall
sudo ufw allow 3001/tcp
```

#### 2. SSH Connection Failed

**Symptom**: "SSH connection failed to hypervisor"

**Solutions**:
```bash
# Test SSH connection
ssh root@hypervisor-ip "virsh list"

# Check SSH keys
ls -la ~/.ssh/id_rsa*

# Re-copy SSH key
ssh-copy-id root@hypervisor-ip
```

#### 3. Backup Stuck at 0%

**Symptom**: Job shows "Initializing..." for >30 minutes

**Solutions**:
- Restart controller backend (automatic recovery will mark as failed)
- Check agent logs for errors
- Verify virtnbdbackup is installed: `virtnbdbackup -V`
- Check VM is accessible: `virsh list --all`

#### 4. JWT Authentication Failed

**Symptom**: "Invalid authentication token" or 401 errors

**Solutions**:
```bash
# Verify secrets match
grep AGENT_JWT_SECRET controller-backend/.env
grep AGENT_JWT_SECRET agent-backend/.env

# Regenerate secrets
./generate-jwt-secrets.sh

# Update .env files and restart services
pm2 restart all
```

#### 5. Storage Pool Not Found

**Symptom**: "Storage pool path not accessible"

**Solutions**:
```bash
# Check path exists
ls -la /opt/kvm_pool/backup

# Check permissions
sudo chown -R backup:backup /opt/kvm_pool

# Check disk space
df -h /opt/kvm_pool
```

### Debug Mode

Enable debug logging:

```bash
# Controller
NODE_ENV=development DEBUG=* pm2 start server.js --name backup-controller

# Agent
NODE_ENV=development DEBUG=* pm2 start server.js --name backup-agent
```

### Log Locations

- **Controller Logs**: `controller-backend/data/logs/`
- **Agent Logs**: `agent-backend/logs/`
- **Backup Logs**: `<backup-path>/.logs/`
- **PM2 Logs**: `~/.pm2/logs/`

## 🤝 Contributing

We welcome contributions from the community! Whether it's bug fixes, new features, documentation improvements, or suggestions, your help is appreciated.

### How to Contribute

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes** and test thoroughly
4. **Commit your changes**: `git commit -m 'feat: Add amazing feature'`
5. **Push to the branch**: `git push origin feature/amazing-feature`
6. **Open a Pull Request**

Please read our [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines on:
- Code of conduct
- Development setup
- Coding standards
- Commit message format
- Pull request process
- Testing guidelines

### Areas We Need Help With

- 🐛 Bug fixes and issue resolution
- ✨ New features and enhancements
- 📚 Documentation improvements
- 🧪 Test coverage expansion
- 🌍 Internationalization (i18n)
- 🎨 UI/UX improvements
- 🔒 Security enhancements

### Development Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Lint code
npm run lint
```

### Contributors

Thank you to all the people who have contributed to this project!

<!-- Contributors will be automatically added here -->


## 👨‍💻 Author

**Mohammad Amin Hashemi**

- 📧 Email: [aminhashemiwin10@gmail.com](mailto:aminhashemiwin10@gmail.com)
- 💼 LinkedIn: [linkedin.com/in/amin-hashemi-2955061bb](https://www.linkedin.com/in/amin-hashemi-2955061bb)
- 🐙 GitHub: [@aminhashemi1994](https://github.com/aminhashemi1994)

*I'm passionate about virtualization, backup solutions, and open-source software. Feel free to reach out if you have questions, suggestions, need help with deployment, or want to collaborate on improving this project!*

### Get in Touch

- **Questions?** Open a [GitHub Discussion](https://github.com/aminhashemi1994/kvm-backup-manager/discussions)
- **Found a bug?** Report it in [GitHub Issues](https://github.com/aminhashemi1994/kvm-backup-manager/issues)
- **Want to contribute?** Check out [CONTRIBUTING.md](CONTRIBUTING.md)
- **Need support?** Email me at aminhashemiwin10@gmail.com

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

**Open Source & Community Driven**: This is an open-source project and contributions from the community are welcome and encouraged. You are free to use, modify, improve, and distribute this software under the terms of the MIT License.

Copyright © 2024-2026 Mohammad Amin Hashemi

## 🙏 Acknowledgments

This project builds upon and integrates several excellent open-source technologies:

### Core Technologies

- **[virtnbdbackup](https://github.com/abbbi/virtnbdbackup)** by [@abbbi](https://github.com/abbbi) - The backbone of our backup functionality. An outstanding open-source incremental backup solution for KVM/QEMU virtual machines using NBD protocol. This project would not be possible without virtnbdbackup's robust and efficient backup engine.
  - \`virtnbdbackup\` - Backup utility for creating full and incremental backups
  - \`virtnbdrestore\` - Restore utility for recovering VMs from backups
  - Learn more: [virtnbdbackup documentation](https://github.com/abbbi/virtnbdbackup)

### Infrastructure & Virtualization

- **[libvirt](https://libvirt.org/)** - Virtualization API and management toolkit
- **[QEMU/KVM](https://www.qemu.org/)** - Open-source machine emulator and virtualizer
- **[libnbd](https://gitlab.com/nbdkit/libnbd)** - NBD client library
- **[nbdkit](https://gitlab.com/nbdkit/nbdkit)** - NBD server with plugin support

### Backend Technologies

- **[Node.js](https://nodejs.org/)** - JavaScript runtime for backend services
- **[Express.js](https://expressjs.com/)** - Fast, minimalist web framework
- **[Socket.IO](https://socket.io/)** - Real-time bidirectional event-based communication
- **[node-cron](https://github.com/node-cron/node-cron)** - Task scheduler for Node.js
- **[node-ssh](https://github.com/steelbrain/node-ssh)** - SSH2 client for Node.js

### Frontend Technologies

- **[React](https://reactjs.org/)** - JavaScript library for building user interfaces
- **[TypeScript](https://www.typescriptlang.org/)** - Typed superset of JavaScript
- **[Vite](https://vitejs.dev/)** - Next-generation frontend build tool
- **[TanStack Query](https://tanstack.com/query)** - Powerful data synchronization for React
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[Recharts](https://recharts.org/)** - Composable charting library for React

### Development & Deployment

- **[PM2](https://pm2.keymetrics.io/)** - Production process manager for Node.js
- **[Nginx](https://nginx.org/)** - High-performance HTTP server and reverse proxy
- **[tmux](https://github.com/tmux/tmux)** - Terminal multiplexer for managing backup sessions

### Special Thanks

- **[@abbbi](https://github.com/abbbi)** - For creating and maintaining virtnbdbackup, the core technology that powers this backup solution
- **The KVM/QEMU Community** - For building robust virtualization infrastructure
- **The libvirt Team** - For providing excellent virtualization management APIs
- **All Contributors** - Everyone who has contributed code, documentation, bug reports, and suggestions

### Community & Support

This project is built for the KVM and open-source virtualization community. We believe in:
- 🌍 Open collaboration
- 📖 Transparent development
- 🤝 Community-driven improvements
- 💡 Knowledge sharing

## 📞 Support & Community

### Get Help

- 📧 **Email**: [aminhashemiwin10@gmail.com](mailto:aminhashemiwin10@gmail.com)
- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/aminhashemi1994/kvm-backup-manager/issues)
- 💬 **Discussions**: [GitHub Discussions](https://github.com/aminhashemi1994/kvm-backup-manager/discussions)
- 📚 **Documentation**: [Project Wiki](https://github.com/aminhashemi1994/kvm-backup-manager/wiki)
- 💼 **LinkedIn**: [Connect with me](https://www.linkedin.com/in/amin-hashemi-2955061bb)

### Reporting Issues

When reporting issues, please include:
- Your environment (OS, Node.js version, virtnbdbackup version)
- Steps to reproduce the problem
- Expected vs actual behavior
- Relevant log files

### Feature Requests

Have an idea for improvement? We'd love to hear it! Open a discussion or issue with:
- Clear description of the feature
- Use case and benefits
- Any implementation ideas

## 🗺️ Roadmap

Future enhancements planned for this project:

- [ ] **Backup Encryption** - AES-256 encryption for backup files
- [ ] **Multi-tenancy Support** - Multiple organizations/teams
- [ ] **Cloud Storage Integration** - S3, Azure Blob, Google Cloud Storage
- [ ] **Backup Deduplication** - Reduce storage requirements
- [ ] **Advanced Reporting** - Detailed analytics and insights
- [ ] **Mobile App** - iOS and Android management apps
- [ ] **Kubernetes Deployment** - Helm charts and operators
- [ ] **Automated Verification** - Scheduled backup integrity checks
- [ ] **Disaster Recovery Planning** - DR workflow automation
- [ ] **Backup Replication** - Multi-site backup replication
- [ ] **API Webhooks** - Event-driven integrations
- [ ] **LDAP/AD Integration** - Enterprise authentication

## 🌟 Star History

If you find this project useful, please consider giving it a star on GitHub! It helps others discover the project and motivates continued development.

## 📈 SEO Keywords

KVM backup solution, QEMU virtual machine backup, libvirt backup tool, incremental VM backup, Linux virtualization backup, automated backup system, disaster recovery KVM, VM restore tool, open source backup manager, enterprise backup solution, virtnbdbackup GUI, KVM backup scheduler, virtual machine management, backup automation, NBD backup protocol, live VM backup, snapshot backup alternative, backup retention management, offsite backup replication, centralized backup management

---

**Made with ❤️ for the KVM and open-source virtualization community**

*Powered by [virtnbdbackup](https://github.com/abbbi/virtnbdbackup) | Built by [Mohammad Amin Hashemi](https://www.linkedin.com/in/amin-hashemi-2955061bb)*
