# ReadNext Sync Server

Sync your articles between the ReadNext Android app and browser extension.

## What This Does

This server stores your saved articles so you can access them from any device. Think of it like your personal Pocket or Instapaper backend.

---

## Option 1: Run on Your Computer (Local)

Best for: Personal use on your home network

### Steps

1. **Download and install**
   ```bash
   git clone https://github.com/yourname/readnext-server
   cd readnext-server
   npm install
   ```

2. **Start the server**
   ```bash
   node server.js
   ```
   You'll see: `Server running on http://localhost:3000`

3. **Find your computer's IP address**
   - Windows: Open CMD, type `ipconfig`, look for "IPv4 Address"
   - Mac/Linux: Open Terminal, type `hostname -I` or `ifconfig`
   - Example: `192.168.1.105`

4. **Connect your apps**
   - In ReadNext app/extension, enter: `http://192.168.1.105:3000`
   - Your phone must be on the same WiFi network!

> ⚠️ **Important**: The file `db.json` stores your articles. It's in `.gitignore` - never upload it to GitHub!

### Run as a Background Service (Linux)

To keep the server running after you close the terminal:

1. **Create a systemd service file**
   ```bash
   sudo nano /etc/systemd/system/readnext.service
   ```

2. **Paste this (edit the paths for your setup):**
   ```ini
   [Unit]
   Description=ReadNext Sync Server
   After=network.target

   [Service]
   Type=simple
   User=YOUR_USERNAME
   WorkingDirectory=/home/YOUR_USERNAME/readnext-server
   ExecStart=/usr/bin/node server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```
   Replace `YOUR_USERNAME` with your Linux username.

3. **Enable and start**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable readnext
   sudo systemctl start readnext
   ```

4. **Check status**
   ```bash
   sudo systemctl status readnext
   ```

Now the server starts automatically on boot!

---

## Option 2: Deploy Online (Render + MongoDB Atlas)

Best for: Access from anywhere, syncing across networks

### Step 1: Create a Free MongoDB Database

1. Go to [mongodb.com/atlas](https://www.mongodb.com/atlas) and sign up (free tier available)
2. Click "Create Cluster" → Choose the **FREE** tier
3. Select a region close to you
4. Wait ~3 minutes for cluster creation
5. Click "Database Access" → Add a user with username/password
6. Click "Network Access" → Add `0.0.0.0/0` (allow all IPs)
7. Click "Connect" → "Connect your application"
8. Copy the connection string, it looks like:
   ```
   mongodb+srv://myuser:mypassword@cluster0.abc123.mongodb.net/readnext
   ```
   Replace `myuser` and `mypassword` with your credentials.

### Step 2: Deploy to Render

1. Go to [render.com](https://render.com) and sign up (free tier available)
2. Click "New" → "Web Service"
3. Connect your GitHub repo containing this server
4. Configure:
   - **Name**: `readnext-sync`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Add Environment Variable:
   - Key: `MONGODB_URI`
   - Value: (paste your MongoDB connection string from Step 1)
6. Click "Create Web Service"
7. Wait for deploy, then copy your URL like: `https://readnext-sync.onrender.com`

### Step 3: Connect Your Apps

In ReadNext app/extension sync settings, enter your Render URL:
```
https://readnext-sync.onrender.com
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't connect from phone | Use computer's IP, not `localhost`. Check firewall. |
| "Network error" on phone | Ensure phone and computer on same WiFi |
| Sync incomplete | Tap "Reset Sync Pointers" in app, then sync again |
| Render deploy failed | Check build logs. Ensure `MONGODB_URI` is set |

---

## Need Help?

Open an issue on GitHub or check the ReadNext app documentation.
