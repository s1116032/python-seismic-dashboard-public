/**
 * 真實 CWA 強地動波形儀表板
 *
 * 資料來源：
 * - data/processed/events.json
 * - data/processed/stations.json
 * - data/processed/waveforms/{eventId}_{stationId}.json
 *
 * 注意：
 * 因為使用 fetch 讀取 JSON，請用 local server 開啟專案，
 * 例如：
 *   npx serve .
 *   python -m http.server 8000
 */

let EVENTS = [];
let ALL_STATIONS = [];

const WAVEFORM_CACHE = {};

/**
 * 用來避免快速切換測站時，舊的非同步波形請求覆蓋新波形。
 */
let waveformRenderToken = 0;

/**
 * 全域狀態
 */
const state = {
  eventId: null,
  stationId: null,
  component: "U",
};

/**
 * 播放狀態
 *
 * 真實波形長度約 90 秒。
 * 目前策略：
 * - 每 500ms 推進 5 秒
 * - 90 秒波形大約 9 秒播放完成
 */
const playback = {
  timer: null,
  isPlaying: false,
  currentTimeSec: 0,
  intervalMs: 500,
  stepSec: 5,
};

let map;
let epicenterLayer;
let stationLayer;

/**
 * 初始化地圖
 */
function initMap() {
  map = L.map("map").setView([23.7, 120.9], 7);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  epicenterLayer = L.layerGroup().addTo(map);
  stationLayer = L.layerGroup().addTo(map);
}

/**
 * 更新底部狀態列
 */
function updateStatus(message) {
  const statusElement = document.getElementById("status");
  statusElement.textContent = message;
}

/**
 * 更新測站資訊區塊
 */
function updateStationInfo(message) {
  const stationInfoElement = document.getElementById("station-info");
  stationInfoElement.textContent = message;
}

/**
 * 更新播放狀態文字
 */
function updatePlayStatus(message = "") {
  const playStatusElement = document.getElementById("play-status");

  if (playStatusElement) {
    playStatusElement.textContent = message;
  }
}

/**
 * 更新播放按鈕文字
 */
function updatePlayButtonLabel(label = "播放波形") {
  const playButton = document.getElementById("play-button");

  if (playButton) {
    playButton.textContent = label;
  }
}

/**
 * 顯示空波形圖或提示圖
 */
function renderEmptyWaveform(message = "請選擇測站") {
  const layout = {
    title: {
      text: message,
      font: {
        size: 16,
      },
    },
    xaxis: {
      title: "相對發震時間（秒）",
    },
    yaxis: {
      title: "振幅",
    },
    margin: {
      l: 60,
      r: 24,
      t: 56,
      b: 48,
    },
  };

  Plotly.react("waveform", [], layout, {
    responsive: true,
    displayModeBar: false,
  });
}

/**
 * 取得所有事件
 */
function getEvents() {
  return EVENTS;
}

/**
 * 用 ID 取得事件
 */
function getEventById(eventId) {
  return EVENTS.find((event) => event.id === eventId);
}

/**
 * 取得某事件下的所有測站，並依距離排序
 */
function getStationsByEventId(eventId) {
  return ALL_STATIONS.filter((station) => station.eventId === eventId).sort(
    (a, b) => a.distanceKm - b.distanceKm
  );
}

/**
 * 取得單一測站
 */
function getStationById(eventId, stationId) {
  return ALL_STATIONS.find(
    (station) => station.eventId === eventId && station.id === stationId
  );
}

/**
 * 載入測站波形
 *
 * 波形 JSON 格式：
 * {
 *   "time": [...],
 *   "U": [...],
 *   "N": [...],
 *   "E": [...]
 * }
 */
async function getWaveform(eventId, stationId) {
  const cacheKey = `${eventId}:${stationId}`;

  if (WAVEFORM_CACHE[cacheKey]) {
    return WAVEFORM_CACHE[cacheKey];
  }

  const url = `data/processed/waveforms/${eventId}_${stationId}.json`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`無法載入波形：${url}`);
  }

  const waveform = await response.json();

  WAVEFORM_CACHE[cacheKey] = waveform;

  return waveform;
}

/**
 * 取得不同分量的波形顏色
 */
function getComponentColor(component) {
  if (component === "N") {
    return "#16a34a";
  }

  if (component === "E") {
    return "#9333ea";
  }

  return "#2563eb";
}

/**
 * 計算穩定的 Y 軸範圍
 *
 * 使用完整波形的最小值與最大值，
 * 避免播放過程中 Y 軸範圍不斷跳動。
 */
