[README.md](https://github.com/user-attachments/files/26470412/README.md)
# Norsk Lovassistent

En AI-drevet juridisk assistent som søker i alle gjeldende norske lover og svarer på spørsmål på vanlig norsk.

## Hva er dette?

Norsk Lovassistent er en webapp som lar privatpersoner stille juridiske spørsmål på vanlig norsk og få svar med henvisning til konkrete paragrafer i norsk lovgivning. Appen er tilgjengelig som en PWA (Progressive Web App) som kan legges til på iPhone-hjemskjermen og brukes som en ekte app.

## Arkitektur

```
iPhone (Safari / PWA)
        │
        ▼ POST /api/spor
┌─────────────────────────────┐
│     Railway Backend         │
│     (Node.js / Express)     │
│                             │
│  1. Claude trekker ut       │
│     nøkkelord               │
│           │                 │
│  2. Søker i 764 lover       │
│     (Lovdata-indeks)        │
│           │                 │
│  3. Søker Stortingets API   │
│           │                 │
│  4. Claude forklarer        │
│     på norsk + paragrafer   │
└─────────────────────────────┘
        │
        ▼ JSON-svar
  Viser svar + paragraflenker
  direkte til lovdata.no
```

## Teknologi

| Komponent | Teknologi |
|-----------|-----------|
| Frontend | HTML / CSS / JavaScript (PWA) |
| Backend | Node.js / Express |
| Hosting frontend | Netlify |
| Hosting backend | Railway |
| Lovdatabase | Lovdata åpent API (764 lover) |
| Parlamentsdata | Stortingets åpne API |
| AI | Claude (Anthropic) |

## Live URLer

- **Frontend (app):** https://symphonious-cupcake-20db47.netlify.app
- **Backend (API):** https://lovassistent-backend-production.up.railway.app
- **API status:** https://lovassistent-backend-production.up.railway.app/api/status

## Filstruktur

```
lovassistent-backend/        ← GitHub-repo (deployes til Railway)
├── server.js                ← Hele backend-logikken
├── package.json             ← Node.js avhengigheter
├── nixpacks.toml            ← Railway byggkonfigurasjon
└── .env.example             ← Mal for miljøvariabler

lovassistent-app/
└── index.html               ← Hele frontend-appen (deployes til Netlify)
```

## Slik fungerer backend (server.js)

### Oppstart
Når Railway starter appen:
1. Laster ned `gjeldende-lover.tar.bz2` fra Lovdata
2. Pakker ut alle HTML-filer med `unbzip2-stream` + `tar`
3. Parser hver lovfil med `node-html-parser` og bygger søkeindeks i minnet
4. Etter ~60 sekunder er 764 lover indeksert og klare

### Når brukeren spør
1. **Claude** trekker ut 1-2 juridiske nøkkelord fra spørsmålet
2. **Lovdata-indeksen** søkes for relevante lover og paragrafer
3. **Stortingets API** søkes for relaterte saker
4. **Claude** får lovteksten og forklarer svaret på enkelt norsk
5. Svaret returneres med strukturerte paragraflenker til lovdata.no

### API-endepunkter

```
GET  /                    → Helsesjekk
GET  /api/status          → Indeksstatus og antall lover
POST /api/spor            → Still et spørsmål (hovedendepunkt)
GET  /api/sok?q=arv       → Søk direkte uten AI
GET  /api/debug           → Vis filer i /tmp/lovdata (debug)
```

#### POST /api/spor – eksempel

Request:
```json
{ "sporsmal": "Kan sjefen si meg opp mens jeg er syk?" }
```

Response:
```json
{
  "svar": "Arbeidstaker har et særlig oppsigelsesvern...",
  "nokkelord": "oppsigelse, sykmelding",
  "paragrafer": [
    {
      "lovnavn": "Arbeidsmiljøloven",
      "paragraf": "§ 15-8",
      "url": "https://lovdata.no/lov/2005-06-17-62/§15-8"
    }
  ],
  "lovdataKlar": true
}
```

## Miljøvariabler (Railway)

| Variabel | Beskrivelse |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API-nøkkel fra console.anthropic.com |
| `LOVDATA_API_KEY` | API-nøkkel fra api.lovdata.no (valgfri) |
| `CACHE_BUST` | Endre verdi for å tvinge ny Railway-deployment |
| `PORT` | Settes automatisk av Railway |

## Avhengigheter

```json
{
  "axios": "^1.7.0",
  "cors": "^2.8.5",
  "dotenv": "^16.4.0",
  "express": "^4.19.0",
  "node-html-parser": "^6.1.0",
  "tar": "^6.2.0",
  "unbzip2-stream": "^1.4.3"
}
```

## Slik deployer du endringer

### Backend
1. Rediger `server.js` på github.com
2. Railway oppdager endringen og deployer automatisk
3. Hvis Railway ikke plukker opp: endre verdien på `CACHE_BUST` i Railway Variables

### Frontend
1. Gå til app.netlify.com → siden din → Deploys
2. Dra ny `index.html` inn på siden

## Slik tester du

Helsesjekk i nettleseren:
```
https://lovassistent-backend-production.up.railway.app
```

Indeksstatus:
```
https://lovassistent-backend-production.up.railway.app/api/status
```

Test i nettleserkonsollen (F12):
```javascript
fetch("https://lovassistent-backend-production.up.railway.app/api/spor", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sporsmal: "Kan sjefen si meg opp mens jeg er syk?" })
}).then(r => r.json()).then(d => console.log(d.svar))
```

## Legg til på iPhone-hjemskjermen

1. Åpne appen i **Safari** (ikke Chrome)
2. Trykk på del-ikonet nederst (firkant med pil opp)
3. Velg "Legg til på hjemskjerm"
4. Gi den navnet "Lovassistent" og trykk "Legg til"

## Mulig videreutvikling

- Lovdata Pro API for å vise faktisk paragraftekst direkte i appen
- Søkehistorikk lagret lokalt på telefonen
- Eget domenenavn (f.eks. lovassistent.no)
- Støtte for nynorsk og engelsk
- Varsler ved lovendringer

## Nyttige lenker

- Lovdata åpent API: https://api.lovdata.no
- Stortingets åpne data: https://data.stortinget.no
- Anthropic Claude API: https://docs.anthropic.com
- Railway: https://docs.railway.app
- Netlify: https://docs.netlify.com
