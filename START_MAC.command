#!/bin/zsh
clear
cd "$(dirname "$0")"
echo "=============================================="
echo " Radar Editorial extern - pornire Mac"
echo "=============================================="
echo "Folder: $(pwd)"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nu este instalat sau nu este găsit în PATH."
  echo "Instalează Node.js LTS de pe https://nodejs.org/en/download sau cu Homebrew: brew install node"
  echo "După instalare, închide și redeschide Terminalul, apoi pornește din nou acest fișier."
  echo ""
  read "?Apasă Enter ca să închizi..."
  exit 1
fi

NODE_VERSION=$(node -v)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
echo "Node detectat: $NODE_VERSION"

if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Ai nevoie de Node.js 18 sau mai nou. Instalează varianta LTS de pe nodejs.org."
  read "?Apasă Enter ca să închizi..."
  exit 1
fi

PORT_VALUE=${PORT:-8787}
if [ -f .env ]; then
  ENV_PORT=$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- | tr -d '"')
  if [ -n "$ENV_PORT" ]; then
    PORT_VALUE=$ENV_PORT
  fi
fi

echo "Deschid browserul la http://localhost:$PORT_VALUE"
open "http://localhost:$PORT_VALUE" >/dev/null 2>&1 &
echo ""
echo "Serverul pornește acum. Ține această fereastră deschisă cât folosești dashboardul."
echo "Ca să oprești aplicația: apasă Control + C sau închide această fereastră."
echo ""
node server.js

echo ""
read "?Server oprit. Apasă Enter ca să închizi..."
