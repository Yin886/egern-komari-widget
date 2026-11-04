/**
 * Komari 面板 · Egern 主屏小组件
 *
 * 把 Komari Monitor 的节点状态搬上 iOS 主屏：
 *   小 —— 第一台（优先在线）节点的 CPU / 内存 / 延迟 / 累计流量 / 剩余天数
 *   中 —— 全部节点列表：在线点、名称、CPU · 内存 · 磁盘、三网延迟
 *   大 —— 汇总条 + 节点明细（进度条、实时网速、累计流量、价格与到期）
 *
 * 数据只走 Komari 自己的公开接口：
 *   GET {PANEL}/api/nodes              节点静态信息（名称、地区、到期、流量上限）
 *   GET {PANEL}/api/recent/{uuid}      每台最新一帧上报（CPU / 内存 / 磁盘 / 网速）
 *   GET {PANEL}/api/records/ping?uuid= 每台的三网探测（移动 / 联通 / 电信均值与丢包）
 *
 * 环境变量（在模块参数里填，同名）：
 * - PANEL：面板根地址，如 https://panel.example.com:8443，只填根地址、
 *   不要带 /admin 或 /api，结尾斜杠可有可无
 * - POLICY：请求走哪个代理策略或策略组（如 Proxy）；留空走默认规则
 * - TOKEN：登录令牌（私有站点用）。与 USER / PASS 二选一，公开站点留空
 * - USER / PASS：后台账号密码（私有站点用）。填了脚本每次刷新自动登录换令牌
 * - ONLY：只显示这些服务器，名称或 ID、英文逗号分隔；留空显示全部
 * - SHOW_HIDDEN：true 显示面板里隐藏的服务器，默认 false
 * - TITLE：小组件标题，默认「Komari 面板」
 * - REFRESH：刷新间隔分钟，默认 15
 *
 * 在线判定与面板一致：最新一帧上报在 5 分钟内算在线。
 * 三网延迟取面板 Ping 任务的窗口均值；名称含 v6 的移动任务不作为「移动」展示
 * （无 IPv6 的机器那条永远不通，展示出来是噪声），三网都取不到时显示 --。
 */

const ONLINE_THRESHOLD_MS = 300_000;
const DEFAULT_REFRESH_MIN = 15;

/** 配色：Egern 自适应 Color（浅 / 深），与常用探针主题口径接近。 */
const COLORS = {
  text: { light: "#18181b", dark: "#d1d7e0" },
  textSub: { light: "#52525b", dark: "#b7bdc8" },
  textDim: { light: "#8a8a93", dark: "#9198a1" },
  track: { light: "rgba(24, 24, 27, 0.12)", dark: "rgba(118, 130, 146, 0.30)" },
  cpu: { light: "#3b82f6", dark: "#539bf5" },
  mem: { light: "#8b5cf6", dark: "#b083f0" },
  disk: { light: "#e97b35", dark: "#e0823d" },
  online: { light: "#2f9e65", dark: "#57ab5a" },
  offline: { light: "#dc2626", dark: "#f47067" },
  up: { light: "#3b82f6", dark: "#539bf5" },
  down: { light: "#2f9e65", dark: "#57ab5a" },
  hairline: { light: "rgba(24, 24, 27, 0.10)", dark: "rgba(101, 108, 118, 0.30)" },
  warn: { light: "#b45309", dark: "#e2a928" },
  bg: { light: "#f4f6fa", dark: "#0b1220" },
};

/** 延迟配色阶梯（60 / 100 / 160 / 200 ms）。 */
const LATENCY_COLORS = {
  excellent: { light: "#15803d", dark: "#2fc66e" },
  good: { light: "#4d7c0f", dark: "#9fe339" },
  moderate: { light: "#a16207", dark: "#cbd83a" },
  elevated: { light: "#b45309", dark: "#e2a928" },
  critical: { light: "#dc2626", dark: "#f47067" },
};

