# Radar Editorial PRO FINAL FINAL

## Noutăți

- Interval de scanare selectabil:
  - 0–60 minute
  - 0–120 minute
  - 0–3 ore
  - 0–4 ore
  - 0–6 ore
  - 0–8 ore
  - 0–12 ore
  - 0–24 ore
- După ce apeși **Pornește Refresh live**, aplicația face refresh automat la fiecare 3 minute.
- Rezultatele deja apărute rămân în listă între refreshuri, dar sunt eliminate automat când ies din intervalul ales.
- Subiectele noi cu recomandarea **scrie acum** declanșează alertă sonoră și notificare de browser, dacă permisiunea este acordată.
- Backendul primește intervalul prin `/api/radar?maxAge=...` și filtrează strict sursele după acel interval.

## Pornire

```bash
cd ~/Downloads/radar-editorial-pro-v3/radar-editorial-pro
npm install
node server.js
```

Apoi deschide:

```text
http://localhost:8787
```

## Folosire

1. Alege intervalul din **Interval scanare**.
2. Apasă **Pornește Refresh live**.
3. Acceptă notificările, dacă browserul cere permisiune.
4. Lasă tabul și Terminalul deschise.

Notă: browserele pot întârzia temporizatoarele în taburi inactive, dar aplicația verifică și la revenirea în tab/focus dacă a ratat un refresh.
