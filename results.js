const BASE = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const SPONSOR_API =
  "https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers";
const UK_GEO_ID = 101165590;
const DELAY_MS = 6000; // base pause between requests (a little random jitter is added)
const RETRY_WAITS_MS = [30000, 60000, 120000]; // back-off waits after an HTTP 429
const REGISTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh the register weekly

const EXPERIENCE_NAMES = { "1": "Internship", "2": "Entry level", "3": "Associate" };

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopped = false;
const jobs = [];
const seen = new Set();

// ---- sponsor register (start) ---------------------------------------------

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd|plc|llp|inc|the)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Turns the register CSV into { normalisedName: [isSkilledWorker(1/0), town, originalName] }
function buildSponsorIndex(csvText) {
  const rows = parseCsv(csvText.replace(/^\uFEFF/, ""));
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const find = (re, fallback) => {
    const i = header.findIndex((h) => re.test(h));
    return i >= 0 ? i : fallback;
  };
  const iName = find(/organisation/, 0);
  const iTown = find(/town|city/, 1);
  const iRoute = find(/route/, 4);

  const index = {};
  for (const r of rows) {
    const key = normName(r[iName]);
    if (!key) continue;
    const skilled = /skilled worker/i.test(r[iRoute] || "") ? 1 : 0;
    const prev = index[key];
    if (!prev) index[key] = [skilled, (r[iTown] || "").trim(), (r[iName] || "").trim()];
    else if (skilled) prev[0] = 1;
  }
  return index;
}

function sponsorStatus(company, index) {
  if (!index) return "Check unavailable";
  const key = normName(company);
  if (!key) return "Not found";

  const hit = index[key];
  if (hit) {
    const where = hit[1] ? `, ${hit[1]}` : "";
    return hit[0]
      ? `Licensed (Skilled Worker${where})`
      : `Licensed (other routes only${where})`;
  }

  // Fallback: the register often uses a longer legal name than the job ad
  // (e.g. "Version 1" vs "Version 1 Solutions Limited"). Flag it for a manual check.
  if (key.length >= 5) {
    const prefix = key + " ";
    for (const k in index) {
      if (k.startsWith(prefix)) {
        const v = index[k];
        return `Possible match: ${v[2]}${v[0] ? " (Skilled Worker)" : " (other routes only)"}`;
      }
    }
  }
  return "Not found";
}

// ---- sponsor register (end) -----------------------------------------------

async function getSponsorIndex() {
  try {
    const { sponsors, sponsorsFetchedAt } = await chrome.storage.local.get([
      "sponsors",
      "sponsorsFetchedAt",
    ]);
    if (sponsors && Date.now() - sponsorsFetchedAt < REGISTER_MAX_AGE_MS) return sponsors;

    setStatus("Downloading the UK sponsor register (first run can take a minute)…");
    const meta = await (await fetch(SPONSOR_API)).json();
    const attachments = (meta.details && meta.details.attachments) || [];
    const file = attachments.find((a) => /\.csv(\?|$)/i.test(a.url || ""));
    if (!file) throw new Error("No CSV found in the register publication");

    const csv = await (await fetch(file.url)).text();
    const index = buildSponsorIndex(csv);
    if (!Object.keys(index).length) throw new Error("Register file was empty");

    await chrome.storage.local.set({ sponsors: index, sponsorsFetchedAt: Date.now() });
    return index;
  } catch (err) {
    console.warn("Sponsor register unavailable:", err);
    return null;
  }
}

function parseLocations(text, distance) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => {
      const low = name.toLowerCase();
      if (["uk", "united kingdom"].includes(low)) return { name: "United Kingdom", geoId: UK_GEO_ID };
      if (["worldwide", "world", "global", "anywhere"].includes(low)) {
        return { name: "Worldwide", location: "Worldwide" };
      }
      return { name, location: name, distance };
    });
}

function describePeriod(seconds) {
  let n, unit;
  if (seconds < 3600) [n, unit] = [Math.max(Math.floor(seconds / 60), 1), "minute"];
  else if (seconds < 86400) [n, unit] = [Math.floor(seconds / 3600), "hour"];
  else [n, unit] = [Math.floor(seconds / 86400), "day"];
  return `last ${n} ${unit}${n !== 1 ? "s" : ""}`;
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function fetchPage(keywords, loc, page, seconds, experience) {
  const params = new URLSearchParams({
    keywords,
    start: String(page * 10),
    f_TPR: `r${seconds}`,
    sortBy: "DD",
  });
  if (loc.geoId) params.set("geoId", String(loc.geoId));
  else {
    params.set("location", loc.location);
    if (loc.distance) params.set("distance", String(loc.distance));
  }
  if (experience) params.set("f_E", experience);

  // credentials: "omit" keeps this a plain guest request (no LinkedIn cookies sent)
  const res = await fetch(`${BASE}?${params}`, { credentials: "omit" });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

// Retries politely when LinkedIn answers 429 (too many requests)
async function fetchWithRetry(kw, loc, page, seconds, experience) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchPage(kw, loc, page, seconds, experience);
    } catch (err) {
      if (err.status !== 429 || attempt >= RETRY_WAITS_MS.length || stopped) throw err;
      const wait = RETRY_WAITS_MS[attempt];
      setStatus(`LinkedIn is rate limiting. Waiting ${wait / 1000}s before retry ${attempt + 1} of ${RETRY_WAITS_MS.length}…`);
      await sleep(wait);
    }
  }
}

