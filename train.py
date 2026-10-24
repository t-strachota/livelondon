"""Train the flow calibration model from WebTRIS sensors near London and export flow_table.json.

Run once: python train.py   (needs: pip install scikit-learn numpy)
"""
import json, datetime as dt, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

API = "https://webtris.nationalhighways.co.uk/api/v1.0"
LONDON = (51.507, -0.128)
N_SITES, DAYS, LANES = 30, 28, 3  # WebTRIS gives no lane count, so every site uses the default 3


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        body = r.read()
    return json.loads(body) if body else None  # 204 No Content = no data for that range


def rows(site, start, end, page_size=10000):
    out, url = [], f"{API}/reports/{start:%d%m%Y}/to/{end:%d%m%Y}/Daily?sites={site}&page=1&page_size={page_size}"
    while url:
        try:
            page = get(url)
        except Exception as e:
            print(f"  site {site}: {e}")
            break
        if not page:
            break
        out += page["Rows"]
        url = next((l["href"] for l in page["Header"].get("links", []) if l["rel"] == "nextPage"), None)
    # Missing readings come back as "" so keep only rows with both values
    return [r for r in out if r["Avg mph"] and r["Total Volume"]]


sites = [s for s in get(f"{API}/sites")["sites"] if s["Status"] == "Active"]
sites.sort(key=lambda s: (s["Latitude"] - LONDON[0]) ** 2 + ((s["Longitude"] - LONDON[1]) * 0.62) ** 2)
sites = sites[:150]

# WebTRIS lags by months and many "Active" sites report blanks, so walk back to the newest day that has data
end = dt.date.today()
with ThreadPoolExecutor(10) as pool:
    for _ in range(40):
        end -= dt.timedelta(days=14)
        if sum(map(bool, pool.map(lambda s: rows(s["Id"], end, end, 96), sites[:10]))) >= 3:
            break
    else:
        raise SystemExit("No recent WebTRIS data found")
    start = end - dt.timedelta(days=DAYS - 1)
    print(f"Window {start} to {end}")

    data = []
    for i in range(0, len(sites), 10):  # in batches, stopping once enough sites have data
        for s, r in zip(sites[i:i + 10], pool.map(lambda s: rows(s["Id"], start, end), sites[i:i + 10])):
            if len(r) > DAYS * 96 // 2 and len(data) < N_SITES:
                data.append((s, r))
                print(f"  {s['Name']:<12} {len(r)} rows")
        if len(data) >= N_SITES:
            break

X, y, t = [], [], []
for s, rs in data:
    mph = np.array([float(r["Avg mph"]) for r in rs])
    p95 = np.percentile(mph, 95)  # this site's free-flow speed
    for r, v in zip(rs, mph):
        when = dt.datetime.fromisoformat(r["Report Date"]) + dt.timedelta(hours=int(r["Time Period Ending"][:2]))
        X.append([when.hour, when.weekday(), min(v / p95, 1.0), LANES])
        y.append(float(r["Total Volume"]) * 4 / LANES)  # 15-min count -> veh/h/lane
        t.append(when)
X, y, t = np.array(X), np.array(y), np.array(t)

test = t >= dt.datetime.combine(end - dt.timedelta(days=6), dt.time())  # last week held out
model = HistGradientBoostingRegressor(random_state=0).fit(X[~test], y[~test])
pred = model.predict(X[test])
mae, r2 = mean_absolute_error(y[test], pred), r2_score(y[test], pred)
print(f"Sites {len(data)}, rows {len(y)}, holdout MAE {mae:.1f} veh/h/lane, R2 {r2:.3f}")

model.fit(X, y)  # refit on everything for the exported table
ratios = [round(0.1 * i, 1) for i in range(1, 11)]
grid = np.array([[h, d, r, LANES] for d in range(7) for h in range(24) for r in ratios])
table = np.maximum(model.predict(grid), 0).round(1).reshape(7, 24, 10)
json.dump({"metrics": {"mae": round(mae, 1), "r2": round(r2, 3), "sites": len(data), "rows": len(y),
                       "window": [str(start), str(end)]},
           "ratios": ratios, "table": table.tolist()},  # table[day_of_week Mon=0][hour][ratio bucket]
          open("flow_table.json", "w"))
print("Wrote flow_table.json")
