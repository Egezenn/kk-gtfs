document.addEventListener("DOMContentLoaded", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("../sw.js")
      .then((reg) => console.log("SW Registered", reg))
      .catch((err) => console.log("SW Failed", err));
  }

  const isDetailPage = document.body.classList.contains("detail-page");

  if (isDetailPage) {
    initDetailPage();
  } else {
    initMainPage();
  }

  function initMainPage() {
    const defaultCity = localStorage.getItem("kk_gtfs-default_city");
    const noRedirect = new URLSearchParams(window.location.search).has("noredirect");
    if (defaultCity && !noRedirect) {
      window.location.replace("details.html?city=" + defaultCity);
      return;
    }

    const feedList = document.getElementById("feedList");
    const citySearch = document.getElementById("citySearch");
    const loading = document.getElementById("loading");

    fetch("../data/metadata.json")
      .then((r) => r.json())
      .then((data) => {
        loading.classList.add("hidden");
        renderFeeds(data);
        citySearch.addEventListener("input", (e) => {
          const term = e.target.value.toLowerCase().replace("c:\\find_city\\>", "");
          renderFeeds(data.filter((f) => f.city.toLowerCase().includes(term)));
        });
      });

    function renderFeeds(feeds) {
      const defaultCity = localStorage.getItem("kk_gtfs-default_city");
      feedList.innerHTML = feeds
        .map((feed) => {
          const isDefault = feed.slug === defaultCity;
          return `
                <div class="feed-card win-outset" onclick="window.location.href='details.html?city=${feed.slug}'" style="cursor: pointer;">
                    <h3 style="display: flex; justify-content: space-between; align-items: center;">
                        <span>${feed.city}</span>
                        <button onclick="event.stopPropagation(); setDefaultCity('${feed.slug}', this)" class="default-btn" title="Set as default municipality" style="background: none; border: none; font-size: 0.8rem; font-family: inherit; font-weight: bold; cursor: pointer; ${isDefault ? "color: #00ff00;" : "color: #bbbbbb;"}">
                            ${isDefault ? "[★ DEFAULT]" : "[☆ SET DEFAULT]"}
                        </button>
                    </h3>
                    <div class="feed-info">
                        SIZE: ${feed.size_mb} MB<br>
                        UPDATED: ${feed.last_updated.split(" ")[0]}<br>
                        RT: ${feed.route_count} | ST: ${feed.stop_count}
                    </div>
                    <div class="card-actions" onclick="event.stopPropagation()">
                        <a href="details.html?city=${feed.slug}" class="explore-btn win-outset">[ EXPLORE ]</a>
                        <button onclick="event.stopPropagation(); cacheCityData('${feed.slug}', this)" class="cache-btn win-outset">[ CACHE ]</button>
                        <a href="https://egezenn.github.io/kk-gtfs/data/${feed.filename}" class="download-btn win-outset" onclick="event.stopPropagation()" download>[ GTFS ]</a>
                    </div>
                </div>
            `;
        })
        .join("");
    }

    if ("caches" in window) {
      caches.keys().then((keys) => {
        const row = document.getElementById("cacheBtnRow");
        if (!row) return;
        row.innerHTML = "";
        if (keys.length === 0) {
          row.textContent = "[ NO CACHES ]";
          return;
        }
        keys.forEach((name) => {
          const label = name.replace(/^kk-gtfs-/, "").toUpperCase();
          const btn = document.createElement("button");
          btn.className = "cache-clear-btn win-outset";
          btn.textContent = `[ CLEAR ${label} ]`;
          btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "[ ... ]";
            caches.delete(name).then((deleted) => {
              btn.textContent = deleted ? "[ CLEARED ]" : "[ NOT FOUND ]";
              btn.style.color = deleted ? "#00ff00" : "#ff8800";
              setTimeout(() => {
                btn.textContent = `[ CLEAR ${label} ]`;
                btn.style.color = "";
                btn.disabled = false;
              }, 2000);
            });
          });
          row.appendChild(btn);
        });
      });
    }
  }

  window.setDefaultCity = function (slug, btn) {
    if (localStorage.getItem("kk_gtfs-default_city") === slug) {
      localStorage.removeItem("kk_gtfs-default_city");
      btn.innerText = "[☆ SET DEFAULT]";
      btn.style.color = "#bbbbbb";
    } else {
      localStorage.setItem("kk_gtfs-default_city", slug);
      document.querySelectorAll(".default-btn").forEach((b) => {
        b.innerText = "[☆ SET DEFAULT]";
        b.style.color = "#bbbbbb";
      });
      btn.innerText = "[★ DEFAULT]";
      btn.style.color = "#00ff00";
    }
  };

  window.cacheCityData = async function (slug, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.innerText = "[ FETCHING... ]";

    try {
      // 1. Fetch all data to cache it, and extract stops to determine bounds
      const [stops] = await Promise.all([
        fetch(`../data/cities/${slug}/stops.json`).then((r) => (r.ok ? r.json() : [])),
        fetch(`../data/cities/${slug}/routes.json`),
        fetch(`../data/cities/${slug}/shapes.json`),
        fetch(`../data/cities/${slug}/trips.json`),
        fetch(`../data/cities/${slug}/timetables.json`).catch(() => {}),
      ]);

      if (stops.length === 0) throw new Error("No stops found");

      let minLat = 90,
        maxLat = -90,
        minLon = 180,
        maxLon = -180;
      stops.forEach((s) => {
        if (s.lat < minLat) minLat = s.lat;
        if (s.lat > maxLat) maxLat = s.lat;
        if (s.lon < minLon) minLon = s.lon;
        if (s.lon > maxLon) maxLon = s.lon;
      });

      // Pad boundaries slightly
      minLat -= 0.05;
      maxLat += 0.05;
      minLon -= 0.05;
      maxLon += 0.05;

      const lon2tile = (lon, zoom) => Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
      const lat2tile = (lat, zoom) =>
        Math.floor(
          ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
            Math.pow(2, zoom),
        );

      const minZoom = 12; // Start detailed enough
      const maxZoom = 15; // Up to decent street level
      const urls = [];
      const subdomains = ["a", "b", "c", "d"];
      let sIdx = 0;

      // Calculate XYZ tiles requested by Leaflet for Cartesian map
      for (let z = minZoom; z <= maxZoom; z++) {
        const minX = lon2tile(minLon, z);
        const maxX = lon2tile(maxLon, z);
        const minY = lat2tile(maxLat, z); // Inverted Y-axis
        const maxY = lat2tile(minLat, z);

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            const s = subdomains[sIdx++ % subdomains.length];
            // Match the Leaflet cartocdn string used in Details
            urls.push(`https://${s}.basemaps.cartocdn.com/rastertiles/voyager_labels_under/${z}/${x}/${y}.png`);
          }
        }
      }

      // Hard cap to avoid hammering the CDN or exhausting memory (e.g. 1500 tiles)
      if (urls.length > 2000) urls.length = 2000;

      let completed = 0;
      const batchSize = 15; // Concurrent fetching speed

      for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        await Promise.all(batch.map((url) => fetch(url, { mode: "cors" }).catch(() => {})));
        completed += batch.length;
        btn.innerText = `[ ${Math.min(100, Math.round((completed / urls.length) * 100))}% ]`;
      }

      btn.innerText = "[ CACHED ]";
      btn.style.color = "#00ff00";
    } catch (e) {
      console.error(e);
      btn.innerText = "[ ERROR ]";
      btn.disabled = false;
      btn.style.color = "#ff0000";
    }
  };

  function initDetailPage() {
    const urlParams = new URLSearchParams(window.location.search);
    const citySlug = urlParams.get("city");
    if (!citySlug) {
      window.location.href = "index.html";
      return;
    }

    let map, routeLayer, stopLayer, busLayer;
    let cityRoutes = [],
      cityStops = [],
      cityShapes = {},
      cityTrips = {},
      cityTimetables = {},
      cityRegionId = "000";
    let liveBusInterval = null;

    // 1. Initialize Map with a slightly more readable Dark Mode
    map = L.map("map", { zoomControl: false }).setView([39.9, 32.8], 6);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_labels_under/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    routeLayer = L.featureGroup().addTo(map);
    stopLayer = L.featureGroup().addTo(map);
    busLayer = L.featureGroup().addTo(map);
    const userLayer = L.featureGroup().addTo(map);
    let userMarker = null;
    let _userZoomHandler = null;

    const LocateControl = L.Control.extend({
      options: { position: "bottomright" },
      onAdd() {
        const btn = L.DomUtil.create("button", "leaflet-bar leaflet-control");
        btn.title = "Go to my location";
        btn.style.cssText =
          "width:34px;height:34px;font-size:1.3rem;cursor:pointer;background:#1a1a1a;color:#00ff00;border:1px solid #00ff00;border-radius:2px;display:flex;align-items:center;justify-content:center;";
        btn.innerHTML = "⊕";
        L.DomEvent.on(btn, "click", L.DomEvent.stopPropagation)
          .on(btn, "click", L.DomEvent.preventDefault)
          .on(btn, "click", () => map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true }));
        return btn;
      },
    });
    new LocateControl().addTo(map);

    map.on("locationfound", (e) => {
      const latlng = e.latlng;
      const style = stopStyleForZoom(map.getZoom());
      if (!userMarker) {
        userMarker = L.circleMarker(latlng, {
          ...style,
          color: "#00ff00",
          fillColor: "#00cc00",
          fillOpacity: 0.9,
        })
          .addTo(userLayer)
          .bindPopup("<b>You are here</b>");

        if (_userZoomHandler) map.off("zoomend", _userZoomHandler);
        _userZoomHandler = () => {
          if (!userMarker) return;
          const s = stopStyleForZoom(map.getZoom());
          userMarker.setStyle(s);
          userMarker.setRadius(s.radius);
        };
        map.on("zoomend", _userZoomHandler);
      } else {
        userMarker.setLatLng(latlng);
      }
    });

    map.on("locationerror", (e) => console.warn("Location error:", e.message));

    // 2. Load Data
    Promise.all([fetch(`../data/metadata.json`).then((r) => (r.ok ? r.json() : []))])
      .then(([metadata]) => {
        const cityMeta = metadata.find((m) => m.slug === citySlug);
        if (cityMeta) {
          cityRegionId = cityMeta.region_id;

          // Check if we need to invalidate cache
          const localLastUpdated = localStorage.getItem(`kk_gtfs-cached_${citySlug}`);
          if (localLastUpdated !== cityMeta.last_updated) {
            // Tell service worker to drop cache for this city
            if (navigator.serviceWorker && navigator.serviceWorker.controller) {
              navigator.serviceWorker.controller.postMessage({
                type: "INVALIDATE_CITY_CACHE",
                citySlug: citySlug,
              });
            }
            // Update local storage to the new modified date
            localStorage.setItem(`kk_gtfs-cached_${citySlug}`, cityMeta.last_updated);
          }
        }

        // Fetch remaining data files (they will go through SW, which may hit cache or network)
        return Promise.all([
          fetch(`../data/cities/${citySlug}/routes.json`).then((r) => (r.ok ? r.json() : [])),
          fetch(`../data/cities/${citySlug}/stops.json`).then((r) => (r.ok ? r.json() : [])),
          fetch(`../data/cities/${citySlug}/shapes.json`).then((r) => (r.ok ? r.json() : {})),
          fetch(`../data/cities/${citySlug}/trips.json`).then((r) => (r.ok ? r.json() : {})),
          fetch(`../data/cities/${citySlug}/timetables.json`)
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({})),
        ]);
      })
      .then(([routes, stops, shapes, trips, timetables]) => {
        cityRoutes = routes;
        cityStops = stops;
        cityShapes = shapes;
        cityTrips = trips;
        cityTimetables = timetables;

        document.getElementById("cityName").innerText = citySlug.replace("_", " ").toUpperCase();
        document.getElementById("cityStats").innerHTML = `
                <span style="color: #00ff00; font-size: 0.7rem;">[ ROUTES: ${routes.length} ] [ STOPS: ${stops.length} ]</span>
            `;
        document.getElementById("detailLoading").classList.add("hidden");

        renderSidebarRoutes(routes);
        renderSidebarStops(stops);

        // Render ALL stops as small pins immediately
        renderAllStopsOnMap(stops);

        if (stops.length > 0) {
          const bounds = L.latLngBounds(stops.map((s) => [s.lat, s.lon]));
          map.fitBounds(bounds, { padding: [50, 50] });
        }

        // Search filtering
        document.getElementById("sidebarSearch").addEventListener("input", (e) => {
          e.target.value = e.target.value.toLocaleUpperCase("tr-TR");
          const term = e.target.value;
          const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
          if (activeTab === "route") {
            renderSidebarRoutes(
              cityRoutes.filter((r) => (r.short + (r.long || "")).toLocaleUpperCase("tr-TR").includes(term)),
            );
          } else {
            renderSidebarStops(cityStops.filter((s) => s.name.toLocaleUpperCase("tr-TR").includes(term)));
          }
        });
      })
      .catch((err) => {
        console.error("Data load error:", err);
        document.getElementById("cityName").innerText = "ERROR:FILE_NOT_FOUND";
      });

    let _stopZoomHandler = null;

    function stopStyleForZoom(zoom) {
      const r = Math.max(3, Math.min(8, zoom - 9));
      const w = zoom >= 15 ? 2 : 1;
      return { radius: r, weight: w };
    }

    function renderAllStopsOnMap(stops) {
      stopLayer.clearLayers();
      stops.forEach((s) => {
        let routeHtml = "";
        if (s.routes && s.routes.length > 0) {
          routeHtml = "<div style='margin-top:5px;display:flex;flex-wrap:wrap;gap:2px;'>";
          s.routes.forEach((routeId) => {
            const route = cityRoutes.find((r) => r.id === routeId);
            if (route) {
              routeHtml += `<span onclick="document.querySelector('.data-item[data-id=\\'${route.id}\\']')?.click()" style="cursor:pointer;background-color:#${route.color || "333"};color:#${route.text_color || "fff"};padding:4px 6px;border-radius:4px;font-size:0.85rem;font-weight:bold;box-shadow: 0 0 5px #${route.color || "333"};">${route.short}</span>`;
            }
          });
          routeHtml += "</div>";
        }

        L.circleMarker([s.lat, s.lon], {
          ...stopStyleForZoom(map.getZoom()),
          color: "#00ffff",
          fillColor: "#008080",
          fillOpacity: 0.8,
        })
          .addTo(stopLayer)
          .bindPopup(`<b>${s.name}</b>${routeHtml ? "<br>" + routeHtml : ""}`);
      });

      if (_stopZoomHandler) map.off("zoomend", _stopZoomHandler);
      _stopZoomHandler = () => {
        const s = stopStyleForZoom(map.getZoom());
        stopLayer.eachLayer((layer) => {
          if (layer.setRadius) {
            layer.setStyle(s);
            layer.setRadius(s.radius);
          }
        });
      };
      map.on("zoomend", _stopZoomHandler);
    }

    let currentRouteId = null;
    let currentDirection = "0";

    window.toggleFavorite = function (type, id, btn, event) {
      if (event) event.stopPropagation();
      const storageKey = `kk_gtfs-fav_${citySlug}_${type}`;
      let favs = JSON.parse(localStorage.getItem(storageKey) || "[]");

      if (favs.includes(id)) {
        favs = favs.filter((f) => f !== id);
        btn.innerText = "☆";
        btn.style.color = "#bbbbbb";
      } else {
        favs.push(id);
        btn.innerText = "★";
        btn.style.color = "#ffff00";
      }

      localStorage.setItem(storageKey, JSON.stringify(favs));

      // Re-render the respective list to update sorting
      const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
      const term = document.getElementById("sidebarSearch").value.toLocaleUpperCase("tr-TR");

      if (type === "route") {
        const filteredRoutes = cityRoutes.filter((r) =>
          (r.short + (r.long || "")).toLocaleUpperCase("tr-TR").includes(term),
        );
        renderSidebarRoutes(filteredRoutes);
      } else {
        const filteredStops = cityStops.filter((s) => s.name.toLocaleUpperCase("tr-TR").includes(term));
        renderSidebarStops(filteredStops);
      }
    };

    function renderSidebarRoutes(routes) {
      const storageKey = `kk_gtfs-fav_${citySlug}_route`;
      const favs = JSON.parse(localStorage.getItem(storageKey) || "[]");

      // Sort routes: Favorites first, then alphabetical by short name
      const sortedRoutes = [...routes].sort((a, b) => {
        const aFav = favs.includes(a.id);
        const bFav = favs.includes(b.id);
        if (aFav && !bFav) return -1;
        if (!aFav && bFav) return 1;
        return a.short.localeCompare(b.short);
      });

      const list = document.getElementById("routeList");
      list.innerHTML = sortedRoutes
        .map((r) => {
          const isFav = favs.includes(r.id);
          const isActive = currentRouteId === r.id ? "active" : "";
          return `
                <div class="data-item win-outset ${isActive}" data-id="${r.id}" style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <div class="route-orb" style="background-color: #${r.color}; border: 1px solid #fff;"></div>
                      <span>${r.short} - ${r.long || "UNNAMED"}</span>
                    </div>
                    <button class="fav-btn" onclick="toggleFavorite('route', '${r.id}', this, event)" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: ${isFav ? "#ffff00" : "#bbbbbb"};">${isFav ? "★" : "☆"}</button>
                </div>
            `;
        })
        .join("");

      list.querySelectorAll(".data-item").forEach((item) => {
        item.addEventListener("click", () => {
          const newRouteId = item.dataset.id;
          if (currentRouteId === newRouteId) {
            // Toggle direction if already selected
            currentDirection = currentDirection === "0" ? "1" : "0";
          } else {
            // New route, reset active states and direction
            list.querySelectorAll(".data-item").forEach((i) => i.classList.remove("active"));
            item.classList.add("active");
            currentRouteId = newRouteId;
            currentDirection = "0";
          }

          showRouteOnMap(currentRouteId);
          showTimetable(currentRouteId, currentDirection);

          // Auto collapse sidebar on mobile
          if (window.innerWidth <= 768) {
            const sb = document.getElementById("sidebar");
            const sTog = document.getElementById("sidebarToggle");
            if (sb && !sb.classList.contains("collapsed")) {
              sb.classList.add("collapsed");
              sTog.innerText = "▲";
              setTimeout(() => map.invalidateSize(), 300);
            }
          }
        });
      });
    }

    document.getElementById("reverseBtn").addEventListener("click", () => {
      if (currentRouteId) {
        currentDirection = currentDirection === "0" ? "1" : "0";
        showRouteOnMap(currentRouteId);
        showTimetable(currentRouteId, currentDirection);
      }
    });

    const refreshBusBtn = document.getElementById("refreshBusBtn");
    if (refreshBusBtn) {
      refreshBusBtn.addEventListener("click", () => {
        if (currentRouteId) fetchLiveBuses();
      });
    }

    document.querySelector(".close-btn").addEventListener("click", () => {
      if (currentRouteId) {
        currentRouteId = null;
        currentDirection = "0";

        const list = document.getElementById("routeList");
        if (list) {
          list.querySelectorAll(".data-item").forEach((i) => i.classList.remove("active"));
        }

        document.getElementById("timetableWindow").style.display = "none";
        routeLayer.clearLayers();
      }

      busLayer.clearLayers();
      if (liveBusInterval) {
        clearInterval(liveBusInterval);
        liveBusInterval = null;
      }
    });

    function renderSidebarStops(stops) {
      const storageKey = `kk_gtfs-fav_${citySlug}_stop`;
      const favs = JSON.parse(localStorage.getItem(storageKey) || "[]");

      // Sort stops: Favorites first, then alphabetical by name
      const sortedStops = [...stops].sort((a, b) => {
        const aFav = favs.includes(a.id);
        const bFav = favs.includes(b.id);
        if (aFav && !bFav) return -1;
        if (!aFav && bFav) return 1;
        return a.name.localeCompare(b.name);
      });

      const list = document.getElementById("stopList");
      list.innerHTML = sortedStops
        .map((s) => {
          const isFav = favs.includes(s.id);
          return `
                <div class="data-item win-outset" data-id="${s.id}" style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="flex-grow: 1;">[ STOP ] ${s.name}</span>
                    <button class="fav-btn" onclick="toggleFavorite('stop', '${s.id}', this, event)" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: ${isFav ? "#ffff00" : "#bbbbbb"}; line-height: 1;" title="Favorite Stop">${isFav ? "★" : "☆"}</button>
                </div>
            `;
        })
        .join("");

      list.querySelectorAll(".data-item").forEach((item) => {
        item.addEventListener("click", () => {
          const stop = cityStops.find((s) => s.id === item.dataset.id);
          if (stop) {
            let routeHtml = "";
            if (stop.routes && stop.routes.length > 0) {
              routeHtml = "<div style='margin-top:5px;display:flex;flex-wrap:wrap;gap:2px;'>";
              stop.routes.forEach((routeId) => {
                const route = cityRoutes.find((r) => r.id === routeId);
                if (route) {
                  routeHtml += `<span onclick="document.querySelector('.data-item[data-id=\\'${route.id}\\']')?.click()" style="cursor:pointer;background-color:#${route.color || "333"};color:#${route.text_color || "fff"};padding:4px 6px;border-radius:4px;font-size:0.85rem;font-weight:bold;box-shadow: 0 0 5px #${route.color || "333"};">${route.short}</span>`;
                }
              });
              routeHtml += "</div>";
            }
            map.setView([stop.lat, stop.lon], 16);
            L.popup()
              .setLatLng([stop.lat, stop.lon])
              .setContent(`<b>${stop.name}</b>${routeHtml ? "<br>" + routeHtml : ""}`)
              .openOn(map);

            // Auto collapse sidebar on mobile
            if (window.innerWidth <= 768) {
              const sb = document.getElementById("sidebar");
              const sTog = document.getElementById("sidebarToggle");
              if (sb && !sb.classList.contains("collapsed")) {
                sb.classList.add("collapsed");
                sTog.innerText = "▲";
                setTimeout(() => map.invalidateSize(), 300);
              }
            }
          }
        });
      });
    }

    function showRouteOnMap(routeId) {
      routeLayer.clearLayers();
      const routeDirs = cityTrips[routeId];
      if (!routeDirs) return;

      const shapeId = routeDirs[currentDirection] || routeDirs[Object.keys(routeDirs)[0]];
      const coordinates = cityShapes[shapeId];
      const route = cityRoutes.find((r) => r.id === routeId);

      if (coordinates && route) {
        // Add a neon glow effect using Leaflet's line options, leveraging CSS filter
        const polyline = L.polyline(coordinates, {
          color: "#" + route.color,
          weight: 6,
          opacity: 1,
          lineJoin: "round",
          className: "neon-route-line",
        }).addTo(routeLayer);

        // Add directional arrows
        if (typeof L.polylineDecorator !== "undefined") {
          L.polylineDecorator(polyline, {
            patterns: [
              {
                offset: "20",
                repeat: "2%",
                symbol: L.Symbol.arrowHead({
                  pixelSize: 10,
                  polygon: false,
                  pathOptions: { stroke: true, color: "#" + (route.text_color || "fff"), weight: 2, opacity: 0.8 },
                }),
              },
            ],
          }).addTo(routeLayer);
        }

        // Inject a dynamic style rule for the current route's neon glow
        let styleEl = document.getElementById("neon-style");
        if (!styleEl) {
          styleEl = document.createElement("style");
          styleEl.id = "neon-style";
          document.head.appendChild(styleEl);
        }
        styleEl.innerHTML = `
            .neon-route-line {
                filter: drop-shadow(0 0 8px #${route.color}) drop-shadow(0 0 4px #${route.color});
                transition: filter 0.3s ease;
            }
        `;

        map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
      }

      fetchLiveBuses();
      if (liveBusInterval) clearInterval(liveBusInterval);
      liveBusInterval = setInterval(fetchLiveBuses, 30000);
    }

    function fetchLiveBuses() {
      if (!currentRouteId || cityRegionId === "000") return Promise.resolve();
      const route = cityRoutes.find((r) => r.id === currentRouteId);
      if (!route) return Promise.resolve();

      const refreshBtn = document.getElementById("refreshBusBtn");
      if (refreshBtn) {
        refreshBtn.innerText = "... ";
        refreshBtn.disabled = true;
      }

      const displayCode = route.short;

      const url = `https://service.kentkart.com/rl1/web/pathInfo?region=${cityRegionId}&lang=tr&direction=${currentDirection}&displayRouteCode=${displayCode}`;

      return fetch(url)
        .then((r) => r.json())
        .then((data) => {
          busLayer.clearLayers();
          if (data && data.pathList && data.pathList.length > 0) {
            const buses = data.pathList[0].busList || [];
            buses.forEach((bus) => {
              if (bus.lat && bus.lng) {
                const busMarker = L.circleMarker([parseFloat(bus.lat), parseFloat(bus.lng)], {
                  radius: 6,
                  color: "#fff",
                  weight: 2,
                  fillColor: "#ff0000",
                  fillOpacity: 1,
                  className: "live-bus-marker",
                });
                busMarker.bindPopup(`<b>BUS: ${bus.plateNumber || bus.busId}</b>`);
                busMarker.addTo(busLayer);
              }
            });
          }
        })
        .catch((err) => console.error("Live bus polling error:", err))
        .finally(() => {
          const refreshBtn = document.getElementById("refreshBusBtn");
          if (refreshBtn) {
            setTimeout(() => {
              refreshBtn.innerText = "LIVE";
              refreshBtn.disabled = false;
            }, 500);
          }
        });
    }

    function showTimetable(routeId, direction) {
      const timetableEl = document.getElementById("timetableWindow");
      const content = document.getElementById("timetableContent");
      const title = document.getElementById("timetableTitle");
      const route = cityRoutes.find((r) => r.id === routeId);
      const timetable = cityTimetables[routeId];

      function renderTimetableTimes(rId, dId, dayType) {
        const dData = cityTimetables[rId][dId];
        const timesArray = dData.times[dayType] || [];

        const now2 = new Date();
        let currentHour = now2.getHours();

        if (currentHour < 4) {
          currentHour += 24;
        }

        const currentMinute = now2.getMinutes();
        const currentTimeStr = `${currentHour.toString().padStart(2, "0")}:${currentMinute.toString().padStart(2, "0")}`;

        let nextTimeIndex = -1;
        for (let i = 0; i < timesArray.length; i++) {
          if (timesArray[i] >= currentTimeStr) {
            nextTimeIndex = i;
            break;
          }
        }

        let timesHtml = `<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; font-weight: normal;">`;
        if (timesArray.length === 0) {
          timesHtml += `<div style="grid-column: span 3; text-align: center; font-style: italic;">No departures found for ${dayType}.</div>`;
        } else {
          timesHtml += timesArray
            .map((t, index) => {
              const isNext =
                index === nextTimeIndex &&
                ((dayType === "sunday" && now2.getDay() === 0) ||
                  (dayType === "saturday" && now2.getDay() === 6) ||
                  (dayType === "weekday" && now2.getDay() > 0 && now2.getDay() < 6));
              const style = isNext
                ? "border-bottom: 1px dotted #333; padding: 2px; background-color: #000080; color: white; border-radius: 2px;"
                : "border-bottom: 1px dotted #333; padding: 2px;";

              // Modulo display time for > 24h
              let displayT = t;
              const parts = t.split(":");
              let h = parseInt(parts[0], 10);
              if (h >= 24) {
                h %= 24;
                displayT = `${h.toString().padStart(2, "0")}:${parts[1]}`;
              }

              return `<div style="${style}">${displayT}</div>`;
            })
            .join("");
        }
        timesHtml += `</div>`;

        content.innerHTML = `
              <div id="daySelector" style="display: flex; gap: 10px; margin-bottom: 10px; font-size: 0.8rem; border-bottom: 1px solid #333; padding-bottom: 5px;">
                  <label><input type="radio" name="dayType" value="weekday" ${dayType === "weekday" ? "checked" : ""}> Weekday</label>
                  <label><input type="radio" name="dayType" value="saturday" ${dayType === "saturday" ? "checked" : ""}> Saturday</label>
                  <label><input type="radio" name="dayType" value="sunday" ${dayType === "sunday" ? "checked" : ""}> Sunday</label>
              </div>
              ${timesHtml}
          `;

        content.querySelectorAll("input[name='dayType']").forEach((radio) => {
          radio.addEventListener("change", () => {
            renderTimetableTimes(rId, dId, radio.value);
          });
        });
      }

      if (route && timetable) {
        const dirData = timetable[direction];
        if (
          dirData &&
          ((dirData.times.weekday && dirData.times.weekday.length > 0) ||
            (dirData.times.saturday && dirData.times.saturday.length > 0) ||
            (dirData.times.sunday && dirData.times.sunday.length > 0))
        ) {
          title.innerText = `${dirData.headsign || "SCHEDULE"}`;

          const now = new Date();
          const currentDayNum = now.getDay();
          let currentDayType = "weekday";
          if (currentDayNum === 0) currentDayType = "sunday";
          else if (currentDayNum === 6) currentDayType = "saturday";

          if (!dirData.times[currentDayType] || dirData.times[currentDayType].length === 0) {
            if (dirData.times.weekday && dirData.times.weekday.length > 0) currentDayType = "weekday";
            else if (dirData.times.saturday && dirData.times.saturday.length > 0) currentDayType = "saturday";
            else if (dirData.times.sunday && dirData.times.sunday.length > 0) currentDayType = "sunday";
          }

          renderTimetableTimes(routeId, direction, currentDayType);
          timetableEl.style.display = "flex";
        } else {
          if (direction === "0") {
            timetableEl.style.display = "none";
          } else {
            content.innerHTML = "No departures found for this direction.";
            timetableEl.style.display = "flex";
          }
        }
      } else {
        timetableEl.style.display = "none";
      }
    }

    // Mobile Toggles
    const sidebarToggle = document.getElementById("sidebarToggle");
    const sidebar = document.getElementById("sidebar");

    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener("click", () => {
        sidebar.classList.toggle("collapsed");
        if (sidebar.classList.contains("collapsed")) {
          sidebarToggle.innerText = "▼";
        } else {
          sidebarToggle.innerText = "▲";
        }
        // Force map resize to prevent blank tiles when container size changes
        setTimeout(() => map.invalidateSize(), 300);
      });
    }

    const timetableToggle = document.getElementById("timetableToggle");
    const timetableWindow = document.getElementById("timetableWindow");

    if (timetableToggle && timetableWindow) {
      timetableToggle.addEventListener("click", () => {
        timetableWindow.classList.toggle("collapsed");
        if (timetableWindow.classList.contains("collapsed")) {
          timetableToggle.innerText = "▲";
        } else {
          timetableToggle.innerText = "▼";
        }
      });
    }

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab + "List").classList.add("active");

        // On mobile, automatically expand the sidebar if a tab is clicked while collapsed
        if (window.innerWidth <= 768 && sidebar.classList.contains("collapsed")) {
          sidebar.classList.remove("collapsed");
          sidebarToggle.innerText = "▼";
          setTimeout(() => map.invalidateSize(), 300);
        }
      });
    });
  }
});
