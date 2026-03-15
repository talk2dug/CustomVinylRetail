#!/bin/bash
# ============================================================================
# Print Station — Build & Deploy Update
# Builds a Windows zip update and deploys to the update server
# Usage: ./deploy-update.sh [patch|minor|major]
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

UPDATE_DIR="/mnt/usrdata/print-station-updates"
BUMP_TYPE="${1:-patch}"

echo "=========================================="
echo "  Print Station — Build & Deploy"
echo "=========================================="

# 1. Bump version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [patch|minor|major]"; exit 1 ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

# Update package.json version
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Version bumped to $NEW_VERSION"

# 2. Clean old build
rm -rf dist/

# 3. Build Windows zip (no Wine needed with signAndEditExecutable=false)
echo ""
echo "Building Windows zip..."
npx electron-builder --win zip --publish never --config.win.signAndEditExecutable=false 2>&1

ZIP_FILE="dist/Vinyl Print Station-${NEW_VERSION}-win.zip"
if [ ! -f "$ZIP_FILE" ]; then
  echo "ERROR: Build failed — zip not found: $ZIP_FILE"
  exit 1
fi

ZIP_SIZE=$(stat -c%s "$ZIP_FILE")
echo "Build complete: $(du -h "$ZIP_FILE" | cut -f1)"

# 4. Generate latest.yml
SHA512=$(sha512sum "$ZIP_FILE" | awk '{print $1}' | xxd -r -p | base64 -w 0)
RELEASE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
ZIP_FILENAME="Vinyl Print Station-${NEW_VERSION}-win.zip"

cat > dist/latest.yml << YAML
version: ${NEW_VERSION}
files:
  - url: ${ZIP_FILENAME}
    sha512: ${SHA512}
    size: ${ZIP_SIZE}
path: ${ZIP_FILENAME}
sha512: ${SHA512}
releaseDate: '${RELEASE_DATE}'
YAML

echo ""
echo "Generated latest.yml:"
cat dist/latest.yml

# 5. Deploy to update server directory
echo ""
echo "Deploying to $UPDATE_DIR..."
mkdir -p "$UPDATE_DIR"

# Remove old files
rm -f "$UPDATE_DIR"/Vinyl\ Print\ Station-*-win.zip
rm -f "$UPDATE_DIR"/Vinyl\ Print\ Station\ Setup\ *.exe

# Copy new files
cp "$ZIP_FILE" "$UPDATE_DIR/"
cp dist/latest.yml "$UPDATE_DIR/"

echo ""
echo "=========================================="
echo "  Deployed v${NEW_VERSION}"
echo "=========================================="
echo ""
echo "Files in update directory:"
ls -lh "$UPDATE_DIR/"
echo ""
echo "Clients will pick up the update within 4 hours"
echo "(or immediately via Settings > Check for Updates)"
echo ""
echo "Test URL: https://blueridgecustomco.com/updates/print-station/latest.yml"
