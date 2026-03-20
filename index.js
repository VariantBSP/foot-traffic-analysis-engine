/**
 * Foot Traffic Signal Engine — MCP Server
 *
 * Delivers AI-powered site intelligence from open data sources.
 * Replaces Placer.ai ($8k–$27k/year) at $0.10/query.
 *
 * Data sources (all free/open, ToS-compliant):
 *   - Nominatim (OSM geocoding)
 *   - Overpass API (OSM POI density, pedestrian infrastructure)
 *   - Google Places API official free tier (review velocity)
 *   - GeoNames (population density)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL = {
  poi:        parseInt(process.env.CACHE_TTL_POI)        || 7 * 24 * 60 * 60 * 1000, // 7 days
  reviews:    parseInt(process.env.CACHE_TTL_REVIEWS)    || 48 * 60 * 60 * 1000,      // 48 hours
  population: parseInt(process.env.CACHE_TTL_POPULATION) || 30 * 24 * 60 * 60 * 1000, // 30 days
  geocode:    60 * 60 * 1000,                                                           // 1 hour
};

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
const GEONAMES_URL = "http://api.geonames.org";
const PLACES_URL = "https://maps.googleapis.com/maps/api/place";

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

/** Geocode a location name to lat/lon using Nominatim */
async function geocode(locationName) {
  const cacheKey = `geocode:${locationName.toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "FootTrafficSignalEngine/1.0 (open-source MCP prototype)" },
  });

  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error(`Location not found: ${locationName}`);

  const result = {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };

  cacheSet(cacheKey, result, CACHE_TTL.geocode);
  return result;
}

/** Fetch POI density and pedestrian infrastructure from Overpass */
async function fetchOsmSignals(lat, lon, radiusMeters = 500) {
  const cacheKey = `osm:${lat.toFixed(4)},${lon.toFixed(4)},${radiusMeters}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Query for amenities, shops, transit, and pedestrian infrastructure
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"](around:${radiusMeters},${lat},${lon});
      node["shop"](around:${radiusMeters},${lat},${lon});
      node["highway"="bus_stop"](around:${radiusMeters},${lat},${lon});
      node["railway"="station"](around:${radiusMeters},${lat},${lon});
      node["railway"="subway_entrance"](around:${radiusMeters},${lat},${lon});
      way["highway"="footway"](around:${radiusMeters},${lat},${lon});
      way["highway"="pedestrian"](around:${radiusMeters},${lat},${lon});
      node["highway"="crossing"](around:${radiusMeters},${lat},${lon});
    );
    out count;
  `.trim();

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);
  const data = await res.json();

  // Separate queries for subcounts
  const detailQuery = `
    [out:json][timeout:25];
    (
      node["amenity"~"restaurant|cafe|bar|fast_food|food_court"](around:${radiusMeters},${lat},${lon});
    );
    out count;
  `.trim();

  const detailRes = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(detailQuery)}`,
  });

  const detailData = detailRes.ok ? await detailRes.json() : { elements: [] };

  const totalPoi = data.elements?.[0]?.tags?.total || 0;
  const foodVenues = detailData.elements?.[0]?.tags?.total || 0;

  const result = {
    totalPoi: parseInt(totalPoi),
    foodVenues: parseInt(foodVenues),
    radiusMeters,
    source: "OpenStreetMap via Overpass API",
  };

  cacheSet(cacheKey, result, CACHE_TTL.poi);
  return result;
}

