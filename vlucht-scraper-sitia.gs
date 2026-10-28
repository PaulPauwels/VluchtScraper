// ============================================================
//  VLUCHT SCRAPER SITIA  –  België ↔ Sitia (JSH) via Athene
//  Google Apps Script  |  Gebruikt SerpApi Google Flights
// ============================================================
//
//  WERKING:
//  Sitia (JSH) heeft geen directe vluchten vanuit België.
//  Dit script zoekt zelf-samengestelde combinaties:
//
//  HEEN:  CRL/BRU/OST → ATH  (Ryanair FR)
//         ATH → JSH           (Aegean A3)
//
//  TERUG: JSH → ATH           (Aegean A3)
//         ATH → CRL/BRU/OST   (Ryanair FR)
//
//  AANPAK – zo min mogelijk API-calls:
//  1. Google Calendar uitlezen: op welke dagen is Paul in België (heen)
//     of op Kreta (terug)? Andere dagen worden volledig overgeslagen.
//  2. Per relevante dag: been2 (ATH↔JSH) ophalen als pre-filter.
//     Alleen als er een Olympic-vlucht is, wordt been1 (BE↔ATH) opgevraagd.
//
//  Totaal: veel minder dan nDagen × 2 × 2, afhankelijk van agenda en schema.
//
//  HOE GEBRUIKEN:
//  1. Ga naar script.google.com → nieuw project
//  2. Plak dit hele bestand
//  3. Vul SERPAPI_KEY en EMAIL_NAAR in
//  4. Klik ▶ Run → zoekSitiaVluchten
//  5. Logs: Weergave → Logboeken
// ============================================================

// ============================================================
//  ▼▼▼  CONFIGURATIE – HIER AANPASSEN  ▼▼▼
// ============================================================

// ── SerpApi ──────────────────────────────────────────────────
// Jouw persoonlijke API-sleutel van https://serpapi.com
const SERPAPI_KEY = "JOUW_API_KEY_HIER";

// Maximaal aantal gratis API-calls per maand op jouw SerpApi-plan
const SERPAPI_MAANDLIMIET = 250;

// ── E-mail ───────────────────────────────────────────────────
// E-mailadres waarnaar het rapport gestuurd wordt
const EMAIL_NAAR = "JOUW_EMAIL_HIER";

// Weergavenaam in het "Van"-veld van de e-mail
const EMAIL_AFZENDER_NAAM = "vlucht-scraper-sitia.gs";

// ── Uitvoering ───────────────────────────────────────────────
// DRY_RUN = true  → geen SerpApi-calls, wél e-mail (voor testen)
// DRY_RUN = false → echte uitvoering
const DRY_RUN = true;

// ── Google Agenda ─────────────────────────────────────────────
// Gebruik de agenda om te bepalen op welke dagen er gezocht wordt?
//   true  → alleen dagen zoeken waarop je op de juiste locatie bent (zie AGENDA_ID)
//   false → alle dagen in de periode zoeken, ongeacht de agenda
const GEBRUIK_AGENDA = true;

// Google Calendar ID van de agenda met locatie-events.
// Alleen relevant als GEBRUIK_AGENDA = true.
// Events moeten in de titel bevatten:
//   AGENDA_TREFWOORD_PERSOON + AGENDA_TREFWOORD_KRETA  → je bent op Kreta  → terugvlucht relevant
//   AGENDA_TREFWOORD_PERSOON + AGENDA_TREFWOORD_BELGIE → je bent in België → heenvlucht relevant
const AGENDA_ID = "41ad8818833b51bfc5cd23d4dbaf75c2bb332c36ab744a7a7e9b480eed8d1701@group.calendar.google.com";

// Trefwoorden die in de event-titel worden gezocht (hoofdletterongevoelig)
const AGENDA_TREFWOORD_PERSOON = "paul";   // moet altijd aanwezig zijn
const AGENDA_TREFWOORD_KRETA   = "kreta";  // aanwezig → je bent op Kreta
const AGENDA_TREFWOORD_BELGIE  = "belg";   // aanwezig → je bent in België

// Aantal dagen na aankomst (inclusief aankomstdag) die overgeslagen worden.
// Je vliegt niet onmiddellijk terug na aankomst.
// Vb. 4 = aankomstdag + 3 volgende dagen worden niet doorzocht.
const AANKOMST_WACHTDAGEN = 4;

// Vertraging tussen API-calls (milliseconden) om rate-limiting te vermijden
const API_VERTRAGING_MS = 500;

// ── Zoekperiode ───────────────────────────────────────────────
const CRITERIA = {
  // Automatische periode: vandaag + PERIODE_START_OFFSET t/m + PERIODE_START_OFFSET + PERIODE_LENGTE_DAGEN
  // Vaste periode: "DD/MM/JJJJ" invullen (beide of geen)
  datumVan: null,
  datumTot: null,

  // Aantal dagen vanaf vandaag waarop de periode start (bij automatische periode)
  periodeStartOffset:  3,
  // Lengte van de zoekperiode in dagen (bij automatische periode)
  periodeLengteDagen: 27,

  // Maximumprijs voor de COMBINATIE van beide vluchten (EUR)
  maximumPrijsTotaal: 250,

  // Overstaptijd in Athene (minuten)
  overstapMinMinuten: 60,
  overstapMaxMinuten: 240,

  // Dagvenster – vroegste vertrek eerste vlucht en laatste aankomst eindbestemming
  vroegsteVertrekuur: "06:00",
  laatsteAankomstuur: "23:59",
};

// ── Luchthavens ───────────────────────────────────────────────
// Belgische vertrek/aankomstluchthavens
const BELGIE_LUCHTHAVENS    = ["CRL", "BRU"];
// Komma-gescheiden string voor SerpApi (departure_id/arrival_id)
const BELGIE_LUCHTHAVENS_ID = "CRL,BRU";
// Tussenliggende luchthaven (overstap)
const ATHENE = "ATH";
// Eindbestemming
const SITIA  = "JSH";

// ── Airlines ─────────────────────────────────────────────────
// Toegestane airlines voor been1 (België ↔ Athene)
// Ryanair = FR
const AIRLINE_BE_ATH  = ["FR"];
// Toegestane airlines voor been2 (Athene ↔ Sitia)
// Aegean = A3, Olympic Air (dochter van Aegean) = OA
const AIRLINE_ATH_JSH = ["A3", "OA"];

// ── SerpApi call-parameters ───────────────────────────────────
// Valuta voor prijzen
const SERPAPI_VALUTA = "EUR";
// Taal van de resultaten (ISO 639-1)
const SERPAPI_TAAL   = "nl";
// Geo-locatie voor prijsbepaling (ISO 3166-1 alpha-2)
const SERPAPI_GEO    = "be";

