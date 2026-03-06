/**
 * Build script — Bundle GPU Bridge into a single .exe using pkg
 *
 * Usage: npm run build
 * Output: dist/gpu-bridge.exe
 *
 * To add to Windows Startup:
 *   1. Press Win+R, type: shell:startup
 *   2. Create a shortcut to dist/gpu-bridge.exe
 *
 * Or via registry (PowerShell as admin):
 *   New-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "GPUBridge" -Value "C:\path\to\gpu-bridge.exe"
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('Building GPU Bridge...');
try {
  execSync('npx pkg . --targets node18-win-x64 --output dist/gpu-bridge.exe', {
    cwd: path.join(__dirname),
    stdio: 'inherit'
  });
  console.log('\nBuild complete: dist/gpu-bridge.exe');
} catch (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
}
