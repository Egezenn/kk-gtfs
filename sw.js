const CACHE_NAME = "kk-gtfs-v2";
const DATA_CACHE_NAME = "kk-gtfs-data-v2";
const TILE_CACHE_NAME = "kk-gtfs-tiles-v2";

const ASSETS = [
  "./",
  "./index.html",
  "./map/",
  "./map/index.html",
  "./map/details.html",
  "./map/style.css",
  "./map/app.js",
  "./map/manifest.json",
  "./map/icon-192.png",
  "./map/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME && key !== DATA_CACHE_NAME && key !== TILE_CACHE_NAME) {
            return caches.delete(key);
          }
        }),
      );
    }),
  );
  self.clients.claim();
});

// Helper function to handle data endpoints
async function handleDataFetch(request) {
  // We use NetworkFirst for metadata.json so we get the fresh version when online,
  // but it falls back to cache when entirely offline.
  if (request.url.includes("metadata.json")) {
    try {
      const networkResponse = await fetch(request);
      if (networkResponse.ok && networkResponse.status === 200) {
        const cache = await caches.open(DATA_CACHE_NAME);
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      const cache = await caches.open(DATA_CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) return cachedResponse;
      throw error;
    }
  }

  // Check cache first for city data files
  const cache = await caches.open(DATA_CACHE_NAME);
  const cachedResponse = await cache.match(request);

  if (cachedResponse) {
    // If we have it in cache, return it immediately,
    // but we'll let app.js handle explicit invalidation if dates mismatch
    return cachedResponse;
  }

  // Not in cache, fetch it
  try {
    const networkResponse = await fetch(request);
    // Only cache successful JSON responses
    if (networkResponse.ok && networkResponse.status === 200) {
      // Clone response to put one copy in cache and return the other
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.error("Fetch failed for data:", error);
    throw error;
  }
}

async function handleTileFetch(request) {
  const cache = await caches.open(TILE_CACHE_NAME);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (e) {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;
    // Return empty image if totally offline and un-cached
    return new Response(new Blob([""], { type: "image/png" }));
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Map Tiles (cartocdn)
  if (url.hostname.includes("basemaps.cartocdn.com")) {
    event.respondWith(handleTileFetch(event.request));
    return;
  }

  // Intercept requests to /data/ directory
  if (url.pathname.includes("/data/")) {
    event.respondWith(handleDataFetch(event.request));
  } else {
    // Fallback for static assets
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request);
      }),
    );
  }
});

// Allow the client (app.js) to tell us to clear the data cache for a specific city
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "INVALIDATE_CITY_CACHE") {
    const citySlug = event.data.citySlug;
    caches.open(DATA_CACHE_NAME).then((cache) => {
      cache.keys().then((requests) => {
        requests.forEach((request) => {
          if (request.url.includes(`/data/cities/${citySlug}/`)) {
            cache.delete(request);
          }
        });
      });
    });
  }
});
