document.addEventListener("DOMContentLoaded", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./sw.js")
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
      feedList.innerHTML = feeds
        .map(
          (feed) => `
                <div class="feed-card win-outset">
                    <h3>${feed.city}</h3>
                    <div class="feed-info">
                        SIZE: ${feed.size_mb} MB<br>
                        UPDATED: ${feed.last_updated.split(" ")[0]}<br>
                        RT: ${feed.route_count} | ST: ${feed.stop_count}
                    </div>
                    <div class="card-actions">
                        <a href="details.html?city=${feed.slug}" class="explore-btn win-outset">[ EXPLORE ]</a>
                        <a href="https://egezenn.github.io/kk-gtfs/data/${feed.filename}" class="download-btn win-outset" download>[ ZIP ]</a>
                    </div>
                </div>
            `,
        )
        .join("");
    }
  }

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

    // 2. Load Data
    Promise.all([
      fetch(`../data/cities/${citySlug}/routes.json`).then((r) => (r.ok ? r.json() : [])),
      fetch(`../data/cities/${citySlug}/stops.json`).then((r) => (r.ok ? r.json() : [])),
      fetch(`../data/cities/${citySlug}/shapes.json`).then((r) => (r.ok ? r.json() : {})),
      fetch(`../data/cities/${citySlug}/trips.json`).then((r) => (r.ok ? r.json() : {})),
      fetch(`../data/cities/${citySlug}/timetables.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
      fetch(`../data/metadata.json`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([routes, stops, shapes, trips, timetables, metadata]) => {
        cityRoutes = routes;
        cityStops = stops;
        cityShapes = shapes;
        cityTrips = trips;
        cityTimetables = timetables;
        const cityMeta = metadata.find((m) => m.slug === citySlug);
        if (cityMeta) cityRegionId = cityMeta.region_id;

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
          radius: 3,
          color: "#00ffff",
          weight: 1,
          fillColor: "#008080",
          fillOpacity: 0.8,
        })
          .addTo(stopLayer)
          .bindPopup(`<b>${s.name}</b><br>ID: ${s.id}${routeHtml}`);
      });
    }

    let currentRouteId = null;
    let currentDirection = "0";

    function renderSidebarRoutes(routes) {
      const list = document.getElementById("routeList");
      list.innerHTML = routes
        .map(
          (r) => `
                <div class="data-item win-outset" data-id="${r.id}">
                    <div class="route-orb" style="background-color: #${r.color}; border: 1px solid #fff;"></div>
                    <span>${r.short} - ${r.long || "UNNAMED"}</span>
                </div>
            `,
        )
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

    document.querySelector(".close-btn").addEventListener("click", () => {
      // Clear current route selection
      if (currentRouteId) {
        currentRouteId = null;
        currentDirection = "0";

        // Remove active class from selected routes in sidebar
        const list = document.getElementById("routeList");
        if (list) {
          list.querySelectorAll(".data-item").forEach((i) => i.classList.remove("active"));
        }

        // Hide window and clear map route layer
        document.getElementById("timetableWindow").style.display = "none";
        routeLayer.clearLayers();
        busLayer.clearLayers();
        if (liveBusInterval) {
          clearInterval(liveBusInterval);
          liveBusInterval = null;
        }
      }
    });

    function renderSidebarStops(stops) {
      const list = document.getElementById("stopList");
      list.innerHTML = stops
        .map(
          (s) => `
                <div class="data-item win-outset" data-id="${s.id}">
                    <span>[ STOP ] ${s.name}</span>
                </div>
            `,
        )
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
              .setContent(`<b>${stop.name}</b><br>ID: ${stop.id}${routeHtml}`)
              .openOn(map);
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
      if (!currentRouteId || cityRegionId === "000") return;
      const route = cityRoutes.find((r) => r.id === currentRouteId);
      if (!route) return;
      const displayCode = route.short;

      const url = `https://service.kentkart.com/rl1/web/pathInfo?region=${cityRegionId}&lang=tr&direction=${currentDirection}&displayRouteCode=${displayCode}`;

      fetch(url)
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
        .catch((err) => console.error("Live bus polling error:", err));
    }

    function showTimetable(routeId, direction) {
      const window = document.getElementById("timetableWindow");
      const content = document.getElementById("timetableContent");
      const title = document.getElementById("timetableTitle");
      const route = cityRoutes.find((r) => r.id === routeId);
      const timetable = cityTimetables[routeId];

      if (route && timetable) {
        const dirData = timetable[direction];
        if (dirData && dirData.times.length > 0) {
          title.innerText = `${dirData.headsign || "SCHEDULE"}`;
          content.innerHTML = `
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-weight: normal;">
                            ${dirData.times.map((t) => `<div style="border-bottom: 1px dotted #333; padding: 2px;">${t}</div>`).join("")}
                        </div>
                    `;
          window.style.display = "flex";
        } else {
          if (direction === "0") {
            window.style.display = "none";
          } else {
            content.innerHTML = "No departures found for this direction.";
            window.style.display = "flex";
          }
        }
      } else {
        window.style.display = "none";
      }
    }

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab + "List").classList.add("active");
      });
    });
  }
});
