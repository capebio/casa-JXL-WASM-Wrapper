
    const GRAPH_DATA = JSON.parse(document.getElementById("graph-data").textContent);
    const metricListEl = document.getElementById("metric-list");
    const svg = document.getElementById("history-chart");
    const tooltip = document.getElementById("tooltip");
    const pad = { left: 98, right: 42, top: 38, bottom: 72 };
    const size = { width: 1600, height: 900 };
    const state = {
      runs: GRAPH_DATA.runs,
      metrics: GRAPH_DATA.metrics.map((metric) => ({ ...metric, enabled: metric.defaultOn, color: metric.color })),
    };

    // Same recent-bias + standard pre-enable as the generated HTML (for when .inline.js is used directly).
    try {
      const RECENT_N = 60;
      if (state.runs.length > RECENT_N) {
        const slice = state.runs.slice(-RECENT_N);
        state.view = { min: slice[0].timestampMs, max: slice[slice.length-1].timestampMs };
      }
      const isStd = (m) => (m.group === "core" || m.group === "raw" || (m.key || "").startsWith("Avg"));
      state.metrics.forEach(m => { if (isStd(m)) m.enabled = true; });
    } catch(e){}

    const presets = {
      core: (metric) => metric.group === "core",
      raw: (metric) => metric.group === "raw",
      encode: (metric) => metric.group === "encode",
      decode: (metric) => metric.group === "decode",
      standard: (metric) => (metric.group === "core" || metric.group === "raw" || (metric.key || "").startsWith("Avg")),
      all: () => true,
      decode: (metric) => metric.group === "decode",
      all: () => true,
    };

    function fmtMs(value) { return value == null ? "n/a" : Math.round(value) + " ms"; }
    function fmtNum(value, suffix = "") { return value == null ? "n/a" : value + suffix; }
    function fmtStamp(value) { return value ? new Date(value).toLocaleString() : "n/a"; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function heatColor(score) {
      const t = clamp(score / 100, 0, 1);
      const stops = [
        [0.0, [67, 191, 255]],
        [0.4, [80, 214, 176]],
        [0.7, [255, 183, 77]],
        [1.0, [255, 93, 93]],
      ];
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
          const [t0, c0] = stops[i - 1];
          const [t1, c1] = stops[i];
          const local = (t - t0) / (t1 - t0);
          const rgb = c0.map((v, idx) => Math.round(lerp(v, c1[idx], local)));
          return 'rgb(' + rgb.join(',') + ')';
        }
      }
      return 'rgb(255,93,93)';
    }

    function setPreset(name) {
      const pick = presets[name];
      state.metrics.forEach((metric) => { metric.enabled = pick(metric); });
      renderControls();
      renderChart();
    }

    function resetColors() {
      state.metrics.forEach((metric) => { metric.color = metric.defaultColor || metric.color; });
      renderControls();
      renderChart();
    }

    function renderControls() {
      metricListEl.innerHTML = "";
      state.metrics.forEach((metric, index) => {
        const row = document.createElement("label");
        row.className = "metric-row";
        row.innerHTML = `
          <input type="checkbox" ${metric.enabled ? "checked" : ""} data-index="${index}" data-kind="toggle" />
          <div class="metric-label">
            <strong>${metric.label}</strong>
            <span>${metric.key}</span>
          </div>
          <input type="color" value="${metric.color}" data-index="${index}" data-kind="color" />
        `;
        metricListEl.appendChild(row);
      });
    }

    function linePath(points) {
      if (points.length === 0) return "";
      if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
      let d = `M ${points[0].x} ${points[0].y}`;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
      }
      return d;
    }

    function enabledMetrics() {
      return state.metrics.filter((metric) => metric.enabled);
    }

    function renderChart() {
      const runs = state.runs;
      const visibleMetrics = enabledMetrics();
      const x0 = pad.left;
      const x1 = size.width - pad.right;
      const y0 = pad.top;
      const y1 = size.height - pad.bottom;
      const minTs = Math.min(...runs.map((run) => run.timestampMs));
      const maxTs = Math.max(...runs.map((run) => run.timestampMs));
      const values = visibleMetrics.flatMap((metric) =>
        runs.map((run) => run.metrics[metric.key]).filter((value) => value != null),
      );
      const minY = 0;
      const maxY = Math.max(1, ...values, 1);
      const toX = (ts) => x0 + ((ts - minTs) / Math.max(1, maxTs - minTs)) * (x1 - x0);
      const toY = (val) => y1 - ((val - minY) / Math.max(1, maxY - minY)) * (y1 - y0);

      const heatBands = runs.map((run, index) => {
        const center = toX(run.timestampMs);
        const prev = index === 0 ? x0 : (center + toX(runs[index - 1].timestampMs)) / 2;
        const next = index === runs.length - 1 ? x1 : (center + toX(runs[index + 1].timestampMs)) / 2;
        return `<rect x="${prev}" y="${y0}" width="${Math.max(1, next - prev)}" height="${y1 - y0}" fill="${heatColor(run.heatScore)}" opacity="${0.09 + (run.heatScore / 100) * 0.11}" />`;
      }).join("");

      const grid = Array.from({ length: 6 }, (_, idx) => {
        const value = (maxY / 5) * idx;
        const y = toY(value);
        return `
          <line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="rgba(255,255,255,0.08)" />
          <text x="${x0 - 16}" y="${y + 5}" fill="#8fa8b6" font-size="20" text-anchor="end">${Math.round(value)} ms</text>
        `;
      }).join("");

      const xTicks = runs.map((run, idx) => {
        if (idx !== 0 && idx !== runs.length - 1 && idx % Math.ceil(runs.length / 8) !== 0) return "";
        const x = toX(run.timestampMs);
        const stamp = new Date(run.timestampIso);
        const label = stamp.toISOString().slice(5, 16).replace("T", " ");
        return `
          <line x1="${x}" y1="${y1}" x2="${x}" y2="${y1 + 8}" stroke="rgba(255,255,255,0.16)" />
          <text x="${x}" y="${y1 + 30}" fill="#8fa8b6" font-size="18" text-anchor="middle">${label}</text>
        `;
      }).join("");

      const lines = visibleMetrics.map((metric) => {
        const points = runs
          .filter((run) => run.metrics[metric.key] != null)
          .map((run) => ({ x: toX(run.timestampMs), y: toY(run.metrics[metric.key]), run }));
        const path = linePath(points);
        const circles = points.map((point) => `
          <circle cx="${point.x}" cy="${point.y}" r="6" fill="${metric.color}" stroke="rgba(6,14,18,0.9)" stroke-width="2" />
          <circle cx="${point.x}" cy="${point.y}" r="${8 + (point.run.heatScore / 25)}" fill="${heatColor(point.run.heatScore)}" opacity="0.08" />
        `).join("");
        return `
          <path d="${path}" fill="none" stroke="${metric.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
          ${circles}
        `;
      }).join("");

      svg.innerHTML = `
        <rect x="0" y="0" width="${size.width}" height="${size.height}" fill="url(#bg)" rx="24" />
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,255,255,0.02)" />
            <stop offset="100%" stop-color="rgba(255,255,255,0.00)" />
          </linearGradient>
        </defs>
        <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="20" fill="rgba(2,8,11,0.48)" stroke="rgba(255,255,255,0.08)" />
        ${heatBands}
        ${grid}
        <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="rgba(255,255,255,0.24)" />
        <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="rgba(255,255,255,0.24)" />
        ${xTicks}
        ${lines}
      `;
    }

    function nearestRun(clientX, rect) {
      const relative = clamp((clientX - rect.left) / rect.width, 0, 1);
      const targetTs = state.runs[0].timestampMs + relative * (state.runs.at(-1).timestampMs - state.runs[0].timestampMs);
      return state.runs.reduce((best, run) => (
        Math.abs(run.timestampMs - targetTs) < Math.abs(best.timestampMs - targetTs) ? run : best
      ), state.runs[0]);
    }

    function showTooltip(event) {
      const rect = svg.getBoundingClientRect();
      const run = nearestRun(event.clientX, rect);
      const rows = enabledMetrics().map((metric) => {
        const value = run.metrics[metric.key];
        return value == null ? "" : `<div class="tip-row"><span>${metric.label}</span><strong style="color:${metric.color}">${fmtMs(value)}</strong></div>`;
      }).join("");
      tooltip.innerHTML = `
        <div class="stamp">${fmtStamp(run.timestampIso)}</div>
        ${rows}
        <div class="tip-row"><span>CpuActiveLoadPct</span><strong>${fmtNum(run.telemetry.CpuActiveLoadPct, "%")}</strong></div>
        <div class="tip-row"><span>CpuThrottlingPct</span><strong>${fmtNum(run.telemetry.CpuThrottlingPct, "%")}</strong></div>
        <div class="tip-row"><span>CpuClockCurrentGhz</span><strong>${fmtNum(run.telemetry.CpuClockCurrentGhz, " GHz")}</strong></div>
        <div class="tip-row"><span>SystemMemoryFreeGb</span><strong>${fmtNum(run.telemetry.SystemMemoryFreeGb, " GB")}</strong></div>
      `;
      tooltip.classList.remove("hidden");
      const left = clamp(event.clientX - rect.left + 14, 12, rect.width - 280);
      tooltip.style.left = left + "px";
      tooltip.style.top = (event.clientY - rect.top) + "px";
    }

    renderControls();
    renderChart();

    metricListEl.addEventListener("input", (event) => {
      const el = event.target;
      const index = Number(el.dataset.index);
      if (!Number.isInteger(index)) return;
      if (el.dataset.kind === "toggle") state.metrics[index].enabled = el.checked;
      if (el.dataset.kind === "color") state.metrics[index].color = el.value;
      renderChart();
    });

    document.querySelectorAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => setPreset(button.dataset.preset));
    });
    document.querySelector('[data-action="reset-colors"]').addEventListener("click", () => {
      state.metrics.forEach((metric) => { metric.color = GRAPH_DATA.metrics.find((m) => m.key === metric.key).color; });
      renderControls();
      renderChart();
    });
    svg.addEventListener("mousemove", showTooltip);
    svg.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
  