function latencyColor(ms) {
  if (ms == null || !Number.isFinite(ms)) return COLORS.textDim;
  if (ms < 60) return LATENCY_COLORS.excellent;
  if (ms < 100) return LATENCY_COLORS.good;
  if (ms < 160) return LATENCY_COLORS.moderate;
  if (ms < 200) return LATENCY_COLORS.elevated;
  return LATENCY_COLORS.critical;
}

// ------------------------------------------------------------------ 工具

function clean(v) {
  return String(v === undefined || v === null ? "" : v).trim();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, num(v, min)));
}

function truthy(v) {
  return v === true || v === 1 || ["true", "1", "yes", "y", "on"].includes(clean(v).toLowerCase());
}

/** 字节格式化：1024 进制，≥100 取整、≥10 一位小数、其余两位。 */
function fmtBytes(bytes) {
  let v = num(bytes);
  if (!Number.isFinite(v) || v < 0) v = 0;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  if (i === 0) return `${Math.round(v)} ${units[i]}`;
  if (v >= 100) return `${Math.round(v)} ${units[i]}`;
  if (v >= 10) return `${v.toFixed(1)} ${units[i]}`;
  return `${v.toFixed(2)} ${units[i]}`;
}

function fmtRate(bytesPerSec) {
  return `${fmtBytes(bytesPerSec)}/s`;
}

function fmtPct(v) {
  return `${Math.round(clamp(v, 0, 100))}%`;
}