function getStableYRange(values) {
  let min = Infinity;
  let max = -Infinity;

  for (const value of values) {
    if (value < min) {
      min = value;
    }

    if (value > max) {
      max = value;
    }
  }

  if (!isFinite(min) || !isFinite(max)) {
    return [-1, 1];
  }

  if (min === max) {
    return [min - 1, max + 1];
  }

  const padding = (max - min) * 0.08;

  return [min - padding, max + padding];
}

/**
 * 建立垂直線標註
 *
 * 標註會盡量放在垂直線右側；
 * 如果垂直線太靠近右邊界，則改放左側。
 */
function createLineAnnotation({
  xValue,
  firstTime,
  xMax,
  text,
  textColor,
  arrowColor,
  ay,
}) {
  const rangeSpan = Math.max(0.001, xMax - firstTime);

  const nearRight = xValue > xMax - rangeSpan * 0.22;

  const ax = nearRight ? -12 : 12;
  const xanchor = nearRight ? "right" : "left";

  return {
    x: xValue,
    y: 1,
    yref: "paper",
    text,
    showarrow: true,
    arrowhead: 0,
    arrowwidth: 1,
    arrowcolor: arrowColor,
    ax,
    ay,
    xanchor,
    font: {
      color: textColor,
      size: 12,
    },
    bgcolor: "rgba(255, 255, 255, 0.85)",
    bordercolor: textColor,
    borderwidth: 1,
    borderpad: 3,
  };
}

/**
 * 畫目前選取測站的波形圖
 *
 * @param {number|null} maxTimeSec
 * 如果為 null，表示畫完整波形。
 * 如果有數值，表示只畫到該秒數，用於播放。
 */
async function renderWaveformForCurrentStation(maxTimeSec = null) {
  const token = ++waveformRenderToken;

  if (!state.eventId || !state.stationId) {
    renderEmptyWaveform("請選擇測站");
    return;
  }

  const station = getStationById(state.eventId, state.stationId);

  if (!station) {
    renderEmptyWaveform("找不到測站資料");
    return;
  }

  if (maxTimeSec === null) {
    updateStatus(`載入波形：${station.name}（${station.id}）...`);
  }

  let waveform;

  try {
    waveform = await getWaveform(state.eventId, state.stationId);
  } catch (error) {
    console.error(error);

    if (token === waveformRenderToken) {
      renderEmptyWaveform("波形載入失敗");
      updateStatus(
        "波形載入失敗。請確認已使用 local server，且已執行 parse_cwa_dat.py。"
      );
    }

    return;
  }

  if (token !== waveformRenderToken) {
    return;
  }

  const component = state.component;
  const times = waveform.time;
  const yFull = waveform[component];

  if (!Array.isArray(times) || !Array.isArray(yFull) || times.length === 0) {
    renderEmptyWaveform("波形資料格式錯誤");
    updateStatus("波形資料格式錯誤");
    return;
  }

  const firstTime = times[0];
  const lastTime = times[times.length - 1];

  let xMax = lastTime;
  let visibleCount = times.length;

  if (maxTimeSec !== null) {
    xMax = Math.max(firstTime, Math.min(lastTime, maxTimeSec));

    visibleCount = times.findIndex((time) => time > xMax);

    if (visibleCount === -1) {
      visibleCount = times.length;
    }

    visibleCount = Math.max(1, visibleCount);
  }

  const x = times.slice(0, visibleCount);
  const y = yFull.slice(0, visibleCount);

  const [yMin, yMax] = getStableYRange(yFull);

  const unit = station.unit || "gal";

  const pSec = station.pArrivalSec;
  const sSec = station.sArrivalSec;

  const shapes = [
    {
      type: "line",
      x0: 0,
      x1: 0,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: {
        color: "#64748b",
        width: 2,
        dash: "dot",
      },
    },
  ];

  const annotations = [
    createLineAnnotation({
      xValue: 0,
      firstTime,
      xMax,
      text: "發震 0s",
      textColor: "#64748b",
      arrowColor: "#94a3b8",
      ay: -18,
    }),
  ];

  if (Number.isFinite(pSec)) {
    shapes.push({
      type: "line",
      x0: pSec,
      x1: pSec,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: {
        color: "#dc2626",
        width: 2,
        dash: "dash",
      },
    });

    annotations.push(
      createLineAnnotation({
        xValue: pSec,
        firstTime,
        xMax,
        text: `P ${pSec}s`,
        textColor: "#dc2626",
        arrowColor: "#fca5a5",
        ay: -38,
      })
    );
  }

  if (Number.isFinite(sSec)) {
    shapes.push({
      type: "line",
      x0: sSec,
      x1: sSec,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: {
        color: "#2563eb",
        width: 2,
        dash: "dash",
      },
    });

    annotations.push(
      createLineAnnotation({
        xValue: sSec,
        firstTime,
        xMax,
        text: `S ${sSec}s`,
        textColor: "#2563eb",
        arrowColor: "#93c5fd",
        ay: -58,
      })
    );
  }

  const trace = {
    x,
    y,
    mode: "lines",
    name: component,
    line: {
      color: getComponentColor(component),
      width: 1.4,
    },
    hovertemplate: `時間 %{x:.2f}s<br>振幅 %{y:.3f} ${unit}<extra></extra>`,
  };

  const layout = {
    title: {
      text: `${station.name}（${station.id}）${component} 分量`,
      font: {
        size: 15,
      },
      x: 0.01,
      xanchor: "left",
    },
    xaxis: {
      title: "相對發震時間（秒）",
      range: [firstTime, xMax],
    },
    yaxis: {
      title: `振幅（${unit}）`,
      range: [yMin, yMax],
      zeroline: true,
      zerolinecolor: "#e2e8f0",
    },
    showlegend: false,
    margin: {
      l: 60,
      r: 24,
      t: 100,
      b: 48,
    },
    annotations,
    shapes,
  };

  Plotly.react("waveform", [trace], layout, {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    scrollZoom: true,
    doubleClick: "reset",
    modeBarButtonsToRemove: [
      "sendDataToCloud",
      "lasso2d",
      "select2d",
      "hoverClosestCartesian",
      "hoverCompareCartesian",
      "toggleSpikelines",
    ],
  });

  if (maxTimeSec === null) {
    updateStatus(
      `已載入波形：${station.name}（${station.id}）｜${component} 分量`
    );
  }
}

