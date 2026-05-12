# ETHZ Events Hub

This project builds a lightweight website for ETH Zurich events and keeps the original posting URL for every extracted item.

## What it does

- Scrapes a curated set of official ETH Zurich and affiliated event pages.
- Extracts event-like items from JSON-LD, HTML event blocks, and ICS links.
- Preserves the source page and original posting URL.
- Writes a static dataset to `public/data/events.json` and `public/data/sources.json`.
- Serves a local site from `public/`.

## Commands

- `npm run refresh` updates the event dataset.
- `npm run serve` starts the local site at `http://localhost:3000`.

## Notes

- Some ETH pages expose event data cleanly; others need page-level fallbacks today.
- The source registry lives in `src/config/sources.mjs` and is designed to be extended.
- Social profile links are tracked as source metadata, but this first version does not scrape private or login-gated social posts directly.
