# Radar Editorial PRO – Oficiul de Știri

Versiune externă, fără pluginuri și fără acces WordPress admin.

## Ce s-a schimbat față de versiunea anterioară

1. **Filtru strict 2 ore**
   - intră doar item-uri RSS cu dată publică clară;
   - orice item peste 120 minute este eliminat înainte de afișare;
   - linkurile nested din Google Trends fără dată sunt ascunse, ca să nu mai deschidă articole vechi.

2. **Scanare mai rapidă**
   - verificarea pe Oficiu folosește implicit modul rapid: WordPress REST public;
   - search intern și sitemap sunt dezactivate implicit pentru viteză;
   - timeout redus la 4,5 secunde;
   - mai multe verificări rulează în paralel.

3. **PRO editorial**
   - detectare entități și termeni de interes: Nicușor Dan, Simion, Ciolacu, ANAF, BNR, ANM, vreme, accidente, pensii, TVA, salarii, facturi etc.;
   - penalizare pentru subiecte internaționale cu relevanță mică pentru România;
   - clasificare pe rubrici;
   - titluri SEO și brief editorial;
   - auto-refresh la 5 minute;
   - alertă sonoră pentru subiecte eligibile cu scor 85+.

## Pornire pe Mac

```bash
cd ~/Downloads/radar-editorial-pro
npm install
node server.js
```

Apoi deschizi în Chrome:

```text
http://localhost:8787
```

Ține Terminalul deschis.

## Configurare RSS Google Trends gratuit

Dacă ai deja `.env`, îl păstrezi. Altfel poți crea/edita `.env` în folder cu:

```env
GOOGLE_TRENDS_RSS_URLS=https://trends.google.com/trending/rss?geo=RO
MAX_AGE_MINUTES=120
FAST_OFICIU_SCAN=1
STRICT_SOURCE_AGE=1
REQUEST_TIMEOUT_MS=4500
CACHE_TTL_MS=300000
```

## Mod ultra-strict

Implicit este deja strict. Dacă vrei să vezi și subiecte blocate pentru audit, bifezi în dashboard:

```text
Arată și subiectele blocate pentru audit
```

## Mod scanare Oficiu mai profundă, dar mai lentă

În `.env` setezi:

```env
FAST_OFICIU_SCAN=0
```

Asta activează și search intern + sitemap, dar va fi mai lent.

## Limitări oneste

Google Trends nu oferă gratis volum exact de căutări. Dashboardul folosește indice/traffic din RSS, numărul de surse, recența și relevanța pentru România.