/**
 * 產生事件選擇器選項
 */
function renderEventOptions() {
  const select = document.getElementById("event-select");

  select.innerHTML = "";

  if (EVENTS.length === 0) {
    const option = document.createElement("option");
    option.textContent = "無事件資料";
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;

  EVENTS.forEach((event) => {
    const option = document.createElement("option");

    option.value = event.id;
    option.textContent = `${event.name}（${event.stationCount} 站）`;

    if (event.id === state.eventId) {
      option.selected = true;
    }

    select.appendChild(option);
  });
}

/**
 * 高亮目前選中的測站
 */
function highlightSelectedStation() {
  stationLayer.eachLayer((layer) => {
    const isSelected = layer.options.stationId === state.stationId;

    layer.setStyle({
      fillColor: isSelected ? "#f59e0b" : "#2563eb",
      radius: isSelected ? 8 : 5,
    });

    if (isSelected) {
      layer.bringToFront();
    }
  });
}

/**
 * 選擇測站
 */
function selectStation(stationId) {
  stopPlayback(false);

  state.stationId = stationId;

  const station = getStationById(state.eventId, stationId);

  if (!station) {
    updateStationInfo("找不到測站資料");
    updateStatus("找不到測站資料");
    updatePlayStatus("");
    renderEmptyWaveform("找不到測站資料");
    return;
  }

  highlightSelectedStation();

  const stationInfo = [
    `測站：${station.name}（${station.id}）`,
    `距離震央：${station.distanceKm} km`,
    `估算 P：${station.pArrivalSec}s`,
    `估算 S：${station.sArrivalSec}s`,
    `取樣率：${station.sampleRate} Hz`,
    `儀器：${station.instrument}`,
  ].join("｜");

  updateStationInfo(stationInfo);
  updatePlayStatus("");

  void renderWaveformForCurrentStation();
}

/**
 * 畫出震央
 */
function renderEpicenter(event) {
  epicenterLayer.clearLayers();

  const epicenterMarker = L.circleMarker(
    [event.epicenter.lat, event.epicenter.lon],
    {
      radius: Math.max(8, event.magnitude * 2),
      color: "#ffffff",
      weight: 2,
      fillColor: "#dc2626",
      fillOpacity: 0.95,
    }
  );

  epicenterMarker.bindTooltip(
    `
    <div>
      <strong>${event.name}</strong><br />
      規模：M${event.magnitude}<br />
      深度：${event.depthKm} km<br />
      測站數：${event.stationCount}
    </div>
    `,
    {
      direction: "top",
    }
  );

  epicenterLayer.addLayer(epicenterMarker);
}

/**
 * 畫出測站
 */
function renderStations(stations) {
  stationLayer.clearLayers();

  stations.forEach((station) => {
    const stationMarker = L.circleMarker([station.lat, station.lon], {
      stationId: station.id,
      radius: 5,
      color: "#ffffff",
      weight: 2,
      fillColor: "#2563eb",
      fillOpacity: 0.95,
    });

    stationMarker.bindTooltip(
      `
      <div>
        <strong>${station.name}</strong>（${station.id}）<br />
        距離：${station.distanceKm} km
      </div>
      `,
      {
        direction: "top",
      }
    );

    stationMarker.on("click", () => {
      selectStation(station.id);
    });

    stationLayer.addLayer(stationMarker);
  });
}

/**
 * 依目前事件在地圖上渲染震央與測站
 */
function renderMapForCurrentEvent() {
  const event = getEventById(state.eventId);

  if (!event) {
    updateStatus("找不到事件資料");
    renderEmptyWaveform("找不到事件資料");
    return;
  }

  const stations = getStationsByEventId(state.eventId);

  renderEpicenter(event);
  renderStations(stations);

  const selectedStation =
    stations.find((station) => station.id === state.stationId) ||
    stations[0];

  if (selectedStation) {
    selectStation(selectedStation.id);
  } else {
    stopPlayback(false);

    state.stationId = null;

    updateStationInfo("此事件沒有測站資料");
    updateStatus("此事件沒有測站資料");
    updatePlayStatus("");
    renderEmptyWaveform("此事件沒有測站資料");
  }

  if (stations.length > 0) {
    const bounds = L.latLngBounds([
      [event.epicenter.lat, event.epicenter.lon],
      ...stations.map((station) => [station.lat, station.lon]),
    ]);

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.15));
    }
  } else {
    map.setView([event.epicenter.lat, event.epicenter.lon], 10);
  }
}

