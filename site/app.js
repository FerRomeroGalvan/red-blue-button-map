(async function () {
  const cfg = window.APP_CONFIG;
  const MOCK = !cfg.API_BASE;
  const MIN = cfg.MIN_VOTES;

  // Support link. If SUPPORT_URL is empty, hide it.
  document.querySelectorAll(".support-btn").forEach((a) => (a.href = cfg.SUPPORT_URL));
  if (!cfg.SUPPORT_URL) document.getElementById("support").hidden = true;
  document.querySelectorAll(".min-n").forEach((el) => (el.textContent = MIN));

  // ---------- Screens ----------
  // "question" → "where" → "results". Only one shows at a time.
  function go(screen) {
    document.body.dataset.screen = screen;
    window.scrollTo({ top: 0 });
  }
  // Returning voters skip straight to results, even before the map has loaded.
  try { if (localStorage.getItem("rb_vote")) document.body.dataset.screen = "results"; } catch {}

  // ---------- Geometry ----------
  const us = await d3.json(cfg.TOPOJSON_URL);
  // 50 states + DC only (territories aren't drawn by the Albers USA projection).
  const inUS = (f) => +f.id.slice(0, 2) < 60;
  const counties = topojson.feature(us, us.objects.counties).features.filter(inUS);
  const states = topojson.feature(us, us.objects.states).features.filter(inUS);
  const nation = topojson.feature(us, us.objects.nation);
  const stateName = new Map(states.map((s) => [s.id, s.properties.name]));
  const countyById = new Map(counties.map((c) => [c.id, c]));
  const countyLabel = (id) => {
    const c = countyById.get(id);
    return c ? `${c.properties.name}, ${stateName.get(id.slice(0, 2)) || ""}` : id;
  };

  // ---------- Local state ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  function getToken() {
    let t = store.get("rb_token");
    if (!t) { t = crypto.randomUUID(); store.set("rb_token", t); }
    return t;
  }
  let myVote = store.get("rb_vote"); // { choice, fips }
  let level = "state";
  let data; // { updated, counties: { fips: [red, blue] } }
  let agg;

  // ---------- Data ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mockResults() {
    const rnd = mulberry32(42);
    const stateBias = new Map(states.map((s) => [s.id, (rnd() - 0.5) * 0.25]));
    const out = {};
    for (const c of counties) {
      const n = Math.floor(Math.pow(rnd(), 2.5) * 400);
      const p = Math.min(0.95, Math.max(0.05, 0.42 + (stateBias.get(c.id.slice(0, 2)) || 0) + (rnd() - 0.5) * 0.3));
      let red = 0;
      for (let i = 0; i < n; i++) if (rnd() < p) red++;
      out[c.id] = [red, n - red];
    }
    if (myVote && out[myVote.fips]) out[myVote.fips][myVote.choice === "red" ? 0 : 1]++;
    return { updated: new Date().toISOString(), counties: out, mock: true };
  }

  async function loadResults() {
    if (MOCK) return mockResults();
    const res = await fetch(cfg.API_BASE + "/results");
    if (!res.ok) throw new Error("Could not load results");
    return res.json();
  }

  function aggregate(d) {
    const county = new Map();
    const state = new Map();
    let R = 0, B = 0;
    for (const [fips, [r, b]] of Object.entries(d.counties)) {
      if (!countyById.has(fips)) continue;
      county.set(fips, { r, b });
      const s = fips.slice(0, 2);
      const o = state.get(s) || { r: 0, b: 0 };
      o.r += r; o.b += b;
      state.set(s, o);
      R += r; B += b;
    }
    return { county, state, R, B };
  }

  // ---------- Map ----------
  const width = 975, height = 610;
  const projection = d3.geoAlbersUsa().fitSize([width, height], nation);
  const path = d3.geoPath(projection);
  const svg = d3.select("#map").append("svg").attr("viewBox", [0, 0, width, height]);
  const gZoom = svg.append("g");
  const gCounties = gZoom.append("g");
  const gStates = gZoom.append("g");
  // "Lifted" shapes: a copy drawn on top with a soft shadow underneath, so the place looks
  // raised off the map. Used for your own area (always) and the place under the pointer.
  const shadow = svg.append("defs").append("filter").attr("id", "lift")
    .attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%")
    .append("feDropShadow").attr("flood-color", "#000").attr("flood-opacity", 0.45);
  const mine = gZoom.append("path").attr("class", "lift");
  const hoverLift = gZoom.append("path").attr("class", "lift");
  // Keep the lift and shadow the same size on screen at any zoom level.
  function sizeLift(k) {
    shadow.attr("dx", 0).attr("dy", 4 / k).attr("stdDeviation", 4 / k);
    gZoom.selectAll(".lift").attr("transform", `translate(0,${-3 / k})`);
  }
  sizeLift(1);
  function lift(sel, feature, f) {
    sel.attr("d", feature ? path(feature) : null).attr("fill", f || null).attr("stroke", f || null);
  }

  // Pinch / scroll / drag to zoom. Scroll-zoom needs ctrl or cmd so the page still scrolls normally.
  const resetBtn = document.getElementById("reset-zoom");
  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .translateExtent([[0, 0], [width, height]])
    .filter((e) => (e.type === "wheel" ? e.ctrlKey || e.metaKey : !e.button))
    .on("zoom", (e) => {
      gZoom.attr("transform", e.transform);
      sizeLift(e.transform.k);
      resetBtn.hidden = e.transform.k === 1;
      hideTip();
    });
  // d3 sets touch-action: none, which traps page scrolling on phones.
  // pan-y lets one finger scroll the page while pinch still zooms the map.
  svg.call(zoom).on("dblclick.zoom", null).style("touch-action", "pan-y");
  resetBtn.addEventListener("click", () => svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity));

  // Diverging scale centered on 50% red: deep cyan → cyan → neutral gray → wine → deep wine.
  // Not the US party red/blue, and checked for colorblind separation (dataviz validator, ΔE 17).
  // Clamped at 20% / 80%.
  const ramp = d3.piecewise(d3.interpolateLab, ["#0b5770", "#1788a8", "#f0efec", "#9b2335", "#5e0f22"]);
  const color = (p) => ramp((Math.max(0.2, Math.min(0.8, p)) - 0.2) / 0.6);
  // "Too few votes" is a hatch, so it can't be mistaken for the gray 50/50 midpoint.
  function addHatch(sel, id) {
    const pat = sel.append("defs").append("pattern").attr("id", id)
      .attr("width", 6).attr("height", 6).attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)");
    pat.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#fbfbfa");
    pat.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6).attr("stroke", "#cfcfcb").attr("stroke-width", 2);
  }
  addHatch(svg, "nodata");
  const NODATA = "url(#nodata)";
  const pct = (o) => o.r / (o.r + o.b);
  const enough = (o) => o && o.r + o.b >= MIN;
  const fill = (o) => (enough(o) ? color(pct(o)) : NODATA);
  const fmtPct = d3.format(".0%");
  const fmtPct1 = d3.format(".1%");
  const fmtInt = d3.format(",");
  const votes = (n) => `${fmtInt(n)} ${n === 1 ? "vote" : "votes"}`;

  const tooltip = document.getElementById("tooltip");
  function showTip(event, title, o, feature) {
    lift(hoverLift, feature, fill(o));
    let body;
    if (!o || o.r + o.b === 0) body = "No votes yet";
    else if (!enough(o)) body = `Not enough votes yet (${o.r + o.b})`;
    else body = `${fmtPct(pct(o))} red · ${votes(o.r + o.b)}`;
    tooltip.innerHTML = `<strong>${title}</strong><br>${body}`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const touch = event.pointerType && event.pointerType !== "mouse";
    const x = Math.max(8, Math.min(event.clientX + (touch ? -tw / 2 : 14), window.innerWidth - tw - 8));
    let y = touch ? event.clientY - th - 16 : event.clientY + 14;
    if (y < 8) y = event.clientY + 16;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  function hideTip() { tooltip.hidden = true; lift(hoverLift, null); }
  // Hide the tooltip when tapping outside the map.
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#map")) hideTip(); });
  // Mouse: tooltip follows the cursor. Touch: tap shows the tooltip.
  const isMouse = (e) => e.pointerType === "mouse";

  gCounties.selectAll("path").data(counties).join("path")
    .attr("class", "area").attr("d", path)
    .on("pointermove", (e, d) => isMouse(e) && showTip(e, countyLabel(d.id), agg.county.get(d.id), d))
    .on("pointerleave", (e) => isMouse(e) && hideTip())
    .on("click", (e, d) => showTip(e, countyLabel(d.id), agg.county.get(d.id), d));

  gStates.selectAll("path").data(states).join("path")
    .attr("class", "area").attr("d", path)
    .on("pointermove", (e, d) => isMouse(e) && showTip(e, d.properties.name, agg.state.get(d.id), d))
    .on("pointerleave", (e) => isMouse(e) && hideTip())
    .on("click", (e, d) => showTip(e, d.properties.name, agg.state.get(d.id), d));

  function drawLegend() {
    const w = 360, h = 46, m = 20;
    const s = d3.select("#legend").append("svg").attr("viewBox", [0, 0, w, h]);
    addHatch(s, "nodata-lg");
    const grad = s.append("defs").append("linearGradient").attr("id", "lg");
    d3.range(0, 1.01, 0.1).forEach((t) =>
      grad.append("stop").attr("offset", t).attr("stop-color", color(0.2 + 0.6 * t))
    );
    s.append("rect").attr("x", m).attr("y", 4).attr("width", w - 2 * m - 70).attr("height", 12).attr("fill", "url(#lg)");
    const lw = w - 2 * m - 70;
    [["80%+ blue", 0, "start"], ["50/50", lw / 2, "middle"], ["80%+ red", lw, "end"]].forEach(([t, x, a]) =>
      s.append("text").attr("x", m + x).attr("y", 32).attr("text-anchor", a).attr("font-size", 11).attr("fill", "#6b6b70").text(t)
    );
    s.append("rect").attr("x", w - m - 56).attr("y", 4).attr("width", 12).attr("height", 12).attr("fill", "url(#nodata-lg)").attr("stroke", "#cfcfcb");
    s.append("text").attr("x", w - m - 40).attr("y", 14).attr("font-size", 11).attr("fill", "#6b6b70").text("Too few");
  }
  drawLegend();

  function renderMap() {
    gCounties.style("display", level === "county" ? null : "none");
    gStates.style("display", level === "state" ? null : "none");
    // No visible boundaries: each shape is edged in its own color, which also hides the
    // hairline seams browsers draw between neighboring shapes.
    gCounties.selectAll("path").each(function (d) { const f = fill(agg.county.get(d.id)); d3.select(this).attr("fill", f).attr("stroke", f); });
    gStates.selectAll("path").each(function (d) { const f = fill(agg.state.get(d.id)); d3.select(this).attr("fill", f).attr("stroke", f); });
    const myFeature = myVote && (level === "county" ? countyById.get(myVote.fips) : states.find((s) => s.id === myVote.fips.slice(0, 2)));
    const myStats = myVote && (level === "county" ? agg.county.get(myVote.fips) : agg.state.get(myVote.fips.slice(0, 2)));
    lift(mine, myFeature, myFeature && fill(myStats));
  }

  document.querySelectorAll(".toggle button").forEach((btn) =>
    btn.addEventListener("click", () => {
      level = btn.dataset.level;
      document.querySelectorAll(".toggle button").forEach((b) => b.classList.toggle("active", b === btn));
      renderMap();
    })
  );

  // ---------- Stats ----------

  function bar(p) { return `<div class="bar"><span style="width:${(p * 100).toFixed(1)}%"></span></div>`; }

  function renderStats() {
    const total = agg.R + agg.B;
    const p = total ? agg.R / total : 0;
    const over = p > 0.5;
    // Your county and state next to the national number (only once you've voted).
    const localStat = (label, o) => `<div><div class="label">${label}</div>${
      enough(o) ? `<div class="value" style="color:${pct(o) > 0.5 ? "var(--red)" : "var(--blue)"}">${fmtPct(pct(o))} red</div>`
                : `<div class="value na">Not enough votes yet</div>`}</div>`;
    const local = myVote
      ? `<div class="local">${localStat(countyLabel(myVote.fips).split(",")[0], agg.county.get(myVote.fips))}${localStat(stateName.get(myVote.fips.slice(0, 2)), agg.state.get(myVote.fips.slice(0, 2)))}</div>`
      : "";
    const you = myVote
      ? `<p class="you">You pressed <span class="chip ${myVote.choice}">${myVote.choice}</span> in ${countyLabel(myVote.fips)}.</p>`
      : "";

    document.getElementById("national").innerHTML = `
      ${you}
      <h2>If the United States were the whole world…</h2>
      <div class="big-number" style="color:${over ? "var(--red)" : "var(--blue)"}">${total ? fmtPct1(p) : "–"} red</div>
      <p class="verdict">${!total ? "No votes yet." : over ? "Over 50%. Everyone who pressed blue dies." : "Under 50%. Everyone survives."}</p>
      <div class="gauge"><div class="fill" style="width:${(p * 100).toFixed(1)}%"></div><div class="mark" title="50% threshold"></div></div>
      <div class="gauge-labels"><span>0%</span><span>50%</span><span>100%</span></div>
      <p class="muted small vote-count">${votes(total)} · ${fmtInt(agg.R)} red · ${fmtInt(agg.B)} blue</p>
      ${local}`;

    const ranked = [...agg.state].filter(([, o]) => enough(o)).map(([id, o]) => ({ id, p: pct(o), n: o.r + o.b }))
      .sort((a, b) => b.p - a.p);
    document.getElementById("state-rank").innerHTML = ranked.map((s) =>
      `<li class="${s.p > 0.5 ? "over" : ""}" title="${votes(s.n)}"><span>${stateName.get(s.id)}</span>${bar(s.p)}<span class="pct">${fmtPct(s.p)}</span></li>`
    ).join("") || `<li class="muted">Not enough votes yet.</li>`;

    const close = [...agg.county].filter(([, o]) => enough(o)).map(([id, o]) => ({ id, p: pct(o), n: o.r + o.b }))
      .sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5) || b.n - a.n).slice(0, 10);
    document.getElementById("close-counties").innerHTML = close.map((c) =>
      `<li class="${c.p > 0.5 ? "over" : ""}" title="${votes(c.n)}"><span>${countyLabel(c.id)}</span>${bar(c.p)}<span class="pct">${fmtPct1(c.p)}</span></li>`
    ).join("") || `<li class="muted">Not enough votes yet.</li>`;

    document.getElementById("updated").textContent = data.mock
      ? "Showing mock data. Set API_BASE in config.js to use live results."
      : data.updated ? `Updated ${new Date(data.updated).toLocaleTimeString()}. Totals refresh every few minutes.` : "";
  }

  function render() { agg = aggregate(data); renderMap(); renderStats(); }

  // ---------- Voting: pick a button, then say where you are ----------
  const stateSel = document.getElementById("state-select");
  const countySel = document.getElementById("county-select");
  const submitBtn = document.getElementById("submit-btn");
  const msg = document.getElementById("vote-msg");
  let pending = null; // "red" | "blue", chosen on screen 1 and not yet submitted

  [...states].sort((a, b) => a.properties.name.localeCompare(b.properties.name)).forEach((s) =>
    stateSel.add(new Option(s.properties.name, s.id))
  );

  function fillCounties(stateId) {
    countySel.length = 1;
    counties.filter((c) => c.id.startsWith(stateId))
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name))
      .forEach((c) => countySel.add(new Option(c.properties.name, c.id)));
    countySel.disabled = !stateId;
    updateSubmit();
  }

  function selectCounty(fips) {
    stateSel.value = fips.slice(0, 2);
    fillCounties(fips.slice(0, 2));
    countySel.value = fips;
    updateSubmit();
    msg.textContent = `Found you: ${countyLabel(fips)}.`;
  }

  function updateSubmit() { submitBtn.disabled = !countySel.value; }

  function choose(choice) {
    if (myVote) { go("results"); return; }
    pending = choice;
    const chip = document.getElementById("chosen-chip");
    chip.textContent = choice;
    chip.className = `chip ${choice}`;
    submitBtn.className = `primary ${choice}`;
    msg.textContent = "";
    go("where");
  }

  function showResults() {
    document.getElementById("vote-cta").hidden = !!myVote;
    render();
    go("results");
  }

  document.getElementById("btn-red").addEventListener("click", () => choose("red"));
  document.getElementById("btn-blue").addEventListener("click", () => choose("blue"));
  document.getElementById("back-btn").addEventListener("click", () => go("question"));
  document.getElementById("peek-btn").addEventListener("click", showResults);
  document.getElementById("vote-now-btn").addEventListener("click", () => go("question"));
  stateSel.addEventListener("change", () => fillCounties(stateSel.value));
  countySel.addEventListener("change", updateSubmit);

  document.getElementById("locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) { msg.textContent = "Location isn't available in this browser."; return; }
    msg.textContent = "Finding your county…";
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const pt = [coords.longitude, coords.latitude];
        const hit = counties.find((c) => d3.geoContains(c, pt));
        if (hit) selectCounty(hit.id);
        else msg.textContent = "Couldn't match your location to a US county. Pick it from the list.";
      },
      () => (msg.textContent = "Couldn't get your location. Pick your county from the list."),
      { timeout: 10000 }
    );
  });

  submitBtn.addEventListener("click", async () => {
    const fips = countySel.value;
    const choice = pending;
    if (!fips || !choice || myVote) return;
    submitBtn.disabled = true;
    msg.textContent = "Recording your vote…";
    if (!MOCK) {
      try {
        const res = await fetch(cfg.API_BASE + "/vote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ county_fips: fips, choice, token: getToken() }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          msg.textContent = j.error || "Something went wrong. Try again.";
          if (res.status !== 409) { updateSubmit(); return; }
        }
      } catch {
        msg.textContent = "Couldn't reach the server. Try again.";
        updateSubmit();
        return;
      }
    }
    myVote = { choice, fips };
    store.set("rb_vote", myVote);
    // Show the vote right away; the server totals catch up on the next refresh.
    data.counties[fips] = data.counties[fips] || [0, 0];
    data.counties[fips][choice === "red" ? 0 : 1]++;
    showResults();
  });

  // ---------- Sharing ----------
  // Phones: the native share sheet (Instagram, TikTok, WhatsApp, Messages…).
  // Instagram and TikTok don't accept links from websites, only images, so "Share as image"
  // shares a story-sized picture of the question with the site address on it.
  // Desktops without a share sheet get a small panel of links instead.
  const shareUrl = cfg.SITE_URL || location.origin + location.pathname;
  const shareTitle = "Red Button, Blue Button";
  // Deliberately doesn't say what you picked, so friends answer without being nudged.
  const shareText = "Everyone on Earth must press red or blue. Which would you press? See how your county answered:";
  const shareMsg = document.getElementById("share-msg");
  const canShareSheet = !!navigator.share;

  // Draw the story image (1080×1920) ahead of time: share() must run right after the tap.
  let storyFile = null;
  let storyDataUrl = ""; // same picture, for showing on the page
  function wrap(ctx, text, maxW) {
    const words = text.split(" "), lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  // Like wrap, but evens out the lines so no word is left alone on the last one.
  function wrapBalanced(ctx, text, maxW) {
    const n = wrap(ctx, text, maxW).length;
    let w = maxW;
    while (n > 1 && w > 100 && wrap(ctx, text, w - 10).length === n) w -= 10;
    return wrap(ctx, text, w);
  }
  function makeStoryImage() {
    const W = 1080, H = 1920, css = getComputedStyle(document.documentElement);
    const red = css.getPropertyValue("--red").trim(), blue = css.getPropertyValue("--blue").trim();
    const font = getComputedStyle(document.body).fontFamily;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fafaf9"; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const text = (str, y, size, weight, color, maxW = 940, lh = 1.3) => {
      ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color;
      const lines = wrapBalanced(ctx, str, maxW);
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y + i * size * lh));
      return y + lines.length * size * lh;
    };
    // Content stays between ~250px and ~1650px: Instagram/TikTok cover the top and bottom with their own UI.
    // Read in two seconds: the question, then the rules on the buttons, then where to vote.
    text("Everyone on Earth has to press one.", 330, 44, 500, "#6b6b70");
    text("Which would", 470, 104, 800, "#1d1d1f", 1000, 1.1);
    text("you press?", 470 + 114, 104, 800, "#1d1d1f", 1000, 1.1);
    // Two stacked buttons, each with its rule, like on the site
    const bx = 90, bw = W - 180, bh = 290, r = 40;
    [[red, "RED", "You survive, no matter what.", 700], [blue, "BLUE", "Everyone lives, if at least half press blue.", 1040]].forEach(([col, name, rule, by]) => {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath(); ctx.roundRect(bx, by + 14, bw, bh, r); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, r); ctx.fill();
      ctx.fillStyle = "#fff";
      // The rule wraps to two lines if the phone's font runs wide.
      ctx.font = `500 42px ${font}`;
      const lines = wrapBalanced(ctx, rule, bw - 120), top = by + (lines.length > 1 ? 105 : 125);
      ctx.font = `800 88px ${font}`; ctx.fillText(name, W / 2, top);
      ctx.font = `500 42px ${font}`;
      lines.forEach((l, i) => ctx.fillText(l, W / 2, top + 82 + i * 52));
    });
    text("If more than half press red, everyone who pressed blue dies.", 1420, 42, 700, "#1d1d1f", 820, 1.3);
    // Where to vote
    const site = shareUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    ctx.font = `700 46px ${font}`;
    const pw = ctx.measureText(site).width + 100, py = 1540;
    ctx.fillStyle = "#1d1d1f";
    ctx.beginPath(); ctx.roundRect(W / 2 - pw / 2, py, pw, 96, 48); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(site, W / 2, py + 64);
    storyDataUrl = c.toDataURL("image/png");
    return new Promise((res) => c.toBlob((b) => res(b && new File([b], "red-button-blue-button.png", { type: "image/png" })), "image/png"));
  }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(makeStoryImage).then((f) => (storyFile = f));

  // Desktop fallback links
  const enc = encodeURIComponent;
  document.getElementById("share-x").href = `https://twitter.com/intent/tweet?text=${enc(shareText)}&url=${enc(shareUrl)}`;
  document.getElementById("share-fb").href = `https://www.facebook.com/sharer/sharer.php?u=${enc(shareUrl)}`;
  document.getElementById("share-wa").href = `https://wa.me/?text=${enc(shareText + " " + shareUrl)}`;
  document.getElementById("share-reddit").href = `https://www.reddit.com/submit?url=${enc(shareUrl)}&title=${enc("Would you press red or blue?")}`;
  document.getElementById("share-email").href = `mailto:?subject=${enc("Would you press red or blue?")}&body=${enc(shareText + "\n\n" + shareUrl)}`;

  const sharePanel = document.getElementById("share-panel");
  async function shareLink() {
    shareMsg.textContent = "";
    if (canShareSheet) {
      try { await navigator.share({ title: shareTitle, text: shareText, url: shareUrl }); }
      catch (e) { if (e.name !== "AbortError") sharePanel.hidden = false; }
      return true;
    }
    return false;
  }
  document.getElementById("share-btn").addEventListener("click", async () => {
    if (!(await shareLink())) sharePanel.hidden = !sharePanel.hidden;
  });
  // The small link in the verdict card: share sheet on phones, otherwise jump to the share card.
  document.getElementById("quick-share-btn").addEventListener("click", async () => {
    if (await shareLink()) return;
    sharePanel.hidden = false;
    document.querySelector(".share-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.getElementById("copy-link-btn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(shareUrl); shareMsg.textContent = "Link copied. Paste it anywhere."; }
    catch { shareMsg.textContent = shareUrl; }
  });

  // After an image share, the link goes on the story as a link sticker, so offer to copy it.
  // (Copying before the share can use up the tap, and then some phones refuse to open the share menu.)
  const siteLabel = shareUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  function offerStickerLink() {
    shareMsg.innerHTML = 'Last step: <button type="button" class="link" id="copy-sticker-btn">copy the link for your link sticker</button>';
    document.getElementById("copy-sticker-btn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(shareUrl); shareMsg.textContent = "Link copied. In your story, add a link sticker and paste it."; }
      catch { shareMsg.textContent = "In your story, add a link sticker with " + siteLabel + "."; }
    });
  }

  const isPhone = matchMedia("(pointer: coarse)").matches;
  const storyDialog = document.getElementById("story-dialog");
  function showStoryDialog() {
    document.getElementById("story-img").src = storyDataUrl;
    // Chrome and Firefox on iPhone can't share pictures, but Safari can.
    document.getElementById("story-tip").hidden = !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
    document.getElementById("story-copy-btn").textContent = "Copy link";
    storyDialog.showModal();
  }
  document.getElementById("story-copy-btn").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(shareUrl); e.target.textContent = "Link copied"; }
    catch { e.target.textContent = siteLabel; }
  });
  document.getElementById("story-close-btn").addEventListener("click", () => storyDialog.close());
  storyDialog.addEventListener("click", (e) => { if (e.target === storyDialog) storyDialog.close(); });

  document.getElementById("share-img-btn").addEventListener("click", async () => {
    shareMsg.textContent = "";
    if (!storyFile) { shareMsg.textContent = "The image is still being made. Try again in a second."; return; }
    let failed = false;
    if (navigator.canShare && navigator.canShare({ files: [storyFile] })) {
      try {
        await navigator.share({ files: [storyFile] });
        offerStickerLink();
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
        failed = true;
        console.warn("Image share failed:", e.name, e.message);
      }
    }
    // Phones that can't share pictures (Chrome on iPhone, in-app browsers): show the picture
    // so a long press saves it to Photos. A download would land in Files instead.
    if (isPhone) { showStoryDialog(failed); return; }
    // Desktops: download it.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(storyFile);
    a.download = storyFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    shareMsg.textContent = (failed ? "This browser couldn't open the share menu, so the image was saved instead. " : "Image saved. ")
      + "Post it to your Instagram or TikTok story, then add a link sticker with " + siteLabel + ".";
  });

  // ---------- Start ----------
  try {
    data = await loadResults();
  } catch {
    data = { updated: null, counties: {} };
    document.getElementById("updated").textContent = "Couldn't load results right now.";
  }
  render();
  if (myVote) showResults();

  // Refresh live totals every 2 minutes.
  if (!MOCK) {
    setInterval(async () => {
      try {
        const fresh = await loadResults();
        data = fresh;
        render();
      } catch {}
    }, 120000);
  }
})();
