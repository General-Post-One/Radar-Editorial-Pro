# Radar Editorial extern – Oficiul de Știri

Dashboard extern pentru redacție. Nu se instalează pe WordPress, nu cere pluginuri și nu are nevoie de acces de admin. Rulează separat, pe laptop, VPS, Replit, Render, Railway sau alt hosting Node.js.

## Ce face

- adună subiecte recente din fluxuri publice: Google Trends RSS, dacă setezi URL-ul RSS, și Google News RSS România;
- filtrează subiectele apărute sau detectate în ultimele maximum 120 minute;
- clasifică subiectele pe rubrici/interese editoriale;
- calculează scor de prioritate editorială;
- scanează public `oficiuldestiri.ro` ca să evite subiectele deja abordate;
- afișează status anti-duplicare: `Neacoperit`, `Posibil acoperit`, `Deja acoperit`;
- generează brief editorial și titluri SEO;
- exportă CSV.

## De ce are backend

Un fișier HTML deschis direct în browser nu poate citi fiabil Google News, Google Trends sau oficiuldestiri.ro din cauza regulilor CORS și a protecțiilor anti-bot. De aceea, proiectul include un `server.js` simplu, fără framework și fără dependențe externe, care face requesturile server-side și trimite datele către dashboard.

## Cum rulezi local

Ai nevoie de Node.js 18+.

```bash
cd radar-editorial-extern
node server.js
```

Deschide în browser:

```text
http://localhost:8787
```

## Configurare opțională

Copiază `.env.example` în `.env` dacă folosești un tool care încarcă variabile de mediu sau setează variabilele direct în hosting.

```bash
PORT=8787
OFICIU_BASE=https://oficiuldestiri.ro
MAX_AGE_MINUTES=120
MAX_TOPICS=24
```

### Google Trends RSS

Intră în Google Trends > Trending Now > România > Export > RSS feed, copiază URL-ul și setează:

```bash
GOOGLE_TRENDS_RSS_URLS="URL_RSS_DE_LA_GOOGLE_TRENDS"
```

Dacă nu setezi acest URL, aplicația folosește fallbackul public:

```text
https://trends.google.com/trends/trendingsearches/daily/rss?geo=RO
```

Pentru regula de 2 ore, cele mai bune rezultate vin din Trending Now / RSS, nu din API-ul istoric.

## Cum scanează oficiuldestiri.ro fără acces WordPress admin

Aplicația încearcă, în ordine:

1. `https://oficiuldestiri.ro/wp-json/wp/v2/posts?search=...`
2. `https://oficiuldestiri.ro/wp-json/wp/v2/search?search=...`
3. search public: `https://oficiuldestiri.ro/?s=...`
4. sitemapuri publice: `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, `/post-sitemap.xml`
5. opțional Google CSE sau SerpAPI cu query `site:oficiuldestiri.ro subiect`

Dacă una dintre metode este blocată, dashboardul continuă cu celelalte și afișează erorile în API.

## Algoritm anti-duplicare

Pentru fiecare subiect:

- extrage tokenuri relevante din titlu, keyworduri și entități;
- caută public pe Oficiu cu 3–4 query-uri;
- calculează similaritatea Jaccard între subiect și rezultatele găsite;
- praguri:
  - `>= 68%`: Deja acoperit;
  - `38–67%`: Posibil acoperit;
  - `< 38%`: Neacoperit.

Dashboardul ascunde implicit duplicatele.

## Scor editorial

```text
Scor = 35% scor interes/search heat
      + 20% recență
      + 15% relevanță România
      + 15% lipsă acoperire Oficiu
      + 10% potențial SEO
      + 5% impact editorial
```

## Reguli hard

Subiectul este blocat dacă:

- este mai vechi de 120 minute;
- este deja acoperit pe oficiuldestiri.ro;
- nu are minimum două surse sau o sursă oficială;
- are interes estimat prea scăzut.

## Limite importante

- Google Trends nu este volum exact de căutări; feedurile pot da semnale/volum aproximativ, iar scorul intern normalizează datele.
- Pentru volum estimat real trebuie conectat un API SEO: Google Keyword Planner, DataForSEO, Ahrefs, Semrush, SerpAPI/SearchAPI etc.
- Dacă oficiuldestiri.ro blochează unele requesturi automate, folosește fallbackurile sitemap/search sau un API `site:` cu cheie.
- Nu publica automat. Dashboardul oferă briefuri și prioritizare, dar verificarea editorială rămâne obligatorie.

## Structură

```text
radar-editorial-extern/
├── server.js
├── .env.example
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Versiunea 2 recomandată

- integrare cu DataForSEO pentru volum estimat de căutări;
- coadă editorială: redactor, status, deadline;
- salvare permanentă în SQLite/PostgreSQL;
- alertă pe Slack/Teams când apare un subiect neacoperit cu scor peste 85;
- semantic embeddings pentru anti-duplicare mai bună;
- raport zilnic cu subiecte ratate și concurenții care le-au publicat primii.
