// ============================================================
//  VLUCHT SCRAPER  –  België ↔ Kreta
//  Google Apps Script  |  Gebruikt SerpApi Google Flights
// ============================================================
//
//  HOE GEBRUIKEN:
//  1. Ga naar script.google.com → nieuw project
//  2. Plak dit hele bestand
//  3. Vul SERPAPI_KEY, EMAIL_NAAR in (zie hieronder)
//  4. Klik ▶ Run → zoekAlleVluchten
//  5. Logs: Weergave → Logboeken
//
//  GRATIS TIER SerpApi: 250 searches/maand
//  15 dagen × 3 vertrek × 2 bestemming × 2 richtingen = 180 calls/uitvoering
// ============================================================

// ============================================================
//  ▼▼▼  CONFIGURATIE – HIER AANPASSEN  ▼▼▼
// ============================================================

// SerpApi key – haal op via https://serpapi.com/manage-api-key
const SERPAPI_KEY = "JOUW_API_KEY_HIER";

// E-mailadres voor het rapport
const EMAIL_NAAR  = "JOUW_EMAIL_HIER";

// DRY_RUN = true  → geen SerpApi calls, wél een e-mail (met DRY RUN banner)
// DRY_RUN = false → echte uitvoering
const DRY_RUN = true;

const CRITERIA = {
  // null = automatisch (vandaag +3 t/m +17 dagen)
  // Vaste periode: "DD/MM/JJJJ"
  datumVan:           null,
  datumTot:           null,
  maximumPrijs:       250,       // EUR, per persoon, enkele reis
  overstapMinMinuten: 60,        // min. overstaptijd ATH
  overstapMaxMinuten: 240,       // max. overstaptijd ATH
  vroegsteVertrekuur: "06:00",   // HH:MM
  laatsteAankomstuur: "23:59",   // HH:MM
};

// ============================================================
//  VASTE CONFIGURATIE
// ============================================================

const LUCHTHAVENS_BELGIE = ["OST", "CRL", "BRU"];
const LUCHTHAVENS_KRETA  = ["HER"];  // HER = Heraklion (JSH heeft geen geschikte vluchten)
const OVERSTAP_IATA      = "ATH";

const GEWENSTE_AIRLINES = {
  "TUI fly Belgium":   ["TB"],
  "Ryanair":           ["FR"],
  "Aegean":            ["A3"],
  "Brussels Airlines": ["SN"],
  "Transavia":         ["HV", "TO"],
  "Corendon":          ["XC"],
  "Sky Express":       ["GQ"],
};
const ALLE_AIRLINE_CODES = Object.values(GEWENSTE_AIRLINES).flat();

// ============================================================
//  DATUM-HULPFUNCTIES
// ============================================================

function parseDate(str) {
  const [d, m, y] = str.split("/").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date) {
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
    van = parseDate(CRITERIA.datumVan);
    tot = parseDate(CRITERIA.datumTot);
    console.log(`  📅 Vaste periode: ${formatDate(van)} → ${formatDate(tot)}`);
  } else {
    van = new Date();
    van.setDate(van.getDate() + 3);
    van.setHours(0, 0, 0, 0);
    tot = new Date(van);
    tot.setDate(tot.getDate() + 14);
    console.log(`  📅 Auto periode: ${formatDate(van)} → ${formatDate(tot)}`);
  }
  return { van, tot };
}

// ============================================================
//  AIRLINE-HULPFUNCTIES
// ============================================================

function isGewensteAirline(iataCode) {
  return ALLE_AIRLINE_CODES.includes(iataCode);
}

// ============================================================
//  SERPAPI – 1 ZOEKOPDRACHT
// ============================================================

function serpApiZoek(vertrek, aankomst, datum) {
  const datumStr = formatDate(datum);

  if (DRY_RUN) {
    console.log(`  🧪 DRY RUN – geen call: ${vertrek} → ${aankomst} op ${datumStr}`);
    return null;
  }

  console.log(`  📡 SerpApi call: ${vertrek} → ${aankomst} op ${datumStr}`);

  const params = {
    engine:        "google_flights",
    departure_id:  vertrek,
    arrival_id:    aankomst,
    outbound_date: datumStr,
    type:          "2",
    max_stops:     "1",
    currency:      "EUR",
    hl:            "nl",
    gl:            "be",
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
    if (code === 429) { console.warn("  ⚠️  Rate limit – pauze 5s"); Utilities.sleep(5000); return null; }
    if (code !== 200) { console.warn(`  ⚠️  Status ${code}`); return null; }
    const json = JSON.parse(resp.getContentText());
    if (json.error) { console.error(`  ❌ SerpApi: ${json.error}`); return null; }
    return json;
  } catch (e) {
    console.error(`  ❌ Fetch-fout: ${e.message}`);
    return null;
  }
}

