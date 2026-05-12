const DATE_PATTERN =
  /\b(?:\d{1,2}\s(?:January|February|March|April|May|June|July|August|September|October|November|December)\s\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s\d{1,2},\s\d{4}|\d{1,2}\.\d{1,2}\.\d{4})\b/i;

const TIME_PATTERN = /\b\d{1,2}(?::|\.)\d{2}\b/g;

export function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function stripHtml(value) {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi, " "))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getMeta(html, property) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return html.match(pattern)?.[1] ?? "";
}

export function getTitle(html) {
  return stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

export function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(regex)) {
    try {
      const url = new URL(decodeHtml(match[1]), baseUrl).href;
      links.push({
        url,
        text: stripHtml(match[2])
      });
    } catch {
      continue;
    }
  }

  return uniqueBy(links, (link) => `${link.url}::${link.text}`);
}

export function extractSocialLinks(links) {
  return links.filter((link) =>
    /(instagram\.com|facebook\.com|linkedin\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|bsky\.app)/i.test(link.url)
  );
}

export function extractCalendarApiLinks(links) {
  return links
    .filter((link) => /pcm-open-services|pcm-pub-services|client-id=anonymous|client-id=wcms/i.test(link.url))
    .map((link) => link.url);
}

export function extractIcsLinks(links) {
  return links.filter((link) => /\.ics(?:$|\?)/i.test(link.url));
}

export function extractJsonLdEvents(html, baseUrl) {
  const events = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(regex)) {
    const payload = match[1].trim();
    if (!payload) {
      continue;
    }

    try {
      const parsed = JSON.parse(payload);
      walkJsonLd(parsed, (node) => {
        if (!node || node["@type"] !== "Event") {
          return;
        }

        events.push({
          title: cleanText(node.name),
          summary: cleanText(node.description),
          start: node.startDate ?? "",
          end: node.endDate ?? "",
          location: extractLocation(node.location),
          postingUrl: toAbsolute(node.url || node["@id"] || baseUrl, baseUrl),
          imageUrl: Array.isArray(node.image) ? node.image[0] : node.image ?? "",
          evidence: "json-ld"
        });
      });
    } catch {
      continue;
    }
  }

  return uniqueBy(events, (event) => `${event.postingUrl}::${event.title}::${event.start}`);
}

export function extractHeuristicEvents(html, baseUrl) {
  const blocks = [];
  const tagPattern = /<(article|li|section|div)[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of html.matchAll(tagPattern)) {
    const rawBlock = match[0];
    const text = stripHtml(rawBlock);
    if (!DATE_PATTERN.test(text)) {
      continue;
    }

    const hrefMatch = rawBlock.match(/<a[^>]+href=["']([^"'#]+)["']/i);
    if (!hrefMatch) {
      continue;
    }

    const headingMatch =
      rawBlock.match(/<(h1|h2|h3|h4|strong|b)[^>]*>([\s\S]*?)<\/\1>/i) ??
      rawBlock.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = cleanText(stripHtml(headingMatch?.[2] ?? headingMatch?.[1] ?? ""));
    if (!title || title.length < 4) {
      continue;
    }

    const times = [...text.matchAll(TIME_PATTERN)].map((item) => item[0]);
    blocks.push({
      title,
      summary: text.slice(0, 360),
      start: extractDate(text),
      end: "",
      location: extractLocationText(text),
      postingUrl: toAbsolute(decodeHtml(hrefMatch[1]), baseUrl),
      imageUrl: "",
      evidence: times.length ? `html-with-time:${times.join(",")}` : "html-block"
    });
  }

  return uniqueBy(blocks, (event) => `${event.postingUrl}::${event.title}::${event.start}`);
}

export function mergeEvents(...groups) {
  return uniqueBy(
    groups.flat().filter((item) => item.title && item.postingUrl),
    (event) => `${event.postingUrl}::${event.title}::${event.start}`
  );
}

