# Foot Traffic Signal Engine

An MCP (Model Context Protocol) tool that delivers AI-powered foot traffic site intelligence from open data — replacing Placer.ai ($8k–$27k/year) at $0.10/query.

## What it does

Given a location and business type, this tool returns:

- **Composite site score** (0–100) built from real open data signals
- **POI density** from OpenStreetMap (shops, restaurants, transit stops within radius)
- **Review velocity** from Google Places API official free tier (visit frequency proxy)
- **Competitor saturation** across 250m, 500m, and 1km radius bands
- **Ranked site comparison** across 2–5 candidate locations
- **Plain-language recommendation** with rationale

No mobile device tracking. No proprietary data. All sources are free, open, and ToS-compliant.

## Example queries

```
"Compare Yaba and Lekki Phase 1 in Lagos for a quick-service restaurant"
"How saturated is the cafe market in Ikeja, Lagos?"
"What are the foot traffic signals for Victoria Island for a retail shop?"
```

## MCP Tools

| Tool | Description |
|---|---|
| `get_site_intelligence` | Full signal breakdown + composite score for one location |
| `compare_sites` | Ranked comparison across 2–5 locations |
| `get_competitor_density` | Competitor count across 250m / 500m / 1km radius bands |

## Data sources

| Source | Used for | License |
|---|---|---|
| OpenStreetMap / Overpass API | POI density, pedestrian infrastructure, competitor counts | ODbL (freely redistributable) |
| Nominatim | Geocoding location names to coordinates | ODbL |
| Google Places API (official free tier) | Review count and velocity as visit proxy | Official API, no scraping |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your Google Places API key. This is optional — without it the tool runs in OSM-only mode (review velocity scores will be skipped, POI density scoring still works).

Get a free Google Places API key at:
https://developers.google.com/maps/documentation/places/web-service/get-api-key

### 3. Run the server

```bash
npm start
```

The server runs over stdio and is ready to connect to any MCP-compatible client (Claude Desktop, Context Protocol, etc.).

## Connect to Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac):

```json
{
  "mcpServers": {
    "foot-traffic-signal-engine": {
      "command": "node",
      "args": ["/absolute/path/to/foot-traffic-mcp/index.js"],
      "env": {
        "GOOGLE_PLACES_API_KEY": "your_key_here"
      }
    }
  }
}
```

## Architecture

```
MCP Tool Call
  → Nominatim (geocode location name to lat/lon)
  → Parallel fetch:
      - Overpass API (POI density, competitor counts) — cached 7 days
      - Google Places API (review velocity)           — cached 48 hours
  → Signal processing:
      - POI density score (normalized 0–100)
      - Review velocity score (normalized 0–100)
      - Competitor saturation label (low/moderate/high/saturated)
      - Composite weighted score
  → Plain-language recommendation
  → Structured JSON output
  → Target latency: 3–8s on cache miss, <1s on hit
```

## Caching

All upstream API calls are cached in-memory with TTLs matched to how often the underlying data changes:

| Data type | TTL |
|---|---|
| OSM POI / competitor data | 7 days |
| Google Places review data | 48 hours |
| Population data | 30 days |
| Geocoding results | 1 hour |

If Google Places API quota is reached for the day, the tool automatically falls back to OSM-only scoring with adjusted weights — no query fails entirely.

## OSM-only mode

If you prefer not to use Google Places API at all, simply leave `GOOGLE_PLACES_API_KEY` empty. The tool will:

- Use OpenStreetMap POI density as the sole scoring signal
- Label review scores as "unavailable" in output
- Still return valid site comparisons and competitor counts

## Why open data works for site selection

Placer.ai uses proprietary mobile device location tracking. This tool uses proxy signals that strongly correlate with foot traffic for site selection purposes:

- **POI density** — areas with more shops, restaurants, and transit attract more visitors (well-established in urban planning research)
- **Review velocity** — Google Places review count is a proven proxy for visit volume (high-traffic venues accumulate reviews faster)
- **Competitor saturation** — OSM POI data gives accurate counts of existing similar venues

For markets outside the US — Lagos, Nairobi, Karachi, Accra — OpenStreetMap often has better coverage than Placer.ai's device panel, making this tool uniquely positioned for emerging markets.

## Roadmap

- [ ] GTFS transit feed integration for peak hour inference
- [ ] GeoNames population density layer
- [ ] OpenRouteService walkability isochrones
- [ ] Persistent cache (Redis or SQLite) for production use
- [ ] Execute-mode pricing for Context Protocol marketplace

## License

MIT
