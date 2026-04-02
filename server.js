import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { DOMParser } from "@xmldom/xmldom";

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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ------------------------------------------------------------
// Hjelper: søk i Stortingets åpne API (ingen nøkkel nødvendig)
// ------------------------------------------------------------
async function sokStortinget(nokkelord) {
  const sesjoner = ["2023-2024", "2022-2023", "2021-2022"];
  let resultater = [];

  for (const sesjon of sesjoner) {
    try {
      const url = `https://data.stortinget.no/eksport/saker?sesjonid=${sesjon}&emne=${encodeURIComponent(nokkelord)}&format=json`;
      const res = await axios.get(url, { timeout: 8000 });
      const saker = res.data?.saker_liste?.sak_liste || [];
      saker.forEach(s => {
        if (s.tittel) {
          resultater.push({
            tittel: s.tittel,
            sesjon,
            status: s.status || "",
            type: s.type || "",
            id: s.id || "",
            url: `https://stortinget.no/no/Saker-og-publikasjoner/Saker/Sak/?p=${s.id}`,
          });
        }
      });
    } catch (e) {
      // prøv neste sesjon
    }
    if (resultater.length >= 6) break;
  }

  // Fallback: søk bredt i nyeste sesjon og filtrer selv
  if (resultater.length === 0) {
    try {
      const url = `https://data.stortinget.no/eksport/saker?sesjonid=2023-2024&format=json`;
      const res = await axios.get(url, { timeout: 10000 });
      const saker = res.data?.saker_liste?.sak_liste || [];
      const kw = nokkelord.toLowerCase();
      saker.filter(s =>
        s.tittel && s.tittel.toLowerCase().includes(kw)
      ).slice(0, 6).forEach(s => {
        resultater.push({
          tittel: s.tittel,
          sesjon: "2023-2024",
          status: s.status || "",
          type: s.type || "",
          id: s.id || "",
          url: `https://stortinget.no/no/Saker-og-publikasjoner/Saker/Sak/?p=${s.id}`,
        });
      });
    } catch (e) {}
  }

  return resultater.slice(0, 5);
}

// ------------------------------------------------------------
// Hjelper: Claude AI-kall
// ------------------------------------------------------------
async function kallClaude(system, bruker, maxTokens = 300) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: bruker }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.content[0].text.trim();
}

// ------------------------------------------------------------
// POST /api/spor
// ------------------------------------------------------------
app.post("/api/spor", async (req, res) => {
  const { sporsmal } = req.body;
  if (!sporsmal || sporsmal.trim().length < 3) {
    return res.status(400).json({ feil: "Spørsmål mangler eller er for kort." });
  }

  try {
    // Steg 1: Claude trekker ut nøkkelord
    const nokkelord = await kallClaude(
      "Du er en juridisk assistent. Trekk ut 1-2 norske juridiske nøkkelord fra spørsmålet egnet for søk. Svar kun med nøkkelordene adskilt med komma, ingen annen tekst.",
      sporsmal,
      100
    );

    // Steg 2: Søk i Stortingets API
    const saker = await sokStortinget(nokkelord.split(",")[0].trim());

    // Steg 3: Claude forklarer basert på saker
    const kontekst = saker.length > 0
      ? saker.map(s => `- ${s.tittel} (${s.sesjon}, status: ${s.status})`).join("\n")
      : "Ingen direkte saker funnet i Stortingets database.";

    const raaRespons = await kallClaude(
      `Du er en hjelpsom norsk juridisk assistent for privatpersoner.
Bruk informasjonen fra Stortingets saksregister til å forklare relevant lovgivning på enkelt norsk.
Avslutt alltid med: "Dette er generell informasjon. Kontakt advokat for konkret rådgivning."
Svar på norsk bokmål.

Etter selve svaret, legg til en linje som starter med PARAGRAFER: og list opp konkrete paragrafhenvisninger i dette formatet:
PARAGRAFER: lovnavn|paragraf|lovdata-id, lovnavn|paragraf|lovdata-id

Eksempel:
PARAGRAFER: Arbeidsmiljøloven|§ 15-8|lov/2005-06-17-62/%C2%A715-8, Husleieloven|§ 9-5|lov/1999-03-26-17/%C2%A79-5

Hvis ingen konkrete paragrafer er aktuelle, skriv:
PARAGRAFER: ingen`,
      `Spørsmål: ${sporsmal}\n\nRelevante saker fra Stortinget:\n${kontekst}`,
      1000
    );

    // Splitt svar og paragraflinjen
    const paragraflinje = raaRespons.match(/PARAGRAFER:\s*(.+)/)?.[1]?.trim() || "";
    const svar = raaRespons.replace(/PARAGRAFER:.*$/s, "").trim();

    // Parse paragrafene til strukturert data med Lovdata-lenker
    const paragrafer = paragraflinje === "ingen" || !paragraflinje
      ? []
      : paragraflinje.split(",").map(p => {
          const deler = p.trim().split("|");
          if (deler.length < 3) return null;
          const [lovnavn, paragraf, lovdataId] = deler.map(d => d.trim());
          return {
            lovnavn,
            paragraf,
            url: `https://lovdata.no/dokument/${lovdataId}`,
          };
        }).filter(Boolean);

    return res.json({ svar, nokkelord, saker, paragrafer });

  } catch (err) {
    console.error("Feil:", err.response?.data || err.message);
    return res.status(500).json({ feil: "Noe gikk galt.", detaljer: err.message });
  }
});

// ------------------------------------------------------------
// GET /api/sok?q=arbeidsmiljø
// ------------------------------------------------------------
app.get("/api/sok", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ feil: "Søkeord mangler." });
  try {
    const saker = await sokStortinget(q);
    return res.json({ saker });
  } catch (err) {
    return res.status(500).json({ feil: "Søk feilet.", detaljer: err.message });
  }
});

// ------------------------------------------------------------
// Helsesjekk
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", melding: "Lovassistent API kjører (Stortinget + Claude)" });
});

app.listen(PORT, () => {
  console.log(`Lovassistent backend kjører på http://localhost:${PORT}`);
});
