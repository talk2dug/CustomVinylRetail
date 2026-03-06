# GPU Bridge — Gaming Laptop Setup Guide

Complete setup to turn your gaming laptop into a GPU inference server for the VPS.

---

## What This Does

Your VPS runs Ollama on CPU (slow). This routes those requests to your gaming laptop's GPU over Tailscale (fast). When the laptop is off or disconnected, the VPS automatically falls back to its local CPU — no downtime.

---

## Step 1: Install Ollama

1. **Download** the Windows installer:
   - https://ollama.com/download/windows
   - Run the installer, follow prompts

2. **Set Ollama to listen on all interfaces** (required for Tailscale access):

   Open **PowerShell as Administrator** and run:
   ```powershell
   [System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "Machine")
   ```

3. **Restart Ollama**:
   - Right-click the Ollama icon in the system tray → Quit
   - Reopen Ollama from the Start menu
   - Or just restart your PC

4. **Pull the model**:
   ```powershell
   ollama pull llama3.1:8b
   ```
   This downloads ~4.7GB. Wait for it to complete.

5. **Verify GPU acceleration**:
   ```powershell
   ollama run llama3.1:8b "Say hello in exactly 5 words"
   ```
   - If GPU is working: response in **1-3 seconds**
   - If CPU only: response in **30+ seconds**

   You can also check the Ollama log for `using CUDA` or `using GPU`.

---

## Step 2: Install Tailscale

1. **Download** the Windows installer:
   - https://tailscale.com/download/windows
   - Run the installer, follow prompts

2. **Get a preauth key** from the VPS (run this on the Pi or any machine with SSH access):
   ```bash
   ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 \
     "sudo headscale preauthkeys create --user 1 --reusable --expiration 24h"
   ```
   Copy the key that's printed (starts with a long string of characters).

3. **Join the tailnet** — Open **PowerShell as Administrator** on the laptop:
   ```powershell
   tailscale up --login-server https://blueridgecustomco.com --authkey YOUR_KEY_HERE --hostname gaming-laptop
   ```
   Replace `YOUR_KEY_HERE` with the key from step 2.

4. **Verify the connection**:
   ```powershell
   tailscale status
   ```
   You should see your laptop and `vinylapp` in the list. Note your laptop's IP (e.g., `100.64.0.13`).

5. **Test from VPS** (run on Pi or SSH):
   ```bash
   ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 \
     "curl -s http://YOUR_LAPTOP_IP:11434/api/tags"
   ```
   Replace `YOUR_LAPTOP_IP` with the Tailscale IP from step 4. Should return a JSON list of models.

---

## Step 3: Activate GPU Bridge on VPS

Run these commands from the Pi (or any machine with SSH to the VPS):

```bash
# Set the laptop's Tailscale IP (replace 100.64.0.13 with your actual IP)
ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 \
  "cd /home/ubuntu/vinylApp && sed -i 's/^GPU_BRIDGE_HOST=.*/GPU_BRIDGE_HOST=100.64.0.13/' .env"

# Restart the app
ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 \
  "cd /home/ubuntu/vinylApp && pm2 restart save-design-server --update-env"

# Verify it's working
ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 \
  "curl -s http://localhost:4000/api/internal/gpu-bridge/status | python3 -m json.tool"
```

You should see:
```json
{
  "configured": true,
  "remote": {
    "host": "100.64.0.13",
    "healthy": true
  }
}
```

---

## Step 4: GPU Bridge Tray App (Optional)

The tray app monitors Ollama + Tailscale health and shows a colored icon in your system tray.

### Option A: Run from source
```powershell
cd gpu-bridge
npm install
npm start
```

### Option B: Build standalone .exe
```powershell
cd gpu-bridge
npm install
npm run build
```
Output: `dist/gpu-bridge.exe` (~50MB standalone, no Node.js required)

### Auto-start on Windows boot
1. Press `Win+R`, type `shell:startup`, press Enter
2. Right-click in the folder → New → Shortcut
3. Point it to `gpu-bridge.exe` (or `node C:\path\to\gpu-bridge\src\index.js`)

### Tray icon colors
- **Green**: Tailscale connected + Ollama healthy
- **Yellow**: Tailscale up, Ollama not responding
- **Red**: Tailscale disconnected

### Status dashboard
Click the tray icon or open http://localhost:19876 to see:
- GPU temperature, VRAM usage, utilization
- Tailscale connection status and peers
- Loaded Ollama models

---

## Troubleshooting

### Ollama not using GPU
```powershell
# Check if CUDA is available
nvidia-smi
# Should show your RTX GPU. If not, update NVIDIA drivers.

# Check Ollama logs
# Look in %LOCALAPPDATA%\Ollama\logs\
```

### Tailscale won't connect
```powershell
# Check status
tailscale status

# If it shows "Stopped", start it:
tailscale up --login-server https://blueridgecustomco.com

# If the authkey expired, generate a new one (see Step 2)
```

### VPS can't reach laptop
```bash
# From VPS, ping the laptop
ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 "ping -c 3 YOUR_LAPTOP_IP"

# If ping works but curl fails, check Ollama is listening:
# On laptop:
netstat -an | findstr 11434
# Should show 0.0.0.0:11434 LISTENING
```

### VPS shows "configured: true" but "healthy: false"
- Make sure the laptop is on and not sleeping
- Check Windows Firewall isn't blocking port 11434
- Run: `ollama list` on the laptop to verify Ollama is running

### Windows Firewall
If Tailscale can reach the laptop but Ollama requests fail, add a firewall rule:
```powershell
# PowerShell as Admin
New-NetFirewallRule -DisplayName "Ollama Tailscale" -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress 100.64.0.0/10 -Action Allow
```

---

## Model Upgrades

Once the base setup works with `llama3.1:8b`, try larger models for better quality:

| Model | VRAM | Quality | Command |
|-------|------|---------|---------|
| `llama3.1:8b` | ~5GB | Baseline (current) | Already installed |
| `qwen2.5:14b` | ~8GB | Noticeably better | `ollama pull qwen2.5:14b` |
| `mistral-nemo:12b` | ~7GB | Better reasoning | `ollama pull mistral-nemo:12b` |

After pulling a new model, update the VPS:
```bash
ssh -i ~/.ssh/server.pem ubuntu@208.113.130.237 \
  "cd /home/ubuntu/vinylApp && sed -i 's/^GPU_BRIDGE_MODEL=.*/GPU_BRIDGE_MODEL=qwen2.5:14b/' .env && pm2 restart save-design-server --update-env"
```

The VPS will use the new model on the GPU and still fall back to `llama3.1:8b` locally if the laptop is offline.
