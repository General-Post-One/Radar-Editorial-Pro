# Radar Editorial extern — pași rapizi pe Mac

## 1. Ce este Node.js 18+

Node.js este programul care pornește micul server local al aplicației. „18+” înseamnă orice versiune Node.js cu număr principal 18 sau mai mare: 18, 20, 22, 24 etc. Pentru Mac, instalează varianta LTS.

## 2. Verifică dacă ai Node.js

Deschide Terminal și scrie:

```bash
node -v
```

Dacă primești ceva de tipul `v20...`, `v22...` sau `v24...`, ești ok.

Verifică și npm:

```bash
npm -v
```

## 3. Dacă nu ai Node.js

Varianta simplă:

1. Intră pe `https://nodejs.org/en/download`.
2. Descarcă varianta LTS pentru macOS.
3. Instalează pachetul `.pkg`.
4. Închide și redeschide Terminalul.
5. Rulează din nou `node -v`.

Varianta cu Homebrew, dacă ai Homebrew:

```bash
brew install node
```

## 4. Pornește aplicația corect

Nu deschide `public/index.html` direct cu Chrome, pentru că intră în demo mode.

În schimb, intră în folderul proiectului și pornește serverul:

```bash
cd ~/Downloads/radar-editorial-extern-mac
node server.js
```

Apoi deschide:

```text
http://localhost:8787
```

Sau dublu-click pe:

```text
START_MAC.command
```

Ține fereastra Terminal deschisă cât folosești dashboardul.

## 5. Setare gratuită Google Trends

Aplicația merge și fără API plătit, folosind Google News RSS și fallback Google Trends RSS. Pentru rezultate mai bune:

1. Intră pe Google Trends > Trending Now.
2. Alege România.
3. Alege filtrare recentă, de exemplu ultimele 4 ore, dacă este disponibilă.
4. Apasă Export > RSS feed.
5. Copiază linkul RSS.
6. Rulează `SETARE_GOOGLE_TRENDS_GRATIS.command` și lipește linkul.
7. Pornește din nou `START_MAC.command`.

## 6. Ce înseamnă „gratis” pentru volume

Gratis, nu ai de obicei volume exacte de căutări. Ai semnale:

- Google Trends: interes relativ / trend / creștere;
- Google Trends RSS: uneori oferă trafic aproximativ sau semnale de trend;
- Google News RSS: recență, număr de surse, intensitate media;
- scanare publică oficiuldestiri.ro: duplicate / posibil duplicate;
- scor intern de prioritate.

Pentru volum estimativ exact se folosesc API-uri SEO plătite sau Google Keyword Planner, care poate fi gratuit cu cont Google Ads, dar uneori arată intervale largi dacă nu ai campanii active.

## 7. Când știi că merge live

Sus în pagină nu trebuie să mai apară mesajul:

`Mod demo: backendul nu răspunde`

Trebuie să vezi:

`Scanare externă: Fluxurile au fost citite...`

Și adresa din Chrome trebuie să fie:

`http://localhost:8787`

nu `file:///Users/.../public/index.html`.
