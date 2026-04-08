# LiveViewRT — IT Deployment Guide

## Overview
This is a Node.js web application with a SQLite database.
It runs as a single process on a Windows or Linux server and is accessed by any browser on the network.

No external internet connectivity is required at runtime.

---

## Requirements

- **Node.js** v18 or later (LTS recommended)
  Download: https://nodejs.org/en/download
- **~50 MB disk space** for the application
- **Port access**: default port 3000 (configurable)

---

## Installation (Windows Server)

### 1. Install Node.js
Download and run the Node.js LTS installer from https://nodejs.org
Accept all defaults. Verify installation:
```
node --version
npm --version
```

### 2. Copy the application
Copy the `rtdashboard` folder to a permanent location, e.g.:
```
C:\Apps\rtdashboard\
```

### 3. Install dependencies
Open a Command Prompt as Administrator, navigate to the folder and run:
```
cd C:\Apps\rtdashboard
npm install
```
This installs Express, better-sqlite3, and ws. All packages are local — no internet required after this step.

### 4. Test the application
```
node server.js
```
You should see:
```
RT Dashboard running on port 3000
```
Open a browser and go to http://localhost:3000 to verify it works.
Press Ctrl+C to stop.

### 5. Install as a Windows Service (so it runs automatically)

Install the `node-windows` package globally:
```
npm install -g node-windows
npm link node-windows
```

Create a file called `install-service.js` in the rtdashboard folder:
```javascript
const Service = require('node-windows').Service;
const svc = new Service({
  name: 'LiveViewRT',
  description: 'Radiotherapy Machine Management Dashboard',
  script: 'C:\\Apps\\rtdashboard\\server.js',
  env: [{ name: 'PORT', value: '3000' }]
});
svc.on('install', () => svc.start());
svc.install();
```

Then run:
```
node install-service.js
```

The service will now start automatically on boot and restart if it crashes.
To manage it: open Services (services.msc) and look for "RT Dashboard".

---

## Installation (Linux — Ubuntu/Debian)

### 1. Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Copy the application
```bash
sudo mkdir -p /opt/rtdashboard
sudo cp -r /path/to/rtdashboard/* /opt/rtdashboard/
cd /opt/rtdashboard
npm install
```

### 3. Create a systemd service
```bash
sudo nano /etc/systemd/system/rtdashboard.service
```

Paste the following:
```ini
[Unit]
Description=LiveViewRT
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/rtdashboard
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable rtdashboard
sudo systemctl start rtdashboard
sudo systemctl status rtdashboard
```

---

## Network Access

### Firewall (Windows)
Allow inbound traffic on port 3000:
```
netsh advfirewall firewall add rule name="RT Dashboard" dir=in action=allow protocol=TCP localport=3000
```

### DNS / Hostname (optional but recommended)
Ask your network team to create an internal DNS entry, e.g.:
```
rtdashboard.yourtrust.nhs.uk  →  <server IP>:3000
```

Users then access the app at: http://rtdashboard.yourtrust.nhs.uk:3000

### Reverse proxy via IIS or Nginx (optional)
If you want to serve on port 80 without specifying a port number,
you can proxy requests through IIS (using ARR) or Nginx.

Example Nginx config:
```nginx
server {
    listen 80;
    server_name rtdashboard.yourtrust.nhs.uk;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
The `Upgrade` and `Connection` headers are required for WebSocket support.

---

## Configuration

Environment variables (set in the service definition or a `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| PORT     | 3000    | Port to listen on |
| HOST     | 0.0.0.0 | Interface to bind (0.0.0.0 = all) |

---

## Database

The SQLite database is created automatically at first run:
```
rtdashboard/data/rtdashboard.db
```

**Backups**: Simply copy this file. It is a single portable file.
Recommended: include it in your standard server backup schedule.

To restore: stop the service, replace the file, restart the service.

---

## Updating the Application

1. Stop the service
2. Replace application files (do NOT delete the `data/` folder)
3. Run `npm install` again if `package.json` changed
4. Restart the service

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | Change PORT env variable or stop conflicting process |
| Cannot access from other PCs | Check firewall — port 3000 must be open inbound |
| WebSocket not connecting | If behind a reverse proxy, ensure Upgrade headers are forwarded |
| Database locked error | Only one instance of the app should run at a time |
| App crashes on start | Run `node server.js` manually and read the error output |

---

## Security Notes

- This application has no user authentication — it is designed for use on a trusted internal network only
- Do NOT expose this application to the internet
- All actions are logged in the audit trail with IP address
- The database file should be readable only by the service account

---

*LiveViewRT v1.2*
