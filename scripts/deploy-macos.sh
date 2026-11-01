#!/usr/bin/env bash
# Development-only unbundled macOS copy; not a signed .app installer.
# Usage: ./scripts/deploy-macos.sh [install_dir]
# Default: /usr/local/lib/lumi-core-dev

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${1:-/usr/local/lib/lumi-core-dev}"
# Never create a flat directory that looks like a valid macOS application bundle.
if [[ "$INSTALL_DIR" =~ \.[aA][pP][pP](/|$) ]]; then
  printf 'Development copy refuses .app paths. Use tauri:build and the signed installer gates for an application bundle.\n' >&2
  exit 1
fi

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

# Copy and verify the backend; any missing file or copy failure stops deployment.
source "$SCRIPT_DIR/lib/deploy-backend.sh"
install_backend_resources "$PROJECT_DIR/desktop-resources/dist-server" "$INSTALL_DIR/dist-server"
echo -e "${GRAY}  dist-server/${NC}"

# Copy GPT-SoVITS (optional)
TTS_DIR="$PROJECT_DIR/desktop-resources/gpt-sovits-src"
if [ -d "$TTS_DIR" ] && ls "$TTS_DIR"/*.py &>/dev/null 2>&1; then
  sudo cp -R "$TTS_DIR" "$INSTALL_DIR/gpt-sovits-src/"
  echo -e "${GRAY}  gpt-sovits-src/ (local TTS)${NC}"
fi

echo -e "${GREEN}  Development files copied; not a signed application bundle.${NC}"

# ── Desktop shortcut ──────────────────────────────────────────────────
echo -e "${YELLOW}[6/6] Creating desktop shortcut...${NC}"

# Create an explicit development command launcher, not a Finder application bundle.
DESKTOP_DIR="$HOME/Desktop"
LAUNCHER="$DESKTOP_DIR/LumiCore-dev.command"
cat > "$LAUNCHER" << LAUNCHEREOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/lumi-core" &
LAUNCHEREOF
chmod +x "$LAUNCHER"
echo -e "${GREEN}  Desktop launcher: ${LAUNCHER}${NC}"

echo ""
echo -e "${CYAN}============================================"
echo -e "  Development copy complete; formal installer checks have not run."
echo -e "  Data: ~/LumiCore/data/"
echo -e "  Development files:  ${INSTALL_DIR}/"
echo -e "  Desktop launcher ready."
echo -e "============================================${NC}"