export function extractEventCalendarConfigs(html, baseUrl) {
  const configs = [];
  const regex = /<div[^>]+data-init=["']eventCalendar["'][^>]*>/gi;

  for (const match of html.matchAll(regex)) {
    const tag = match[0];
    const eventsUrl = getAttribute(tag, "data-events-url");
    if (!eventsUrl) {
      continue;
    }

    configs.push({
      eventsUrl: toAbsolute(decodeHtml(eventsUrl), baseUrl),
      eventSeriesUrl: toAbsolute(decodeHtml(getAttribute(tag, "data-event-series-url")), baseUrl),
      typeUrl: toAbsolute(decodeHtml(getAttribute(tag, "data-type-url")), baseUrl),
      locationUrl: toAbsolute(decodeHtml(getAttribute(tag, "data-location-url")), baseUrl),
      detailEventUrlTemplate: decodeHtml(getAttribute(tag, "data-detail-event-url")),
      itemsPerPage: Number.parseInt(getAttribute(tag, "data-items-per-page") || "0", 10) || 0
    });
  }

  return uniqueBy(configs, (config) => `${config.eventsUrl}::${config.detailEventUrlTemplate}`);
}

export function extractTableJsonUrls(html, baseUrl) {
  const urls = [];
  const regex = /data-json-url=["']([^"']+)["']/gi;

  for (const match of html.matchAll(regex)) {
    const url = toAbsolute(decodeHtml(match[1]), baseUrl);
    if (url) {
      urls.push(url);
    }
  }

  return uniqueBy(urls, (url) => url);
}

export function extractMathSeminarEvents(html, baseUrl) {
  const events = [];
  const tablePattern = /<table[^>]*class=["'][^"']*seminar[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;

  for (const match of html.matchAll(tablePattern)) {
    const tableHtml = match[1];
    const dayLabel = stripHtml(tableHtml.match(/<thead[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
    if (!dayLabel) {
      continue;
    }

    const dateMatch = dayLabel.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i);
    const pageYearMatch = html.match(/<meta[^>]+name=["']ethz_lmd["'][^>]+content=["'](\d{4})-/i);
    const year = pageYearMatch?.[1] ?? String(new Date().getFullYear());
    const isoDate = dateMatch ? toIsoMonthDate(dateMatch[1], dateMatch[2], year) : "";

    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const rowMatch of tableHtml.matchAll(rowPattern)) {
      const rowHtml = rowMatch[1];
      if (/no_events/i.test(rowHtml) || /<th\b/i.test(rowHtml)) {
        continue;
      }

      const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cell[1]);
      if (cells.length < 4) {
        continue;
      }

      const time = stripHtml(cells[0]);
      const speaker = stripHtml(cells[1]);
      const titleCell = cells[2];
      const location = stripHtml(cells[3]);
      const title =
        stripHtml(titleCell.match(/<span[^>]*class=["'][^"']*event_title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") ||
        extractFirstLinkText(titleCell) ||
        "";

      if (!title) {
        continue;
      }

      const postingUrl = extractMathEventUrl(titleCell, baseUrl);
      const seminarSeries = extractMathSeminarSeries(titleCell);
      const abstract = stripHtml(titleCell.match(/<div[^>]*class=["'][^"']*ethContentForModal[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");

      events.push({
        title,
        summary: [seminarSeries, speaker ? `Speaker: ${speaker}` : "", cleanExcerpt(abstract, 320)].filter(Boolean).join(" | "),
        start: formatDateWithTime(isoDate, time),
        end: "",
        location,
        postingUrl,
        imageUrl: "",
        evidence: "math-seminar-table"
      });
    }
  }

  return uniqueBy(events, (event) => `${event.postingUrl}::${event.title}::${event.start}`);
}

function extractDate(text) {
  return text.match(DATE_PATTERN)?.[0] ?? "";
}

function extractLocation(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return cleanText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractLocation(item)).filter(Boolean).join(" | ");
  }
  return cleanText([value.name, value.address?.streetAddress, value.address?.addressLocality].filter(Boolean).join(", "));
}

function extractLocationText(text) {
  const marker = text.match(/\b(?:Room|Audimax|Campus|Building|Zurich|Zürich|online)\b[\s\S]{0,80}/i);
  return marker ? cleanText(marker[0]) : "";
}

function walkJsonLd(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkJsonLd(item, visit));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  visit(value);
  Object.values(value).forEach((child) => walkJsonLd(child, visit));
}

function cleanText(value) {
  return decodeHtml((value ?? "").replace(/\s+/g, " ").trim());
}

function toAbsolute(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getAttribute(tag, name) {
  const pattern = new RegExp(`${escapeRegExp(name)}=["']([^"']+)["']`, "i");
  return tag.match(pattern)?.[1] ?? "";
}

function toIsoMonthDate(day, monthName, year) {
  const monthMap = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12"
  };

  const month = monthMap[String(monthName).toLowerCase()];
  if (!month) {
    return "";
  }

  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

function extractMathEventUrl(html, baseUrl) {
  const href =
    html.match(/<a[^>]+class=["'][^"']*showEthModal[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
    html.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1];

  if (!href) {
    return baseUrl;
  }

  try {
    return new URL(href, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

function extractMathSeminarSeries(html) {
  const links = [...html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => stripHtml(match[1])).filter(Boolean);
  return links.find((text) => /seminar|colloqu|lecture/i.test(text)) ?? "";
}

function cleanExcerpt(value, maxLength = 280) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