// ============================================================
//  PARSE SERPAPI JSON → vlucht-objecten
// ============================================================

function parseResultaat(json, vertrek, aankomst, datum) {
  if (!json) return [];
  const secties = [...(json.best_flights || []), ...(json.other_flights || [])];
  console.log(`  📦 Itineraria ontvangen: ${secties.length}`);
  const vluchten = [];
  for (const it of secties) {
    const segs     = it.flights  || [];
    const prijs    = it.price    || null;
    const layovers = it.layovers || [];
    if (segs.length === 0) continue;
    const alleOK = segs.every(s =>
      isGewensteAirline((s.flight_number || "").substring(0, 2).trim()));
    if (!alleOK) { console.log("    ↩ Overgeslagen: niet-gewenste airline"); continue; }
    const depTime = segs[0].departure_airport?.time            || "";
    const arrTime = segs[segs.length - 1].arrival_airport?.time || "";
    let type = "direct", overstapMin = null;
    if (segs.length > 1) {
      const stopId = segs[0].arrival_airport?.id || "";
      if (stopId !== OVERSTAP_IATA) {
        console.log(`    ↩ Overgeslagen: stop via ${stopId}`); continue;
      }
      type = "via-ATH";
      overstapMin = layovers.length > 0 ? layovers[0].duration : null;
    }
    vluchten.push({
      type, overstapMin, prijs,
      depHHMM:    depTime.substring(11, 16),
      arrHHMM:    arrTime.substring(11, 16),
      route:      `${vertrek}→${aankomst}`,
      datum:      formatDate(datum),
      totaleDuur: it.total_duration || null,
      segmenten:  segs.map(s => ({
        vluchtnummer: s.flight_number           || "?",
        airlineNaam:  s.airline                 || "?",
        van:          s.departure_airport?.id   || "?",
        naar:         s.arrival_airport?.id     || "?",
        depTime:      s.departure_airport?.time || "?",
        arrTime:      s.arrival_airport?.time   || "?",
        duur:         s.duration                || 0,
      })),
    });
  }
  console.log(`  ✈️  Na airline-filter: ${vluchten.length}`);
  return vluchten;
}

// ============================================================
//  FILTER OP CRITERIA
// ============================================================

function filterVluchten(vluchten) {
  const vroegsteMin = tijdNaarMinuten(CRITERIA.vroegsteVertrekuur);
  const laaststeMin = tijdNaarMinuten(CRITERIA.laatsteAankomstuur);
  return vluchten.filter(v => {
    if (v.prijs !== null && v.prijs > CRITERIA.maximumPrijs) {
      console.log(`    🚫 Prijs €${v.prijs} > €${CRITERIA.maximumPrijs}`); return false; }
    if (tijdNaarMinuten(v.depHHMM) < vroegsteMin) {
      console.log(`    🚫 Vertrek ${v.depHHMM} te vroeg`); return false; }
    if (tijdNaarMinuten(v.arrHHMM) > laaststeMin) {
      console.log(`    🚫 Aankomst ${v.arrHHMM} te laat`); return false; }
    if (v.type === "via-ATH" && v.overstapMin !== null) {
      if (v.overstapMin < CRITERIA.overstapMinMinuten) {
        console.log(`    🚫 Overstap ${v.overstapMin}min te kort`); return false; }
      if (v.overstapMin > CRITERIA.overstapMaxMinuten) {
        console.log(`    🚫 Overstap ${v.overstapMin}min te lang`); return false; }
    }
    return true;
  });
}

// ============================================================
//  LOG
// ============================================================