function hhmm(date) {
  const p = (x) => String(x).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

function daysLeft(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

function priceText(node) {
  const price = num(node.price, NaN);
  if (!Number.isFinite(price)) return "";
  const cur = clean(node.currency) || "¥";
  const cycle = num(node.billing_cycle, 30);
  const unit = cycle === 365 ? "年" : cycle === 30 ? "月" : `${cycle}天`;
  return `${cur}${price}/${unit}`;
}

// ------------------------------------------------------------------ DSL 积木

function text(content, { size = 10, weight, color = COLORS.text, align, maxLines, minScale, opacity, flex } = {}) {
  const node = { type: "text", text: String(content), font: { size }, textColor: color };
  if (weight) node.font.weight = weight;
  if (align) node.textAlign = align;
  if (maxLines) node.maxLines = maxLines;
  if (minScale) node.minScale = minScale;
  if (opacity != null) node.opacity = opacity;
  if (flex != null) node.flex = flex;
  return node;
}

function row(children, { gap = 4, align = "center", ...rest } = {}) {
  return { type: "stack", direction: "row", alignItems: align, gap, children, ...rest };
}

function col(children, { gap = 4, align = "start", ...rest } = {}) {
  return { type: "stack", direction: "column", alignItems: align, gap, children, ...rest };
}

/** text 没有 width，要定宽列时用 stack 包一层。 */
function cell(width, node) {
  return { type: "stack", direction: "row", width, children: [node] };
}

/** 进度条：填充块用 flex 占比，不用像素宽。 */
function bar(pct, color, { height = 4, flex = 1 } = {}) {
  const value = clamp(pct, 0, 100);
  return {
    type: "stack",
    direction: "row",
    height,
    flex,
    borderRadius: height / 2,
    backgroundColor: COLORS.track,
    gap: 0,
    children: [
      { type: "stack", flex: Math.max(value, 0.001), height, borderRadius: height / 2, backgroundColor: color, children: [] },
      { type: "stack", flex: Math.max(100 - value, 0.001), height, children: [] },
    ],
  };
}

/** 分隔线：里面塞 spacer 防被压成 0 宽。 */
function divider() {
  return {
    type: "stack",
    direction: "row",
    height: 1,
    backgroundColor: COLORS.hairline,
    children: [{ type: "spacer" }],
  };
}

function spacer() {
  return { type: "spacer" };
}

// ------------------------------------------------------------------ 取数

export default async function (ctx) {
  const env = (ctx && ctx.env) || {};
  const family = (ctx && ctx.widgetFamily) || "systemMedium";
  const refreshMin = Math.max(1, num(env.REFRESH, DEFAULT_REFRESH_MIN) || DEFAULT_REFRESH_MIN);
  const refreshAfter = new Date(Date.now() + refreshMin * 60 * 1000).toISOString();
  const title = clean(env.TITLE) || "Komari 面板";

  const base = clean(env.PANEL).replace(/\/+$/, "");
  if (!base) {
    return renderError("未配置面板地址", refreshAfter, "在模块参数里填 PANEL：面板根地址，如 https://panel.example.com:8443");
  }

  const policy = clean(env.POLICY);
  let token = clean(env.TOKEN);
  const user = clean(env.USER);
  const pass = clean(env.PASS);

  function reqOptions(extra) {
    const options = {
      timeout: 10000,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
      },
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;
    if (policy) options.policy = policy;
    return Object.assign(options, extra || {});
  }

  async function getJSON(url) {
    try {
      const res = await ctx.http.get(url, reqOptions());
      let data = null;
      let notJson = false;
      try {
        data = await res.json();
      } catch (_) {
        notJson = true;
      }
      return { status: res.status || 0, data, notJson, networkError: false };
    } catch (_) {
      return { status: 0, data: null, notJson: false, networkError: true };
    }
  }

  /** 私有站点：账号密码换令牌。拿不到就继续裸奔，让后面的报错口径统一处理。 */
  async function tryLogin() {
    if (token || !user || !pass || !ctx.http || typeof ctx.http.post !== "function") return;
    try {
      const res = await ctx.http.post(
        `${base}/api/login`,
        reqOptions({
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
            Accept: "application/json,text/plain,*/*",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username: user, password: pass }),
        })
      );
      const j = await res.json();
      const t =
        (j && j.data && (j.data.token || j.data.access_token)) ||
        (j && (j.token || j.access_token)) ||
        "";
      if (t) token = String(t);
    } catch (_) {
      /* 登录失败不单独报，/api/nodes 的结果会给出统一口径 */
    }
  }

  await tryLogin();

  const nodesRes = await getJSON(`${base}/api/nodes`);
  if (nodesRes.networkError) {
    return renderError("无法连接面板", refreshAfter, `${base} 超时或不通，检查地址与请求策略`);
  }
  if (nodesRes.notJson) {
    return renderError("返回的不是 JSON", refreshAfter, "地址可能填错：只填根地址，不要带 /api 或 /admin");
  }
  const rawNodes = Array.isArray(nodesRes.data) ? nodesRes.data : nodesRes.data && nodesRes.data.data;
  if (!Array.isArray(rawNodes)) {
    if (nodesRes.status === 401 || nodesRes.status === 403) {
      return renderError("面板需要登录", refreshAfter, "私有站点：在参数里填 TOKEN，或填 USER / PASS 让脚本自动登录");
    }
    return renderError("面板返回异常", refreshAfter, `HTTP ${nodesRes.status || "?"}，确认这是 Komari 面板地址`);
  }

  // 过滤：隐藏开关 + ONLY 名单（名称或 ID、英文逗号分隔）
  const onlyTokens = clean(env.ONLY)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const showHidden = truthy(env.SHOW_HIDDEN);
  const nodes = rawNodes
    .filter((n) => n && n.uuid)
    .filter((n) => showHidden || !n.hidden)
    .filter(
      (n) =>
        !onlyTokens.length ||
        onlyTokens.some((t) => t === n.uuid || clean(n.name).includes(t))
    )
    .sort((a, b) => num(a.weight, 999) - num(b.weight, 999));

  if (!nodes.length) {
    return renderError("没有可显示的服务器", refreshAfter, onlyTokens.length ? "ONLY 名单没匹配上任何节点" : "面板里还没有节点");
  }

  // 每台并行取最新帧 + 三网探测；单台失败只降级该台
  const enriched = await Promise.all(
    nodes.map(async (node) => {
      const [recentRes, pingRes] = await Promise.all([
        getJSON(`${base}/api/recent/${encodeURIComponent(node.uuid)}`),
        getJSON(`${base}/api/records/ping?uuid=${encodeURIComponent(node.uuid)}`),
      ]);
      const reports = recentRes.data && (Array.isArray(recentRes.data) ? recentRes.data : recentRes.data.data);
      const report = Array.isArray(reports) && reports.length ? reports[0] : null;
      const pingData = pingRes.data && (pingRes.data.data || pingRes.data);
      const tasks = pingData && Array.isArray(pingData.tasks) ? pingData.tasks : [];
      return buildNode(node, report, tasks);
    })
  );

  const view =
    family === "systemSmall"
      ? viewSmall(enriched, refreshAfter)
      : family === "systemLarge" || family === "systemExtraLarge"
        ? viewLarge(enriched, title, refreshAfter)
        : viewMedium(enriched, title, refreshAfter);
  return view;
}

