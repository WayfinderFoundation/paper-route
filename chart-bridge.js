// Runs in the page's MAIN world. papertrade's chart is a custom canvas renderer with no
// public instance, but it draws price-axis labels with fillText at exactly mapY(price) and
// time-axis labels at exactly the x of their timestamp. We observe those calls each frame
// and fit price->y and time->x, then hand the mapping to the isolated-world overlay.
(() => {
  const TAG = "wf-pt-map";
  const origFillText = CanvasRenderingContext2D.prototype.fillText;

  const PRICE_RE = /^\$?-?[\d,]+(\.\d+)?$/;
  const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

  let chartCanvas = null;
  let batch = null;
  let lastSent = "";
  // Every canvas text draw on the page passes through the hooks below, so the chart check and its
  // CSS size are cached: no DOM walk per draw, and no forced layout inside papertrade's render.
  const notChart = new WeakSet();
  let cssSize = null; // { width, height } of the chart canvas, kept current by a ResizeObserver
  const sizeObserver = new ResizeObserver(([entry]) => {
    cssSize = { width: entry.contentRect.width, height: entry.contentRect.height };
  });

  function isChartCanvas(canvas) {
    if (canvas === chartCanvas) return true;
    if (notChart.has(canvas)) return false;
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.closest(".trade-chart")) {
      notChart.add(canvas);
      return false;
    }
    if (chartCanvas) sizeObserver.unobserve(chartCanvas);
    chartCanvas = canvas;
    const rect = canvas.getBoundingClientRect();
    cssSize = { width: rect.width, height: rect.height };
    sizeObserver.observe(canvas);
    return true;
  }

  function toCss(ctx, x, y) {
    const m = ctx.getTransform();
    const dx = m.a * x + m.c * y + m.e;
    const dy = m.b * x + m.d * y + m.f;
    return [dx / batch.scaleX, dy / batch.scaleY];
  }

  function nearestTimestamp(h, m, s) {
    const now = new Date();
    const d = new Date(now);
    d.setHours(h, m, s ?? 0, 0);
    let t = d.getTime();
    // labels can straddle midnight; pick the candidate closest to now
    if (t - now.getTime() > 12 * 3600e3) t -= 86400e3;
    if (now.getTime() - t > 12 * 3600e3) t += 86400e3;
    return t;
  }

  function startBatch(canvas) {
    batch = {
      canvas,
      scaleX: canvas.width / cssSize.width,
      scaleY: canvas.height / cssSize.height,
      prices: new Map(), // style key -> [{price, x, y}]
      times: [],
      dot: null, // the live-price dot: last glowing arc drawn this frame
    };
    queueMicrotask(flush);
  }

  // least squares y = slope * (x - x0) + intercept; centring on x0 keeps epoch-ms inputs well conditioned
  function fitLine(points, xKey, yKey) {
    const n = points.length;
    const x0 = points[0][xKey];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of points) {
      const x = p[xKey] - x0;
      sx += x; sy += p[yKey]; sxx += x * x; sxy += x * p[yKey];
    }
    const den = n * sxx - sx * sx;
    if (den === 0) return null;
    const slope = (n * sxy - sx * sy) / den;
    return { x0, slope, intercept: (sy - slope * sx) / n };
  }

  function flush() {
    const b = batch;
    batch = null;
    if (!b) return;

    // grid labels share one style and are the largest group; price tags / crosshair are singletons
    let grid = [];
    for (const group of b.prices.values()) if (group.length > grid.length) grid = group;
    if (grid.length < 2) return;
    const yFit = fitLine(grid, "price", "y");
    if (!yFit || yFit.slope >= 0) return;

    let xFit = null;
    if (b.times.length >= 2) xFit = fitLine(b.times, "t", "x");

    const msg = {
      type: TAG,
      price0: yFit.x0,
      priceSlope: yFit.slope,
      priceIntercept: yFit.intercept,
      plotRight: grid[0].x - 5,
      plotBottom: b.times.length ? b.times[0].y - 14 : null,
      time0: xFit ? xFit.x0 : null,
      timeSlope: xFit ? xFit.slope : null,
      timeIntercept: xFit ? xFit.intercept : null,
      dotX: b.dot ? b.dot[0] : null,
      dotY: b.dot ? b.dot[1] : null,
    };
    const key = JSON.stringify(msg);
    if (key === lastSent) return;
    lastSent = key;
    window.postMessage(msg, location.origin);
  }

  const origArc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.arc = function (x, y, r, a0, a1, ccw) {
    if (this.shadowBlur > 0 && r <= 8 && isChartCanvas(this.canvas)) {
      if (!batch || batch.canvas !== this.canvas) startBatch(this.canvas);
      batch.dot = toCss(this, x, y);
    }
    return origArc.call(this, x, y, r, a0, a1, ccw);
  };

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    if (typeof text === "string" && isChartCanvas(this.canvas)) {
      if (!batch || batch.canvas !== this.canvas) startBatch(this.canvas);
      const s = text.trim();
      if (this.textAlign === "left" && this.textBaseline === "middle" && PRICE_RE.test(s)) {
        const [cx, cy] = toCss(this, x, y);
        const key = `${this.font}|${this.fillStyle}`;
        const group = groupFor(batch.prices, key);
        group.push({ price: parseFloat(s.replace(/[$,]/g, "")), x: cx, y: cy });
      } else if (this.textAlign === "center" && this.textBaseline === "alphabetic") {
        const m = TIME_RE.exec(s);
        if (m) {
          const [cx, cy] = toCss(this, x, y);
          batch.times.push({ t: nearestTimestamp(+m[1], +m[2], m[3] && +m[3]), x: cx, y: cy });
        }
      }
    }
    return origFillText.call(this, text, x, y, maxWidth);
  };

  function groupFor(map, key) {
    let v = map.get(key);
    if (!v) map.set(key, (v = []));
    return v;
  }
})();