function logVlucht(v, i) {
  const prijs = v.prijs !== null ? `€${v.prijs}` : "prijs ?";
  const duur  = v.totaleDuur
    ? `${Math.floor(v.totaleDuur / 60)}u${String(v.totaleDuur % 60).padStart(2,"0")}m` : "?";
  console.log(`\n  ┌─ [${i+1}] ${v.route} | ${v.datum} | ${v.type.toUpperCase()} | ${prijs} | ${duur}`);
  v.segmenten.forEach((s, j) => {
    const dep = s.depTime.substring(11, 16);
    const arr = s.arrTime.substring(11, 16);
    const d   = `${Math.floor(s.duur/60)}u${String(s.duur%60).padStart(2,"0")}m`;
    console.log(`  │  ✈ ${s.vluchtnummer.padEnd(8)} ${s.airlineNaam.padEnd(20)} ${s.van} ${dep} → ${s.naar} ${arr} (${d})`);
    if (j < v.segmenten.length - 1 && v.overstapMin)
      console.log(`  │  ⏱  Overstap ATH: ${v.overstapMin} min`);
  });
  console.log(`  └${"─".repeat(53)}`);
}

// ============================================================
//  VERWERK ÉÉN RICHTING
// ============================================================

function verwerkRichting(vertrekLH, aankomstLH, label) {
  console.log(`\n${"═".repeat(62)}\n  ${label}\n${"═".repeat(62)}`);
  const { van: dVan, tot: dTot } = berekenPeriode();
  const datums = datumReeks(dVan, dTot);
  console.log(`  🛫 Van: ${vertrekLH.join(", ")}  🛬 Naar: ${aankomstLH.join(", ")}`);
  console.log(`  💶 Max €${CRITERIA.maximumPrijs}  ⏱ ${CRITERIA.overstapMinMinuten}–${CRITERIA.overstapMaxMinuten}min  🕐 ${CRITERIA.vroegsteVertrekuur}–${CRITERIA.laatsteAankomstuur}`);
  const resultaten = [];
  for (const van of vertrekLH) {
    for (const naar of aankomstLH) {
      for (const datum of datums) {
        console.log(`\n  ── ${van} → ${naar} | ${formatDate(datum)}`);
        const json      = serpApiZoek(van, naar, datum);
        const gevonden  = parseResultaat(json, van, naar, datum);
        const gefilterd = filterVluchten(gevonden);
        console.log(`  ✅ ${gefilterd.length}/${gevonden.length}`);
        gefilterd.forEach(v => { logVlucht(v, resultaten.length); resultaten.push(v); });
        if (!DRY_RUN) Utilities.sleep(500);
      }
    }
  }
  console.log(`\n  TOTAAL ${label}: ${resultaten.length} vlucht(en)`);
  return resultaten;
}

// ============================================================
//  E-MAIL  –  HTML-opmaak
// ============================================================

function bouwVluchtRij(v, i) {
  const prijs    = v.prijs !== null ? `€${v.prijs}` : "?";
  const duur     = v.totaleDuur
    ? `${Math.floor(v.totaleDuur/60)}u${String(v.totaleDuur%60).padStart(2,"0")}m` : "?";
  const typeLabel = v.type === "direct" ? "Direct" : "Via ATH";
  const typeKleur = v.type === "direct" ? "#2e7d32" : "#1565c0";
  const bgRij     = i % 2 === 0 ? "#ffffff" : "#f7f8fc";
  let html = "";
  v.segmenten.forEach((s, j) => {
    const dep = s.depTime.substring(11, 16);
    const arr = s.arrTime.substring(11, 16);
    const d   = `${Math.floor(s.duur/60)}u${String(s.duur%60).padStart(2,"0")}m`;
    html += `<tr style="background:${bgRij};">
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;">
        ${j === 0 ? `
          <div style="font-size:14px;font-weight:700;color:#1a1a1a;">
            ${i+1}.&nbsp;${v.route}
            <span style="font-weight:400;color:#9e9e9e;font-size:12px;">&nbsp;${v.datum}</span>
          </div>
          <div style="margin-top:4px;">
            <span style="display:inline-block;padding:2px 8px;border-radius:3px;
              font-size:11px;font-weight:700;letter-spacing:.3px;
              color:#fff;background:${typeKleur};">${typeLabel}</span>
            &nbsp;
            <span style="font-size:17px;font-weight:800;color:#c62828;">${prijs}</span>
            <span style="font-size:12px;color:#9e9e9e;">&nbsp;totaal&nbsp;${duur}</span>
          </div>` : "&nbsp;"}
      </td>
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;
          font-weight:700;color:#263238;vertical-align:middle;">${s.vluchtnummer}</td>
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;
          vertical-align:middle;">${s.airlineNaam}</td>
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;
          font-weight:600;vertical-align:middle;white-space:nowrap;">
        ${s.van}&thinsp;→&thinsp;${s.naar}</td>
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;
          vertical-align:middle;">${dep}</td>
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;
          vertical-align:middle;">${arr}</td>
      <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;
          color:#78909c;vertical-align:middle;">${d}</td>
    </tr>`;
    if (j < v.segmenten.length - 1 && v.overstapMin) {
      html += `<tr style="background:#fffde7;">
        <td colspan="7" style="padding:5px 14px;font-size:11px;color:#e65100;
            font-style:italic;border-bottom:1px solid #eee;">
          ⏱&nbsp;Overstap Athene (ATH):&nbsp;<strong>${v.overstapMin}&nbsp;min</strong>
        </td>
      </tr>`;
    }
  });
  return html;
}

