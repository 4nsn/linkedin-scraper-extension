const BASE = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const UK_GEO_ID = 101165590;
const DELAY_MS = 3000; // pause between requests, same as the Python script

const EXPERIENCE_NAMES = { "1": "Internship", "2": "Entry level", "3": "Associate" };

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopped = false;
const jobs = [];
const seen = new Set();

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
  const cells = [job.title, job.company, job.location, job.posted, job.search];
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
}

function toCsv() {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Title", "Company", "Location", "Posted", "URL", "Search"].map(esc).join(",")];
  jobs.forEach((j) => lines.push([j.title, j.company, j.location, j.posted, j.url, j.search].map(esc).join(",")));
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

  outer: for (const kw of keywords) {
    for (const loc of locations) {
      for (let page = 0; page < settings.pages; page++) {
        if (stopped) break outer;
        setStatus(`Searching "${kw}" in ${loc.name}, page ${page + 1} of ${settings.pages}… (${jobs.length} jobs so far)`);

        let html;
        try {
          html = await fetchPage(kw, loc, page, settings.seconds, experience);
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
          jobs.push(job);
          addRow(job);
        }

        await sleep(DELAY_MS);
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

$("filter").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  for (const tr of $("rows").children) {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
  }
});

run();