# Radar Editorial Oficiul V4 Functional

Build funcțional, pornit din varianta care mergea deja local, cu modulele V4 integrate în interfață.

## Ce include

- Interval scanare: 0–60 min, 0–120 min, 0–3h, 0–4h, 0–6h, 0–8h, 0–12h, 0–24h.
- Auto-refresh la 3 minute după apăsarea butonului.
- Păstrează subiectele între refreshuri cât timp sunt în interval.
- Alertă sonoră pentru subiecte cu recomandarea „scrie acum”.
- Brief Oficiul.
- SEO complet.
- Contacte + drafturi email personalizate.
- Linkuri + poze legale.
- Draft copy-paste local.
- Prompt articol GPT complet, pentru folosit în ChatGPT Pro.
- Regula: exact 2 linkuri externe + exact 2 linkuri interne, ancorate pe expresii relevante.

## Pornire pe Mac

Oprește versiunea veche cu CONTROL + C.

```bash
cd ~/Downloads/radar-editorial-oficiul-v4-functional
npm install
node server.js
```

Apoi deschide:

```text
http://localhost:8787/?v4=1
```

Dacă pagina pare veche, apasă:

```text
CMD + SHIFT + R
```

## Notă

ChatGPT Pro nu se integrează ca API gratuit. Butonul „Prompt articol GPT” copiază promptul complet, iar tu îl lipești în ChatGPT Pro.
