// ============================================================
// Lovassistent Backend – Node.js / Express
// ============================================================
// Krever: Node.js 18+
// Installer: npm install express axios dotenv cors
// Start:     node server.js
// ============================================================

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options("*", cors());

const PORT = process.env.PORT || 3000;
const LOVDATA_API_KEY = process.env.LOVDATA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ------------------------------------------------------------
// Hjelper: kall Lovdata API
// ------------------------------------------------------------
const lovdata = axios.create({
  baseURL: "https://api.lovdata.no",
  headers: {
    "X-API-Key": LOVDATA_API_KEY,
    "Accept": "application/json",
  },
});

// ------------------------------------------------------------
// POST /api/spor
// Tar imot fritekst-spørsmål og returnerer relevante lover
// ------------------------------------------------------------
// Request body: { sporsmal: "Kan arbeidsgiver si meg opp mens jeg er sykemeldt?" }
// Response:     { svar: "...", lover: [...] }
// ------------------------------------------------------------
app.post("/api/spor", async (req, res) => {
  const { sporsmal } = req.body;

  if (!sporsmal || sporsmal.trim().length < 3) {
    return res.status(400).json({ feil: "Spørsmål mangler eller er for kort." });
  }

  try {
    // Steg 1: Bruk Claude til å trekke ut nøkkelord for Lovdata-søk
    const nokkelordSvar = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system:
          "Du er en juridisk assistent. Trekk ut 1-3 norske juridiske nøkkelord fra spørsmålet som er egnet til å søke i Lovdata. Svar kun med nøkkelordene adskilt med komma, ingen annen tekst.",
        messages: [{ role: "user", content: sporsmal }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const nokkelord = nokkelordSvar.data.content[0].text.trim();

    // Steg 2: Søk i Lovdata med nøkkelordene
    const sokResultat = await lovdata.get("/v1/search", {
      params: { q: nokkelord, max: 5 },
    });

    const lover = sokResultat.data.documents || [];

    // Steg 3: Hent lovtekst for de mest relevante treffene (maks 2)
    const lovtekster = await Promise.all(
      lover.slice(0, 2).map(async (lov) => {
        try {
          const detalj = await lovdata.get("/renderRefID", {
            params: { refID: lov.refId },
          });
          return {
            tittel: lov.title,
            refId: lov.refId,
            tekst: detalj.data?.text?.slice(0, 2000) || "", // Begrens lengde
          };
        } catch {
          return { tittel: lov.title, refId: lov.refId, tekst: "" };
        }
      })
    );

    // Steg 4: La Claude forklare svaret basert på lovtekstene
    const kontekst = lovtekster
      .map((l) => `### ${l.tittel} (${l.refId})\n${l.tekst}`)
      .join("\n\n");

    const forklaring = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: `Du er en hjelpsom norsk juridisk assistent for privatpersoner.
Forklar relevante lover på enkelt, forståelig norsk.
Alltid avslutt med: "Dette er generell informasjon. Kontakt advokat for konkret rådgivning."
Svar på norsk bokmål.`,
        messages: [
          {
            role: "user",
            content: `Spørsmål: ${sporsmal}\n\nRelevante lovtekster:\n${kontekst}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    // Steg 5: Returner samlet svar til appen
    return res.json({
      svar: forklaring.data.content[0].text,
      nokkelord,
      lover: lover.map((l) => ({
        tittel: l.title,
        refId: l.refId,
        url: `https://lovdata.no/dokument/${l.refId}`,
      })),
    });
  } catch (err) {
    console.error("Feil:", err.response?.data || err.message);
    return res.status(500).json({
      feil: "Noe gikk galt. Prøv igjen.",
      detaljer: err.message,
    });
  }
});

// ------------------------------------------------------------
// GET /api/lov/:refId
// Henter full lovtekst for en spesifikk lov
// Eksempel: GET /api/lov/lov%2F2005-06-17-62  (arbeidsmiljøloven)
// ------------------------------------------------------------
app.get("/api/lov/:refId", async (req, res) => {
  const refId = decodeURIComponent(req.params.refId);
  try {
    const svar = await lovdata.get("/renderRefID", {
      params: { refID: refId },
    });
    return res.json(svar.data);
  } catch (err) {
    return res.status(500).json({ feil: "Kunne ikke hente lovtekst." });
  }
});

// ------------------------------------------------------------
// GET /api/sok?q=arbeidsmiljø
// Direkte søk i Lovdata uten AI-tolkning
// ------------------------------------------------------------
app.get("/api/sok", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ feil: "Søkeord mangler." });

  try {
    const svar = await lovdata.get("/v1/search", {
      params: { q, max: 10 },
    });
    return res.json(svar.data);
  } catch (err) {
    return res.status(500).json({ feil: "Søk feilet." });
  }
});

// ------------------------------------------------------------
// Helsesjekk
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", melding: "Lovassistent API kjører" });
});

app.listen(PORT, () => {
  console.log(`Lovassistent backend kjører på http://localhost:${PORT}`);
});
