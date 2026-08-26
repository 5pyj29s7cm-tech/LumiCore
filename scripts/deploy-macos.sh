#!/usr/bin/env bash
# LumiCore macOS Deployment
# Usage: ./scripts/deploy-macos.sh [install_dir]
# Default: /Applications/LumiCore.app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${1:-/Applications/LumiCore.app}"

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
  echo -e "${RED}ERROR: Node.js not found. Install: brew install node${NC}"
  exit 1
fi
echo -e "${GREEN}  Node.js $(node --version)${NC}"

if ! command -v rustc &>/dev/null; then
  echo -e "${RED}ERROR: Rust not found. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh${NC}"
  exit 1
fi
echo -e "${GREEN}  Rust $(rustc --version)${NC}"

if ! command -v xcodebuild &>/dev/null; then
  echo -e "${YELLOW}  WARNING: Xcode CLI tools not found. Run: xcode-select --install${NC}"
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

# Download stand-alone Node.js binary for embedding
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
if [ -d "$DIST_SERVER" ]; then
  sudo cp -R "$DIST_SERVER"/* "$INSTALL_DIR/dist-server/"
fi
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

# Create a .app-like launcher in /Applications that the user can pin to Dock
DESKTOP_DIR="$HOME/Desktop"
LAUNCHER="$DESKTOP_DIR/LumiCore.command"
cat > "$LAUNCHER" << LAUNCHEREOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/lumi-core" &
LAUNCHEREOF
chmod +x "$LAUNCHER"
echo -e "${GREEN}  Desktop launcher: ${LAUNCHER}${NC}"

echo ""
echo -e "${CYAN}============================================"
echo -e "  Deployment complete!"
echo -e "  Data: ~/LumiCore/data/"
echo -e "  App:  ${INSTALL_DIR}/"
echo -e "  Desktop launcher ready."
echo -e "============================================${NC}"