function bouwSectieHtml(vluchten, titel) {
  if (vluchten.length === 0) return `
    <h2 style="color:#546e7a;font-size:16px;font-weight:700;margin:32px 0 8px;">${titel}</h2>
    <p style="color:#b0bec5;font-style:italic;font-size:13px;margin:0 0 8px;">
      Geen vluchten gevonden die aan alle criteria voldoen.</p>`;
  const rijen = vluchten.map((v, i) => bouwVluchtRij(v, i)).join("");
  return `
    <h2 style="color:#1a237e;font-size:16px;font-weight:700;margin:32px 0 10px;">${titel}</h2>
    <table width="100%" cellpadding="0" cellspacing="0"
        style="border-collapse:collapse;font-family:Arial,sans-serif;
               border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;">
      <thead>
        <tr style="background:#283593;color:#fff;">
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Vlucht</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Nr</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Maatschappij</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Route</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Vertrek</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Aankomst</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;">Duur</th>
        </tr>
      </thead>
      <tbody>${rijen}</tbody>
    </table>`;
}

function stuurEmail(heenVluchten, terugVluchten, periode, isDryRun) {
  if (!EMAIL_NAAR || EMAIL_NAAR === "JOUW_EMAIL_HIER") {
    console.warn("⚠️  EMAIL_NAAR niet ingevuld – e-mail overgeslagen.");
    return;
  }

  const totaal    = heenVluchten.length + terugVluchten.length;
  const timestamp = new Date().toLocaleString("nl-BE");

  const dryBanner = isDryRun ? `
    <tr><td style="padding:0 30px 20px;">
      <div style="background:#e65100;color:#fff;padding:14px 18px;border-radius:6px;
          font-size:13px;font-weight:700;letter-spacing:.3px;">
        🧪&nbsp; DRY RUN – testrapport zonder echte SerpApi-zoekopdrachten.
        Vluchtdata is leeg; de opmaak en het e-mailadres worden getest.
      </div>
    </td></tr>` : "";

  const criteriaRijen = [
    ["Periode",          `${periode.van} → ${periode.tot}`],
    ["Vertrek (heen)",   LUCHTHAVENS_BELGIE.join(", ")],
    ["Aankomst (heen)",  LUCHTHAVENS_KRETA.join(", ")],
    ["Vertrek (terug)",  LUCHTHAVENS_KRETA.join(", ")],
    ["Aankomst (terug)", LUCHTHAVENS_BELGIE.join(", ")],
    ["Overstap via",     OVERSTAP_IATA],
    ["Airlines",         Object.entries(GEWENSTE_AIRLINES).map(([n,c]) => `${n} (${c.join("/")})`).join(", ")],
    ["Max. prijs",       `€${CRITERIA.maximumPrijs} p.p.`],
    ["Overstap ATH",     `${CRITERIA.overstapMinMinuten} – ${CRITERIA.overstapMaxMinuten} min`],
    ["Dagvenster",       `${CRITERIA.vroegsteVertrekuur} – ${CRITERIA.laatsteAankomstuur}`],
    ["Vluchten heen",    `${heenVluchten.length}`],
    ["Vluchten terug",   `${terugVluchten.length}`],
  ].map(([k, val]) => `
    <tr>
      <td style="padding:4px 16px 4px 0;font-size:13px;color:#546e7a;
          white-space:nowrap;width:160px;vertical-align:top;">${k}</td>
      <td style="padding:4px 0;font-size:13px;font-weight:600;color:#1a1a1a;">${val}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#eceff1;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eceff1;padding:32px 16px;">
<tr><td align="center">
<table width="660" cellpadding="0" cellspacing="0"
    style="max-width:660px;background:#fff;border-radius:10px;
           overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.10);">

  <!-- HEADER -->
  <tr>
    <td style="background:#1a237e;padding:30px 30px 24px;">
      <div style="font-size:26px;font-weight:800;color:#fff;letter-spacing:.5px;">
        ✈&nbsp;Vluchtrapport
      </div>
      <div style="font-size:15px;color:#c5cae9;margin-top:4px;">
        België &harr; Kreta
      </div>
      <div style="margin-top:12px;">
        <span style="display:inline-block;background:rgba(255,255,255,.15);
            color:#fff;font-size:12px;padding:4px 12px;border-radius:20px;">
          ${timestamp}
        </span>
      </div>
    </td>
  </tr>

  ${dryBanner}

  <!-- CRITERIA -->
  <tr>
    <td style="padding:24px 30px 0;">
      <div style="background:#e8eaf6;border-radius:8px;padding:18px 22px;">
        <div style="font-size:11px;font-weight:800;color:#3949ab;
            text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">
          Zoekcriteria
        </div>
        <table cellpadding="0" cellspacing="0">${criteriaRijen}</table>
      </div>
    </td>
  </tr>

  <!-- VLUCHTEN -->
  <tr>
    <td style="padding:8px 30px 30px;">
      ${bouwSectieHtml(heenVluchten, "🛫&nbsp; België → Kreta")}
      ${bouwSectieHtml(terugVluchten, "🛬&nbsp; Kreta → België")}
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f5f5f5;padding:16px 30px;border-top:1px solid #e0e0e0;">
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
  const onderwerp = totaal > 0
    ? `✈${dryLabel} ${totaal} vlucht${totaal !== 1 ? "en" : ""} – BE↔Kreta ${periode.van}→${periode.tot}`
    : `✈${dryLabel} Geen vluchten – BE↔Kreta ${periode.van}→${periode.tot}`;

  MailApp.sendEmail({ to: EMAIL_NAAR, subject: onderwerp, htmlBody: html });
  console.log(`📧 E-mail verstuurd → ${EMAIL_NAAR}`);
  console.log(`   Onderwerp: ${onderwerp}`);
}

// ============================================================
//  ENTRY POINT
// ============================================================

function zoekAlleVluchten() {

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
  console.log("║         VLUCHT SCRAPER  –  Start                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  console.log("\nAirlines:");
  Object.entries(GEWENSTE_AIRLINES)
    .forEach(([n, c]) => console.log(`  • ${n.padEnd(22)} (${c.join(", ")})`));

  const { van: pVan, tot: pTot } = berekenPeriode();
  const nDagen  = datumReeks(pVan, pTot).length;
  const nRoutes = LUCHTHAVENS_BELGIE.length * LUCHTHAVENS_KRETA.length * 2;
  console.log(`\n📊 ${nDagen} dagen × ${nRoutes} routes = ~${nDagen * nRoutes} calls (max 250/maand)`);
  if (!DRY_RUN && nDagen * nRoutes > 250)
    console.warn("⚠️  Quota kan worden overschreden!");

  console.log("\n▓▓▓  DEEL 1: BELGIË → KRETA  ▓▓▓");
  const heen = verwerkRichting(LUCHTHAVENS_BELGIE, LUCHTHAVENS_KRETA, "BELGIË → KRETA");

  console.log("\n▓▓▓  DEEL 2: KRETA → BELGIË  ▓▓▓");
  const terug = verwerkRichting(LUCHTHAVENS_KRETA, LUCHTHAVENS_BELGIE, "KRETA → BELGIË");

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         SAMENVATTING                                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Heen  : ${heen.length} vlucht(en)`);
  console.log(`  Terug : ${terug.length} vlucht(en)`);

  [...heen, ...terug]
    .filter(v => v.prijs !== null)
    .sort((a, b) => a.prijs - b.prijs)
    .slice(0, 10)
    .forEach((v, i) => logVlucht(v, i));

  const periode = { van: formatDate(pVan), tot: formatDate(pTot) };
  stuurEmail(heen, terug, periode, DRY_RUN);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         VLUCHT SCRAPER  –  Klaar                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
}
