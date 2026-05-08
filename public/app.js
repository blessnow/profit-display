const API = "";
const AUTH_KEY = "posd_basic";
/** 与后端 SNAPSHOT_HISTORY_CALENDAR_DAYS 默认一致（约两周） */
const CHART_HISTORY_CALENDAR_DAYS = 14;

function getAuthHeader() {
  const v = sessionStorage.getItem(AUTH_KEY);
  return v ? { Authorization: v } : {};
}

async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}), ...getAuthHeader() };
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    sessionStorage.removeItem(AUTH_KEY);
    const e = new Error("UNAUTHORIZED");
    e.status = 401;
    throw e;
  }
  return r;
}

function showLogin() {
  document.getElementById("login-overlay").classList.remove("hidden");
}
function hideLogin() {
  document.getElementById("login-overlay").classList.add("hidden");
}

let suggestTimer = null;

function wireTradeSuggest() {
  const inp = document.getElementById("trade-stock");
  const box = document.getElementById("trade-suggest");
  const hid = document.getElementById("trade-stock-code");
  if (!inp || inp.dataset.wired === "1") return;
  inp.dataset.wired = "1";

  inp.addEventListener("input", () => {
    hid.value = "";
    const q = inp.value.trim();
    clearTimeout(suggestTimer);
    if (q.length < 1) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    suggestTimer = setTimeout(() => void loadSuggest(q), 280);
  });

  inp.addEventListener("blur", () => {
    setTimeout(() => box.classList.add("hidden"), 180);
  });

  inp.addEventListener("focus", () => {
    if (box.innerHTML.trim() && inp.value.trim())
      box.classList.remove("hidden");
  });
}

function pickSuggest(item) {
  document.getElementById("trade-stock").value = item.name;
  document.getElementById("trade-stock-code").value = item.code || "";
  const px =
    item.price != null && Number.isFinite(Number(item.price))
      ? Number(item.price)
      : null;
  const priceEl = document.getElementById("trade-price");
  const curEl = document.getElementById("trade-current");
  if (px != null && px > 0) {
    priceEl.value = String(px);
    curEl.value = String(px);
  }
  document.getElementById("trade-suggest").classList.add("hidden");
}

async function loadSuggest(q) {
  const box = document.getElementById("trade-suggest");
  try {
    const r = await apiFetch(`${API}/api/suggest?q=` + encodeURIComponent(q));
    const j = await r.json().catch(() => ({ items: [] }));
    const items = j.items || [];
    if (!items.length) {
      box.innerHTML =
        '<div class="sx" style="padding:0.5rem 0.65rem;color:var(--muted)">无联想结果（请配置 QUOTE_SUGGEST_URL）</div>';
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = items
      .map(
        (it, i) => `
      <button type="button" data-i="${i}" class="suggest-item">
        <span class="sn">${escapeHtml(it.name)}</span>
        <span class="sx">${escapeHtml(it.code)}${
          it.price != null ? " · " + fmt(it.price) : ""
        }</span>
      </button>`
      )
      .join("");
    box.querySelectorAll(".suggest-item").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const i = Number(btn.dataset.i);
        pickSuggest(items[i]);
      });
    });
    box.classList.remove("hidden");
  } catch {
    box.classList.add("hidden");
  }
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 持仓收益率（相对成本市值），与后端 profit_pct 一致 */
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const x = Number(n);
  const sign = x > 0 ? "+" : "";
  return sign + x.toFixed(2) + "%";
}

function clsPnL(n) {
  if (n == null) return "";
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "";
}

