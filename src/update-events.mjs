import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sources } from "./config/sources.mjs";
import {
  extractCalendarApiLinks,
  extractEventCalendarConfigs,
  extractHeuristicEvents,
  extractIcsLinks,
  extractJsonLdEvents,
  extractLinks,
  extractMathSeminarEvents,
  extractSocialLinks,
  extractTableJsonUrls,
  getMeta,
  getTitle,
  stripHtml,
  mergeEvents
} from "./lib/extractors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");

async function main() {
  const results = [];
  const allEvents = [];

  for (const source of sources) {
    const result = await scrapeSource(source);
    results.push(result);
    allEvents.push(...result.events);
  }

  const events = normalizeEvents(allEvents);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    sourceCount: results.length,
    events
  };

  const sourceSnapshot = {
    generatedAt: snapshot.generatedAt,
    sources: results.map((result) => ({
      id: result.source.id,
      label: result.source.label,
      affiliation: result.source.affiliation,
      url: result.source.url,
      status: result.status,
      warnings: result.warnings,
      socialProfiles: result.socialProfiles,
      discoveredCalendarApis: result.discoveredCalendarApis,
      discoveredIcsLinks: result.discoveredIcsLinks,
      eventCount: result.events.length
    }))
  };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "events.json"), JSON.stringify(snapshot, null, 2));
  await fs.writeFile(path.join(dataDir, "sources.json"), JSON.stringify(sourceSnapshot, null, 2));

  console.log(`Updated ${events.length} events from ${results.length} sources at ${snapshot.generatedAt}`);
  for (const result of results) {
    console.log(`- ${result.source.label}: ${result.events.length} events, ${result.status}`);
    for (const warning of result.warnings) {
      console.log(`  warning: ${warning}`);
    }
  }
}

async function scrapeSource(source) {
  const warnings = [];

  try {
    const response = await fetch(source.url, {
      headers: {
        "user-agent": "ETHZ-Events-Hub/0.1 (+https://ethz.ch)"
      }
    });

    if (!response.ok) {
      return {
        source,
        status: `http-${response.status}`,
        warnings: [`Request failed with status ${response.status}`],
        socialProfiles: [],
        discoveredCalendarApis: [],
        discoveredIcsLinks: [],
        events: []
      };
    }

    const html = await response.text();
    const links = extractLinks(html, source.url);
    const socialProfiles = extractSocialLinks(links);
    const widgetConfigs = extractEventCalendarConfigs(html, source.url);
    const tableJsonUrls = extractTableJsonUrls(html, source.url);
    const discoveredCalendarApis = [...extractCalendarApiLinks(links), ...widgetConfigs.map((config) => config.eventsUrl)];
    const discoveredIcsLinks = extractIcsLinks(links);

    if (!discoveredCalendarApis.length) {
      warnings.push("No public ETH calendar API link discovered on this page.");
    }

    const widgetEvents = enrichEvents(await fetchWidgetEvents(widgetConfigs, source), source, "event-calendar-api");
    const tableEvents = enrichEvents(await fetchTableEvents(tableJsonUrls, source), source, "table-json");
    const mathSeminarEvents = enrichEvents(extractMathSeminarEvents(html, source.url), source, "math-seminar-table");
    const jsonLdEvents = enrichEvents(extractJsonLdEvents(html, source.url), source, "json-ld");
    const htmlEvents = enrichEvents(extractHeuristicEvents(html, source.url), source, "html");
    const icsEvents = enrichEvents(
      discoveredIcsLinks.map((link) => ({
        title: link.text || inferTitleFromUrl(link.url),
        summary: `ICS link discovered on ${source.label}`,
        start: "",
        end: "",
        location: "",
        postingUrl: link.url,
        imageUrl: "",
        evidence: "ics-link"
      })),
      source,
      "ics-link"
    );

    const events = mergeEvents(widgetEvents, tableEvents, mathSeminarEvents, jsonLdEvents, htmlEvents, icsEvents);

    if (!events.length) {
      const fallbackTitle = getMeta(html, "og:title") || getTitle(html) || source.label;
      const fallbackSummary =
        getMeta(html, "description") ||
        getMeta(html, "og:description") ||
        `No individual event blocks were extracted from ${source.label}.`;
      warnings.push("Only page-level fallback item available; this source likely needs a custom extractor.");
      events.push(
        enrichEvents(
          [
            {
              title: fallbackTitle,
              summary: fallbackSummary,
              start: "",
              end: "",
              location: "",
              postingUrl: source.url,
              imageUrl: getMeta(html, "og:image"),
              evidence: "page-fallback"
            }
          ],
          source,
          "fallback"
        )[0]
      );
    }

    return {
      source,
      status: "ok",
      warnings,
      socialProfiles,
      discoveredCalendarApis,
      discoveredIcsLinks: discoveredIcsLinks.map((item) => item.url),
      events
    };
  } catch (error) {
    return {
      source,
      status: "error",
      warnings: [error.message],
      socialProfiles: [],
      discoveredCalendarApis: [],
      discoveredIcsLinks: [],
      events: []
    };
  }
}

