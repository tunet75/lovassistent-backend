import express from "express";
import Stripe from "stripe";
import pg from "pg";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { createWriteStream, mkdirSync } from "fs";
import { readFile, mkdir } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { parse as parseHtml } from "node-html-parser";
import tar from "tar";
import unbzip2 from "unbzip2-stream";

dotenv.config();

const execAsync = promisify(exec);

// ------------------------------------------------------------
// PostgreSQL database
// ------------------------------------------------------------
const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function opprettTabeller() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS premium_brukere (
      enhet_id TEXT PRIMARY KEY,
      aktiv BOOLEAN DEFAULT true,
      opprettet TIMESTAMPTZ DEFAULT NOW(),
      stripe_kunde_id TEXT
    )
  `);
  console.log("Database klar");
}

async function erPremiumDB(enhetId) {
  const res = await db.query("SELECT aktiv FROM premium_brukere WHERE enhet_id = $1", [enhetId]);
  return res.rows.length > 0 && res.rows[0].aktiv;
}

async function settPremium(enhetId, aktiv, stripeKundeId = null) {
  await db.query(`
    INSERT INTO premium_brukere (enhet_id, aktiv, stripe_kunde_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (enhet_id) DO UPDATE SET aktiv = $2, stripe_kunde_id = COALESCE($3, premium_brukere.stripe_kunde_id)
  `, [enhetId, aktiv, stripeKundeId]);
}
const app = express();
app.use((req, res, next) => {
  if (req.path === "/api/stripe-webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// Premium-brukere lagret i minnet (enhetId -> true)
const premiumBrukere = new Set();

// ------------------------------------------------------------
// Freemium: spørsmålstelling per enhet per dag
// ------------------------------------------------------------
const GRATIS_GRENSE = 2;
const kvoter = new Map(); // { "enhetId_dato": antall }

function getDatoNokkel(enhetId) {
  const dato = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return `${enhetId}_${dato}`;
}

function sjekkKvote(enhetId) {
  const nokkel = getDatoNokkel(enhetId);
  return kvoter.get(nokkel) || 0;
}

function inkrementerKvote(enhetId) {
  const nokkel = getDatoNokkel(enhetId);
  const antall = (kvoter.get(nokkel) || 0) + 1;
  kvoter.set(nokkel, antall);
  return antall;
}

async function erPremium(enhetId) {
  if (premiumBrukere.has(enhetId)) return true;
  if (process.env[`PREMIUM_${enhetId}`] === "true") return true;
  try {
    return await erPremiumDB(enhetId);
  } catch(e) {
    return false;
  }
}
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

    // Last ned og pakk ut direkte via stream (ingen bzip2 på Railway)
    mkdirSync(utpakketDir, { recursive: true });
    const respons = await axios.get(LOVDATA_URL, { responseType: "stream", timeout: 120000 });

    await new Promise((resolve, reject) => {
      const extract = tar.extract({ cwd: utpakketDir });
      extract.on("finish", resolve);
      extract.on("error", reject);
      respons.data
        .on("error", reject)
        .pipe(unbzip2())
        .on("error", reject)
        .pipe(extract);
    });
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

  for (const fil of filer.slice(0, 2000)) {
    try {
      const innhold = await readFile(fil, "utf-8");
      const doc = parseHtml(innhold);

      // Hent lovtittel fra <title> eller <dd class="titleShort">
      const kortTittelNode = doc.querySelector("dd.titleShort");
      const tittelNode = doc.querySelector("title");
      const tittel = kortTittelNode?.text?.trim() || tittelNode?.text?.trim() || "";
      if (!tittel) continue;

      const lovId = hentLovId(fil);
      const nokkel = tittel.toLowerCase();

      if (!lovIndeks[nokkel]) lovIndeks[nokkel] = { tittel, lovId, paragrafer: [] };

      // Hent paragrafer fra <article class="legalArticle">
      const artikler = doc.querySelectorAll("article.legalArticle");
      for (const artikkel of artikler) {
        // Paragrafnummer fra data-name eller span.legalArticleValue
        const dataNavn = artikkel.getAttribute("data-name") || "";
        const spanVerdi = artikkel.querySelector("span.legalArticleValue");
        const nr = dataNavn || spanVerdi?.text?.trim() || "";

        // Tittel fra span.legalArticleTitle
        const artikkelTittel = artikkel.querySelector("span.legalArticleTitle")?.text?.trim() || "";

        // Tekst fra første ledd
        const leddTekst = artikkel.querySelector("article.legalP, article.numberedLegalP")
          ?.text?.replace(/\s+/g, " ").trim().slice(0, 400) || "";

        if (nr) {
          lovIndeks[nokkel].paragrafer.push({
            nr,
            tittel: artikkelTittel,
            tekst: leddTekst,
          });
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
  // Format: nl-YYYYMMDD-NNN.xml
  const match = filsti.match(/nl-(\d{4})(\d{2})(\d{2})-(\d+)\.xml/);
  if (!match) return "";
  return `lov/${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
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
  const { sporsmal, enhetId } = req.body;
  if (!sporsmal || sporsmal.trim().length < 3) {
    return res.status(400).json({ feil: "Spørsmål mangler eller er for kort." });
  }

  // Sjekk kvote
  const id = enhetId || "anonym";
  if (!await erPremium(id)) {
    const brukt = sjekkKvote(id);
    if (brukt >= GRATIS_GRENSE) {
      return res.status(429).json({
        feil: "kvote_brukt",
        melding: `Du har brukt dine ${GRATIS_GRENSE} gratis spørsmål i dag. Kom tilbake i morgen eller oppgrader til Premium for ubegrenset tilgang.`,
        brukt,
        grense: GRATIS_GRENSE,
      });
    }
    inkrementerKvote(id);
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
          const renUrl = lovdataId.replace(/%C2%A7/g, '§').replace(/%C2%a7/g, '§');
          return { lovnavn, paragraf, url: `https://lovdata.no/${renUrl}` };
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
// Debug – vis innhold i én XML-fil
app.get("/api/debug/xml", async (req, res) => {
  try {
    const fil = "/tmp/lovdata/lover/nl/nl-20190614-021.xml";
    const { readFile } = await import("fs/promises");
    const innhold = await readFile(fil, "utf-8");
    res.send("<pre>" + innhold.slice(0, 3000).replace(/</g, "&lt;") + "</pre>");
  } catch(e) {
    res.json({ feil: e.message });
  }
});

// Debug – vis mappestruktur
app.get("/api/debug", async (req, res) => {
  try {
    const ex = promisify(exec);
    const { stdout } = await ex("find /tmp/lovdata -type f | head -30");
    res.json({ filer: stdout.trim().split("\n") });
  } catch(e) {
    res.json({ feil: e.message });
  }
});

// GET /api/kvote?enhetId=xxx – sjekk gjenværende spørsmål
app.get("/api/kvote", async (req, res) => {
  const enhetId = req.query.enhetId || "anonym";
  const brukt = sjekkKvote(enhetId);
  const premium = await erPremium(enhetId);
  res.json({
    premium,
    brukt,
    grense: GRATIS_GRENSE,
    gjenstaar: premium ? null : Math.max(0, GRATIS_GRENSE - brukt),
  });
});

// POST /api/avslutt-abonnement – kanseller Stripe-abonnement
app.post("/api/avslutt-abonnement", async (req, res) => {
  const { enhetId } = req.body;
  if (!enhetId) return res.status(400).json({ feil: "enhetId mangler" });

  try {
    // Hent stripe_kunde_id fra databasen
    const result = await db.query(
      "SELECT stripe_kunde_id FROM premium_brukere WHERE enhet_id = $1 AND aktiv = true",
      [enhetId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ feil: "Ingen aktivt abonnement funnet." });
    }

    const stripeKundeId = result.rows[0].stripe_kunde_id;

    // Finn aktivt abonnement hos Stripe
    const abonnementer = await stripe.subscriptions.list({
      customer: stripeKundeId,
      status: "active",
      limit: 1,
    });

    if (abonnementer.data.length === 0) {
      // Ikke noe aktivt abonnement i Stripe, oppdater bare databasen
      await settPremium(enhetId, false);
      premiumBrukere.delete(enhetId);
      return res.json({ avsluttet: true, melding: "Abonnement avsluttet." });
    }

    // Kanseller abonnementet ved periodens slutt
    await stripe.subscriptions.update(abonnementer.data[0].id, {
      cancel_at_period_end: true,
    });

    return res.json({
      avsluttet: true,
      melding: "Abonnementet ditt er avsluttet og løper ut ved neste fornyelsesdato.",
    });
  } catch (err) {
    console.error("Avmeldingsfeil:", err.message);
    return res.status(500).json({ feil: "Kunne ikke avslutte abonnement." });
  }
});

// POST /api/opprett-abonnement – lag Stripe Checkout session
app.post("/api/opprett-abonnement", async (req, res) => {
  const { enhetId } = req.body;
  if (!enhetId) return res.status(400).json({ feil: "enhetId mangler" });

  try {
    console.log("STRIPE_PRICE_ID:", STRIPE_PRICE_ID);
    console.log("STRIPE_SECRET_KEY satt:", !!process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `https://symphonious-cupcake-20db47.netlify.app/?premium=true&enhetId=${enhetId}`,
      cancel_url: `https://symphonious-cupcake-20db47.netlify.app/?avbrutt=true`,
      metadata: { enhetId },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe feil:", err.message);
    res.status(500).json({ feil: "Kunne ikke opprette betalingsside." });
  }
});

// POST /api/stripe-webhook – motta betalingsbekreftelse fra Stripe
app.post("/api/stripe-webhook", async (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).json({ feil: "Webhook feil: " + err.message });
  }

  if (event.type === "checkout.session.completed") {
    const enhetId = event.data.object.metadata?.enhetId;
    const stripeKundeId = event.data.object.customer;
    if (enhetId) {
      premiumBrukere.add(enhetId);
      await settPremium(enhetId, true, stripeKundeId);
      console.log("Premium aktivert for:", enhetId);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const enhetId = event.data.object.metadata?.enhetId;
    if (enhetId) {
      premiumBrukere.delete(enhetId);
      await settPremium(enhetId, false);
      console.log("Premium avsluttet for:", enhetId);
    }
  }

  res.json({ mottatt: true });
});

// Debug – vis alle premium-brukere
app.get("/api/debug/premium", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM premium_brukere");
    res.json(result.rows);
  } catch(e) {
    res.json({ feil: e.message });
  }
});

// Debug – slett alle premium-brukere (kun for testing!)
app.delete("/api/debug/premium", async (req, res) => {
  try {
    await db.query("DELETE FROM premium_brukere");
    res.json({ slettet: true });
  } catch(e) {
    res.json({ feil: e.message });
  }
});

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
opprettTabeller().then(() => {
  app.listen(PORT, () => {
    console.log(`Server kjører på port ${PORT}`);
    lastNedLovdata();
  });
}).catch(err => {
  console.error("Database feil:", err.message);
  app.listen(PORT, () => {
    console.log(`Server kjører på port ${PORT} (uten database)`);
    lastNedLovdata();
  });
});
