const eventGrid = document.querySelector("#event-grid");
const searchInput = document.querySelector("#search");
const facultyToggles = document.querySelector("#faculty-toggles");
const resultCount = document.querySelector("#result-count");
let allEvents = [];
let activeFaculty = "";

fetch("/data/events.json").then((response) => response.json()).then((eventSnapshot) => {
  allEvents = eventSnapshot.events.filter(isTodayOrUpcoming);
  renderFacultyToggles(uniqueSorted(allEvents.map((event) => event.affiliation)));
  renderEvents(allEvents);
}).catch((error) => {
  console.error(error);
  showLoadError("Unable to load the latest event snapshot right now.");
});

searchInput.addEventListener("input", applyFilters);
facultyToggles.addEventListener("click", handleFacultyToggleClick);

function renderEvents(events) {
  resultCount.textContent = `${events.length} ${events.length === 1 ? "event" : "events"}`;

  if (!events.length) {
    eventGrid.innerHTML = '<p class="empty-state">No events match the current filters.</p>';
    return;
  }

  eventGrid.innerHTML = events.map(renderEventCard).join("");
}

function showLoadError(message) {
  resultCount.textContent = "Unavailable";
  eventGrid.innerHTML = `<p class="empty-state">${escapeHtml(message)}</p>`;
}

function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();
  const faculty = activeFaculty;

  const filtered = allEvents.filter((event) => {
    const matchesFaculty = !faculty || event.affiliation === faculty;
    const haystack = [event.title, event.summary, event.sourceLabel, event.affiliation, event.location]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    return matchesFaculty && matchesQuery;
  });

  renderEvents(filtered);
}

function renderFacultyToggles(values) {
  const toggles = values
    .map((value) => {
      const label = formatFacultyLabel(value);
      const isActive = value === activeFaculty;
      return `<button type="button" class="faculty-toggle${isActive ? " is-active" : ""}" data-faculty="${escapeAttribute(value)}">${escapeHtml(label)}</button>`;
    })
    .join("");
  facultyToggles.innerHTML = `<button type="button" class="faculty-toggle${activeFaculty === "" ? " is-active" : ""}" data-faculty="">All</button>${toggles}`;
}

function handleFacultyToggleClick(event) {
  const button = event.target.closest(".faculty-toggle");
  if (!button) {
    return;
  }

  activeFaculty = button.dataset.faculty || "";
  updateActiveFacultyToggle();
  applyFilters();
}

function updateActiveFacultyToggle() {
  for (const button of facultyToggles.querySelectorAll(".faculty-toggle")) {
    button.classList.toggle("is-active", (button.dataset.faculty || "") === activeFaculty);
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function renderEventCard(event) {
  const whenLabel = formatEventWhen(event.start);
  const facultyLabel = formatFacultyLabel(event.affiliation);

  return `
    <article class="event-card">
      <div class="event-main">
        <div class="event-meta">
          <span class="badge faculty-label">${escapeHtml(facultyLabel)}</span>
        </div>
        <h3 class="event-title">${escapeHtml(event.title)}</h3>
        <p class="event-summary">${escapeHtml(event.summary)}</p>
      </div>
      <div class="event-side">
        <dl class="event-facts">
          <div><dt>When</dt><dd class="event-when">${escapeHtml(whenLabel)}</dd></div>
          <div><dt>Where</dt><dd class="event-where">${escapeHtml(event.location || "Location not extracted yet")}</dd></div>
        </dl>
        <a class="event-link" target="_blank" rel="noreferrer" href="${escapeAttribute(event.postingUrl)}">Open link</a>
      </div>
    </article>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function formatEventWhen(value) {
  if (!value) {
    return "Date not extracted yet";
  }

  const parsed = parseEventDateParts(value);
  if (!parsed) {
    return value;
  }

  const { year, month, day, time } = parsed;
  const date = new Date(`${year}-${month}-${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const eventDay = new Date(date);
  eventDay.setHours(0, 0, 0, 0);

  let label;
  if (eventDay.getTime() === today.getTime()) {
    label = "Today";
  } else if (eventDay.getTime() === tomorrow.getTime()) {
    label = "Tomorrow";
  } else {
    label = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
  }

  return time ? `${label}, ${year}-${month}-${day} ${time}` : `${label}, ${year}-${month}-${day}`;
}

function isTodayOrUpcoming(event) {
  const candidate = toComparableDate(event?.end || event?.start || "");
  if (!candidate) {
    return true;
  }

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return candidate >= `${year}-${month}-${day}`;
}

function parseEventDateParts(value) {
  const text = String(value ?? "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(.+))?$/);
  if (isoMatch) {
    return { year: isoMatch[1], month: isoMatch[2], day: isoMatch[3], time: isoMatch[4] || "" };
  }

  const dottedMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(.+))?$/);
  if (dottedMatch) {
    return { year: dottedMatch[3], month: dottedMatch[2], day: dottedMatch[1], time: dottedMatch[4] || "" };
  }

  return null;
}

function toComparableDate(value) {
  const text = String(value ?? "").trim();
  const shortRangeMatch = text.match(/^(\d{2})\.-(\d{2})\.(\d{2})\.(\d{4})$/);
  if (shortRangeMatch) {
    return `${shortRangeMatch[4]}-${shortRangeMatch[3]}-${shortRangeMatch[2]}`;
  }

  const fullRangeMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})$/);
  if (fullRangeMatch) {
    return `${fullRangeMatch[6]}-${fullRangeMatch[5]}-${fullRangeMatch[4]}`;
  }

  const parsed = parseEventDateParts(value);
  if (!parsed) {
    return "";
  }
  return `${parsed.year}-${parsed.month}-${parsed.day}`;
}

function formatFacultyLabel(value) {
  const code = String(value || "ETH Zurich").trim();
  const fullName = FACULTY_NAMES[code];
  return fullName ? `${code} - ${fullName}` : code;
}

const FACULTY_NAMES = {
  "D-ARCH": "Architecture",
  "D-BAUG": "Civil, Environmental and Geomatic Engineering",
  "D-BIOL": "Biology",
  "D-BSSE": "Biosystems Science and Engineering",
  "D-CHAB": "Chemistry and Applied Biosciences",
  "D-EAPS": "Earth and Planetary Sciences",
  "D-GESS": "Humanities, Social and Political Sciences",
  "D-HEST": "Health Sciences and Technology",
  "D-INFK": "Computer Science",
  "D-ITET": "Information Technology and Electrical Engineering",
  "D-MATH": "Mathematics",
  "D-MATL": "Department of Materials",
  "D-MAVT": "Mechanical and Process Engineering",
  "D-MTEC": "Management, Technology, and Economics",
  "D-PHYS": "Physics",
  "D-USYS": "Environmental Systems Science",
  "ETH Zurich": "ETH Zurich",
  "ETH Entrepreneurship": "ETH Entrepreneurship",
  "ETH Library": "ETH Library",
  "ETH Global": "ETH Global",
  "Quantum Center": "Quantum Center",
  "ISTP": "Institute of Science, Technology and Policy",
  "MaP": "Materials and Processes"
};
