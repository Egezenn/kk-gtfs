import os
import json
import time
import zipfile
import csv
from io import TextIOWrapper


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
            with open(os.path.join(extract_to, "stops.json"), "w", encoding="utf-8") as f:
                json.dump(stops, f, indent=2, ensure_ascii=False)

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
        trip_to_route = {}  # trip_id -> (route_id, direction_id, headsign)
        if "trips.txt" in z.namelist():
            with z.open("trips.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    r_id = row.get("route_id")
                    s_id = row.get("shape_id")
                    t_id = row.get("trip_id")
                    dir_id = row.get("direction_id", "0")
                    headsign = row.get("trip_headsign", "")

                    if r_id and s_id:
                        if r_id not in trips_info:
                            trips_info[r_id] = {}
                        trips_info[r_id][dir_id] = s_id  # Store shape for both directions

                    if t_id and r_id:
                        trip_to_route[t_id] = (r_id, dir_id, headsign)
                        if r_id not in route_timetables:
                            route_timetables[r_id] = {
                                "0": {"headsign": "", "times": set()},
                                "1": {"headsign": "", "times": set()},
                            }
                        if headsign:
                            route_timetables[r_id][dir_id]["headsign"] = headsign

            with open(os.path.join(extract_to, "trips.json"), "w", encoding="utf-8") as f:
                json.dump(trips_info, f, indent=2, ensure_ascii=False)

        # 5. Extract stop_times for departure lists
        if "stop_times.txt" in z.namelist():
            with z.open("stop_times.txt") as f:
                reader = csv.DictReader(TextIOWrapper(f, encoding="utf-8-sig"))
                for row in reader:
                    t_id = row.get("trip_id")
                    seq = row.get("stop_sequence")
                    dep_time = row.get("departure_time") or row.get("arrival_time")

                    if t_id in trip_to_route and seq == "1" and dep_time:
                        r_id, dir_id, _ = trip_to_route[t_id]
                        # Trim seconds if present e.g. 08:30:00 -> 08:30
                        time_short = ":".join(dep_time.split(":")[:2])
                        route_timetables[r_id][dir_id]["times"].add(time_short)

        # Finalize timetables: convert sets to sorted lists
        final_timetables = {}
        for r_id, dirs in route_timetables.items():
            final_timetables[r_id] = {
                "0": {"headsign": dirs["0"]["headsign"] or "Direction 0", "times": sorted(list(dirs["0"]["times"]))},
                "1": {"headsign": dirs["1"]["headsign"] or "Direction 1", "times": sorted(list(dirs["1"]["times"]))},
            }

        with open(os.path.join(extract_to, "timetables.json"), "w", encoding="utf-8") as f:
            json.dump(final_timetables, f, indent=2, ensure_ascii=False)

    return len(routes), len(stops)


def generate_metadata(data_dir, output_file):
    metadata = []
    cities_dir = os.path.join(data_dir, "cities")
    BLACKLIST = {"akcakoca", "altinova", "yozgat"}

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

            metadata.append(
                {
                    "city": city_name,
                    "slug": city_slug,
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
