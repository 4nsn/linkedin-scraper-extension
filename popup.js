const DEFAULTS = {
  keywords: "Junior Software Engineer",
  locations: "Manchester, England, United Kingdom\nUK",
  distance: 25,
  pages: 10,
  seconds: 604800,
  experience: ["2", "3"],
  exclude: "senior, lead, principal, staff, manager, head of",
};

const $ = (id) => document.getElementById(id);

function readForm() {
  return {
    keywords: $("keywords").value,
    locations: $("locations").value,
    distance: Number($("distance").value) || 0,
    pages: Math.max(1, Number($("pages").value) || 1),
    seconds: Number($("seconds").value),
    experience: [...document.querySelectorAll("#experience input:checked")].map((c) => c.value),
    exclude: $("exclude").value,
  };
}

function fillForm(s) {
  $("keywords").value = s.keywords;
  $("locations").value = s.locations;
  $("distance").value = s.distance;
  $("pages").value = s.pages;
  $("seconds").value = String(s.seconds);
  document.querySelectorAll("#experience input").forEach((c) => {
    c.checked = s.experience.includes(c.value);
  });
  $("exclude").value = s.exclude;
}

async function init() {
  const { settings } = await chrome.storage.local.get("settings");
  fillForm({ ...DEFAULTS, ...(settings || {}) });
}

$("search").addEventListener("click", async () => {
  const settings = readForm();
  if (!settings.keywords.trim()) {
    $("keywords").focus();
    return;
  }
  await chrome.storage.local.set({ settings });
  await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
  window.close();
});

init();