async function loadAccounts() {
  const r = await apiFetch(`${API}/api/accounts`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function loadDailyCharts() {
  const r = await apiFetch(
    `${API}/api/charts/daily?days=${CHART_HISTORY_CALENDAR_DAYS}`
  );
  if (!r.ok) return null;
  return r.json();
}

/** YYYY-MM-DD → UTC ms at calendar midnight (stable across TZ). */
function parseDayMs(dayStr) {
  const [y, m, d] = String(dayStr)
    .split("-")
    .map((x) => Number(x));
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d);
}

function sumAccountsCumulativePnl(accounts) {
  if (!accounts?.length) return null;
  let s = 0;
  for (const a of accounts) {
    const v = a.summary?.cumulative_pnl;
    if (Number.isFinite(v)) s += v;
  }
  return s;
}

/** account_cumulative：已实现累计 + 持仓浮动（快照绝对额） */
function enrichPointsWithCumulativeMoney(ptsSorted) {
  if (!ptsSorted.length) return [];
  return ptsSorted.map((p) => {
    const pp = Number(p.position_profit) || 0;
    const rp = Number(p.realized_pnl) || 0;
    return {
      day: p.day,
      total_assets: p.total_assets,
      market_value: p.market_value,
      position_profit: pp,
      realized_pnl: rp,
      account_cumulative: pp + rp,
    };
  });
}

/** 纵轴刻度（元，略缩短） */
function fmtAxisMoney(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const x = Number(n);
  const ax = Math.abs(x);
  if (ax >= 1e8) return (x / 1e8).toFixed(1) + "亿";
  if (ax >= 1e4) return (x / 1e4).toFixed(1) + "万";
  return x.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function renderAccountCumulativeChart(points, opts = {}) {
  const title = opts.title || "账户累计收益（元）";
  const legendHtml = `<div class="chart-legend"><span class="lg lg-mv">${escapeHtml(
    title
  )}</span></div>`;
  if (!points || points.length === 0) {
    return `<div class="chart-interactive">${legendHtml}<div class="chart-empty muted">暂无历史快照；登录、同步行情或成交后会记录当日资产</div></div>`;
  }

  const pts = enrichPointsWithCumulativeMoney(
    [...points].sort((a, b) => parseDayMs(a.day) - parseDayMs(b.day))
  );
  const nPts = pts.length;

  const W = 560;
  const H = 118;
  const pad = { l: 58, r: 10, t: 10, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  /** 横轴：仅有快照的交易日等距，周末/休市不占宽度 */
  const xAtIdx = (i) => {
    if (nPts <= 1) return pad.l + innerW / 2;
    return pad.l + (i / (nPts - 1)) * innerW;
  };

  const vals = pts.map((p) => p.account_cumulative);
  let mn = Math.min(...vals);
  let mx = Math.max(...vals);
  if (!Number.isFinite(mn)) mn = 0;
  if (!Number.isFinite(mx)) mx = 1;
  if (Math.abs(mx - mn) < 1e-6) {
    mn -= 50;
    mx += 50;
  }

  const yAt = (v) => pad.t + (1 - (v - mn) / (mx - mn)) * innerH;

  const y0 = fmtAxisMoney(mx);
  const y1 = fmtAxisMoney((mx + mn) / 2);
  const y2 = fmtAxisMoney(mn);

  const fmtMd = (dayStr) =>
    String(dayStr).length >= 10 ? dayStr.slice(5, 10) : dayStr;
  const dLeft = fmtMd(pts[0].day);
  const dRight = fmtMd(pts[nPts - 1].day);
  const midI = Math.max(0, Math.floor((nPts - 1) / 2));
  const dMid = fmtMd(pts[midI].day);

  let pathLine = "";
  let dotsSvg = "";
  const rIdle = pts.length === 1 ? 3.2 : 2.8;
  if (pts.length === 1) {
    const px = xAtIdx(0).toFixed(1);
    const py = yAt(pts[0].account_cumulative).toFixed(1);
    dotsSvg = `<g class="chart-dots-vertices" pointer-events="none"><circle class="chart-dot-v" data-idx="0" cx="${px}" cy="${py}" r="${rIdle}" fill="var(--chart-line-mv)" /></g>`;
  } else {
    pathLine = pts
      .map((p, i) =>
        `${i === 0 ? "M" : "L"}${xAtIdx(i).toFixed(1)},${yAt(
          p.account_cumulative
        ).toFixed(1)}`
      )
      .join("");
    dotsSvg = `<g class="chart-dots-vertices" pointer-events="none">${pts
      .map((p, i) => {
        const x = xAtIdx(i).toFixed(1);
        const y = yAt(p.account_cumulative).toFixed(1);
        return `<circle class="chart-dot-v" data-idx="${i}" cx="${x}" cy="${y}" r="${rIdle}" fill="var(--chart-line-mv)" />`;
      })
      .join("")}</g>`;
  }

  const payload = encodeURIComponent(JSON.stringify(pts));
  const ws = pts[0].day;
  const we = pts[nPts - 1].day;

  const pathStroke =
    'fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"';
  const paths = pathLine
    ? `<path ${pathStroke} stroke="var(--chart-line-mv)" d="${pathLine}" />`
    : "";

  return `<div class="chart-interactive" data-chart-points="${payload}" data-window-start="${escapeHtml(
    ws
  )}" data-window-end="${escapeHtml(
    we
  )}" data-pad-l="${pad.l}" data-inner-w="${innerW}" data-pad-t="${
    pad.t
  }" data-inner-h="${innerH}" data-y-min="${mn}" data-y-max="${mx}">
  ${legendHtml}
  <svg class="daily-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
  <text class="daily-chart-axis" x="${
    pad.l - 4
  }" y="${pad.t + 4}" text-anchor="end">${escapeHtml(y0)}</text>
  <text class="daily-chart-axis" x="${
    pad.l - 4
  }" y="${pad.t + innerH / 2 + 4}" text-anchor="end">${escapeHtml(y1)}</text>
  <text class="daily-chart-axis" x="${
    pad.l - 4
  }" y="${pad.t + innerH + 4}" text-anchor="end">${escapeHtml(y2)}</text>
  <text class="daily-chart-axis" x="${pad.l}" y="${
    H - 6
  }" text-anchor="start">${escapeHtml(dLeft)}</text>
  <text class="daily-chart-axis" x="${
    pad.l + innerW / 2
  }" y="${H - 6}" text-anchor="middle">${escapeHtml(dMid)}</text>
  <text class="daily-chart-axis" x="${
    pad.l + innerW
  }" y="${H - 6}" text-anchor="end">${escapeHtml(dRight)}</text>
  ${paths}
  ${dotsSvg}
  <g class="chart-hover-markers hidden" pointer-events="none" aria-hidden="true">
    <line class="chart-hover-xline" stroke="var(--muted)" stroke-opacity="0.45" stroke-width="1.25" stroke-dasharray="4 3" />
  </g>
</svg>
  <div class="chart-tooltip hidden" role="tooltip"></div>
</div>`;
}

/** 屏幕坐标 → SVG 用户坐标（适配 viewBox + preserveAspectRatio） */
function clientToSvgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  try {
    return pt.matrixTransform(ctm.inverse());
  } catch {
    return null;
  }
}

function distSqPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) {
    const ex = px - x1;
    const ey = py - y1;
    return { d2: ex * ex + ey * ey, t: 0 };
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  const ex = px - qx;
  const ey = py - qy;
  return { d2: ex * ex + ey * ey, t };
}

/** 到账户累计收益折线的最近顶点索引 */
function nearestIndexOnCumulativePolyline(mx, my, pts, xAtIdx, yForVal) {
  const n = pts.length;
  if (n <= 1) return 0;
  let bestD2 = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < n - 1; i++) {
    const r = distSqPointSeg(
      mx,
      my,
      xAtIdx(i),
      yForVal(pts[i].account_cumulative),
      xAtIdx(i + 1),
      yForVal(pts[i + 1].account_cumulative)
    );
    if (r.d2 < bestD2) {
      bestD2 = r.d2;
      bestIdx = r.t < 0.5 ? i : i + 1;
    }
  }
  return Math.min(bestIdx, n - 1);
}