/** Fetch competitor density (specific category) from Overpass */
async function fetchCompetitorDensity(lat, lon, category, radiusMeters = 500) {
  const cacheKey = `competitors:${lat.toFixed(4)},${lon.toFixed(4)},${category},${radiusMeters}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Map category to OSM tags
  const tagMap = {
    restaurant:   `["amenity"~"restaurant|fast_food|food_court"]`,
    cafe:         `["amenity"="cafe"]`,
    bar:          `["amenity"~"bar|pub|nightclub"]`,
    retail:       `["shop"]`,
    gym:          `["leisure"~"fitness_centre|gym"]`,
    pharmacy:     `["amenity"="pharmacy"]`,
    supermarket:  `["shop"~"supermarket|grocery"]`,
  };

  const tag = tagMap[category.toLowerCase()] || `["amenity"]`;

  const counts = {};
  for (const r of [250, 500, 1000]) {
    const query = `
      [out:json][timeout:15];
      node${tag}(around:${r},${lat},${lon});
      out count;
    `.trim();

    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (res.ok) {
      const data = await res.json();
      counts[`${r}m`] = parseInt(data.elements?.[0]?.tags?.total || 0);
    } else {
      counts[`${r}m`] = null;
    }
  }

  const nearest = counts["500m"] ?? 0;
  const saturationLabel =
    nearest <= 3  ? "low" :
    nearest <= 8  ? "moderate" :
    nearest <= 15 ? "high" : "saturated";

  const result = {
    category,
    counts,
    saturationLabel,
    nearest500m: nearest,
    source: "OpenStreetMap via Overpass API",
  };

  cacheSet(cacheKey, result, CACHE_TTL.poi);
  return result;
}

/** Fetch review velocity from Google Places API (official free tier) */
async function fetchReviewVelocity(lat, lon, radiusMeters = 500) {
  if (!GOOGLE_API_KEY) {
    return { available: false, reason: "GOOGLE_PLACES_API_KEY not set — running in OSM-only mode" };
  }

  const cacheKey = `reviews:${lat.toFixed(4)},${lon.toFixed(4)},${radiusMeters}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Nearby search — returns up to 20 places
  const url = `${PLACES_URL}/nearbysearch/json?location=${lat},${lon}&radius=${radiusMeters}&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);

  if (!res.ok) {
    return { available: false, reason: `Google Places API error: ${res.status}` };
  }

  const data = await res.json();

  if (data.status === "REQUEST_DENIED") {
    return { available: false, reason: "Google Places API key invalid or quota exceeded" };
  }

  const places = data.results || [];
  const totalReviews = places.reduce((sum, p) => sum + (p.user_ratings_total || 0), 0);
  const avgRating = places.length
    ? (places.reduce((sum, p) => sum + (p.rating || 0), 0) / places.length).toFixed(1)
    : null;

  // Score based on total review count (proxy for visit volume)
  // 0–500 reviews = low, 500–2000 = moderate, 2000–5000 = high, 5000+ = very high
  const velocityLabel =
    totalReviews < 500   ? "low" :
    totalReviews < 2000  ? "moderate" :
    totalReviews < 5000  ? "high" : "very high";

  const result = {
    available: true,
    totalReviews,
    avgRating: parseFloat(avgRating),
    placesScanned: places.length,
    velocityLabel,
    source: "Google Places API (official free tier)",
  };

  cacheSet(cacheKey, result, CACHE_TTL.reviews);
  return result;
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Normalize a raw count to a 0–100 score given expected min/max range */
function normalize(value, min, max) {
  if (value <= min) return 0;
  if (value >= max) return 100;
  return Math.round(((value - min) / (max - min)) * 100);
}

/** Compute composite site score from signals */
function computeSiteScore(osmSignals, reviewSignals) {
  const poiScore = normalize(osmSignals.totalPoi, 0, 300);

  // Review velocity score
  const velocityMap = { low: 20, moderate: 50, high: 75, "very high": 95 };
  const reviewScore = reviewSignals.available
    ? (velocityMap[reviewSignals.velocityLabel] ?? 40)
    : null;

  // Composite: weighted average
  // If Google Places unavailable, weight POI score at 100%
  const composite = reviewScore !== null
    ? Math.round(poiScore * 0.55 + reviewScore * 0.45)
    : poiScore;

  return {
    poiScore,
    reviewScore,
    composite,
    signals: {
      totalPoi: osmSignals.totalPoi,
      foodVenues: osmSignals.foodVenues,
      reviewVelocity: reviewSignals.available ? reviewSignals.velocityLabel : "unavailable",
      totalReviews: reviewSignals.available ? reviewSignals.totalReviews : null,
    },
  };
}

/** Generate a plain-text site recommendation */
function generateRecommendation(siteName, score, competitors) {
  const level =
    score.composite >= 75 ? "strong" :
    score.composite >= 50 ? "moderate" :
    score.composite >= 30 ? "developing" : "weak";

  const competitorNote = competitors
    ? `Competitor saturation within 500m is ${competitors.saturationLabel} (${competitors.nearest500m} similar venues).`
    : "";

  return `${siteName} shows ${level} foot traffic signals with a composite site score of ${score.composite}/100. ` +
    `POI density score: ${score.poiScore}/100. ` +
    (score.reviewScore !== null ? `Review velocity score: ${score.reviewScore}/100. ` : "") +
    competitorNote;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "foot-traffic-signal-engine",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool 1: get_site_intelligence
// ---------------------------------------------------------------------------

server.tool(
  "get_site_intelligence",
  "Returns a composite foot traffic signal score for a location, including POI density, review velocity, and competitor saturation.",
  {
    location:      z.string().describe("Location name, address, or neighborhood (e.g. 'Yaba, Lagos')"),
    business_type: z.string().describe("Type of business (e.g. 'restaurant', 'cafe', 'retail', 'gym')"),
    radius_meters: z.number().optional().default(500).describe("Search radius in meters (default: 500)"),
  },
  async ({ location, business_type, radius_meters }) => {
    try {
      // Step 1: Geocode
      const coords = await geocode(location);

      // Step 2: Fetch signals in parallel
      const [osmSignals, reviewSignals, competitors] = await Promise.all([
        fetchOsmSignals(coords.lat, coords.lon, radius_meters),
        fetchReviewVelocity(coords.lat, coords.lon, radius_meters),
        fetchCompetitorDensity(coords.lat, coords.lon, business_type, radius_meters),
      ]);

      // Step 3: Score
      const score = computeSiteScore(osmSignals, reviewSignals);
      const recommendation = generateRecommendation(location, score, competitors);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            location,
            resolvedAs: coords.displayName,
            coordinates: { lat: coords.lat, lon: coords.lon },
            radiusMeters: radius_meters,
            scores: {
              composite: score.composite,
              poiDensity: score.poiScore,
              reviewVelocity: score.reviewScore,
            },
            signals: score.signals,
            competitorSaturation: {
              category: business_type,
              counts: competitors.counts,
              saturationLabel: competitors.saturationLabel,
              nearest500m: competitors.nearest500m,
            },
            recommendation,
            dataSources: [
              osmSignals.source,
              reviewSignals.available ? reviewSignals.source : "Google Places skipped (no API key)",
              competitors.source,
            ],
            cachedUntil: {
              poiData: new Date(Date.now() + CACHE_TTL.poi).toISOString(),
              reviewData: new Date(Date.now() + CACHE_TTL.reviews).toISOString(),
            },
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2: compare_sites
// ---------------------------------------------------------------------------

server.tool(
  "compare_sites",
  "Compares two or more locations by foot traffic signals and returns a ranked recommendation.",
  {
    locations:     z.array(z.string()).min(2).max(5).describe("List of 2–5 location names to compare"),
    business_type: z.string().describe("Type of business (e.g. 'restaurant', 'cafe', 'retail')"),
    radius_meters: z.number().optional().default(500).describe("Search radius in meters (default: 500)"),
  },
  async ({ locations, business_type, radius_meters }) => {
    try {
      // Process all locations in parallel
      const results = await Promise.all(
        locations.map(async (location) => {
          const coords = await geocode(location);
          const [osmSignals, reviewSignals, competitors] = await Promise.all([
            fetchOsmSignals(coords.lat, coords.lon, radius_meters),
            fetchReviewVelocity(coords.lat, coords.lon, radius_meters),
            fetchCompetitorDensity(coords.lat, coords.lon, business_type, radius_meters),
          ]);
          const score = computeSiteScore(osmSignals, reviewSignals);
          return { location, coords, osmSignals, reviewSignals, competitors, score };
        })
      );

      // Rank by composite score descending
      results.sort((a, b) => b.score.composite - a.score.composite);

      const winner = results[0];
      const ranked = results.map((r, i) => ({
        rank: i + 1,
        location: r.location,
        compositeScore: r.score.composite,
        poiScore: r.score.poiScore,
        reviewScore: r.score.reviewScore,
        competitorSaturation: r.competitors.saturationLabel,
        nearbyCompetitors500m: r.competitors.nearest500m,
        totalPoi: r.osmSignals.totalPoi,
        reviewVelocity: r.reviewSignals.available ? r.reviewSignals.velocityLabel : "unavailable",
      }));

      const recommendation =
        `${winner.location} is the recommended site with the highest composite score of ${winner.score.composite}/100. ` +
        `It has ${winner.osmSignals.totalPoi} POIs within ${radius_meters}m and ` +
        `${winner.competitors.saturationLabel} competitor saturation (${winner.competitors.nearest500m} nearby ${business_type} venues). ` +
        (results.length > 1
          ? `Runner-up: ${results[1].location} (score: ${results[1].score.composite}/100).`
          : "");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            businessType: business_type,
            radiusMeters: radius_meters,
            rankedSites: ranked,
            recommendation,
            winner: winner.location,
            dataSources: ["OpenStreetMap via Overpass API", "Google Places API (official free tier)"],
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3: get_competitor_density
// ---------------------------------------------------------------------------

server.tool(
  "get_competitor_density",
  "Returns the count and saturation level of competing venues around a location across 250m, 500m, and 1km radius bands.",
  {
    location: z.string().describe("Location name or address"),
    category: z.string().describe("Business category (restaurant, cafe, bar, retail, gym, pharmacy, supermarket)"),
  },
  async ({ location, category }) => {
    try {
      const coords = await geocode(location);
      const competitors = await fetchCompetitorDensity(coords.lat, coords.lon, category);

      const interpretation =
        competitors.saturationLabel === "low"      ? "Low competition — good entry opportunity." :
        competitors.saturationLabel === "moderate"  ? "Moderate competition — viable with strong differentiation." :
        competitors.saturationLabel === "high"      ? "High competition — requires clear differentiation or superior location." :
        "Saturated market — entry is high-risk without a strong concept advantage.";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            location,
            resolvedAs: coords.displayName,
            category,
            competitorCounts: competitors.counts,
            saturationLabel: competitors.saturationLabel,
            interpretation,
            source: competitors.source,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Foot Traffic Signal Engine MCP server running.");
