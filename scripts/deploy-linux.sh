#!/usr/bin/env bash
# LumiCore Linux Deployment
# Usage: ./scripts/deploy-linux.sh [install_dir]
# Default: /opt/lumi-core

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${1:-/opt/lumi-core}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

echo -e "${CYAN}============================================"
echo -e "  LumiCore Deployment"
echo -e "  Install: ${INSTALL_DIR}"
echo -e "============================================${NC}"

# ── Prerequisites ──────────────────────────────────────────────────────
echo -e "${YELLOW}[1/6] Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}ERROR: Node.js not found. Install from https://nodejs.org${NC}"
  exit 1
fi
echo -e "${GREEN}  Node.js $(node --version)${NC}"

if ! command -v rustc &>/dev/null; then
  echo -e "${RED}ERROR: Rust not found. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh${NC}"
  exit 1
fi
echo -e "${GREEN}  Rust $(rustc --version)${NC}"

# Check WebKit2GTK (required by Tauri on Linux)
if ! dpkg -l libwebkit2gtk-4.1-dev &>/dev/null && ! rpm -q webkit2gtk4.1-devel &>/dev/null; then
  echo -e "${YELLOW}  WARNING: libwebkit2gtk-4.1 not found. Install:"
  echo -e "    Ubuntu/Debian: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev"
  echo -e "    Fedora:        sudo dnf install webkit2gtk4.1-devel gtk3-devel"
  echo -e "    Arch:          sudo pacman -S webkit2gtk-4.1 gtk3${NC}"
fi

if ! command -v gcc &>/dev/null; then
  echo -e "${RED}ERROR: build-essential not found (gcc required for sqlite3).${NC}"
  exit 1
fi

# ── Install dependencies ──────────────────────────────────────────────
echo -e "${YELLOW}[2/6] Installing npm dependencies...${NC}"
cd "$PROJECT_DIR"
npm install
echo -e "${GREEN}  Done.${NC}"

# ── Build ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[3/6] Building frontend + backend...${NC}"

echo -e "${GRAY}  Building frontend...${NC}"
npm run build
echo -e "${GRAY}  Building backend...${NC}"
npm run build:server
echo -e "${GRAY}  Downloading Node.js runtime...${NC}"
node scripts/download-node-binary.mjs
echo -e "${GRAY}  Preparing desktop resources...${NC}"
npm run prepare:desktop
echo -e "${GREEN}  Done.${NC}"

# ── Compile Rust ──────────────────────────────────────────────────────
echo -e "${YELLOW}[4/6] Compiling desktop shell (Rust)... this may take a few minutes${NC}"
cd "$PROJECT_DIR/src-tauri"
cargo build --release
cd "$PROJECT_DIR"
echo -e "${GREEN}  Done.${NC}"

# ── Install ───────────────────────────────────────────────────────────
echo -e "${YELLOW}[5/6] Installing to ${INSTALL_DIR}...${NC}"

sudo mkdir -p "$INSTALL_DIR"

BINARY="$PROJECT_DIR/src-tauri/target/release/lumi-core"
if [ ! -f "$BINARY" ]; then
  echo -e "${RED}ERROR: lumi-core binary not found at ${BINARY}${NC}"
  exit 1
fi
sudo cp "$BINARY" "$INSTALL_DIR/lumi-core"
sudo chmod +x "$INSTALL_DIR/lumi-core"
echo -e "${GRAY}  lumi-core${NC}"

# Copy dist-server (Node.js backend)
DIST_SERVER="$PROJECT_DIR/desktop-resources/dist-server"
sudo cp -R "$DIST_SERVER"/* "$INSTALL_DIR/dist-server/" 2>/dev/null || true
# Ensure node binary is executable
sudo chmod -R +x "$INSTALL_DIR/dist-server/"
echo -e "${GRAY}  dist-server/${NC}"

# Copy GPT-SoVITS (optional)
TTS_DIR="$PROJECT_DIR/desktop-resources/gpt-sovits-src"
if [ -d "$TTS_DIR" ] && ls "$TTS_DIR"/*.py &>/dev/null 2>&1; then
  sudo cp -R "$TTS_DIR" "$INSTALL_DIR/gpt-sovits-src/"
  echo -e "${GRAY}  gpt-sovits-src/ (local TTS)${NC}"
fi

echo -e "${GREEN}  Installed.${NC}"

# ── Desktop shortcut ──────────────────────────────────────────────────
echo -e "${YELLOW}[6/6] Creating desktop shortcut...${NC}"

DESKTOP_ENTRY="$HOME/.local/share/applications/lumi-core.desktop"
mkdir -p "$(dirname "$DESKTOP_ENTRY")"
cat > "$DESKTOP_ENTRY" << DESKTOPEOF
[Desktop Entry]
Type=Application
Name=LumiCore
Comment=Personal AI Operating System
Exec=$INSTALL_DIR/lumi-core
Icon=$INSTALL_DIR/lumi-core
Terminal=false
Categories=Utility;
StartupWMClass=lumi-core
DESKTOPEOF

# Also copy to desktop
cp "$DESKTOP_ENTRY" "$HOME/Desktop/lumi-core.desktop" 2>/dev/null || true
chmod +x "$HOME/Desktop/lumi-core.desktop" 2>/dev/null || true

echo -e "${GREEN}  Desktop entry: ${DESKTOP_ENTRY}${NC}"

echo ""
echo -e "${CYAN}============================================"
echo -e "  Deployment complete!"
echo -e "  Data: ~/LumiCore/data/"
echo -e "  App:  ${INSTALL_DIR}/"
echo -e "  Desktop shortcut ready."
echo -e "============================================${NC}"