function wireChartTooltips(container) {
  container.querySelectorAll(".chart-interactive").forEach((wrap) => {
    if (wrap.dataset.tooltipWired === "1") return;
    wrap.dataset.tooltipWired = "1";
    const svg = wrap.querySelector(".daily-chart-svg");
    const tip = wrap.querySelector(".chart-tooltip");
    if (!svg || !tip) return;
    let pts = [];
    try {
      pts = JSON.parse(decodeURIComponent(wrap.dataset.chartPoints || "[]"));
    } catch {
      pts = [];
    }
    if (!pts.length) return;
    pts.sort((a, b) => parseDayMs(a.day) - parseDayMs(b.day));
    pts = enrichPointsWithCumulativeMoney(pts);

    const padL = Number(wrap.dataset.padL);
    const innerW = Number(wrap.dataset.innerW);
    const padT = Number(wrap.dataset.padT);
    const innerH = Number(wrap.dataset.innerH);
    const yMin = Number(wrap.dataset.yMin);
    const yMax = Number(wrap.dataset.yMax);
    const n = pts.length;
    if (
      !Number.isFinite(padL) ||
      !Number.isFinite(innerW) ||
      innerW <= 0 ||
      !n
    )
      return;

    const markers = svg.querySelector(".chart-hover-markers");
    const lineEl = markers?.querySelector(".chart-hover-xline");
    const vertexDots = svg.querySelectorAll(".chart-dot-v");

    const setVertexHighlight = (activeIdx) => {
      const valid = Number.isFinite(activeIdx) && activeIdx >= 0;
      vertexDots.forEach((c) => {
        const i = Number(c.dataset.idx);
        const on = valid && (pts.length <= 1 || i === activeIdx);
        c.classList.toggle("is-sel", on);
      });
    };

    const xAtIdx = (i) => {
      if (n <= 1) return padL + innerW / 2;
      return padL + (i / (n - 1)) * innerW;
    };
    const yForVal = (v) => {
      const span = yMax - yMin;
      const den = Math.abs(span) < 1e-12 ? 1 : span;
      return padT + (1 - (v - yMin) / den) * innerH;
    };

    wrap.addEventListener("mousemove", (e) => {
      const svgP = clientToSvgPoint(svg, e.clientX, e.clientY);
      if (!svgP) return;
      const idx =
        pts.length <= 1
          ? 0
          : nearestIndexOnCumulativePolyline(
              svgP.x,
              svgP.y,
              pts,
              xAtIdx,
              yForVal
            );
      setVertexHighlight(idx);
      const p = pts[idx];
      tip.innerHTML = `<div class="chart-tip-date">${escapeHtml(p.day)}</div><div class="chart-tip-row"><span>账户累计收益</span><strong class="${clsPnL(
        p.account_cumulative
      )}">${fmt(p.account_cumulative)}</strong><span class="muted" style="margin-left:0.25rem;font-size:0.85em">已实现+持仓浮动</span></div><div class="chart-tip-row"><span>持仓浮动</span><strong class="${clsPnL(
        p.position_profit
      )}">${fmt(p.position_profit)}</strong></div><div class="chart-tip-row"><span>已实现累计</span><strong class="${clsPnL(
        p.realized_pnl
      )}">${fmt(p.realized_pnl)}</strong></div><div class="chart-tip-row"><span>总资产</span><strong>${fmt(
        p.total_assets
      )}</strong></div><div class="chart-tip-row"><span>持仓市值</span><strong>${fmt(
        p.market_value
      )}</strong></div>`;
      tip.classList.remove("hidden");
      const wr = wrap.getBoundingClientRect();
      let left = e.clientX - wr.left + 12;
      let top = e.clientY - wr.top + 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      requestAnimationFrame(() => {
        const tr = tip.getBoundingClientRect();
        if (tr.right > wr.right) left -= tr.width + 24;
        if (tr.bottom > wr.bottom) top -= tr.height + 16;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${Math.max(4, top)}px`;
      });

      if (markers && lineEl && Number.isFinite(padT) && Number.isFinite(innerH)) {
        const px = xAtIdx(idx);
        lineEl.setAttribute("x1", px);
        lineEl.setAttribute("x2", px);
        lineEl.setAttribute("y1", padT);
        lineEl.setAttribute("y2", padT + innerH);
        markers.classList.remove("hidden");
      }
    });
    wrap.addEventListener("mouseleave", () => {
      tip.classList.add("hidden");
      markers?.classList.add("hidden");
      setVertexHighlight(-1);
    });
  });
}

function buildTotalChartSummary(charts) {
  if (!charts) return null;
  const totalSorted = [...(charts.total || [])].sort(
    (a, b) => parseDayMs(a.day) - parseDayMs(b.day)
  );
  const fbFirst = totalSorted[0]?.day;
  const fbLast = totalSorted.length
    ? totalSorted[totalSorted.length - 1].day
    : null;
  return {
    windowDays: charts.days,
    windowStart: charts.window_start ?? fbFirst,
    windowEnd: charts.window_end ?? fbLast,
    snapshotFirst: charts.snapshot_first_day ?? fbFirst ?? null,
    snapshotLast: charts.snapshot_last_day ?? fbLast,
    pointCount: charts.snapshot_points_total ?? totalSorted.length,
  };
}

function buildAccountChartSummary(charts, series) {
  if (!charts) return null;
  const pts = [...(series?.points || [])].sort(
    (a, b) => parseDayMs(a.day) - parseDayMs(b.day)
  );
  const fbFirst = pts[0]?.day;
  const fbLast = pts.length ? pts[pts.length - 1].day : null;
  return {
    windowDays: charts.days,
    windowStart: charts.window_start ?? fbFirst,
    windowEnd: charts.window_end ?? fbLast,
    snapshotFirst: fbFirst ?? null,
    snapshotLast: fbLast,
    pointCount: pts.length,
  };
}

function renderAccounts(data, charts) {
  const root = document.getElementById("accounts");
  const loading = document.getElementById("loading");
  loading.classList.add("hidden");
  root.classList.remove("hidden");
  const list = data.accounts || [];
  const multi = list.length > 1;
  const totalSummary = buildTotalChartSummary(charts);
  const totalCum = sumAccountsCumulativePnl(list);
  const totalCumBanner =
    totalCum != null && Number.isFinite(totalCum)
      ? `<div class="broker" style="margin-bottom:0.35rem">账户累计收益（合计·元）= 各账户已实现累计 + 持仓浮动：<strong class="${clsPnL(
          totalCum
        )}">${fmt(totalCum)}</strong></div>`
      : "";
  const totalSection =
    multi && charts
      ? `<section class="account chart-summary-account">
      <div class="account-head"><div><h2>全部账户汇总</h2><div class="broker">曲线为各账户「已实现累计+持仓浮动」按日合计（写入当日快照）</div></div></div>
      ${totalCumBanner}<div class="chart-panel">${renderAccountCumulativeChart(
        charts.total || [],
        {
          title: "账户累计收益（合计·元）",
          summary: totalSummary,
          windowStart: charts.window_start,
          windowEnd: charts.window_end,
        }
      )}</div></section>`
      : "";
  root.innerHTML =
    totalSection + list.map((a) => renderOneAccount(a, charts)).join("");
  bind(root);
}

function renderOneAccount(a, charts) {
  const s = a.summary;
  const series =
    charts &&
    charts.accounts &&
    charts.accounts.find((x) => x.account_id === a.id);
  const daysHint =
    charts && charts.days
      ? `近 ${charts.days} 个自然日窗口；仅展示账户累计收益（已实现累计+持仓浮动）；横轴为相邻快照日等距`
      : "账户累计收益为快照绝对额（已实现累计+持仓浮动）；卖出会累加已实现";
  const chartHtml = renderAccountCumulativeChart(series?.points || [], {
    title: "账户累计收益（元）",
    summary: buildAccountChartSummary(charts, series),
    windowStart: charts?.window_start,
    windowEnd: charts?.window_end,
  });
  return `
    <section class="account" data-account-id="${a.id}">
      <div class="account-head">
        <div>
          <h2>${escapeHtml(a.account_name)}</h2>
          <div class="broker">${escapeHtml(a.broker)}${
    a.account_type ? " · " + escapeHtml(a.account_type) : ""
  }</div>
        </div>
        <div class="toolbar">
          <button type="button" class="small btn-buy-first" data-account="${
            a.id
          }">买入</button>
          <button type="button" class="small btn-cash" data-id="${
            a.id
          }">银证入出金</button>
        </div>
      </div>
      <div class="summary-grid">
        <div><span>总资产</span><strong>${fmt(s.total_assets)}</strong></div>
        <div><span>持仓市值</span><strong>${fmt(s.market_value)}</strong></div>
        <div><span>可用资金</span><strong>${fmt(s.available_cash)}</strong></div>
        <div><span>持仓盈亏</span><strong class="${clsPnL(
          s.total_profit
        )}">${fmt(s.total_profit)}</strong></div>
        <div><span>已实现累计</span><strong class="${clsPnL(
          s.realized_pnl_total
        )}">${fmt(s.realized_pnl_total)}</strong></div>
        <div><span>账户累计收益</span><strong class="${clsPnL(
          s.cumulative_pnl
        )}">${fmt(s.cumulative_pnl)}</strong><span class="muted" style="margin-left:0.35rem;font-size:0.8em">已实现+持仓浮动</span></div>
        <div><span>仓位</span><strong>${
          a.position_ratio != null ? a.position_ratio + "%" : "—"
        }</strong></div>
      </div>
      <div class="chart-panel">
        <div class="broker" style="margin-bottom: 0.35rem">${escapeHtml(
          daysHint
        )}</div>
        ${chartHtml}
      </div>
      <table>
        <thead>
          <tr>
            <th>股票</th>
            <th>数量</th>
            <th>成本</th>
            <th>现价</th>
            <th>市值</th>
            <th>盈亏</th>
            <th>收益率</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${(a.holdings || [])
            .map(
              (h) => `
            <tr data-holding-id="${h.id}" data-stock-code="${
                h.stock_code ? escapeHtml(String(h.stock_code)) : ""
              }">
              <td class="stock-cell"><span class="stock-n">${escapeHtml(
                h.stock_name
              )}</span>${
                h.stock_code
                  ? `<span class="stock-c">${escapeHtml(
                      String(h.stock_code)
                    )}</span>`
                  : `<span class="stock-c">未绑代码</span>`
              }</td>
              <td>${h.position}</td>
              <td>${fmt(h.cost_price)}</td>
              <td>${fmt(h.current_price)}</td>
              <td>${fmt(h.market_value)}</td>
              <td class="${clsPnL(h.profit)}">${fmt(h.profit)}</td>
              <td class="${clsPnL(h.profit)}">${fmtPct(h.profit_pct)}</td>
              <td class="row-trade-btns"><button type="button" class="small btn-add-pos" data-account="${
                a.id
              }" data-name="${escapeHtml(h.stock_name)}" data-code="${
                h.stock_code ? escapeHtml(String(h.stock_code)) : ""
              }" data-price="${h.current_price}">加仓</button>
                  <button type="button" class="small btn-reduce-pos" data-account="${
                    a.id
                  }" data-name="${escapeHtml(h.stock_name)}" data-code="${
                h.stock_code ? escapeHtml(String(h.stock_code)) : ""
              }" data-price="${h.current_price}">减仓</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </section>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bind(container) {
  container.querySelectorAll(".btn-add-pos").forEach((btn) => {
    btn.addEventListener("click", () =>
      openTrade(Number(btn.dataset.account), {
        side: "buy",
        stock_name: btn.dataset.name,
        stock_code: btn.dataset.code || "",
        price: btn.dataset.price,
        current_price: btn.dataset.price,
      })
    );
  });
  container.querySelectorAll(".btn-reduce-pos").forEach((btn) => {
    btn.addEventListener("click", () =>
      openTrade(Number(btn.dataset.account), {
        side: "sell",
        stock_name: btn.dataset.name,
        stock_code: btn.dataset.code || "",
        price: btn.dataset.price,
        current_price: btn.dataset.price,
      })
    );
  });
  container.querySelectorAll(".btn-buy-first").forEach((btn) => {
    btn.addEventListener("click", () =>
      openTrade(Number(btn.dataset.account), { side: "buy" })
    );
  });
  container.querySelectorAll(".btn-cash").forEach((btn) => {
    btn.addEventListener("click", () => openCash(Number(btn.dataset.id)));
  });
  wireChartTooltips(container);
}

const dlgTrade = document.getElementById("dlg-trade");
const dlgEdit = document.getElementById("dlg-edit");
const dlgNewAccount = document.getElementById("dlg-new-account");
const dlgCash = document.getElementById("dlg-cash");

function openNewAccount() {
  document.getElementById("new-acc-name").value = "";
  document.getElementById("new-acc-broker").value = "";
  document.getElementById("new-acc-type").value = "";
  document.getElementById("new-acc-cash").value = "0";
  document.getElementById("new-acc-withdraw").value = "";
  dlgNewAccount.showModal();
}

document.getElementById("btn-new-account").onclick = () => openNewAccount();
document.getElementById("new-acc-cancel").onclick = () => dlgNewAccount.close();
document.getElementById("form-new-account").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const name = document.getElementById("new-acc-name").value.trim();
    const body = {
      account_name: name,
      broker: document.getElementById("new-acc-broker").value.trim(),
      account_type:
        document.getElementById("new-acc-type").value.trim() || undefined,
      available_cash: Number(document.getElementById("new-acc-cash").value),
    };
    const w = document.getElementById("new-acc-withdraw").value.trim();
    if (w !== "") body.withdrawable_cash = Number(w);
    const r = await apiFetch(`${API}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(j.error || r.statusText);
      return;
    }
    dlgNewAccount.close();
    refresh();
  } catch (err) {
    if (err.message === "UNAUTHORIZED" || err.status === 401) return;
    alert(err.message || String(err));
  }
};

function openTrade(accountId, preset = {}) {
  document.getElementById("trade-account-id").value = accountId;
  document.getElementById("trade-side").value = preset.side || "buy";
  document.getElementById("trade-stock").value = preset.stock_name || "";
  document.getElementById("trade-stock-code").value = preset.stock_code || "";
  document.getElementById("trade-qty").value =
    preset.quantity != null ? preset.quantity : "";
  document.getElementById("trade-price").value =
    preset.price != null ? preset.price : "";
  document.getElementById("trade-current").value =
    preset.current_price != null ? preset.current_price : "";
  document.getElementById("trade-suggest").classList.add("hidden");
  document.getElementById("trade-suggest").innerHTML = "";
  dlgTrade.showModal();
}

document.getElementById("trade-cancel").onclick = () => dlgTrade.close();
document.getElementById("form-trade").onsubmit = async (e) => {
  e.preventDefault();
  const accountId = Number(document.getElementById("trade-account-id").value);
  const body = {
    side: document.getElementById("trade-side").value,
    stock_name: document.getElementById("trade-stock").value.trim(),
    quantity: Number(document.getElementById("trade-qty").value),
    price: Number(document.getElementById("trade-price").value),
  };
  const cur = document.getElementById("trade-current").value;
  if (cur) body.current_price = Number(cur);
  const sc = document.getElementById("trade-stock-code").value.trim();
  if (sc) body.stock_code = sc;
  const r = await apiFetch(`${API}/api/accounts/${accountId}/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(j.error || r.statusText);
    return;
  }
  dlgTrade.close();
  refresh();
};

