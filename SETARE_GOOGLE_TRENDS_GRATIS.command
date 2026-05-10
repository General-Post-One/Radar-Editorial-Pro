#!/bin/zsh
clear
cd "$(dirname "$0")"
echo "=================================================="
echo " Setare gratuită Google Trends RSS"
echo "=================================================="
echo "1) Deschide Google Trends > Trending Now."
echo "2) Alege România, eventual Past 4 hours / active trends only."
echo "3) Apasă Export > RSS feed."
echo "4) Copiază URL-ul RSS și lipește-l aici."
echo ""
read "RSS_URL?Lipește URL RSS Google Trends, apoi Enter: "

if [ -z "$RSS_URL" ]; then
  echo "Nu ai introdus niciun URL. Nu modific nimic."
  read "?Apasă Enter ca să închizi..."
  exit 1
fi

cat > .env <<EOF2
PORT=8787
OFICIU_BASE=https://oficiuldestiri.ro
MAX_AGE_MINUTES=120
MAX_TOPICS=24
CACHE_TTL_MS=480000
REQUEST_TIMEOUT_MS=9000
GOOGLE_TRENDS_RSS_URLS=$RSS_URL
EOF2

echo ""
echo "Gata. Am creat/actualizat fișierul .env cu RSS-ul Google Trends."
echo "Acum pornește START_MAC.command."
echo ""
read "?Apasă Enter ca să închizi..."
