# Radar Editorial Oficiul – build redacție

Această versiune integrează regulile editoriale pentru Oficiul de Știri și contactele încărcate din fișierul Excel.

## Noutăți

- Buton **Brief Oficiul** pe fiecare subiect.
- Buton **SEO complet** cu focus keyword, slug, meta, taguri max 4, categorii și H2-uri.
- Buton **Contacte + drafturi**.
- Contacte din fișierul local `contacts-deputati.json` generat din Excelul încărcat.
- Căutare suplimentară de emailuri/telefoane publice în paginile surselor listate pe subiect.
- Drafturi de email personalizate per contact, cu 5 întrebări adaptate pe competența persoanei/instituției.
- Reguli de stil Oficiul: ce s-a întâmplat, de ce contează, cine e afectat, ce urmează.

## Pornire

```bash
cd ~/Downloads/radar-editorial-oficiul-redactie-final
npm install
node server.js
```

Deschide apoi:

```text
http://localhost:8787/?oficiu=redactie
```

## Important

Contactele din Excel sunt folosite local pe calculator. Softul nu trimite emailuri automat. Drafturile pot fi copiate sau deschise cu mailto dacă există adresă email publică.

Telefonul este afișat doar dacă vine din lista încărcată sau dacă este găsit explicit pe o pagină publică.