function buildNode(node, report, tasks) {
  const now = Date.now();
  const updatedAt = Date.parse((report && report.updated_at) || node.updated_at || "");
  const online = Number.isFinite(updatedAt) && now - updatedAt < ONLINE_THRESHOLD_MS;

  const ram = (report && report.ram) || {};
  const disk = (report && report.disk) || {};
  const net = (report && report.network) || {};
  const ramTotal = num(ram.total) || num(node.mem_total);
  const diskTotal = num(disk.total) || num(node.disk_total);

  const pickCarrier = (keyword, excludeV6) => {
    let t = tasks.find(
      (x) => x && clean(x.name).includes(keyword) && !(excludeV6 && /v6/i.test(clean(x.name)))
    );
    if (!t) t = tasks.find((x) => x && clean(x.name).includes(keyword));
    if (!t || !num(t.total)) return null;
    if (num(t.loss) >= 100) return { avg: null, loss: 100 };
    return { avg: Math.round(num(t.avg)), loss: Math.round(num(t.loss) * 10) / 10 };
  };

  const carriers = {
    mobile: pickCarrier("移动", true),
    unicom: pickCarrier("联通", false),
    telecom: pickCarrier("电信", false),
  };
  const avail = [carriers.mobile, carriers.unicom, carriers.telecom].filter(
    (c) => c && c.avg != null
  );
  const best = avail.length ? avail.reduce((a, b) => (a.avg <= b.avg ? a : b)) : null;
  const maxLoss = Math.max(
    0,
    ...[carriers.mobile, carriers.unicom, carriers.telecom].map((c) => (c ? num(c.loss) : 0))
  );

  return {
    name: clean(node.name) || node.uuid.slice(0, 8),
    flag: clean(node.region),
    online,
    cpu: report ? num(report.cpu && report.cpu.usage) : null,
    memPct: ramTotal ? (num(ram.used) / ramTotal) * 100 : null,
    diskPct: diskTotal ? (num(disk.used) / diskTotal) * 100 : null,
    netUp: num(net.up),
    netDown: num(net.down),
    totalTraffic: num(net.totalUp) + num(net.totalDown),
    hasReport: !!report,
    carriers,
    best,
    maxLoss,
    days: daysLeft(node.expired_at),
    price: priceText(node),
  };
}

// ------------------------------------------------------------------ 视图

function statusDot(online) {
  return text("●", { size: 8, color: online ? COLORS.online : COLORS.offline });
}

function carrierText(label, c) {
  if (!c) return text(`${label} --`, { size: 10, color: COLORS.textDim });
  if (c.avg == null) return text(`${label} 不通`, { size: 10, color: COLORS.offline });
  return text(`${label} ${c.avg}`, { size: 10, weight: "semibold", color: latencyColor(c.avg) });
}

function header(title, nodes, refreshAfter) {
  const on = nodes.filter((n) => n.online).length;
  return row([
    text(title, { size: 14, weight: "semibold", maxLines: 1, flex: 1 }),
    text(`在线 ${on}/${nodes.length}`, {
      size: 10,
      weight: "semibold",
      color: on === nodes.length ? COLORS.online : COLORS.warn,
    }),
    text(hhmm(new Date()), { size: 10, color: COLORS.textDim }),
  ]);
}

