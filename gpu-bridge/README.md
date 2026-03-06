# GPU Bridge

System tray app for Windows that monitors Ollama GPU and Tailscale connectivity for the VPS GPU bridge.

## Quick Start

```powershell
# Install dependencies
npm install

# Run directly
npm start

# Build to single .exe
npm run build
# Output: dist/gpu-bridge.exe
```

## Prerequisites

1. **Ollama** installed and running with `OLLAMA_HOST=0.0.0.0:11434`
2. **Tailscale** connected to the homelab tailnet
3. **Node.js 18+** (for development) or the built .exe

## Auto-Start on Boot

### Option A: Startup Folder
1. Press `Win+R`, type `shell:startup`, press Enter
2. Create a shortcut to `gpu-bridge.exe` in that folder

### Option B: Registry (PowerShell)
```powershell
New-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" `
  -Name "GPUBridge" -Value "C:\path\to\gpu-bridge.exe"
```

## Tray Icons

- **Green**: Tailscale connected + Ollama healthy
- **Yellow**: Tailscale connected but Ollama not responding
- **Red**: Tailscale disconnected

## Status Page

Click the tray icon or visit `http://localhost:19876` for the dashboard showing:
- Tailscale connection status and IP
- Ollama health and loaded models
- GPU info (temperature, utilization, VRAM)
- Uptime stats