function parseCards(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("li")].map((card) => {
    const text = (sel) => card.querySelector(sel)?.textContent.trim() || null;
    const link = card.querySelector("a.base-card__full-link");
    const time = card.querySelector("time");
    return {
      title: text("h3.base-search-card__title"),
      company: text("h4.base-search-card__subtitle"),
      location: text("span.job-search-card__location"),
      url: link ? link.getAttribute("href").split("?")[0] : null,
      posted: time ? time.getAttribute("datetime") : null,
    };
  });
}

function addRow(job) {
  const tr = document.createElement("tr");
  tr.dataset.licensed = /^(Licensed|Possible match)/.test(job.sponsor) ? "1" : "0";
  const cells = [job.title, job.company, job.location, job.posted, job.sponsor, job.search];
  cells.forEach((value, i) => {
    const td = document.createElement("td");
    if (i === 0 && job.url) {
      const a = document.createElement("a");
      a.href = job.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = value || "N/A";
      td.appendChild(a);
    } else {
      td.textContent = value || "N/A";
    }
    tr.appendChild(td);
  });
  $("rows").appendChild(tr);
  applyFilters(tr);
}

function applyFilters(onlyRow) {
  const q = $("filter").value.toLowerCase();
  const onlyLicensed = $("onlySponsors").checked;
  const rows = onlyRow ? [onlyRow] : [...$("rows").children];
  for (const tr of rows) {
    const textOk = tr.textContent.toLowerCase().includes(q);
    const sponsorOk = !onlyLicensed || tr.dataset.licensed === "1";
    tr.style.display = textOk && sponsorOk ? "" : "none";
  }
}

function toCsv() {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Title", "Company", "Location", "Posted", "Visa sponsor", "URL", "Search"];
  const lines = [header.map(esc).join(",")];
  jobs.forEach((j) =>
    lines.push([j.title, j.company, j.location, j.posted, j.sponsor, j.url, j.search].map(esc).join(","))
  );
  return lines.join("\n");
}

async function run() {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    setStatus("No settings found. Open the extension popup and start a search.", true);
    return;
  }

  const keywords = settings.keywords.split("\n").map((s) => s.trim()).filter(Boolean);
  const locations = parseLocations(settings.locations, settings.distance);
  if (!locations.length) locations.push({ name: "United Kingdom", geoId: UK_GEO_ID });
  const exclude = settings.exclude.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const experience = settings.experience.join(",") || null;

  const level = settings.experience.map((e) => EXPERIENCE_NAMES[e]).join(" / ");
  $("heading").textContent =
    `${keywords.join(", ")}${level ? ` (${level})` : ""} jobs in ` +
    `${locations.map((l) => l.name).join(", ")}, ${describePeriod(settings.seconds)}`;
  document.title = `${keywords.join(", ")} - Job Results`;

  const sponsorIndex = await getSponsorIndex();
  if (!sponsorIndex) {
    $("sponsorNote").textContent =
      "The sponsor register could not be downloaded, so the Visa sponsor column is unavailable this time.";
  }

  outer: for (const kw of keywords) {
    for (const loc of locations) {
      for (let page = 0; page < settings.pages; page++) {
        if (stopped) break outer;
        setStatus(`Searching "${kw}" in ${loc.name}, page ${page + 1} of ${settings.pages}… (${jobs.length} jobs so far)`);

        let html;
        try {
          html = await fetchWithRetry(kw, loc, page, settings.seconds, experience);
        } catch (err) {
          const hint = err.status === 429 ? " (LinkedIn is rate limiting, try again later)" : "";
          setStatus(`Stopped: ${err.message}${hint}. Showing what was found so far.`, true);
          break outer;
        }

        const cards = parseCards(html);
        if (!cards.length) break; // no more results for this keyword + location

        for (const job of cards) {
          if (!job.title) continue;
          if (job.url && seen.has(job.url)) continue;
          if (exclude.some((w) => job.title.toLowerCase().includes(w))) continue;
          if (job.url) seen.add(job.url);
          job.search = `${kw} / ${loc.name}`;
          job.sponsor = sponsorStatus(job.company, sponsorIndex);
          jobs.push(job);
          addRow(job);
        }

        await sleep(DELAY_MS + Math.random() * 2000);
      }
    }
  }

  $("stop").disabled = true;
  $("csv").disabled = jobs.length === 0;
  if (!$("status").classList.contains("error")) {
    setStatus(stopped ? `Stopped. ${jobs.length} jobs found.` : `Done. ${jobs.length} jobs found.`);
  }
}

$("stop").addEventListener("click", () => {
  stopped = true;
  $("stop").disabled = true;
});

$("csv").addEventListener("click", () => {
  const blob = new Blob([toCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "linkedin_jobs.csv";
  a.click();
  URL.revokeObjectURL(url);
});

$("filter").addEventListener("input", () => applyFilters());
$("onlySponsors").addEventListener("change", () => applyFilters());

run();