function openEdit(holdingId, accountId, stock, position, cost, current, code) {
  document.getElementById("edit-holding-id").value = holdingId;
  document.getElementById("edit-account-id").value = accountId;
  document.getElementById("edit-stock-label").textContent = stock;
  document.getElementById("edit-position").value = position;
  document.getElementById("edit-cost").value = cost;
  document.getElementById("edit-current").value = current;
  const curDisp = document.getElementById("edit-current-display");
  if (curDisp)
    curDisp.textContent =
      current != null && Number.isFinite(Number(current))
        ? fmt(Number(current))
        : "—";
  document.getElementById("edit-stock-code").value = code || "";
  dlgEdit.showModal();
}

document.getElementById("edit-cancel").onclick = () => dlgEdit.close();
document.getElementById("form-edit").onsubmit = async (e) => {
  e.preventDefault();
  const id = Number(document.getElementById("edit-holding-id").value);
  const body = {
    position: Number(document.getElementById("edit-position").value),
    cost_price: Number(document.getElementById("edit-cost").value),
    current_price: Number(document.getElementById("edit-current").value),
    stock_code: document.getElementById("edit-stock-code").value.trim(),
  };
  const r = await apiFetch(`${API}/api/holdings/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(j.error || r.statusText);
    return;
  }
  dlgEdit.close();
  refresh();
};

function openCash(accountId) {
  document.getElementById("cash-account-id").value = accountId;
  document.getElementById("cash-kind").value = "deposit";
  document.getElementById("cash-amount").value = "";
  document.getElementById("cash-note").value = "";
  dlgCash.showModal();
}

document.getElementById("cash-cancel").onclick = () => dlgCash.close();
document.getElementById("form-cash").onsubmit = async (e) => {
  e.preventDefault();
  const accountId = Number(document.getElementById("cash-account-id").value);
  const body = {
    kind: document.getElementById("cash-kind").value,
    amount: Number(document.getElementById("cash-amount").value),
    note: document.getElementById("cash-note").value || undefined,
  };
  const r = await apiFetch(`${API}/api/accounts/${accountId}/ledger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(j.error || r.statusText);
    return;
  }
  dlgCash.close();
  refresh();
};