/**
 * 事件切換處理
 */
function handleEventChange(event) {
  stopPlayback(false);

  state.eventId = event.target.value;
  state.stationId = null;

  const selectedEvent = getEventById(state.eventId);

  renderMapForCurrentEvent();
  updateStatus(`目前事件：${selectedEvent.name}`);
}

/**
 * 設定事件選擇器
 */
function setupEventSelect() {
  const select = document.getElementById("event-select");

  select.addEventListener("change", handleEventChange);
}

/**
 * 設定分量切換按鈕
 */
function setupComponentControls() {
  const buttons = document.querySelectorAll(".component-button");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      stopPlayback(false);

      state.component = button.dataset.component;

      buttons.forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      void renderWaveformForCurrentStation();
    });
  });
}

/**
 * 停止播放
 *
 * @param {boolean} renderFull
 * 是否停止後重新畫完整波形。
 */
function stopPlayback(renderFull = true) {
  if (playback.timer) {
    clearInterval(playback.timer);
    playback.timer = null;
  }

  playback.isPlaying = false;

  updatePlayButtonLabel("播放波形");

  if (renderFull && state.stationId) {
    void renderWaveformForCurrentStation();
  }
}

/**
 * 播放過程中的每一步
 */
async function advancePlayback() {
  const station = getStationById(state.eventId, state.stationId);

  if (!station) {
    stopPlayback(false);
    return;
  }

  let waveform;

  try {
    waveform = await getWaveform(state.eventId, state.stationId);
  } catch (error) {
    console.error(error);
    stopPlayback(false);
    updatePlayStatus("播放失敗：無法載入波形");
    return;
  }

  const lastTime = waveform.time[waveform.time.length - 1];

  playback.currentTimeSec = Math.min(
    lastTime,
    playback.currentTimeSec + playback.stepSec
  );

  await renderWaveformForCurrentStation(playback.currentTimeSec);

  if (playback.currentTimeSec >= lastTime) {
    stopPlayback(false);
    updatePlayStatus("播放結束，已顯示完整波形");
    void renderWaveformForCurrentStation();
  } else {
    updatePlayStatus(
      `播放中：${playback.currentTimeSec.toFixed(1)} s / ${lastTime.toFixed(
        1
      )} s`
    );
  }
}

/**
 * 開始播放
 */