function widgetRoot(children, refreshAfter, gap = 6) {
  return {
    type: "widget",
    padding: [10, 12],
    gap,
    backgroundColor: COLORS.bg,
    refreshAfter,
    children: [...children, spacer()],
  };
}

function viewMedium(nodes, title, refreshAfter) {
  const shown = nodes.slice(0, 4);
  const children = [header(title, nodes, refreshAfter)];
  shown.forEach((n, i) => {
    if (i > 0) children.push(divider());
    children.push(
      col(
        [
          row([
            statusDot(n.online),
            text(`${n.flag ? n.flag + " " : ""}${n.name}`, {
              size: 13,
              weight: "semibold",
              maxLines: 1,
              flex: 1,
            }),
            n.online && n.best
              ? text(`${n.best.avg} ms`, { size: 12, weight: "semibold", color: latencyColor(n.best.avg) })
              : text(n.online ? "-- ms" : "离线", { size: 11, color: n.online ? COLORS.textDim : COLORS.offline }),
          ]),
          row([
            text(
              n.hasReport
                ? `CPU ${n.cpu == null ? "--" : fmtPct(n.cpu)} · 内存 ${n.memPct == null ? "--" : fmtPct(n.memPct)} · 磁盘 ${n.diskPct == null ? "--" : fmtPct(n.diskPct)}`
                : "暂无上报数据",
              { size: 10, color: COLORS.textSub, maxLines: 1, flex: 1 }
            ),
            carrierText("移", n.carriers.mobile),
            carrierText("联", n.carriers.unicom),
            carrierText("电", n.carriers.telecom),
            n.maxLoss >= 5
              ? text(`丢包${Math.round(n.maxLoss)}%`, { size: 10, color: COLORS.offline })
              : null,
          ].filter(Boolean)),
        ],
        { gap: 2 }
      )
    );
  });
  if (nodes.length > shown.length) {
    children.push(text(`还有 ${nodes.length - shown.length} 台，放大尺寸查看`, { size: 9, color: COLORS.textDim }));
  }
  return widgetRoot(children, refreshAfter);
}

function viewLarge(nodes, title, refreshAfter) {
  const shown = nodes.slice(0, 5);
  const totalTraffic = nodes.reduce((s, n) => s + n.totalTraffic, 0);
  const children = [
    header(title, nodes, refreshAfter),
    row([
      text(`累计流量 ${fmtBytes(totalTraffic)}`, { size: 10, color: COLORS.textSub, flex: 1 }),
      text(`共 ${nodes.length} 台`, { size: 10, color: COLORS.textDim }),
    ]),
  ];
  shown.forEach((n, i) => {
    if (i > 0) children.push(divider());
    const daysColor =
      n.days == null ? COLORS.textDim : n.days <= 3 ? COLORS.offline : n.days <= 7 ? COLORS.warn : COLORS.textSub;
    children.push(
      col(
        [
          row([
            statusDot(n.online),
            text(`${n.flag ? n.flag + " " : ""}${n.name}`, {
              size: 13,
              weight: "semibold",
              maxLines: 1,
              flex: 1,
            }),
            n.price ? text(n.price, { size: 10, color: COLORS.textSub }) : null,
            n.days == null
              ? null
              : text(n.days < 0 ? "已过期" : `剩 ${n.days} 天`, { size: 10, weight: "semibold", color: daysColor }),
          ].filter(Boolean)),
          row([
            cell(26, text("CPU", { size: 9, color: COLORS.textDim })),
            bar(n.online && n.cpu != null ? n.cpu : 0, COLORS.cpu),
            cell(36, text(n.cpu == null ? "--" : fmtPct(n.cpu), { size: 10, color: COLORS.textSub, align: "right" })),
            cell(26, text("内存", { size: 9, color: COLORS.textDim })),
            bar(n.online && n.memPct != null ? n.memPct : 0, COLORS.mem),
            cell(36, text(n.memPct == null ? "--" : fmtPct(n.memPct), { size: 10, color: COLORS.textSub, align: "right" })),
            cell(26, text("磁盘", { size: 9, color: COLORS.textDim })),
            bar(n.online && n.diskPct != null ? n.diskPct : 0, COLORS.disk),
            cell(36, text(n.diskPct == null ? "--" : fmtPct(n.diskPct), { size: 10, color: COLORS.textSub, align: "right" })),
          ], { gap: 5 }),
          row([
            text(`↑ ${fmtRate(n.netUp)}`, { size: 10, color: COLORS.up }),
            text(`↓ ${fmtRate(n.netDown)}`, { size: 10, color: COLORS.down }),
            text(`累计 ${fmtBytes(n.totalTraffic)}`, { size: 10, color: COLORS.textSub, flex: 1 }),
            carrierText("移动", n.carriers.mobile),
            carrierText("联通", n.carriers.unicom),
            carrierText("电信", n.carriers.telecom),
          ]),
        ],
        { gap: 3 }
      )
    );
  });
  if (nodes.length > shown.length) {
    children.push(text(`还有 ${nodes.length - shown.length} 台未显示`, { size: 9, color: COLORS.textDim }));
  }
  return widgetRoot(children, refreshAfter);
}