async function refresh() {
  const loading = document.getElementById("loading");
  const accountsEl = document.getElementById("accounts");
  try {
    const data = await loadAccounts();
    let charts = null;
    try {
      charts = await loadDailyCharts();
    } catch (_) {
      charts = null;
    }
    hideLogin();
    loading.classList.add("hidden");
    renderAccounts(data, charts);
  } catch (err) {
    if (err.status === 401 || err.message === "UNAUTHORIZED") {
      showLogin();
      loading.classList.remove("hidden");
      accountsEl.classList.add("hidden");
      loading.textContent = "请先登录";
      return;
    }
    loading.classList.remove("hidden");
    loading.textContent = "加载失败：" + (err.message || String(err));
  }
}

document.getElementById("form-login").onsubmit = (e) => {
  e.preventDefault();
  const u = document.getElementById("login-user").value.trim();
  const p = document.getElementById("login-pass").value;
  sessionStorage.setItem(
    AUTH_KEY,
    "Positions " + btoa(unescape(encodeURIComponent(u + ":" + p)))
  );
  refresh();
};

document.getElementById("btn-logout").onclick = () => {
  sessionStorage.removeItem(AUTH_KEY);
  document.getElementById("login-pass").value = "";
  document.getElementById("accounts").classList.add("hidden");
  showLogin();
  document.getElementById("loading").textContent = "请先登录";
  document.getElementById("loading").classList.remove("hidden");
};