// ============================================================
//  INTERNE VLAG – NIET AANPASSEN
// ============================================================

// Wordt true zodra een HTTP 429 ontvangen wordt.
// Alle verdere API-calls worden dan overgeslagen.
var QUOTA_OP = false;

// ============================================================
//  AGENDA-FILTER
//
//  Leest de Google Calendar met AGENDA_ID uit en bepaalt per datum
//  of er een relevant event is voor Paul.
//
//  Geeft terug:
//    { heenDagen: Set<"YYYY-MM-DD">, terugDagen: Set<"YYYY-MM-DD"> }
//
//  heenDagen  = dagen waarop Paul in België is  → BE→JSH zoeken
//  terugDagen = dagen waarop Paul op Kreta is   → JSH→BE zoeken
//
//  Als AGENDA_ID null is, of de agenda niet bereikbaar is,
//  worden ALLE dagen als relevant beschouwd (geen filtering).
// ============================================================

function leesAgendaDagen(van, tot) {
  const leeg = { heenDagen: null, terugDagen: null,
                 aankomstGefilterdHeen: new Set(), aankomstGefilterdTerug: new Set() };

  if (!GEBRUIK_AGENDA || !AGENDA_ID) {
    console.log("  📅 Agenda-filter uitgeschakeld – alle dagen worden doorzocht");
    return leeg;
  }

  let kalender;
  try {
    kalender = CalendarApp.getCalendarById(AGENDA_ID);
  } catch (e) {
    console.warn(`  ⚠️  Agenda niet bereikbaar: ${e.message} – alle dagen worden doorzocht`);
    return leeg;
  }

  if (!kalender) {
    console.warn("  ⚠️  Agenda niet gevonden – alle dagen worden doorzocht");
    return leeg;
  }

  const totPlusEen = new Date(tot);
  totPlusEen.setDate(totPlusEen.getDate() + 1);
  const events = kalender.getEvents(van, totPlusEen);

  console.log(`  📅 Agenda: ${events.length} event(s) gevonden tussen ${formatDatum(van)} en ${formatDatum(tot)}`);

  const heenDagen  = new Set();
  const terugDagen = new Set();

  for (const ev of events) {
    const titel = (ev.getTitle() || "").toLowerCase();
    const heeftPersoon = titel.includes(AGENDA_TREFWOORD_PERSOON.toLowerCase());
    const heeftKreta   = titel.includes(AGENDA_TREFWOORD_KRETA.toLowerCase());
    const heeftBelg    = titel.includes(AGENDA_TREFWOORD_BELGIE.toLowerCase());

    if (!heeftPersoon) continue;
    if (!heeftKreta && !heeftBelg) continue;

    const evStart = ev.getStartTime();
    const evEind  = ev.getEndTime();
    const cursor  = new Date(evStart);
    cursor.setHours(0, 0, 0, 0);
    const eind = new Date(evEind);
    eind.setHours(0, 0, 0, 0);

    while (cursor <= eind) {
      const ds = formatDatum(cursor);
      if (heeftKreta) terugDagen.add(ds);
      if (heeftBelg)  heenDagen.add(ds);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  console.log(`  📅 Dagen ${AGENDA_TREFWOORD_PERSOON} in België (heenvlucht): ${heenDagen.size}`);
  console.log(`  📅 Dagen ${AGENDA_TREFWOORD_PERSOON} op Kreta  (terugvlucht): ${terugDagen.size}`);

  function filterAankomstDagen(dagen) {
    if (dagen.size === 0) return { gefilterd: dagen, verwijderd: new Set() };
    const gesorteerd = [...dagen].sort();
    const teVerwijderen = new Set();
    for (const ds of gesorteerd) {
      const [y, m, d] = ds.split("-").map(Number);
      const gisteren    = new Date(y, m - 1, d - 1);
      const gisterenStr = formatDatum(gisteren);
      if (!dagen.has(gisterenStr)) {
        // Aankomstdag gevonden: markeer dag 0 t/m dag (AANKOMST_WACHTDAGEN - 1)
        for (let i = 0; i < AANKOMST_WACHTDAGEN; i++) {
          const extra = new Date(y, m - 1, d + i);
          teVerwijderen.add(formatDatum(extra));
        }
      }
    }
    const gefilterd = new Set([...dagen].filter(ds => !teVerwijderen.has(ds)));
    const verwijderd = new Set([...dagen].filter(ds => teVerwijderen.has(ds)));
    if (verwijderd.size > 0)
      console.log(`    ✂️  Aankomstfilter: ${verwijderd.size} dag(en) overgeslagen (eerste ${AANKOMST_WACHTDAGEN} dagen na aankomst)`);
    return { gefilterd, verwijderd };
  }

  const heen  = filterAankomstDagen(heenDagen);
  const terug = filterAankomstDagen(terugDagen);

  return {
    heenDagen:              heen.gefilterd,
    terugDagen:             terug.gefilterd,
    aankomstGefilterdHeen:  heen.verwijderd,
    aankomstGefilterdTerug: terug.verwijderd,
  };
}

// ============================================================
//  DATUM-HULPFUNCTIES
// ============================================================

function parseDatum(str) {
  const [d, m, y] = str.split("/").map(Number);
  return new Date(y, m - 1, d);
}

function formatDatum(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function datumReeks(van, tot) {
  const lijst = [];
  const cur = new Date(van);
  while (cur <= tot) {
    lijst.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return lijst;
}

function tijdNaarMinuten(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function berekenPeriode() {
  let van, tot;
  if (CRITERIA.datumVan && CRITERIA.datumTot) {
    van = parseDatum(CRITERIA.datumVan);
    tot = parseDatum(CRITERIA.datumTot);
    console.log(`  📅 Vaste periode: ${formatDatum(van)} → ${formatDatum(tot)}`);
  } else {
    van = new Date();
    van.setDate(van.getDate() + CRITERIA.periodeStartOffset);
    van.setHours(0, 0, 0, 0);
    tot = new Date(van);
    tot.setDate(tot.getDate() + CRITERIA.periodeLengteDagen);
    console.log(`  📅 Auto periode: ${formatDatum(van)} → ${formatDatum(tot)}`);
  }
  return { van, tot };
}

// ============================================================
//  SERPAPI – 1 CALL
// ============================================================

function serpApiZoek(vertrek, aankomst, datum) {
  const datumStr = formatDatum(datum);

  if (DRY_RUN) {
    console.log(`  🧪 DRY RUN – geen call: ${vertrek} → ${aankomst} op ${datumStr}`);
    return null;
  }

  if (QUOTA_OP) {
    console.warn(`  ⏭️  Quota op – call overgeslagen: ${vertrek} → ${aankomst}`);
    return null;
  }

  console.log(`  📡 SerpApi: ${vertrek} → ${aankomst} op ${datumStr}`);

  const params = {
    engine:        "google_flights",
    departure_id:  vertrek,
    arrival_id:    aankomst,
    outbound_date: datumStr,
    type:          "2",      // enkele reis
    max_stops:     "0",      // directe vluchten (BE→ATH en ATH→JSH zijn direct)
    currency:      SERPAPI_VALUTA,
    hl:            SERPAPI_TAAL,
    gl:            SERPAPI_GEO,
    api_key:       SERPAPI_KEY,
  };

  const qs  = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  try {
    const resp = UrlFetchApp.fetch(`https://serpapi.com/search?${qs}`,
      { method: "GET", muteHttpExceptions: true });
    const code = resp.getResponseCode();
    console.log(`  ↩️  HTTP ${code}`);

    if (code === 429) {
      QUOTA_OP = true;
      console.error("  🚫 HTTP 429 – quota opgebruikt! Alle verdere calls worden gestopt.");
      return null;
    }
    if (code !== 200) {
      console.warn(`  ⚠️  Status ${code}`);
      return null;
    }

    const json = JSON.parse(resp.getContentText());
    if (json.error) {
      console.error(`  ❌ SerpApi: ${json.error}`);
      return null;
    }
    return json;

  } catch (e) {
    console.error(`  ❌ Fetch-fout: ${e.message}`);
    return null;
  }
}

// ============================================================
//  EXTRACT vluchten van 1 airline uit SerpApi JSON
// ============================================================

function extractVluchten(json, filterAirlineCodes, verwachteAankomst = null) {
  if (!json) return [];

  // filterAirlineCodes kan een string of array zijn
  const codes = Array.isArray(filterAirlineCodes)
    ? filterAirlineCodes
    : [filterAirlineCodes];

  const secties = [...(json.best_flights || []), ...(json.other_flights || [])];
  console.log(`  📦 Totaal itineraria in response: ${secties.length}`);

  const resultaten = [];

  for (const it of secties) {
    const segs = it.flights || [];
    if (segs.length === 0) continue;

    const seg  = segs[0];
    const code = (seg.flight_number || "").substring(0, 2).trim();

    // Log elk gevonden segment voor diagnose
    console.log(`    Segment: ${seg.flight_number || "?"} | ${seg.airline || "?"} | `
      + `${seg.departure_airport?.id}→${seg.arrival_airport?.id} | `
      + `${(seg.departure_airport?.time || "").substring(11,16)}`
      + `→${(seg.arrival_airport?.time || "").substring(11,16)} | €${it.price}`);

    if (!codes.includes(code)) {
      console.log(`    ↩ Skip: code "${code}" niet in [${codes.join(",")}]`);
      continue;
    }

    // Controleer aankomstluchthaven als verwachteAankomst meegegeven is
    const aankomstId = seg.arrival_airport?.id || "";
    if (verwachteAankomst && aankomstId !== verwachteAankomst) {
      console.log(`    ↩ Skip: aankomst "${aankomstId}" ≠ verwacht "${verwachteAankomst}"`);
      continue;
    }

    resultaten.push({
      vluchtnummer: seg.flight_number                 || "?",
      airlineNaam:  seg.airline                       || "?",
      van:          seg.departure_airport?.id         || "?",
      naar:         seg.arrival_airport?.id           || "?",
      depTime:      seg.departure_airport?.time       || "?",
      arrTime:      seg.arrival_airport?.time         || "?",
      duur:         seg.duration                      || 0,
      prijs:        it.price                          || null,
    });
  }

  console.log(`  ✈️  Vluchten na filter [${codes.join(",")}]: ${resultaten.length}`);
  return resultaten;
}

// ============================================================
//  COMBINEER been1 (BE→ATH) + been2 (ATH→JSH) op overstap
// ============================================================

function combineerVluchten(been1Lijst, been2Lijst, datum) {
  const vroegsteMin = tijdNaarMinuten(CRITERIA.vroegsteVertrekuur);
  const laaststeMin = tijdNaarMinuten(CRITERIA.laatsteAankomstuur);
  const resultaten  = [];

  console.log(`  🔗 Combineren: ${been1Lijst.length} × ${been2Lijst.length} combinaties`);

  for (const been1 of been1Lijst) {
    for (const been2 of been2Lijst) {

      // Controleer dat been1 aankomt in ATH en been2 vertrekt vanuit ATH
      if (been1.naar !== ATHENE || been2.van !== ATHENE) continue;

      // Bereken overstaptijd
      const arr1  = new Date(been1.arrTime);
      const dep2  = new Date(been2.depTime);
      const overstapMin = Math.round((dep2 - arr1) / 60000);

      // Negatieve overstap = been2 vertrekt vóór been1 aankomt
      if (overstapMin < 0) {
        console.log(`    ↩ ${been1.vluchtnummer}+${been2.vluchtnummer}: been2 te vroeg (${overstapMin}min)`);
        continue;
      }

      // Overstap binnen criteria?
      if (overstapMin < CRITERIA.overstapMinMinuten) {
        console.log(`    🚫 Overstap ${overstapMin}min < ${CRITERIA.overstapMinMinuten}min`);
        continue;
      }
      if (overstapMin > CRITERIA.overstapMaxMinuten) {
        console.log(`    🚫 Overstap ${overstapMin}min > ${CRITERIA.overstapMaxMinuten}min`);
        continue;
      }

      // Vertrekuur eerste vlucht
      const depHHMM = (been1.depTime || "").substring(11, 16);
      if (tijdNaarMinuten(depHHMM) < vroegsteMin) {
        console.log(`    🚫 Vertrek ${depHHMM} te vroeg`);
        continue;
      }

      // Aankomstuur laatste vlucht
      const arrHHMM = (been2.arrTime || "").substring(11, 16);
      if (tijdNaarMinuten(arrHHMM) > laaststeMin) {
        console.log(`    🚫 Aankomst ${arrHHMM} te laat`);
        continue;
      }

      // Totale prijs
      const prijsBeen1 = been1.prijs || 0;
      const prijsBeen2 = been2.prijs || 0;
      const prijsTotaal = (prijsBeen1 > 0 && prijsBeen2 > 0)
        ? prijsBeen1 + prijsBeen2 : null;

      if (prijsTotaal !== null && prijsTotaal > CRITERIA.maximumPrijsTotaal) {
        console.log(`    🚫 Prijs €${prijsBeen1}+€${prijsBeen2}=€${prijsTotaal} > €${CRITERIA.maximumPrijsTotaal}`);
        continue;
      }

      // Totale reisduur (minuten)
      const totaleDuur = been1.duur + overstapMin + been2.duur;

      console.log(`    ✅ ${been1.van}→ATH→JSH | ${depHHMM}→${arrHHMM} | overstap ${overstapMin}min | €${prijsTotaal}`);

      resultaten.push({
        datum:       formatDatum(datum),
        richting:    `${been1.van}→ATH→JSH`,
        been1, been2,
        overstapMin,
        prijsBeen1,  prijsBeen2, prijsTotaal,
        depHHMM,     arrHHMM,
        totaleDuur,
      });
    }
  }

  return resultaten;
}

// ============================================================
//  LOG een combinatie
// ============================================================

function logCombi(c, i) {
  const prijs = c.prijsTotaal !== null ? `€${c.prijsTotaal}` : "prijs ?";
  const duur  = `${Math.floor(c.totaleDuur / 60)}u${String(c.totaleDuur % 60).padStart(2,"0")}m`;
  console.log(`\n  ┌─ [${i+1}] ${c.richting} | ${c.datum} | ${prijs} | ${duur} totaal`);
  console.log(`  │  ✈ ${c.been1.vluchtnummer.padEnd(9)} ${c.been1.airlineNaam.padEnd(20)} ${c.been1.van} ${c.depHHMM} → ATH ${c.been1.arrTime.substring(11,16)}  (€${c.prijsBeen1})`);
  console.log(`  │  ⏱  Overstap ATH: ${c.overstapMin} min`);
  console.log(`  │  ✈ ${c.been2.vluchtnummer.padEnd(9)} ${c.been2.airlineNaam.padEnd(20)} ATH ${c.been2.depTime.substring(11,16)} → JSH ${c.arrHHMM}  (€${c.prijsBeen2})`);
  console.log(`  └${"─".repeat(55)}`);
}

// ============================================================
//  VERWERK ÉÉN RICHTING
// ============================================================

function verwerkRichting(vertrekId, aankomstId, filterV, filterA, label, toegestaneDagen = null) {
  console.log(`\n${"═".repeat(62)}\n  ${label}\n${"═".repeat(62)}`);

  const { van: dVan, tot: dTot } = berekenPeriode();
  let datums = datumReeks(dVan, dTot);

  // Agenda-filter: houd enkel dagen over waarop Paul op de juiste locatie is
  if (toegestaneDagen !== null) {
    const voor = datums.length;
    datums = datums.filter(d => toegestaneDagen.has(formatDatum(d)));
    console.log(`  📅 Agenda-filter: ${voor} → ${datums.length} dag(en) (${voor - datums.length} overgeslagen)`);
  }

  if (datums.length === 0) {
    console.log(`  ↩ Geen relevante dagen in agenda – richting overgeslagen`);
    return { resultaten: [], aantalCalls: 0 };
  }
  console.log(`  🛫 ${vertrekId} → ${ATHENE} (${filterV}) → ${aankomstId} (${filterA})`);
  console.log(`  💶 Max €${CRITERIA.maximumPrijsTotaal} totaal  ⏱ ${CRITERIA.overstapMinMinuten}–${CRITERIA.overstapMaxMinuten}min  🕐 ${CRITERIA.vroegsteVertrekuur}–${CRITERIA.laatsteAankomstuur}`);

  const resultaten = [];
  let aantalCalls  = 0;

  // ── STAP A: haal been2 per dag op (ATH ↔ kleine luchthaven) ──────────────
  //
  //  Per datum ophalen (niet eenmalig) zodat we weten op welke dagen
  //  Aegean/Olympic effectief vliegt. Pre-filter: alleen op dagen mét een
  //  been2-vlucht wordt daarna been1 opgevraagd.
  //  Dit spaart been1-calls voor dagen zonder Aegean-vlucht.

  console.log(`\n  📥 Been2-vluchten ophalen per dag: ${ATHENE} ↔ ${aankomstId}`);

  const been2PerDag = {};
  for (const datum of datums) {
    aantalCalls++;
    const json2 = serpApiZoek(ATHENE, aankomstId, datum);
    const vluchten = extractVluchten(json2, filterA);
    been2PerDag[formatDatum(datum)] = vluchten;
    if (vluchten.length > 0) {
      console.log(`    📅 ${formatDatum(datum)}: ${vluchten.length} been2-vlucht(en) beschikbaar`);
    } else {
      console.log(`    📅 ${formatDatum(datum)}: geen been2-vluchten → been1 wordt overgeslagen`);
    }
    if (!DRY_RUN) Utilities.sleep(API_VERTRAGING_MS);
  }

  const dagenMetBeen2 = datums.filter(d => been2PerDag[formatDatum(d)].length > 0);
  console.log(`  ✅ ${dagenMetBeen2.length}/${datums.length} dagen hebben een been2-vlucht`);

  if (dagenMetBeen2.length === 0) {
    console.log(`  ↩ Geen been2-vluchten in de hele periode – gehele richting overgeslagen`);
    return { resultaten, aantalCalls };
  }

  // ── STAP B: per dag been1 – ALLEEN als been2 die dag bestaat ─────────────
  //
  //  Pre-filter: dagen zonder been2 krijgen NOOIT een been1-call.
  //  Alle data is altijd vers – geen caching, script loopt wekelijks.

  console.log(`\n  📥 Been1-vluchten ophalen – alleen voor ${dagenMetBeen2.length} dag(en) met been2`);

  for (const datum of dagenMetBeen2) {
    const datumStr = formatDatum(datum);
    console.log(`\n  ── ${datumStr}`);

    aantalCalls++;
    const json1 = serpApiZoek(vertrekId, ATHENE, datum);
    const been1 = extractVluchten(json1, filterV, ATHENE);

    if (been1.length === 0) {
      console.log(`  ↩ Geen ${filterV}-vluchten naar ATH – overgeslagen`);
      if (!DRY_RUN) Utilities.sleep(API_VERTRAGING_MS);
      continue;
    }

    // Pas de datum aan in de been2-vluchten voor die dag (tijden blijven gelijk)
    const been2 = been2PerDag[datumStr].map(b => ({
      ...b,
      depTime: datumStr + " " + b.depTime.substring(11),
      arrTime: datumStr + " " + b.arrTime.substring(11),
    }));

    const combis = combineerVluchten(been1, been2, datum);
    console.log(`  ✅ ${combis.length} geldige combinatie(s)`);
    combis.forEach(c => { logCombi(c, resultaten.length); resultaten.push(c); });
    if (!DRY_RUN) Utilities.sleep(API_VERTRAGING_MS);
  }

  const overgeslagenDagen = datums.length - dagenMetBeen2.length;
  const geenBeen2Dagen = new Set(
    datums.filter(d => been2PerDag[formatDatum(d)].length === 0).map(d => formatDatum(d))
  );
  console.log(`\n  TOTAAL ${label}: ${resultaten.length} combinatie(s) | ${aantalCalls} API-calls`);
  console.log(`  💡 Pre-filter: ${overgeslagenDagen} been1-call(s) uitgespaard (geen been2 die dag)`);
  return { resultaten, aantalCalls, geenBeen2Dagen };
}
// ============================================================
//  E-MAIL  –  HTML-opmaak
// ============================================================

function bouwCombiRij(c, i) {
  const prijs  = c.prijsTotaal !== null ? `€${c.prijsTotaal}` : "?";
  const duur   = `${Math.floor(c.totaleDuur/60)}u${String(c.totaleDuur%60).padStart(2,"0")}m`;
  const bg     = i % 2 === 0 ? "#ffffff" : "#f7f8fc";
  const arr1   = c.been1.arrTime.substring(11, 16);
  const dep2   = c.been2.depTime.substring(11, 16);
  const d1     = `${Math.floor(c.been1.duur/60)}u${String(c.been1.duur%60).padStart(2,"0")}m`;
  const d2     = `${Math.floor(c.been2.duur/60)}u${String(c.been2.duur%60).padStart(2,"0")}m`;

  return `
  <!-- Vlucht header -->
  <tr style="background:${bg};">
    <td colspan="6" style="padding:10px 14px 4px;border-top:2px solid #e0e0e0;">
      <span style="font-size:14px;font-weight:700;color:#1a1a1a;">${i+1}.&nbsp;${c.richting}</span>
      &nbsp;
      <span style="font-size:12px;color:#9e9e9e;">${c.datum}</span>
      &nbsp;&nbsp;
      <span style="font-size:17px;font-weight:800;color:#c62828;">${prijs}</span>
      <span style="font-size:11px;color:#9e9e9e;">&nbsp;(${c.prijsBeen1 ? `€${c.prijsBeen1}+€${c.prijsBeen2}` : "prijs onbekend"})</span>
      <span style="font-size:12px;color:#78909c;">&nbsp;|&nbsp;totaal ${duur}</span>
    </td>
  </tr>
  <!-- Segment 1 -->
  <tr style="background:${bg};">
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;
        font-weight:700;color:#263238;">${c.been1.vluchtnummer}</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;">Ryanair</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;
        font-weight:600;">${c.been1.van}&thinsp;→&thinsp;ATH</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;">${c.depHHMM}</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;">${arr1}</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;color:#78909c;">${d1}</td>
  </tr>
  <!-- Overstap -->
  <tr style="background:#fffde7;">
    <td colspan="6" style="padding:4px 14px;font-size:11px;color:#e65100;
        font-style:italic;border-bottom:1px solid #eee;">
      ⏱&nbsp;Overstap Athene (ATH):&nbsp;<strong>${c.overstapMin}&nbsp;min</strong>
    </td>
  </tr>
  <!-- Segment 2 -->
  <tr style="background:${bg};">
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;
        font-weight:700;color:#263238;">${c.been2.vluchtnummer}</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;">Aegean</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;
        font-weight:600;">ATH&thinsp;→&thinsp;JSH</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;">${dep2}</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;">${c.arrHHMM}</td>
    <td style="padding:5px 14px;font-size:13px;border-bottom:1px solid #eee;color:#78909c;">${d2}</td>
  </tr>`;
}

function bouwSectieHtml(combis, titel) {
  if (combis.length === 0) return `
    <h2 style="color:#546e7a;font-size:16px;font-weight:700;margin:32px 0 8px;">${titel}</h2>
    <p style="color:#b0bec5;font-style:italic;font-size:13px;margin:0 0 8px;">
      Geen combinaties gevonden die aan alle criteria voldoen.</p>`;

  const rijen = combis.map((c, i) => bouwCombiRij(c, i)).join("");
  return `
    <h2 style="color:#1a237e;font-size:16px;font-weight:700;margin:32px 0 10px;">${titel}</h2>
    <table width="100%" cellpadding="0" cellspacing="0"
        style="border-collapse:collapse;font-family:Arial,sans-serif;
               border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;">
      <thead>
        <tr style="background:#283593;color:#fff;">
          <th style="padding:9px 14px;text-align:left;font-size:12px;">Nr</th>
          <th style="padding:9px 14px;text-align:left;font-size:12px;">Maatschappij</th>
          <th style="padding:9px 14px;text-align:left;font-size:12px;">Route</th>
          <th style="padding:9px 14px;text-align:left;font-size:12px;">Vertrek</th>
          <th style="padding:9px 14px;text-align:left;font-size:12px;">Aankomst</th>
          <th style="padding:9px 14px;text-align:left;font-size:12px;">Duur</th>
        </tr>
      </thead>
      <tbody>${rijen}</tbody>
    </table>`;
}

function stuurEmail(heenCombis, terugCombis, periode, isDryRun, apiInfo, agendaInfo) {
  if (!EMAIL_NAAR || EMAIL_NAAR === "JOUW_EMAIL_HIER") {
    console.warn("⚠️  EMAIL_NAAR niet ingevuld – e-mail overgeslagen.");
    return;
  }

  const totaal    = heenCombis.length + terugCombis.length;
  const timestamp = new Date().toLocaleString("nl-BE");

  // ── Quota-banner (grote rode blokkade bovenaan als quota op is) ───────────
  const quotaBanner = apiInfo.quotaOp ? `
    <tr><td style="padding:0 30px 16px;">
      <div style="background:#b71c1c;color:#fff;padding:18px 22px;border-radius:8px;
          font-size:16px;font-weight:800;letter-spacing:.3px;
          border:3px solid #ff1744;text-align:center;">
        🚨&nbsp;QUOTA OPGEBRUIKT – geen verdere SerpApi-calls mogelijk deze maand!<br>
        <span style="font-size:12px;font-weight:400;opacity:.85;">
          Vernieuwing: ${apiInfo.vernieuwing || "?"}
        </span>
      </div>
    </td></tr>` : "";

  const dryBanner = isDryRun ? `
    <tr><td style="padding:0 30px 16px;">
      <div style="background:#e65100;color:#fff;padding:14px 18px;border-radius:6px;
          font-size:13px;font-weight:700;">
        🧪&nbsp;DRY RUN – testrapport, geen echte SerpApi-calls uitgevoerd.
      </div>
    </td></tr>` : "";

  const criteriaRijen = [
    ["Periode",           `${periode.van} → ${periode.tot}`],
    ["Vertrek (heen)",    BELGIE_LUCHTHAVENS.join(", ")],
    ["Aankomst (heen)",   `${ATHENE} → ${SITIA}`],
    ["Vertrek (terug)",   `${SITIA} → ${ATHENE}`],
    ["Aankomst (terug)",  BELGIE_LUCHTHAVENS.join(", ")],
    ["Airlines heen",     `Ryanair (FR): BE→ATH  |  Aegean/Olympic (A3/OA): ATH→JSH`],
    ["Airlines terug",    `Aegean/Olympic (A3/OA): JSH→ATH  |  Ryanair (FR): ATH→BE`],
    ["Max. prijs totaal", `€${CRITERIA.maximumPrijsTotaal} (beide vluchten samen)`],
    ["Overstap ATH",      `${CRITERIA.overstapMinMinuten} – ${CRITERIA.overstapMaxMinuten} min`],
    ["Dagvenster",        `${CRITERIA.vroegsteVertrekuur} – ${CRITERIA.laatsteAankomstuur}`],
    ["Heen combinaties",  `${heenCombis.length}`],
    ["Terug combinaties", `${terugCombis.length}`],
    ["API-calls deze run",   `${apiInfo.callsGedaan}`],
    ["API-calls deze maand",  `${apiInfo.callsMaand} / ${SERPAPI_MAANDLIMIET}`],
    ["API-calls resterend",
      apiInfo.quotaOp
        ? `<span style="color:#b71c1c;font-weight:800;">0 – QUOTA OPGEBRUIKT 🚨</span>`
        : `≈ ${apiInfo.callsResterend}`],
  ].map(([k, v]) => `
    <tr>
      <td style="padding:4px 16px 4px 0;font-size:13px;color:#546e7a;width:200px;">${k}</td>
      <td style="padding:4px 0;font-size:13px;font-weight:600;color:#1a1a1a;">${v}</td>
    </tr>`).join("");

  // ── Dagkalender ───────────────────────────────────────────────────────────
  //
  //  Bouw een map: datum → array van combinaties (heen of terug)
  const combiPerDatum = {};
  for (const c of [...heenCombis, ...terugCombis]) {
    if (!combiPerDatum[c.datum]) combiPerDatum[c.datum] = [];
    combiPerDatum[c.datum].push(c);
  }

  // Alle datums in de periode ophalen
  const { van: dVan, tot: dTot } = berekenPeriode();
  const alleDatums = datumReeks(dVan, dTot).map(d => formatDatum(d));

  const heenSet  = agendaInfo ? agendaInfo.heenDagen  : null;
  const terugSet = agendaInfo ? agendaInfo.terugDagen : null;
  const aankomstHeenSet  = agendaInfo ? (agendaInfo.aankomstGefilterdHeen  || new Set()) : new Set();
  const aankomstTerugSet = agendaInfo ? (agendaInfo.aankomstGefilterdTerug || new Set()) : new Set();
  const geenBeen2HeenSet  = agendaInfo ? (agendaInfo.geenBeen2HeenDagen  || new Set()) : new Set();
  const geenBeen2TerugSet = agendaInfo ? (agendaInfo.geenBeen2TerugDagen || new Set()) : new Set();

  const WEEKDAGEN = ["zo","ma","di","wo","do","vr","za"];

  function dagKalenderRij(datumStr, idx) {
    const [y, m, d]  = datumStr.split("-").map(Number);
    const datumObj   = new Date(y, m - 1, d);
    const weekdag    = WEEKDAGEN[datumObj.getDay()];
    const dagLeesb   = `${weekdag} ${d}/${m}`;
    const bg         = idx % 2 === 0 ? "#ffffff" : "#f7f8fc";

    // Locatie bepalen (heen = België, terug = Kreta)
    // Inclusief aankomstgefilterde dagen voor de locatieweergave
    const inBelgieRauw = (heenSet && heenSet.has(datumStr)) || aankomstHeenSet.has(datumStr);
    const inKretaRauw  = (terugSet && terugSet.has(datumStr)) || aankomstTerugSet.has(datumStr);
    const inBelgie     = heenSet  && heenSet.has(datumStr);
    const inKreta      = terugSet && terugSet.has(datumStr);

    const locatieTxt   = inBelgieRauw ? "🇧🇪 België" : inKretaRauw ? "🇬🇷 Kreta" : "–";
    const locatieKleur = inBelgieRauw ? "#1565c0"    : inKretaRauw ? "#2e7d32"   : "#9e9e9e";

    // Reden waarom niet gezocht
    let redenNietGezocht = null;
    if (!inBelgieRauw && !inKretaRauw) {
      redenNietGezocht = "Niet gezocht – geen agenda-event";
    } else if (aankomstHeenSet.has(datumStr) || aankomstTerugSet.has(datumStr)) {
      redenNietGezocht = `Niet gezocht – aankomstdag of eerste ${AANKOMST_WACHTDAGEN} dagen na aankomst`;
    } else if (inBelgie && geenBeen2HeenSet.has(datumStr)) {
      redenNietGezocht = "Niet gezocht – geen Olympic-vlucht ATH→JSH deze dag";
    } else if (inKreta && geenBeen2TerugSet.has(datumStr)) {
      redenNietGezocht = "Niet gezocht – geen Olympic-vlucht JSH→ATH deze dag";
    }

    const gezochtTxt = redenNietGezocht
      ? `<span style="color:#9e9e9e;font-style:italic;">${redenNietGezocht}</span>`
      : (combiPerDatum[datumStr]
          ? `<span style="color:#2e7d32;font-weight:700;">✓ gevonden</span>`
          : `<span style="color:#e53935;">✗ gezocht, geen resultaat</span>`);

    // Vluchtdata
    const combis = combiPerDatum[datumStr] || [];
    if (combis.length === 0) {
      return `<tr style="background:${bg};">
        <td style="padding:5px 10px;font-size:12px;color:#546e7a;white-space:nowrap;">${dagLeesb}</td>
        <td style="padding:5px 10px;font-size:12px;font-weight:600;color:${locatieKleur};">${locatieTxt}</td>
        <td colspan="5" style="padding:5px 10px;font-size:12px;">${gezochtTxt}</td>
      </tr>`;
    }

    return combis.map((c, ci) => {
      const prijs  = c.prijsTotaal !== null ? `<strong style="color:#c62828;">€${c.prijsTotaal}</strong>` : "?";
      const dep2   = c.been2.depTime.substring(11, 16);
      const arr1   = c.been1.arrTime.substring(11, 16);
      const duur   = `${Math.floor(c.totaleDuur/60)}u${String(c.totaleDuur%60).padStart(2,"0")}`;
      const ovst   = `${c.overstapMin}min`;
      const vlInfo = `${c.been1.vluchtnummer}&thinsp;${c.been1.van}&thinsp;${c.depHHMM}→ATH&thinsp;${arr1}`
                   + `&ensp;|&ensp;`
                   + `${c.been2.vluchtnummer}&thinsp;ATH&thinsp;${dep2}→JSH&thinsp;${c.arrHHMM}`;
      return `<tr style="background:${bg};">
        ${ci === 0
          ? `<td rowspan="${combis.length}" style="padding:5px 10px;font-size:12px;color:#546e7a;white-space:nowrap;vertical-align:top;">${dagLeesb}</td>
             <td rowspan="${combis.length}" style="padding:5px 10px;font-size:12px;font-weight:600;color:${locatieKleur};vertical-align:top;">${locatieTxt}</td>
             <td rowspan="${combis.length}" style="padding:5px 10px;font-size:12px;vertical-align:top;">${gezochtTxt}</td>`
          : ""}
        <td style="padding:5px 10px;font-size:11px;color:#37474f;">${vlInfo}</td>
        <td style="padding:5px 10px;font-size:12px;text-align:center;">${ovst}&thinsp;overstap</td>
        <td style="padding:5px 10px;font-size:12px;text-align:center;color:#78909c;">${duur}</td>
        <td style="padding:5px 10px;font-size:12px;text-align:right;">${prijs}</td>
      </tr>`;
    }).join("");
  }

  const kalenderRijen = alleDatums.map((ds, i) => dagKalenderRij(ds, i)).join("");

  const dagKalenderHtml = `
    <h2 style="color:#1a237e;font-size:16px;font-weight:700;margin:32px 0 10px;">
      📆&nbsp;Dagkalender
    </h2>
    <table width="100%" cellpadding="0" cellspacing="0"
        style="border-collapse:collapse;font-family:Arial,sans-serif;
               border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;">
      <thead>
        <tr style="background:#283593;color:#fff;">
          <th style="padding:8px 10px;text-align:left;font-size:11px;white-space:nowrap;">Datum</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;">Locatie</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;">Gezocht</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;">Vlucht</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;">Overstap</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;">Duur</th>
          <th style="padding:8px 10px;text-align:right;font-size:11px;">Prijs</th>
        </tr>
      </thead>
      <tbody>${kalenderRijen}</tbody>
    </table>`;

  const html = `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#eceff1;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eceff1;padding:32px 16px;">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0"
    style="max-width:680px;background:#fff;border-radius:10px;
           overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.10);">

  <!-- HEADER -->
  <tr>
    <td style="background:linear-gradient(135deg,#1a237e 0%,#283593 100%);
        padding:28px 30px 22px;">
      <div style="font-size:24px;font-weight:800;color:#fff;letter-spacing:.5px;">
        ✈&nbsp;Sitia Vluchtrapport
      </div>
      <div style="font-size:14px;color:#c5cae9;margin-top:4px;">
        België &harr; Sitia (JSH) via Athene (ATH)
      </div>
      <div style="margin-top:10px;">
        <span style="background:rgba(255,255,255,.2);color:#fff;
            font-size:11px;padding:3px 10px;border-radius:20px;">
          Ryanair (FR) + Aegean (A3)
        </span>
        &nbsp;
        <span style="background:rgba(255,255,255,.15);color:#fff;
            font-size:11px;padding:3px 10px;border-radius:20px;">
          ${timestamp}
        </span>
      </div>
    </td>
  </tr>

  ${quotaBanner}
  ${dryBanner}

  <!-- CRITERIA -->
  <tr>
    <td style="padding:24px 30px 0;">
      <div style="background:#e8eaf6;border-radius:8px;padding:16px 22px;">
        <div style="font-size:11px;font-weight:800;color:#3949ab;
            text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">
          Zoekcriteria
        </div>
        <table cellpadding="0" cellspacing="0">${criteriaRijen}</table>
      </div>
    </td>
  </tr>

  <!-- TOELICHTING -->
  <tr>
    <td style="padding:16px 30px 0;">
      <div style="background:#fff8e1;border-left:3px solid #f9a825;
          padding:10px 14px;border-radius:0 4px 4px 0;font-size:12px;color:#5d4037;">
        💡&nbsp;<strong>Sitia (JSH) is geen internationale luchthaven</strong> en heeft
        geen rechtstreekse vluchten vanuit België. De enige optie is een zelf-samengestelde
        combinatie: Ryanair naar Athene + Aegean naar Sitia. De prijzen zijn de
        <strong>som van 2 losse tickets</strong> — je koopt deze apart en er is
        geen doorboekingsgarantie bij vertraging van de eerste vlucht.
      </div>
    </td>
  </tr>

  <!-- DAGKALENDER -->
  <tr>
    <td style="padding:8px 30px 0;">
      ${dagKalenderHtml}
    </td>
  </tr>

  <!-- VLUCHTEN (detail per richting) -->
  <tr>
    <td style="padding:8px 30px 30px;">
      ${bouwSectieHtml(heenCombis,  "🛫&nbsp; België → Sitia (via ATH)")}
      ${bouwSectieHtml(terugCombis, "🛬&nbsp; Sitia → België (via ATH)")}
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #e0e0e0;">
      <p style="margin:0;font-size:11px;color:#b0bec5;text-align:center;">
        Automatisch gegenereerd via Google Apps Script + SerpApi
        ${isDryRun ? "&nbsp;|&nbsp;<strong style='color:#e65100;'>DRY RUN</strong>" : ""}
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const dryLabel  = isDryRun ? " [DRY RUN]" : "";

  // Datum omzetten naar leesbaar Nederlands (bv. "10 september")
  const MAANDEN = ["januari","februari","maart","april","mei","juni",
                   "juli","augustus","september","oktober","november","december"];
  function leesbareDatum(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    return `${d} ${MAANDEN[m - 1]}`;
  }
  const datumVanLeesbaar = leesbareDatum(periode.van);
  const datumTotLeesbaar = leesbareDatum(periode.tot);

  const onderwerp = totaal > 0
    ? `✈${dryLabel} ${totaal} Sitia-vlucht${totaal !== 1 ? "en" : ""} – ${datumVanLeesbaar}→${datumTotLeesbaar}`
    : `✈${dryLabel} Geen Sitia-vluchten – ${datumVanLeesbaar}→${datumTotLeesbaar}`;

  MailApp.sendEmail({ to: EMAIL_NAAR, subject: onderwerp, htmlBody: html, name: EMAIL_AFZENDER_NAAM });
  console.log(`📧 E-mail verstuurd → ${EMAIL_NAAR}`);
  console.log(`   Onderwerp: ${onderwerp}`);
}

// ============================================================
//  SERPAPI ACCOUNT INFO
//  Gratis endpoint – telt NIET mee voor de quota.
//  Geeft exacte maandgebruik en resterend terug.
// ============================================================

function getAccountInfo() {
  if (DRY_RUN) {
    console.log("  🧪 DRY RUN – account-info overgeslagen");
    return { gebruik: 0, resterend: SERPAPI_MAANDLIMIET, limiet: SERPAPI_MAANDLIMIET, vernieuwing: "?" };
  }
  try {
    const url  = `https://serpapi.com/account.json?api_key=${SERPAPI_KEY}`;
    const resp = UrlFetchApp.fetch(url, { method: "GET", muteHttpExceptions: true });
    const json = JSON.parse(resp.getContentText());
    return {
      gebruik:    json.this_month_usage    || 0,
      resterend:  json.total_searches_left || 0,
      limiet:     json.searches_per_month  || SERPAPI_MAANDLIMIET,
      vernieuwing: json.plan_renewal_date  || "?",
    };
  } catch (e) {
    console.error(`  ❌ Account-info fout: ${e.message}`);
    return { gebruik: "?", resterend: "?", limiet: SERPAPI_MAANDLIMIET, vernieuwing: "?" };
  }
}

// ============================================================
//  ENTRY POINT
// ============================================================

function zoekSitiaVluchten() {

  if (DRY_RUN) {
    console.log("🧪 ══════════════════════════════════════════════════════");
    console.log("🧪  DRY RUN – geen SerpApi calls, wél e-mail");
    console.log("🧪 ══════════════════════════════════════════════════════");
  } else {
    if (!SERPAPI_KEY || SERPAPI_KEY === "JOUW_API_KEY_HIER") {
      console.error("❌ SERPAPI_KEY niet ingevuld!"); return;
    }
  }

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     SITIA VLUCHT SCRAPER  –  Start                      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`\nStrategie:`);
  console.log(`  Heen : CRL/BRU/OST → ATH (Ryanair FR) + ATH → JSH (Aegean A3)`);
  console.log(`  Terug: JSH → ATH (Aegean A3) + ATH → CRL/BRU/OST (Ryanair FR)`);
  console.log(`\nOptimalisatie:`);
  console.log(`  • Been2 (ATH↔JSH) per dag opgehaald – pre-filter: been1 enkel als been2 bestaat`);

  const { van: pVan, tot: pTot } = berekenPeriode();
  const nDagen = datumReeks(pVan, pTot).length;
  console.log(`\n📊 Theoretisch max: ${nDagen} dagen × 2 richtingen × 2 = ${nDagen * 4} calls`);
  console.log(`   Agenda-filter + pre-filter reduceren dit verder`);

  // ── AGENDA-FILTER ──────────────────────────────────────────
  console.log("\n▓▓▓  AGENDA UITLEZEN  ▓▓▓");
  const { heenDagen, terugDagen, aankomstGefilterdHeen, aankomstGefilterdTerug } = leesAgendaDagen(pVan, pTot);

  // ── HEEN: België → JSH ─────────────────────────────────────
  console.log("\n▓▓▓  HEEN: BELGIË → SITIA  ▓▓▓");
  const resultaatHeen = verwerkRichting(
    BELGIE_LUCHTHAVENS_ID, SITIA,
    AIRLINE_BE_ATH, AIRLINE_ATH_JSH,
    "BELGIË → ATH (FR) → JSH (A3)",
    heenDagen
  );
  const heen = resultaatHeen.resultaten;

  // ── TERUG: JSH → België ────────────────────────────────────
  console.log("\n▓▓▓  TERUG: SITIA → BELGIË  ▓▓▓");
  const resultaatTerug = verwerkRichting(
    SITIA, BELGIE_LUCHTHAVENS_ID,
    AIRLINE_ATH_JSH, AIRLINE_BE_ATH,
    "JSH (A3) → ATH → BELGIË (FR)",
    terugDagen
  );
  const terug = resultaatTerug.resultaten;

  // ── SAMENVATTING ───────────────────────────────────────────
  const totaleCalls = resultaatHeen.aantalCalls + resultaatTerug.aantalCalls;

  // Haal exacte quota-stand op via SerpApi Account API (gratis, telt niet mee)
  console.log("\n  📊 Quota opvragen bij SerpApi...");
  const account = getAccountInfo();
  const callsResterend  = account.resterend;
  const callsTotaalMaand = account.gebruik;
  const totaal = heen.length + terug.length;
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     SITIA VLUCHT SCRAPER  –  Samenvatting               ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Heen  : ${heen.length} combinatie(s)`);
  console.log(`  Terug : ${terug.length} combinatie(s)`);
  console.log(`  API-calls deze run : ${totaleCalls}`);

  // Top 10 goedkoopste
  [...heen, ...terug]
    .filter(c => c.prijsTotaal !== null)
    .sort((a, b) => a.prijsTotaal - b.prijsTotaal)
    .slice(0, 10)
    .forEach((c, i) => logCombi(c, i));

  // E-mail
  const periode = { van: formatDatum(pVan), tot: formatDatum(pTot) };
  const apiInfo = {
    callsGedaan:   totaleCalls,
    callsMaand:    callsTotaalMaand,
    callsLimiet:   account.limiet,
    callsResterend,
    vernieuwing:   account.vernieuwing,
    quotaOp:       QUOTA_OP,
  };
  stuurEmail(heen, terug, periode, DRY_RUN, apiInfo, {
    heenDagen,
    terugDagen,
    aankomstGefilterdHeen,
    aankomstGefilterdTerug,
    geenBeen2HeenDagen:  resultaatHeen.geenBeen2Dagen  || new Set(),
    geenBeen2TerugDagen: resultaatTerug.geenBeen2Dagen || new Set(),
  });

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     SITIA VLUCHT SCRAPER  –  Klaar                      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
}
