import argparse
import csv
from io import StringIO
import json
import os
import re
import ssl
import time
import urllib.parse
import urllib.request
import zipfile


class KentkartGTFSGenerator:
    def __init__(self, region, delay=0.0):
        self.region = region.zfill(3)
        self.delay = delay
        self.base_url = "https://service.kentkart.com/rl1"
        self.ctx = ssl.create_default_context()
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE

        # In-memory storage of GTFS records
        self.agencies = {}
        self.routes = []
        self.stops = {}
        self.trips = []
        self.stop_times = []
        self.shapes = []
        self.calendar = []

        self.city_name = "unknown"

    def fetch_json(self, path, query_params=None):
        if query_params is None:
            query_params = {}
        query_params["region"] = self.region
        query_params["lang"] = "tr"
        query_string = urllib.parse.urlencode(query_params)
        url = f"{self.base_url}{path}?{query_string}"

        print(f"Fetching {url}")

        max_retries = 3
        for attempt in range(max_retries):
            if self.delay > 0:
                time.sleep(self.delay)

            req = urllib.request.Request(url, headers={"User-Agent": "KentkartGTFSGenerator/1.0"})
            try:
                with urllib.request.urlopen(req, context=self.ctx, timeout=10) as response:
                    return json.loads(response.read().decode("utf-8"))
            except Exception as e:
                print(f"Error fetching {url} (Attempt {attempt + 1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)  # Exponential backoff: 1s, 2s...
                else:
                    return None

    def fetch_city_info(self):
        url = "https://service.kentkart.com/rl1/api/v2.0/city"
        print(f"Fetching {url}")

        max_retries = 3
        for attempt in range(max_retries):
            if self.delay > 0:
                time.sleep(self.delay)

            req = urllib.request.Request(url, headers={"User-Agent": "KentkartGTFSGenerator/1.0"})
            try:
                with urllib.request.urlopen(req, context=self.ctx, timeout=10) as response:
                    data = json.loads(response.read().decode("utf-8"))
                    if data and "city" in data:
                        for c in data["city"]:
                            if str(c.get("id", "")).zfill(3) == self.region:
                                name = c.get("name", "unknown").lower()
                                name = name.replace("ü", "u").replace("ö", "o").replace("ç", "c")
                                name = name.replace("ş", "s").replace("ğ", "g").replace("ı", "i")
                                name = re.sub(r"[^a-z0-9]", "", name)
                                self.city_name = name
                                return
                        return  # City data fetched but region not found
            except Exception as e:
                print(f"Error fetching city info (Attempt {attempt + 1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                else:
                    return

    def time_str_to_seconds(self, time_str):
        if not time_str or time_str == "-":
            return 0
        parts = time_str.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 3600 + int(parts[1]) * 60
        return 0

    def seconds_to_time_str(self, seconds):
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        return f"{h:02d}:{m:02d}:{s:02d}"

    def parse_calendar_days(self, desc):
        if not desc or len(desc) < 7:
            return [0] * 7

        return [
            1 if desc[0].isupper() else 0,  # monday
            1 if desc[1].isupper() else 0,  # tuesday
            1 if desc[2].isupper() else 0,  # wednesday
            1 if desc[3].isupper() else 0,  # thursday
            1 if desc[4].isupper() else 0,  # friday
            1 if desc[5].isupper() else 0,  # saturday
            1 if desc[6].isupper() else 0,  # sunday
        ]

    def process_nearest_find(self):
        data = self.fetch_json("/web/nearest/find")
        if not data or "routeList" not in data:
            return False

        print(f"Found {len(data['routeList'])} routes and {len(data.get('stopList', []))} stops.")

        for stop in data.get("stopList", []):
            stop_id = stop.get("stopId")
            if stop_id not in self.stops:
                self.stops[stop_id] = {
                    "stop_id": stop_id,
                    "stop_name": stop.get("name"),
                    "stop_lat": stop.get("lat"),
                    "stop_lon": stop.get("lng"),
                    "location_type": 0,
                }

        for route in data["routeList"]:
            agency_id = route.get("agencyId")
            agency_name = route.get("agencyName", "Unknown Agency")

            if agency_id and agency_id not in self.agencies:
                self.agencies[agency_id] = {
                    "agency_id": agency_id,
                    "agency_name": agency_name,
                    "agency_url": "https://www.kentkart.com/",
                    "agency_timezone": "Europe/Istanbul",
                }

            # Kentkart is a bus-only company, so GTFS route_type is always 3 (Bus).
            route_type = 3

            r_color = route.get("routeColor", "")
            r_text_color = route.get("routeTextColor", "")

            self.routes.append(
                {
                    "route_id": route.get("routeCode"),
                    "agency_id": agency_id,
                    "route_short_name": route.get("displayRouteCode"),
                    "route_long_name": route.get("name"),
                    "route_type": route_type,
                    "route_color": r_color,
                    "route_text_color": r_text_color,
                }
            )

        return True

    def process_path_info(self):
        processed_display_codes = set()

        for route in self.routes:
            display_code = route["route_short_name"]
            route_id = route["route_id"]

            if display_code in processed_display_codes:
                continue

            processed_display_codes.add(display_code)

            for direction in [0, 1]:
                data = self.fetch_json("/web/pathInfo", {"direction": str(direction), "displayRouteCode": display_code})
                if not data or "pathList" not in data:
                    continue

                for path in data["pathList"]:
                    shape_id = path.get("path_code") or f"shape_{display_code}_{direction}"

                    seq = 1
                    for pt in path.get("pointList", []):
                        self.shapes.append(
                            {
                                "shape_id": shape_id,
                                "shape_pt_lat": pt.get("lat"),
                                "shape_pt_lon": pt.get("lng"),
                                "shape_pt_sequence": seq,
                            }
                        )
                        seq += 1

                    bus_stops = path.get("busStopList", [])
                    for bs in bus_stops:
                        s_id = bs.get("stopId")
                        if s_id and s_id not in self.stops:
                            self.stops[s_id] = {
                                "stop_id": s_id,
                                "stop_name": bs.get("stopName", f"Stop {s_id}"),
                                "stop_lat": bs.get("lat"),
                                "stop_lon": bs.get("lng"),
                                "location_type": 0,
                            }

                    schedules = path.get("scheduleList", [])
                    for sched in schedules:
                        service_id = f"service_{sched.get('serviceId', '0')}_{sched.get('description', 'MTWTFSS')}"
                        days_active = self.parse_calendar_days(sched.get("description"))

                        if not any(c["service_id"] == service_id for c in self.calendar):
                            self.calendar.append(
                                {
                                    "service_id": service_id,
                                    "monday": days_active[0],
                                    "tuesday": days_active[1],
                                    "wednesday": days_active[2],
                                    "thursday": days_active[3],
                                    "friday": days_active[4],
                                    "saturday": days_active[5],
                                    "sunday": days_active[6],
                                    "start_date": "20250101",
                                    "end_date": "20301231",
                                }
                            )

                        for tl in sched.get("timeList", []):
                            trip_id = tl.get("tripId")
                            if not trip_id:
                                continue

                            start_time_str = tl.get("departureTime")
                            start_seconds = self.time_str_to_seconds(start_time_str)

                            self.trips.append(
                                {
                                    "route_id": route_id,
                                    "service_id": service_id,
                                    "trip_id": trip_id,
                                    "trip_headsign": path.get("headSign", ""),
                                    "direction_id": direction,
                                    "shape_id": shape_id,
                                }
                            )

                            stop_seq = 1
                            for bs in bus_stops:
                                arr_offset = int(bs.get("arrival_offset", 0))
                                dep_offset = int(bs.get("departure_offset", 0))

                                arr_time = self.seconds_to_time_str(start_seconds + arr_offset)
                                dep_time = self.seconds_to_time_str(start_seconds + dep_offset)

                                self.stop_times.append(
                                    {
                                        "trip_id": trip_id,
                                        "arrival_time": arr_time,
                                        "departure_time": dep_time,
                                        "stop_id": bs.get("stopId"),
                                        "stop_sequence": bs.get("seq", stop_seq),
                                    }
                                )
                                stop_seq += 1

    def write_csv(self, fieldnames, data):
        output = StringIO()
        writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for row in data:
            writer.writerow(row)
        return output.getvalue()

    def generate_zip(self):
        output_dir = "data"
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)

        output_file = os.path.join(output_dir, f"{self.city_name}.zip")
        print(f"Generating {output_file}...")

        if not self.agencies:
            self.agencies["1"] = {
                "agency_id": "1",
                "agency_name": "Kentkart Agency",
                "agency_url": "https://www.kentkart.com/",
                "agency_timezone": "Europe/Istanbul",
            }

        files = {
            "agency.txt": {
                "fields": ["agency_id", "agency_name", "agency_url", "agency_timezone"],
                "data": list(self.agencies.values()),
            },
            "stops.txt": {
                "fields": ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type"],
                "data": list(self.stops.values()),
            },
            "routes.txt": {
                "fields": [
                    "route_id",
                    "agency_id",
                    "route_short_name",
                    "route_long_name",
                    "route_type",
                    "route_color",
                    "route_text_color",
                ],
                "data": self.routes,
            },
            "trips.txt": {
                "fields": ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
                "data": self.trips,
            },
            "stop_times.txt": {
                "fields": ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
                "data": self.stop_times,
            },
            "shapes.txt": {
                "fields": ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
                "data": self.shapes,
            },
            "calendar.txt": {
                "fields": [
                    "service_id",
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                    "start_date",
                    "end_date",
                ],
                "data": self.calendar,
            },
        }

        with zipfile.ZipFile(output_file, "w", zipfile.ZIP_DEFLATED) as zf:
            for fname, content in files.items():
                if content["data"]:
                    csv_string = self.write_csv(content["fields"], content["data"])
                    zf.writestr(fname, csv_string)
                    print(f"  Added {fname} ({len(content['data'])} records)")

        print(f"Successfully created {output_file}")


def get_all_regions():
    url = "https://service.kentkart.com/rl1/api/v2.0/city"
    regions = []

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    max_retries = 3
    for attempt in range(max_retries):
        req = urllib.request.Request(url, headers={"User-Agent": "KentkartGTFSGenerator/1.0"})
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
                if data and "city" in data:
                    for c in data["city"]:
                        r_id = str(c.get("id", "")).zfill(3)
                        if r_id and r_id != "000":
                            regions.append(r_id)
                return regions
        except Exception as e:
            print(f"Error fetching API city info (Attempt {attempt + 1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                time.sleep(2**attempt)
            else:
                return regions


def main():
    parser = argparse.ArgumentParser(description="Kentkart GTFS Generator")
    parser.add_argument("-r", "--region", type=str, default="ALL", help="Region code (default: ALL)")
    parser.add_argument("-d", "--delay", type=float, default=0.0, help="Delay in seconds between requests (default: 0)")
    parser.add_argument("-f", "--force", action="store_true", help="Force regenerate existing GTFS feed zips")
    args = parser.parse_args()

    if args.region.upper() == "ALL":
        regions = get_all_regions()
        print(f"Discovered {len(regions)} regions to process.")
    else:
        regions = [args.region.zfill(3)]

    for region in regions:
        generator = KentkartGTFSGenerator(region=region, delay=args.delay)
        print(f"\n--- Starting extraction for region {region} ---")

        generator.fetch_city_info()
        print(f"City mapped to: {generator.city_name}")

        if not args.force:
            existing_zip = os.path.join("data", f"{generator.city_name}.zip")
            if os.path.exists(existing_zip):
                print(f"--- City {generator.city_name} already exists ({existing_zip}), skipping ---")
                continue

        if not generator.process_nearest_find():
            print(f"Failed to fetch initial route and stop data for region {region}. Skipping.")
            continue

        generator.process_path_info()

        generator.generate_zip()


if __name__ == "__main__":
    main()
