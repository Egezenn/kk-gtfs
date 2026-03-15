import csv
from io import TextIOWrapper
import json
import os
import re
import ssl
import time
import urllib.request
import zipfile


def safe_float(val):
    if not val:
        return None
    try:
        f = float(val)
        return f
    except ValueError:
        return None


def extract_gtfs_data(zip_path, extract_to):
    routes = []
    stops = []
    shapes = {}
    trips_info = {}  # route_id -> shape_id (single sample)
    route_timetables = (
        {}
    )  # route_id -> { "dir0": { "headsign": "", "times": [] }, "dir1": { "headsign": "", "times": [] } }

    if not os.path.exists(extract_to):
        os.makedirs(extract_to)

    with zipfile.ZipFile(zip_path, "r") as z:
        # 1. Extract routes
        if "routes.txt" in z.namelist():
            with z.open("routes.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    routes.append(
                        {
                            "id": row.get("route_id"),
                            "short": row.get("route_short_name"),
                            "long": row.get("route_long_name"),
                            "color": row.get("route_color", "6366f1"),
                            "text_color": row.get("route_text_color", "ffffff"),
                        }
                    )
            with open(os.path.join(extract_to, "routes.json"), "w", encoding="utf-8") as f:
                json.dump(routes, f, indent=2, ensure_ascii=False)

        # 2. Extract stops
        if "stops.txt" in z.namelist():
            with z.open("stops.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    s_id = row.get("stop_id")
                    lat_val = safe_float(row.get("stop_lat"))
                    lon_val = safe_float(row.get("stop_lon"))
                    if s_id and lat_val is not None and lon_val is not None:
                        stops.append({"id": s_id, "name": row.get("stop_name"), "lat": lat_val, "lon": lon_val})

        # 3. Extract shapes
        if "shapes.txt" in z.namelist():
            with z.open("shapes.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    s_id = row.get("shape_id")
                    lat_val = safe_float(row.get("shape_pt_lat"))
                    lon_val = safe_float(row.get("shape_pt_lon"))
                    if s_id and lat_val is not None and lon_val is not None:
                        if s_id not in shapes:
                            shapes[s_id] = []
                        shapes[s_id].append([lat_val, lon_val])
            with open(os.path.join(extract_to, "shapes.json"), "w", encoding="utf-8") as f:
                json.dump(shapes, f, indent=2, ensure_ascii=False)

        # 4. Extract trips for both shapes and timetable grouping
        trip_to_route = {}  # trip_id -> (route_id, direction_id, headsign, service_id)
        if "trips.txt" in z.namelist():
            with z.open("trips.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    r_id = row.get("route_id")
                    s_id = row.get("shape_id")
                    t_id = row.get("trip_id")
                    dir_id = row.get("direction_id", "0")
                    headsign = row.get("trip_headsign", "")
                    service_id = row.get("service_id", "")

                    if r_id and s_id:
                        if r_id not in trips_info:
                            trips_info[r_id] = {}
                        trips_info[r_id][dir_id] = s_id  # Store shape for both directions

                    if t_id and r_id:
                        trip_to_route[t_id] = (r_id, dir_id, headsign, service_id)
                        if r_id not in route_timetables:
                            route_timetables[r_id] = {
                                "0": {"headsign": "", "times": {"weekday": set(), "saturday": set(), "sunday": set()}},
                                "1": {"headsign": "", "times": {"weekday": set(), "saturday": set(), "sunday": set()}},
                            }
                        if headsign:
                            route_timetables[r_id][dir_id]["headsign"] = headsign

            with open(os.path.join(extract_to, "trips.json"), "w", encoding="utf-8") as f:
                json.dump(trips_info, f, indent=2, ensure_ascii=False)

        stop_routes_map = {}

        # 5. Extract stop_times for departure lists
        if "stop_times.txt" in z.namelist():
            with z.open("stop_times.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    t_id = row.get("trip_id")
                    s_id = row.get("stop_id")
                    seq = row.get("stop_sequence")
                    dep_time = row.get("departure_time") or row.get("arrival_time")

                    if t_id in trip_to_route:
                        r_id, dir_id, _, service_id = trip_to_route[t_id]

                        if s_id:
                            if s_id not in stop_routes_map:
                                stop_routes_map[s_id] = set()
                            stop_routes_map[s_id].add(r_id)

                        if seq == "1" and dep_time:
                            # Trim seconds if present e.g. 08:30:00 -> 08:30
                            time_short = ":".join(dep_time.split(":")[:2])

                            # Determine day type from service_id (e.g. service_0_MTWTFss)
                            day_type = "weekday"
                            if service_id:
                                parts = service_id.split("_")
                                if len(parts) >= 3:
                                    desc = parts[-1]
                                    if len(desc) >= 7:
                                        if desc[5].isupper() and not desc[6].isupper():
                                            day_type = "saturday"
                                        elif desc[6].isupper():
                                            day_type = "sunday"

                            route_timetables[r_id][dir_id]["times"][day_type].add(time_short)

        # Finalize timetables: convert sets to sorted lists
        final_timetables = {}
        for r_id, dirs in route_timetables.items():
            final_timetables[r_id] = {
                "0": {
                    "headsign": dirs["0"]["headsign"] or "Direction 0",
                    "times": {
                        "weekday": sorted(list(dirs["0"]["times"]["weekday"])),
                        "saturday": sorted(list(dirs["0"]["times"]["saturday"])),
                        "sunday": sorted(list(dirs["0"]["times"]["sunday"])),
                    },
                },
                "1": {
                    "headsign": dirs["1"]["headsign"] or "Direction 1",
                    "times": {
                        "weekday": sorted(list(dirs["1"]["times"]["weekday"])),
                        "saturday": sorted(list(dirs["1"]["times"]["saturday"])),
                        "sunday": sorted(list(dirs["1"]["times"]["sunday"])),
                    },
                },
            }

        with open(os.path.join(extract_to, "timetables.json"), "w", encoding="utf-8") as f:
            json.dump(final_timetables, f, indent=2, ensure_ascii=False)

        for stop in stops:
            stop["routes"] = sorted(list(stop_routes_map.get(stop["id"], set())))

        with open(os.path.join(extract_to, "stops.json"), "w", encoding="utf-8") as f:
            json.dump(stops, f, indent=2, ensure_ascii=False)

    return len(routes), len(stops)


def get_region_map():
    url = "https://service.kentkart.com/rl1/api/v2.0/city"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    for attempt in range(3):
        try:
            req = urllib.request.Request(url)
            res = json.loads(urllib.request.urlopen(req, context=ctx, timeout=10).read().decode("utf-8"))
            rmap = {}
            for c in res.get("city", []):
                r_id = str(c.get("id", "")).zfill(3)
                name = c.get("name", "unknown").lower()
                name = name.replace("ü", "u").replace("ö", "o").replace("ç", "c")
                name = name.replace("ş", "s").replace("ğ", "g").replace("ı", "i")
                name = re.sub(r"[^a-z0-9]", "", name)
                rmap[name] = r_id
            return rmap
        except Exception as e:
            print(f"Error fetching regions (Attempt {attempt+1}): {e}")
            time.sleep(2)

    return {}


def generate_metadata(data_dir, output_file):
    metadata = []
    cities_dir = os.path.join(data_dir, "cities")
    BLACKLIST = {"akcakoca", "altinova", "yozgat"}

    region_map = get_region_map()
    if not region_map:
        print("Warning: Failed to fetch region map from API. All region IDs will be '000'.")
    else:
        print(f"Fetched mapping for {len(region_map)} cities.")

    if not os.path.exists(cities_dir):
        os.makedirs(cities_dir)

    for filename in os.listdir(data_dir):
        if filename.endswith(".zip"):
            city_slug = filename[:-4]
            if city_slug in BLACKLIST:
                print(f"Skipping blacklisted city: {city_slug}")
                continue

            filepath = os.path.join(data_dir, filename)
            stats = os.stat(filepath)
            city_slug = filename[:-4]
            city_name = city_slug.replace("_", " ").title()

            print(f"Processing {city_name}...")
            city_extract_path = os.path.join(cities_dir, city_slug)
            route_count, stop_count = extract_gtfs_data(filepath, city_extract_path)

            region_id = region_map.get(city_slug)
            if not region_id:
                print(f"Warning: No region_id found for city: {city_slug}. Defaulting to '000'.")
                region_id = "000"

            metadata.append(
                {
                    "city": city_name,
                    "slug": city_slug,
                    "region_id": region_id,
                    "filename": filename,
                    "size_mb": round(stats.st_size / (1024 * 1024), 2),
                    "last_updated": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(stats.st_mtime)),
                    "route_count": route_count,
                    "stop_count": stop_count,
                    "download_url": f"https://egezenn.github.io/kk-gtfs/data/{filename}",
                }
            )

    metadata.sort(key=lambda x: x["city"])
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    generate_metadata("data", "data/metadata.json")
