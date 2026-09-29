(() => {
  const element = (id) => document.getElementById(id);
  if (!element("monitor")) return;
  let data = null, chosenToken = null, busy = false, unavailable = false, receivedAt = 0, reviewing = false;
  const percent = (value) => value === null ? "—" : `${value >= 0 ? "+" : ""}${(value / 100).toFixed(2)}%`;
  const label = (signal) => signal.replaceAll("_", " ");
  const identity = (row) => row.launch.metadata.status === "DECLARED" ? row.launch.metadata.symbol || row.launch.metadata.name || row.token : `${row.token.slice(0, 10)}…${row.token.slice(-4)}`;
  const isFresh = (row) => !unavailable && Date.now() - receivedAt <= 15_000 && row.observedAt && Date.now() - Date.parse(row.observedAt) <= (data?.staleAfterMs ?? 45_000);
  const chosen = () => data?.opportunities.find((row) => row.token === chosenToken);
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/monitor.css"; document.head.append(css);
  const shortcut = document.createElement("a"); shortcut.href = "#monitor"; shortcut.textContent = "OPEN OPPORTUNITY MONITOR ↓"; shortcut.className = "monitor-shortcut";
  document.querySelector(".briefing")?.append(shortcut);

  function drawChart(points) {
    const svg = element("monitor-chart"); svg.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    if (points.length < 2) { const text = document.createElementNS(ns, "text"); text.setAttribute("x", "20"); text.setAttribute("y", "80"); text.textContent = "Collecting live observations…"; svg.append(text); return; }
    const minimum = Math.min(...points.map((point) => point.index)), maximum = Math.max(...points.map((point) => point.index));
    const start = Date.parse(points[0].at), duration = Math.max(1, Date.parse(points.at(-1).at) - start);
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", points.map((point) => `${20 + (Date.parse(point.at) - start) / duration * 600},${maximum === minimum ? 75 : 130 - (point.index - minimum) / (maximum - minimum) * 110}`).join(" "));
    svg.append(line);
  }

  function detail() {
    const row = chosen();
    element("monitor-buy").disabled = reviewing || !row || !row.canReviewBuy || !isFresh(row);
    element("monitor-sell").disabled = reviewing || !row || !row.canReviewSell || !isFresh(row);
    if (!row) {
      element("monitor-token").textContent = "NO MATCHING OPPORTUNITY";
      element("monitor-signal").textContent = "WAIT";
      element("monitor-observation").textContent = "No matching tokens are in the monitored set.";
      for (const id of ["momentum", "liquidity", "drawdown", "entry", "stop", "target", "trailing"]) element(`monitor-${id}`).textContent = "—";
      element("monitor-reasons").replaceChildren(); drawChart([]); return;
    }
    element("monitor-token").textContent = identity(row);
    element("monitor-signal").textContent = label(!isFresh(row) && row.samples > 0 ? "STALE" : row.signal);
    element("monitor-observation").textContent = `${row.score}/100 evidence score · ${row.samples} observations · ${row.windowSeconds}s history${row.observedAt ? ` · ${new Date(row.observedAt).toLocaleTimeString()}` : ""}`;
    element("monitor-momentum").textContent = percent(row.momentumBps);
    element("monitor-liquidity").textContent = percent(row.liquidityChangeBps);
    element("monitor-drawdown").textContent = percent(row.drawdownBps);
    const reasons = element("monitor-reasons"); reasons.replaceChildren();
    row.reasons.forEach((reason) => { const li = document.createElement("li"); li.textContent = reason; reasons.append(li); });
    const plan = row.plan;
    element("monitor-entry").textContent = plan ? `${plan.entryLow.toFixed(2)} – ${plan.entryHigh.toFixed(2)}` : "—";
    element("monitor-stop").textContent = plan ? plan.invalidation.toFixed(2) : "—";
    element("monitor-target").textContent = plan ? plan.profitReview.toFixed(2) : "—";
    element("monitor-trailing").textContent = plan ? plan.trailingReview.toFixed(2) : "—";
    drawChart(row.chart);
  }

  function render() {
    const filter = element("monitor-filter").value;
    const rows = (data?.opportunities ?? []).filter((row) => filter === "ALL" || row.signal === filter);
    if (!rows.some((row) => row.token === chosenToken)) chosenToken = rows[0]?.token ?? null;
    const list = element("monitor-list"), focused = document.activeElement?.dataset.monitorToken;
    list.replaceChildren();
    element("monitor-status").textContent = unavailable ? "FEED UNAVAILABLE" : `${label(data?.status ?? "WARMING_UP")} · ${data?.opportunities.length ?? 0} TOKENS`;
    if (!rows.length) { const empty = document.createElement("p"); empty.textContent = "No matching opportunities yet. Monitoring continues."; list.append(empty); }
    rows.forEach((row) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "monitor-row";
      button.dataset.monitorToken = row.token; button.dataset.signal = row.signal; button.setAttribute("aria-pressed", String(row.token === chosenToken));
      const title = document.createElement("strong"); title.textContent = identity(row);
      const summary = document.createElement("span"); summary.textContent = `${row.score}/100 · ${label(row.signal)} · 1m ${percent(row.momentumBps)}`;
      button.append(title, summary); button.addEventListener("click", () => { chosenToken = row.token; render(); }); list.append(button);
      if (focused === row.token) button.focus({ preventScroll: true });
    });
    detail();
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch("/api/opportunities", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error("Feed unavailable");
      const next = await response.json();
      if (next.mode !== "approval-required" || !Array.isArray(next.opportunities)) throw new Error("Invalid feed");
      data = next; receivedAt = Date.now(); unavailable = next.status === "STALE"; render();
    } catch { unavailable = true; element("monitor-status").textContent = "FEED UNAVAILABLE · REVIEWS PAUSED"; detail(); }
    finally { busy = false; }
  }

  async function review(side) {
    const row = chosen();
    if (reviewing || !row || !isFresh(row) || !(side === "BUY" ? row.canReviewBuy : row.canReviewSell)) return;
    reviewing = true;
    element("monitor-buy").disabled = true; element("monitor-sell").disabled = true;
    element("monitor-review-status").textContent = "Checking the latest proposal…";
    try {
      if (!window.GptheistDesk?.reviewOpportunity) throw new Error("Trade controls are unavailable.");
      await window.GptheistDesk.reviewOpportunity(row.token, side);
      element("monitor-review-status").textContent = `${side} selected for ${identity(row)}. Enter an amount and review the execution gates.`;
    } catch (error) { element("monitor-review-status").textContent = String(error?.message || error).slice(0, 180); }
    finally { reviewing = false; detail(); }
  }
  element("monitor-filter").addEventListener("change", render);
  element("monitor-buy").addEventListener("click", () => { void review("BUY"); });
  element("monitor-sell").addEventListener("click", () => { void review("SELL"); });
  void poll(); setInterval(poll, 5_000);
  setInterval(() => { const row = chosen(); if (row && !isFresh(row)) { element("monitor-buy").disabled = true; element("monitor-sell").disabled = true; } }, 1_000);
})();
