import os
import json
import math
from datetime import datetime

# === 設定 ===
RAW_DIR = "../data-raw"  # 存放 .dat 檔案的資料夾 (相對於 scripts)
OUT_DIR = "../data/processed"  # 輸出 JSON 的資料夾


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_time(time_str):
    # 處理兩種格式: 2026/09/14-06:44:41 或 2026/09/14-06:44:30.000
    time_str = time_str.strip()
    if "." in time_str:
        return datetime.strptime(time_str, "%Y/%m/%d-%H:%M:%S.%f")
    else:
        return datetime.strptime(time_str, "%Y/%m/%d-%H:%M:%S")


def parse_dat_file(filepath):
    header = {}
    data_lines = []
    is_data = False

    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            if line.startswith("#"):
                if ":" in line:
                    key, val = line[1:].split(":", 1)
                    header[key.strip()] = val.strip()
                if "#Data:" in line:
                    is_data = True
            elif is_data:
                parts = line.split()
                if len(parts) >= 4:
                    try:
                        t = float(parts[0])
                        u = float(parts[1])
                        n = float(parts[2])
                        e = float(parts[3])
                        data_lines.append((t, u, n, e))
                    except ValueError:
                        continue

    # 解析時間偏移
    origin_time = parse_time(header.get("Origin Time(GMT+08)", ""))
    start_time = parse_time(header.get("StartTime(GMT+08)", ""))
    time_offset_sec = (origin_time - start_time).total_seconds()

    # 解析震央與測站資訊
    eq_lat = float(header.get("EpicenterLatitude(N)", 0))
    eq_lon = float(header.get("EpicenterLongitude(E)", 0))

    eq_info = {
        "originTime": origin_time.isoformat(),
        "epicenter": {"lat": eq_lat, "lon": eq_lon},
        "depthKm": float(header.get("Depth(km)", 0)),
        "magnitude": float(header.get("Magnitude(Ml)", 0).replace("M", "")),
    }

    sta_info = {
        "code": header.get("StationCode", ""),
        "name": header.get("StationName", ""),
        "lat": float(header.get("StationLatitude(N)", 0)),
        "lon": float(header.get("StationLongitude(E)", 0)),
        "instrument": header.get("InstrumentKind", ""),
        "sampleRate": int(header.get("SampleRate(Hz)", 100)),
        "unit": header.get("AmplitudeUnit", "gal").split(".")[0].strip(),
        "recordLength": int(header.get("RecordLength(sec)", 90)),
    }

    # 計算距離與估算 P/S 波
    dist_km = haversine_km(eq_lat, eq_lon, sta_info["lat"], sta_info["lon"])
    p_arrival = round(1.0 + dist_km / 6.0, 2)
    s_arrival = round(1.0 + dist_km / 3.5, 2)

    # 轉換波形資料 (相對發震時間)
    waveform = {"U": [], "N": [], "E": []}
    time_axis = []

    for t, u, n, e in data_lines:
        rel_t = round(t - time_offset_sec, 3)
        time_axis.append(rel_t)
        waveform["U"].append(round(u, 4))
        waveform["N"].append(round(n, 4))
        waveform["E"].append(round(e, 4))

    return eq_info, sta_info, dist_km, p_arrival, s_arrival, time_axis, waveform


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.join(OUT_DIR, "waveforms"), exist_ok=True)

    events = {}
    stations = []

    # 掃描所有 .dat 檔案
    for filename in os.listdir(RAW_DIR):
        if not filename.endswith(".dat"):
            continue

        filepath = os.path.join(RAW_DIR, filename)

        print(f"Processing {filename}...")
        eq_info, sta_info, dist_km, p_arr, s_arr, time_axis, wave_data = parse_dat_file(
            filepath
        )

        # 生成唯一事件 ID：發震時間 + 震央座標
        origin_time_str = (
            eq_info["originTime"]
            .replace("T", "")
            .replace(":", "")
            .replace("-", "")[:14]
        )
        event_id = f"{origin_time_str}_{eq_info['epicenter']['lon']}_{eq_info['epicenter']['lat']}"

        # 記錄事件
        if event_id not in events:
            events[event_id] = {
                "id": event_id,
                "name": f"{eq_info['originTime'][:10]} M{eq_info['magnitude']} 地震",
                **eq_info,
                "stationCount": 0,
            }
        events[event_id]["stationCount"] += 1

        # 記錄測站
        stations.append(
            {
                "eventId": event_id,
                "id": sta_info["code"],
                "name": sta_info["name"],
                "lat": sta_info["lat"],
                "lon": sta_info["lon"],
                "instrument": sta_info["instrument"],
                "sampleRate": sta_info["sampleRate"],
                "unit": sta_info["unit"],
                "distanceKm": round(dist_km, 1),
                "pArrivalSec": p_arr,
                "sArrivalSec": s_arr,
            }
        )

        # 寫入個別測站的波形 JSON
        wave_out = {
            "time": time_axis,
            "U": wave_data["U"],
            "N": wave_data["N"],
            "E": wave_data["E"],
        }
        wave_filename = f"{event_id}_{sta_info['code']}.json"
        with open(
            os.path.join(OUT_DIR, "waveforms", wave_filename), "w", encoding="utf-8"
        ) as f:
            json.dump(wave_out, f, ensure_ascii=False)

    # 寫入 events.json (加上 ensure_ascii=False 解決中文亂碼)
    with open(os.path.join(OUT_DIR, "events.json"), "w", encoding="utf-8") as f:
        json.dump(list(events.values()), f, indent=2, ensure_ascii=False)

    # 寫入 stations.json (加上 ensure_ascii=False 解決中文亂碼)
    with open(os.path.join(OUT_DIR, "stations.json"), "w", encoding="utf-8") as f:
        json.dump(stations, f, indent=2, ensure_ascii=False)

    print(f"\nDone! Processed {len(stations)} stations across {len(events)} events.")
    print(f"JSON files saved to {OUT_DIR}")


if __name__ == "__main__":
    main()