function viewSmall(nodes, refreshAfter) {
  const n = nodes.find((x) => x.online) || nodes[0];
  const children = [
    row([
      statusDot(n.online),
      text(`${n.flag ? n.flag + " " : ""}${n.name}`, { size: 14, weight: "semibold", maxLines: 1, flex: 1 }),
    ]),
    row([
      cell(30, text("CPU", { size: 10, color: COLORS.textDim })),
      bar(n.cpu != null ? n.cpu : 0, COLORS.cpu),
      cell(38, text(n.cpu == null ? "--" : fmtPct(n.cpu), { size: 11, weight: "semibold", align: "right" })),
    ], { gap: 5 }),
    row([
      cell(30, text("内存", { size: 10, color: COLORS.textDim })),
      bar(n.memPct != null ? n.memPct : 0, COLORS.mem),
      cell(38, text(n.memPct == null ? "--" : fmtPct(n.memPct), { size: 11, weight: "semibold", align: "right" })),
    ], { gap: 5 }),
    row([
      n.best
        ? text(`${n.best.avg} ms`, { size: 17, weight: "semibold", color: latencyColor(n.best.avg) })
        : text(n.online ? "-- ms" : "离线", { size: 15, weight: "semibold", color: n.online ? COLORS.textDim : COLORS.offline }),
      text(n.best ? "三网最优" : "", { size: 9, color: COLORS.textDim }),
    ]),
    text(
      `累计 ${fmtBytes(n.totalTraffic)}${n.days == null ? "" : n.days < 0 ? " · 已过期" : ` · 剩 ${n.days} 天`}`,
      { size: 10, color: COLORS.textSub }
    ),
    nodes.length > 1
      ? text(`共 ${nodes.length} 台 · ${nodes.filter((x) => x.online).length} 台在线`, { size: 9, color: COLORS.textDim })
      : null,
  ].filter(Boolean);
  return widgetRoot(children, refreshAfter, 5);
}

function renderError(message, refreshAfter, hint) {
  const children = [
    spacer(),
    row([text(`⚠️ ${message}`, { size: 13, weight: "semibold", align: "center", maxLines: 2, flex: 1 })]),
  ];
  if (hint) {
    children.push(
      row([text(hint, { size: 10, color: COLORS.textDim, align: "center", maxLines: 3, flex: 1 })])
    );
  }
  children.push(spacer());
  return {
    type: "widget",
    padding: 16,
    gap: 6,
    backgroundColor: COLORS.bg,
    refreshAfter,
    children,
  };
}