async function startPlayback() {
  const station = getStationById(state.eventId, state.stationId);

  if (!station) {
    updatePlayStatus("請先選擇測站");
    return;
  }

  try {
    const waveform = await getWaveform(state.eventId, state.stationId);

    if (!Array.isArray(waveform.time) || waveform.time.length === 0) {
      updatePlayStatus("無法播放：波形資料為空");
      return;
    }

    stopPlayback(false);

    playback.isPlaying = true;
    playback.currentTimeSec = waveform.time[0];

    const lastTime = waveform.time[waveform.time.length - 1];

    updatePlayButtonLabel("停止播放");
    updatePlayStatus(
      `播放中：${playback.currentTimeSec.toFixed(1)} s / ${lastTime.toFixed(
        1
      )} s`
    );

    await renderWaveformForCurrentStation(playback.currentTimeSec);

    playback.timer = setInterval(advancePlayback, playback.intervalMs);
  } catch (error) {
    console.error(error);
    updatePlayStatus("無法播放：波形載入失敗");
  }
}

/**
 * 播放按鈕切換
 */
function togglePlayback() {
  if (!state.stationId) {
    updatePlayStatus("請先選擇測站");
    return;
  }

  if (playback.isPlaying) {
    stopPlayback(true);
    updatePlayStatus("已停止播放");
  } else {
    void startPlayback();
  }
}

/**
 * 設定快速縮放按鈕
 */
function setupZoomControls() {
  const buttons = document.querySelectorAll(".zoom-button");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      void applyQuickZoom(button.dataset.zoom);
    });
  });
}

/**
 * 快速縮放波形
 *
 * full：完整波形
 * event：發震附近
 * ps：P / S 附近
 */
async function applyQuickZoom(zoomType) {
  if (!state.eventId || !state.stationId) {
    updateStatus("請先選擇測站");
    return;
  }

  stopPlayback(false);

  try {
    const waveform = await getWaveform(state.eventId, state.stationId);
    const times = waveform.time;

    if (!Array.isArray(times) || times.length === 0) {
      return;
    }

    const firstTime = times[0];
    const lastTime = times[times.length - 1];

    const station = getStationById(state.eventId, state.stationId);

    let xMin = firstTime;
    let xMax = lastTime;

    if (zoomType === "event") {
      xMin = Math.max(firstTime, -5);
      xMax = Math.min(lastTime, 30);
    }

    if (zoomType === "ps") {
      const pSec = station ? station.pArrivalSec : undefined;
      const sSec = station ? station.sArrivalSec : undefined;

      if (!Number.isFinite(pSec)) {
        updateStatus("沒有可用的 P 到時資料");
        return;
      }

      const center = Number.isFinite(sSec)
        ? (pSec + sSec) / 2
        : pSec;

      const spread = Number.isFinite(sSec)
        ? Math.abs(sSec - pSec)
        : 0;

      const halfRange = Math.max(6, spread * 1.5);

      xMin = Math.max(firstTime, center - halfRange);
      xMax = Math.min(lastTime, center + halfRange);
    }

    Plotly.relayout("waveform", {
      "xaxis.range": [xMin, xMax],
    });

    updateStatus(
      `縮放範圍：${xMin.toFixed(1)}s ～ ${xMax.toFixed(1)}s`
    );
  } catch (error) {
    console.error(error);
    updateStatus("縮放失敗");
  }
}

/**
 * 設定播放控制按鈕
 */
function setupPlaybackControls() {
  const playButton = document.getElementById("play-button");

  if (playButton) {
    playButton.addEventListener("click", togglePlayback);
  }
}

/**
 * 載入真實 JSON 資料
 */
async function loadData() {
  try {
    updateStatus("載入事件與測站資料...");

    const [eventsResponse, stationsResponse] = await Promise.all([
      fetch("data/processed/events.json"),
      fetch("data/processed/stations.json"),
    ]);

    if (!eventsResponse.ok || !stationsResponse.ok) {
      throw new Error("events.json 或 stations.json 載入失敗");
    }

    EVENTS = await eventsResponse.json();
    ALL_STATIONS = await stationsResponse.json();

    renderEventOptions();

    if (EVENTS.length > 0) {
      state.eventId = EVENTS[0].id;
      renderMapForCurrentEvent();
      updateStatus(
        `已載入 ${EVENTS.length} 個事件、${ALL_STATIONS.length} 個測站`
      );
    } else {
      renderEmptyWaveform("沒有事件資料");
      updateStatus("沒有事件資料");
    }
  } catch (error) {
    console.error(error);

    renderEmptyWaveform("資料載入失敗");
    updateStatus(
      "資料載入失敗。請使用 local server 開啟，並先執行 parse_cwa_dat.py。"
    );
  }
}

/**
 * 頁面初始化
 */
async function init() {
  setupEventSelect();
  setupComponentControls();
  setupZoomControls();
  setupPlaybackControls();
  initMap();

  await loadData();
}

document.addEventListener("DOMContentLoaded", init);