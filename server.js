import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { createWriteStream, mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { createBrotliDecompress } from "zlib";
import { DOMParser } from "@xmldom/xmldom";
import tar from "tar";

dotenv.config();

const execAsync = promisify(exec);
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
const LOVDATA_DIR = "/tmp/lovdata";
const LOVDATA_URL = "https://api.lovdata.no/v1/publicData/get/gjeldende-lover.tar.bz2";

// ------------------------------------------------------------
// In-memory indeks over lovtekster
// { "arveloven": { tittel, paragrafId, lovId, tekst }[] }
// ------------------------------------------------------------
let lovIndeks = {};
let indeksKlar = false;
let indeksStatus = "ikke startet";

// ------------------------------------------------------------
// Last ned og pakk ut Lovdata-datasett
// ------------------------------------------------------------
async function lastNedLovdata() {
  try {
    indeksStatus = "laster ned lover fra Lovdata...";
    console.log(indeksStatus);

    mkdirSync(LOVDATA_DIR, { recursive: true });
    const tarPath = join(LOVDATA_DIR, "gjeldende-lover.tar.bz2");
    const utpakketDir = join(LOVDATA_DIR, "lover");

    // Last ned tar.bz2
    const respons = await axios.get(LOVDATA_URL, { responseType: "stream", timeout: 60000 });
    await pipeline(respons.data, createWriteStream(tarPath));
    console.log("Nedlasting ferdig, pakker ut...");

    indeksStatus = "pakker ut lovfiler...";
    mkdirSync(utpakketDir, { recursive: true });
    await tar.x({ file: tarPath, cwd: utpakketDir, brotli: false });
    console.log("Utpakking ferdig, bygger indeks...");

    indeksStatus = "bygger søkeindeks...";
    await byggIndeks(utpakketDir);

    indeksKlar = true;
    indeksStatus = `klar – ${Object.keys(lovIndeks).length} lover indeksert`;
    console.log(indeksStatus);
  } catch (err) {
    indeksStatus = "feil: " + err.message;
    console.error("Lovdata-feil:", err.message);
  }
}

// ------------------------------------------------------------
// Bygg søkeindeks fra XML-filer
// ------------------------------------------------------------
async function byggIndeks(dir) {
  const filer = await finnXmlFiler(dir);
  const parser = new DOMParser();

  for (const fil of filer.slice(0, 2000)) {
    try {
      const innhold = await readFile(fil, "utf-8");
      const doc = parser.parseFromString(innhold, "text/xml");

      // Hent lovtittel
      const tittelNode = doc.getElementsByTagName("kortTittel")[0]
        || doc.getElementsByTagName("tittel")[0];
      const tittel = tittelNode?.textContent?.trim() || "";
      if (!tittel) continue;

      const lovId = hentLovId(fil);
      const nokkel = tittel.toLowerCase();

      if (!lovIndeks[nokkel]) lovIndeks[nokkel] = { tittel, lovId, paragrafer: [] };

      // Hent paragrafer
      const paragrafNoder = doc.getElementsByTagName("paragraf");
      for (let i = 0; i < paragrafNoder.length; i++) {
        const node = paragrafNoder[i];
        const nr = node.getAttribute("id") || node.getElementsByTagName("nr")?.[0]?.textContent || "";
        const tekst = node.textContent?.replace(/\s+/g, " ").trim().slice(0, 500) || "";
        if (nr && tekst) {
          lovIndeks[nokkel].paragrafer.push({ nr, tekst });
        }
      }
    } catch (e) {
      // hopp over feil
    }
  }
}

async function finnXmlFiler(dir) {
  const filer = [];
  async function scan(d) {
    try {
      const { readdir } = await import("fs/promises");
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = join(d, e.name);
        if (e.isDirectory()) await scan(full);
        else if (e.name.endsWith(".xml")) filer.push(full);
      }
    } catch(e) {}
  }
  await scan(dir);
  return filer;
}

function hentLovId(filsti) {
  const match = filsti.match(/([A-Z]{2}-\d{4}-\d{2}-\d{2}-\d+)/);
  if (!match) return "";
  const deler = match[1].split("-");
  return `lov/${deler[1]}-${deler[2]}-${deler[3]}-${deler[4]}`;
}

// ------------------------------------------------------------
// Søk i lokal indeks
// ------------------------------------------------------------
function sokILovIndeks(nokkelord) {
  const kw = nokkelord.toLowerCase();
  const treff = [];

  for (const [nokkel, lov] of Object.entries(lovIndeks)) {
    if (nokkel.includes(kw) || kw.includes(nokkel.split(" ")[0])) {
      treff.push(lov);
      if (treff.length >= 3) break;
    }
  }
  return treff;
}