async function fetchWidgetEvents(widgetConfigs, source) {
  const events = [];

  for (const config of widgetConfigs) {
    if (!config.eventsUrl) {
      continue;
    }

    try {
      const response = await fetch(config.eventsUrl, {
        headers: {
          "user-agent": "ETHZ-Events-Hub/0.1 (+https://ethz.ch)",
          accept: "application/json"
        }
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const entries = Array.isArray(payload?.["entry-array"]) ? payload["entry-array"] : [];

      for (const entry of entries) {
        const mapped = mapWidgetEntry(entry, config, source);
        if (mapped) {
          events.push(mapped);
        }
      }
    } catch {
      continue;
    }
  }

  return events;
}

async function fetchTableEvents(tableJsonUrls, source) {
  const events = [];

  for (const tableJsonUrl of tableJsonUrls) {
    try {
      const response = await fetch(tableJsonUrl, {
        headers: {
          "user-agent": "ETHZ-Events-Hub/0.1 (+https://ethz.ch)",
          accept: "application/json"
        }
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const headers = (payload?.thead?.rows?.[0]?.cells ?? []).map((cell) => stripHtml(cell?.content ?? "").toLowerCase());
      const rows = payload?.tbody?.rows ?? [];

      for (const row of rows) {
        const mapped = mapTableRow(row?.cells ?? [], headers, source.url);
        if (mapped) {
          events.push(mapped);
        }
      }
    } catch {
      continue;
    }
  }

  return events;
}

function enrichEvents(events, source, extractor) {
  return events.map((event) => ({
    id: `${source.id}:${slugify(event.title || event.postingUrl)}`,
    title: event.title,
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location,
    postingUrl: event.postingUrl,
    imageUrl: event.imageUrl,
    sourceId: source.id,
    sourceLabel: source.label,
    affiliation: source.affiliation,
    sourcePageUrl: source.url,
    extractor,
    evidence: event.evidence
  }));
}

function normalizeEvents(events) {
  const deduped = new Map();
  const today = formatLocalDate(new Date());

  for (const event of events) {
    const key = `${event.postingUrl}::${event.title}`.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, event);
      continue;
    }

    const existing = deduped.get(key);
    if ((existing.summary?.length ?? 0) < (event.summary?.length ?? 0)) {
      deduped.set(key, { ...existing, ...event });
    }
  }

  return [...deduped.values()]
    .filter((event) => isUpcomingEvent(event, today))
    .sort((left, right) => {
      const a = left.start || "9999";
      const b = right.start || "9999";
      return a.localeCompare(b) || left.title.localeCompare(right.title);
    })
    .map((event) => ({
      ...event,
      title: event.title || event.sourceLabel,
      summary: event.summary || "No summary extracted yet.",
      location: event.location || "TBD",
      start: event.start || "",
      end: event.end || ""
    }));
}

function inferTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop()?.replace(/[-_]/g, " ") || url;
  } catch {
    return url;
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function mapWidgetEntry(entry, config, source) {
  const title = cleanSnippet(entry?.content?.title);
  if (!title) {
    return null;
  }

  const detailUrl = buildDetailUrl(config.detailEventUrlTemplate, entry?.id, title, source.url);
  const postingUrl = detailUrl || entry?.content?.["link-url"] || config.eventsUrl;
  const primaryRange = entry?.["date-time-indication"]?.["in-progress-timerange-array"]?.[0];
  const primaryDate = entry?.["date-time-indication"]?.["date-with-times-array"]?.[0];

  return {
    title,
    summary: cleanSnippet(entry?.content?.description, 420),
    start: primaryRange?.["date-time-from"] || formatDateWithTime(primaryDate?.date, primaryDate?.["time-from"]),
    end: primaryRange?.["date-time-to"] || formatDateWithTime(primaryDate?.date, primaryDate?.["time-to"]),
    location: formatLocation(entry?.location),
    postingUrl,
    imageUrl: entry?.image?.path || "",
    evidence: `event-calendar:${entry?.id ?? "unknown"}`
  };
}

function mapTableRow(cells, headers, baseUrl) {
  if (!cells.length) {
    return null;
  }

  const cellHtml = cells.map((cell) => String(cell?.content ?? ""));
  const cellText = cellHtml.map((content) => stripHtml(content));

  const dateIndex = findColumnIndex(headers, ["date", "when"]);
  const eventIndex = findColumnIndex(headers, ["event"]);
  const locationIndex = findColumnIndex(headers, ["location"]);
  const speakerIndex = findColumnIndex(headers, ["speaker"]);
  const audienceIndex = findColumnIndex(headers, ["target audience"]);
  const timeIndex = findColumnIndex(headers, ["time"]);

  const rawDate = pickDateText(cellHtml[dateIndex] ?? cellText[dateIndex] ?? "");
  const eventHtml = cellHtml[eventIndex] ?? "";
  const eventText = cellText[eventIndex] ?? "";
  const title = extractBoldText(eventHtml) || extractFirstLinkText(eventHtml) || firstMeaningfulLine(eventText);
  if (!title || title.length < 4) {
    return null;
  }

  const postingUrl = extractFirstLinkUrl(eventHtml, baseUrl) || baseUrl;
  const location =
    cellText[locationIndex] ||
    extractSecondParagraph(cellHtml[dateIndex] ?? "") ||
    "";

  const summaryParts = [
    compactTableText(eventText, title),
    cellText[timeIndex],
    speakerIndex >= 0 ? `Speaker: ${cellText[speakerIndex]}` : "",
    audienceIndex >= 0 ? `Audience: ${cellText[audienceIndex]}` : ""
  ].filter(Boolean);

  return {
    title,
    summary: summaryParts.join(" | "),
    start: rawDate,
    end: "",
    location,
    postingUrl,
    imageUrl: "",
    evidence: "table-json"
  };
}

function buildDetailUrl(template, eventId, title, baseUrl) {
  if (!template || !eventId) {
    return "";
  }

  const resolved = template
    .replaceAll("${eventId}", String(eventId))
    .replaceAll("${title}", slugify(title));

  try {
    return new URL(resolved, baseUrl).href;
  } catch {
    return "";
  }
}

function formatDateWithTime(date, time) {
  if (!date) {
    return "";
  }
  return time ? `${date} ${time}` : date;
}

function formatLocation(location) {
  const internal = location?.internal;
  const external = location?.external;

  if (internal) {
    return [internal["area-desc"], internal.building, internal.floor, internal.room, internal.addition]
      .filter(Boolean)
      .join(", ");
  }

  if (external) {
    return [
      external.name,
      external["street-address"],
      external["postal-code"],
      external.city,
      external.country
    ]
      .filter(Boolean)
      .join(", ");
  }

  return "";
}

function cleanSnippet(value, maxLength = 280) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function findColumnIndex(headers, candidates) {
  return headers.findIndex((header) => candidates.some((candidate) => header.includes(candidate)));
}

function pickDateText(value) {
  const text = stripHtml(value);
  const match =
    text.match(/\b\d{2}\.\d{2}\.\d{4}\b/) ??
    text.match(/\b\d{2}\.-\d{2}\.\d{2}\.\d{4}\b/) ??
    text.match(/\b\d{2}\.\d{2}\.\d{4}\s*-\s*\d{2}\.\d{2}\.\d{4}\b/) ??
    text.match(/\b\d{2}\.\d{2}\.\d{4}\s*-\s*\d{2}\.\d{2}\.\d{4}\b/) ??
    text.match(/\b(?:Spring|Autumn)\s+Semester\s+\d{4}\b/i);

  return match?.[0] ?? text;
}

function extractFirstLinkUrl(html, baseUrl) {
  const href = html.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1];
  if (!href) {
    return "";
  }

  try {
    return new URL(href, baseUrl).href;
  } catch {
    return "";
  }
}

function extractFirstLinkText(html) {
  return stripHtml(html.match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
}

function extractBoldText(html) {
  return stripHtml(html.match(/<b[^>]*>([\s\S]*?)<\/b>/i)?.[1] ?? "");
}

function extractSecondParagraph(html) {
  const matches = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripHtml(match[1])).filter(Boolean);
  return matches[1] ?? "";
}

function firstMeaningfulLine(value) {
  return String(value ?? "")
    .split(/\s{2,}|\n+/)
    .map((item) => item.trim())
    .find(Boolean) ?? "";
}

function compactTableText(value, title) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const compactTitle = String(title ?? "").replace(/\s+/g, " ").trim();
  return text.startsWith(compactTitle) ? text.slice(compactTitle.length).trim().replace(/^[|:,-\s]+/, "") : text;
}

function isUpcomingEvent(event, today) {
  const candidate = toComparableDate(event.end || event.start || "");
  if (!candidate) {
    return true;
  }
  return candidate >= today;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const dottedMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dottedMatch) {
    return `${dottedMatch[3]}-${dottedMatch[2]}-${dottedMatch[1]}`;
  }

  return "";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
