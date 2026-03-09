# KentKart GTFS Data Generator

A product of, "hey, i could probably do this."

to run:

```shell
git clone https://github.com/Egezenn/kk-gtfs
uv run kk-gtfs.py
```

```plaintext
usage: kk-gtfs.py [-h] [-r REGION] [-d DELAY] [-f]

Kentkart GTFS Generator

options:
  -h, --help            show this help message and exit
  -r, --region REGION   Region code (default: ALL)
  -d, --delay DELAY     Delay in seconds between requests (default: 0)
  -f, --force           Force regenerate existing GTFS feed zips
```

<details>
<summary><h2>Publicly available API endpoints</h2></summary>

<https://service.kentkart.com/rl1/api/v2.0/city>
<https://service.kentkart.com/rl1/api/info/announce?region=XXX&lang=tr>
<https://service.kentkart.com/rl1/web/nearest/find?region=XXX&lang=tr>
<https://service.kentkart.com/rl1/web/pathInfo?region=XXX&lang=tr&direction=X&displayRouteCode=X>
</details>

## Hardcoded Assumptions

Because the KentKart API endpoints do not provide all required fields to generate a strictly compliant GTFS feed, the generator enforces the following hardcoded baseline assumptions:

- **Agency URL**: Defaulted to `https://www.kentkart.com/` (`agency.txt`)
- **Agency Timezone**: Defaulted to `Europe/Istanbul` (`agency.txt`)
- **Route Type**: Forced to `3` (Bus) for all routes, as Kentkart is a bus-centric platform (`routes.txt`)
- **Calendar Dates**: Service ID dates are set with a start boundary of `20250101` and an end boundary of `20301231` (`calendar.txt`)

## Data Access

`https://github.com/Egezenn/kk-gtfs/raw/main/data/{city}.zip`

`https://github.com/Egezenn/kk-gtfs/raw/main/data/adana.zip`