// ------------------------------------------------------------
// Søk i Stortingets API (fallback)
// ------------------------------------------------------------
async function sokStortinget(nokkelord) {
  const sesjoner = ["2023-2024", "2022-2023"];
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
            url: `https://stortinget.no/no/Saker-og-publikasjoner/Saker/Sak/?p=${s.id}`,
          });
        }
      });
    } catch (e) {}
    if (resultater.length >= 5) break;
  }
  return resultater.slice(0, 5);
}

// ------------------------------------------------------------
// Claude AI-kall
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
      "Du er en juridisk assistent. Trekk ut 1-2 norske juridiske nøkkelord fra spørsmålet egnet for søk i lovregister. Svar kun med nøkkelordene adskilt med komma, ingen annen tekst.",
      sporsmal,
      100
    );

    const hovedNokkel = nokkelord.split(",")[0].trim();

    // Steg 2a: Søk i Lovdata-indeks (hvis klar)
    const lovtreff = indeksKlar ? sokILovIndeks(hovedNokkel) : [];

    // Steg 2b: Søk i Stortingets API parallelt
    const saker = await sokStortinget(hovedNokkel);

    // Bygg kontekst fra begge kilder
    let kontekst = "";

    if (lovtreff.length > 0) {
      kontekst += "LOVTEKSTER FRA LOVDATA:\n";
      lovtreff.forEach(lov => {
        kontekst += `\n### ${lov.tittel} (${lov.lovId})\n`;
        lov.paragrafer.slice(0, 5).forEach(p => {
          kontekst += `${p.nr}: ${p.tekst}\n`;
        });
      });
    }

    if (saker.length > 0) {
      kontekst += "\nRELATERTE STORTINGSSAKER:\n";
      kontekst += saker.map(s => `- ${s.tittel} (${s.sesjon})`).join("\n");
    }

    if (!kontekst) kontekst = "Ingen direkte treff funnet.";

    // Steg 3: Claude forklarer
    const raaRespons = await kallClaude(
      `Du er en hjelpsom norsk juridisk assistent for privatpersoner.
${lovtreff.length > 0 ? "Du har tilgang til faktiske lovtekster fra Lovdata – bruk disse aktivt i svaret." : "Bruk din kunnskap om norsk lovgivning."}
Forklar relevant lovgivning på enkelt, forståelig norsk.
Avslutt alltid med: "Dette er generell informasjon. Kontakt advokat for konkret rådgivning."
Svar på norsk bokmål.

VIKTIG – bruk alltid oppdaterte paragrafnumre:
- Arveloven 2019 (lov/2019-06-14-21): § 2 barn arver likt, § 3 ektefelle, § 4 representasjonsarv, § 6 rekkefølge
- Arbeidsmiljøloven (lov/2005-06-17-62)
- Husleieloven (lov/1999-03-26-17)
- Forbrukerkjøpsloven (lov/2002-06-21-34)

Etter svaret, legg til:
PARAGRAFER: lovnavn|paragraf|lovdata-id/%C2%A7nummer, ...
Eks: PARAGRAFER: Arveloven|§ 4|lov/2019-06-14-21/%C2%A74
Hvis ingen: PARAGRAFER: ingen`,
      `Spørsmål: ${sporsmal}\n\n${kontekst}`,
      1200
    );

    const paragraflinje = raaRespons.match(/PARAGRAFER:\s*(.+)/)?.[1]?.trim() || "";
    const svar = raaRespons.replace(/PARAGRAFER:.*$/s, "").trim();

    const paragrafer = paragraflinje === "ingen" || !paragraflinje
      ? []
      : paragraflinje.split(",").map(p => {
          const deler = p.trim().split("|");
          if (deler.length < 3) return null;
          const [lovnavn, paragraf, lovdataId] = deler.map(d => d.trim());
          return { lovnavn, paragraf, url: `https://lovdata.no/dokument/${lovdataId}` };
        }).filter(Boolean);

    return res.json({ svar, nokkelord, saker, paragrafer, lovdataKlar: indeksKlar });

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
    const lover = indeksKlar ? sokILovIndeks(q) : [];
    return res.json({ saker, lover, indeksKlar });
  } catch (err) {
    return res.status(500).json({ feil: "Søk feilet.", detaljer: err.message });
  }
});

// ------------------------------------------------------------
// GET /api/status – sjekk indeksstatus
// ------------------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({
    indeksKlar,
    indeksStatus,
    antallLover: Object.keys(lovIndeks).length,
  });
});

// ------------------------------------------------------------
// Helsesjekk
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    melding: "Lovassistent API kjører (Lovdata + Stortinget + Claude)",
    lovdata: indeksStatus,
  });
});

// ------------------------------------------------------------
// Start server og last ned Lovdata i bakgrunnen
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server kjører på port ${PORT}`);
  lastNedLovdata(); // starter i bakgrunnen, blokkerer ikke
});
