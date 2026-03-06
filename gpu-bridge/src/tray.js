/**
 * System Tray — Icon and menu using systray2
 */

const SysTray = require('systray2').default;
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let systray = null;

// Load icon as base64
function loadIcon(name) {
  const iconPath = path.join(__dirname, '..', 'assets', `icon-${name}.ico`);
  try {
    return fs.readFileSync(iconPath).toString('base64');
  } catch (e) {
    // Return empty string if icon file not found (will use default)
    return '';
  }
}

const icons = {
  green: loadIcon('green'),
  yellow: loadIcon('yellow'),
  red: loadIcon('red')
};

const tooltips = {
  green: 'GPU Bridge: Connected & Healthy',
  yellow: 'GPU Bridge: Tailscale OK, Ollama Issue',
  red: 'GPU Bridge: Disconnected'
};

function createTray() {
  systray = new SysTray({
    menu: {
      icon: icons.red || '',
      title: '',
      tooltip: tooltips.red,
      items: [
        {
          title: 'Status Page',
          tooltip: 'Open status dashboard in browser',
          enabled: true
        },
        {
          title: 'Restart Ollama',
          tooltip: 'Restart the local Ollama service',
          enabled: true
        },
        SysTray.separator,
        {
          title: 'Quit',
          tooltip: 'Exit GPU Bridge',
          enabled: true
        }
      ]
    },
    debug: false,
    copyDir: true
  });

  systray.onClick(action => {
    switch (action.seq_id) {
      case 0: // Status Page
        exec('start http://localhost:19876');
        break;
      case 1: // Restart Ollama
        console.log('[GPU Bridge] Restarting Ollama...');
        exec('taskkill /F /IM ollama.exe & timeout /t 2 & ollama serve', (err) => {
          if (err) console.error('[GPU Bridge] Ollama restart error:', err.message);
          else console.log('[GPU Bridge] Ollama restart initiated');
        });
        break;
      case 3: // Quit
        systray.kill(false);
        process.exit(0);
        break;
    }
  });

  return systray;
}

function updateTrayIcon(state) {
  if (!systray) return;
  systray.sendAction({
    type: 'update-menu',
    menu: {
      icon: icons[state] || icons.red,
      title: '',
      tooltip: tooltips[state] || tooltips.red
    }
  });
}

module.exports = { createTray, updateTrayIcon };