document.getElementById("btn-refresh-kline").onclick = async () => {
  try {
    const r = await apiFetch(`${API}/api/admin/refresh-history-kline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendar_days: CHART_HISTORY_CALENDAR_DAYS }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint =
        r.status === 404
          ? "（后端没有这个接口，多半是服务还在跑旧代码：请停掉进程后重新执行 npm start）"
          : "";
      alert((j.error || r.statusText || "请求失败") + hint);
      return;
    }
    if (j.skipped) {
      alert("未执行：" + (j.reason || "") + "（请配置 QUOTE_KLINE_URL）");
      return;
    }
    const failHint =
      j.codes_failed > 0
        ? "\n\n注意：" +
          j.codes_failed +
          " 个代码日K未拉到数据，历史日会用同一现价估算，曲线可能每天数值相同。看终端日志或下方原因。"
        : "";
    const warn =
      j.fetch_errors && j.fetch_errors.length
        ? "\n失败示例：\n" +
          j.fetch_errors
            .slice(0, 4)
            .map((x) => x.code + ": " + (x.message || ""))
            .join("\n")
        : "";
    alert(
      "已按真实日K写入 " +
        (j.historical_days?.length ?? "?") +
        " 个历史自然日；当日仍用现价快照。" +
        failHint +
        warn
    );
    refresh();
  } catch (e) {
    if (e.message === "UNAUTHORIZED") return;
    alert(e.message || String(e));
  }
};

document.getElementById("btn-sync-quotes").onclick = async () => {
  try {
    const r = await apiFetch(`${API}/api/admin/sync-quotes`, {
      method: "POST",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(j.error || r.statusText);
      return;
    }
    if (j.skipped) {
      alert(
        j.reason === "QUOTE_PRICE_URL and QUOTE_SYNC_URL empty"
          ? "未配置行情：请设置 QUOTE_PRICE_URL（按代码）或 QUOTE_SYNC_URL（按名称 JSON）"
          : "已跳过：" + (j.reason || "")
      );
    } else {
      alert(
        "已更新现价 " +
          (j.updated ?? 0) +
          " 条" +
          (j.codesFetched != null ? "（代码源 " + j.codesFetched + "）" : "")
      );
    }
    refresh();
  } catch (e) {
    if (e.message === "UNAUTHORIZED") return;
    alert(e.message || String(e));
  }
};

wireTradeSuggest();
refresh();
