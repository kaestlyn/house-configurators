"use strict";

/* ===================================================================
   shared.js — configurator plumbing common to every elevation tool in
   this repo (garage, porch, ...). Geometry/drawing code stays in each
   tool's own file since that's genuinely different; this file only
   holds the UI/share-link machinery that would otherwise be copy-
   pasted and drift between them.
   =================================================================== */

/* ---------- field groups: a small labeled divider inside a .grid panel,
   so a tab's fields read as clusters instead of one flat wall ---------- */
function insertFieldGroup(hostId, label) {
  const host = document.getElementById(hostId);
  const h = document.createElement("div");
  h.className = "field-group";
  h.textContent = label;
  host.appendChild(h);
}

/* ---------- base64url ---------- */
function toBase64Url(raw) {
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}

/* ---------- share-link codec ----------
   schema: { fieldKey: { code, type } }, type one of num|bool|str|numArr|colors.
   colorKeys: the color role keys, in order, for any "colors" field.

   Self-describing by design: values are packed as short "code=value"
   pairs (not by position), so schema drift can't break a link — a field
   an old link lacks just keeps the caller's current default, and a code
   this version doesn't recognize (from a newer link) is silently
   skipped. The only real rule for callers: once a code has shipped,
   never reassign it to a different field — mint a new code instead. */
function makeShareCodec(schema, colorKeys) {
  const codeToField = Object.fromEntries(
    Object.entries(schema).map(([key, { code, type }]) => [code, { key, type }]));

  function encode(cfg) {
    const raw = Object.entries(schema).map(([key, { code, type }]) => {
      const v = cfg[key];
      let val;
      if (type === "numArr") val = v.join(".");
      else if (type === "bool") val = v ? "1" : "0";
      else if (type === "colors") val = colorKeys.map(k => v[k].replace("#", "")).join(".");
      else val = String(v);
      return `${code}=${val}`;
    }).join("|");
    return toBase64Url(raw);
  }

  function decode(str) {
    try {
      const out = {};
      fromBase64Url(str).split("|").forEach(pair => {
        const eq = pair.indexOf("=");
        if (eq < 0) return;
        const field = codeToField[pair.slice(0, eq)];
        if (!field) return;
        const { key, type } = field, val = pair.slice(eq + 1);
        if (type === "num") out[key] = parseFloat(val);
        else if (type === "bool") out[key] = val === "1";
        else if (type === "str") out[key] = val;
        else if (type === "numArr") out[key] = val.split(".").filter(Boolean).map(Number);
        else if (type === "colors") {
          const vals = val.split(".");
          out.colors = {};
          colorKeys.forEach((k, j) => { out.colors[k] = "#" + vals[j]; });
        }
      });
      return out;
    } catch (e) { return null; }
  }

  return { encode, decode };
}

/* ---------- share-link controller ----------
   Wires a config object to the "c" query param. Doesn't touch the URL on
   a plain default-config visit — only once render() has run at least
   once (i.e. something changed, or a link was already shared) does the
   query string get written on subsequent renders. Call loadFromURL()
   before building controls, and afterRender() at the end of render(). */
function createShareLink(config, schema, colorKeys) {
  const codec = makeShareCodec(schema, colorKeys);
  let isFirstRender = true;

  function loadFromURL() {
    const c = new URLSearchParams(location.search).get("c");
    if (!c) return;
    const parsed = codec.decode(c);
    if (parsed) Object.assign(config, parsed);
  }
  function updateURL() {
    const url = new URL(location.href);
    url.searchParams.set("c", codec.encode(config));
    history.replaceState(null, "", url);
  }
  function afterRender() {
    if (!isFirstRender) updateURL();
    isFirstRender = false;
  }

  return { loadFromURL, updateURL, afterRender };
}

/* ---------- SVG saving ---------- */
function saveSVG(markup, name) {
  const blob = new Blob([markup], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- toast: small transient confirmation note ---------- */
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 250); }, 1600);
}

/* ---------- blob helpers: download / clipboard-copy ---------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyBlobToClipboard(blob) {
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/* ---------- SVG -> PNG rasterization ----------
   Renders to a fixed "2K" long-edge (2048px), aspect ratio preserved,
   regardless of the tool's current pxPerFt display scale. The SVG carries
   its own color variables inline (see each tool's drawXxx()), so it
   rasterizes correctly even loaded standalone via a blob URL. */
function svgViewBoxSize(svgMarkup) {
  const m = svgMarkup.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [1000, 1000];
}
function svgToPngBlob(svgMarkup, longEdge = 2048) {
  return new Promise((resolve, reject) => {
    const [w, h] = svgViewBoxSize(svgMarkup);
    const scale = longEdge / Math.max(w, h);
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("canvas.toBlob failed")), "image/png");
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/* ---------- flyout menu: a button that opens a small dropdown of actions ----------
   items: [{ label, onClick }, ...]. Only one global outside-click listener
   is ever attached (not one per flyout instance) since render() rebuilds
   these on every change — attaching per-instance would leak listeners. */
let _flyoutListenerAttached = false;
function buildFlyout(label, items) {
  if (!_flyoutListenerAttached) {
    _flyoutListenerAttached = true;
    document.addEventListener("click", () => {
      document.querySelectorAll(".flyout-menu.open").forEach(m => m.classList.remove("open"));
    });
  }
  const wrap = document.createElement("div");
  wrap.className = "flyout";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains("open");
    document.querySelectorAll(".flyout-menu.open").forEach(m => m.classList.remove("open"));
    if (!isOpen) menu.classList.add("open");
  });
  const menu = document.createElement("div");
  menu.className = "flyout-menu";
  items.forEach(({ label: itemLabel, onClick }) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = itemLabel;
    item.addEventListener("click", () => { menu.classList.remove("open"); onClick(); });
    menu.appendChild(item);
  });
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

/* ---------- elevation header actions: Export (SVG/PNG) + Share (link/image) ----------
   getSvg(): returns the current svg markup string.
   filenames: { svg, png }
   updateURL: the share controller's updateURL function */
function buildElevationActions({ getSvg, filenames, updateURL }) {
  const wrap = document.createElement("div");
  wrap.className = "actions";

  wrap.appendChild(buildFlyout("Export ▾", [
    { label: "Save SVG", onClick: () => saveSVG(getSvg(), filenames.svg) },
    { label: "Save PNG", onClick: async () => {
        try { downloadBlob(await svgToPngBlob(getSvg()), filenames.png); }
        catch (e) { showToast("Couldn't render PNG"); }
      } }
  ]));

  wrap.appendChild(buildFlyout("Share ▾", [
    { label: "Copy link", onClick: () => {
        updateURL();
        navigator.clipboard.writeText(location.href)
          .then(() => showToast("Link copied"))
          .catch(() => showToast("Couldn't copy link"));
      } },
    { label: "Copy image", onClick: async () => {
        try { await copyBlobToClipboard(await svgToPngBlob(getSvg())); showToast("Image copied to clipboard"); }
        catch (e) { showToast("Couldn't copy image — try Export > Save PNG"); }
      } }
  ]));

  return wrap;
}

/* ---------- custom right-click menu on the elevation image ----------
   Suppresses the native context menu on `container` and shows our own
   with Copy image / Save image / Copy link. */
function attachImageContextMenu(container, { getSvg, filename, updateURL }) {
  function closeMenu() {
    const el = document.querySelector(".ctxmenu");
    if (el) el.remove();
  }
  container.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.style.left = e.pageX + "px";
    menu.style.top = e.pageY + "px";
    const items = [
      ["Copy image", async () => {
        try { await copyBlobToClipboard(await svgToPngBlob(getSvg())); showToast("Image copied to clipboard"); }
        catch (err) { showToast("Couldn't copy image"); }
      }],
      ["Save image (PNG)", async () => {
        try { downloadBlob(await svgToPngBlob(getSvg()), filename); }
        catch (err) { showToast("Couldn't render PNG"); }
      }],
      ["Copy link", () => {
        updateURL();
        navigator.clipboard.writeText(location.href)
          .then(() => showToast("Link copied"))
          .catch(() => showToast("Couldn't copy link"));
      }]
    ];
    items.forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => { closeMenu(); fn(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  });
}

/* ---------- palette export modal: a swatch grid (hex + rgb) rendered to
   canvas, with copy-to-clipboard / save-PNG for that image ---------- */
function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function renderPaletteCanvas(colors, colorRoles, extra) {
  const cols = 3, pad = 18, sw = 100;
  const labelFont = "600 13px sans-serif", monoFont = "11px monospace", headerFont = "600 14px sans-serif";
  const headerText = extra && Object.keys(extra).length
    ? Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join("   ·   ") : null;

  // size columns to the widest text actually on them, not a fixed guess
  const measure = document.createElement("canvas").getContext("2d");
  let maxTextW = sw;
  colorRoles.forEach(([key, label]) => {
    const hex = colors[key], [r, g, b] = hexToRgb(hex);
    measure.font = labelFont;
    maxTextW = Math.max(maxTextW, measure.measureText(label).width);
    measure.font = monoFont;
    maxTextW = Math.max(maxTextW, measure.measureText(hex.toUpperCase()).width);
    maxTextW = Math.max(maxTextW, measure.measureText(`rgb(${r}, ${g}, ${b})`).width);
  });
  const cellW = Math.ceil(maxTextW) + 20;
  const rowH = sw + 56;
  const rows = Math.ceil(colorRoles.length / cols);

  measure.font = headerFont;
  const headerW = headerText ? Math.ceil(measure.measureText(headerText).width) : 0;
  const headerH = headerText ? 30 : 0;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(pad * 2 + cols * cellW, pad * 2 + headerW);
  canvas.height = pad * 2 + headerH + rows * rowH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#F4F2EE";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (headerText) {
    ctx.fillStyle = "#26201D";
    ctx.font = headerFont;
    ctx.fillText(headerText, pad, pad + 14);
  }
  colorRoles.forEach(([key, label], i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * cellW, y = pad + headerH + row * rowH;
    const hex = colors[key], [r, g, b] = hexToRgb(hex);
    ctx.fillStyle = hex;
    ctx.fillRect(x, y, sw, sw);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.strokeRect(x + 0.5, y + 0.5, sw - 1, sw - 1);
    ctx.fillStyle = "#26201D";
    ctx.font = labelFont;
    ctx.fillText(label, x, y + sw + 18);
    ctx.font = monoFont;
    ctx.fillText(hex.toUpperCase(), x, y + sw + 34);
    ctx.fillText(`rgb(${r}, ${g}, ${b})`, x, y + sw + 48);
  });
  return canvas;
}
function openPaletteModal({ colors, colorRoles, extra, filename }) {
  const canvas = renderPaletteCanvas(colors, colorRoles, extra || {});

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.className = "modal";

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "modal-canvas-wrap";
  canvasWrap.appendChild(canvas);

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy to clipboard";
  copyBtn.addEventListener("click", () => {
    canvas.toBlob(async (blob) => {
      try { await copyBlobToClipboard(blob); showToast("Copied palette image to clipboard"); }
      catch (e) { showToast("Couldn't copy — try Save PNG instead"); }
    }, "image/png");
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save PNG";
  saveBtn.addEventListener("click", () => {
    canvas.toBlob((blob) => downloadBlob(blob, filename), "image/png");
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => overlay.remove());

  actions.appendChild(copyBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(closeBtn);
  modal.appendChild(canvasWrap);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/* ---------- tabs ---------- */
function initTabs() {
  const buttons = document.querySelectorAll(".tabbar button");
  buttons.forEach(btn => btn.addEventListener("click", () => {
    buttons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tabpanel").forEach(p => p.classList.remove("active"));
    document.getElementById(btn.dataset.tab).classList.add("active");
  }));
}

/* ---------- appearance: color palette picker + swatches with copy-from ----------
   paletteHostId / swatchHostId: element ids to append the controls into.
   palettes: [{ name, c: { role: "#hex", ... } }, ...]
   colorRoles: [[roleKey, label], ...]
   config: the tool's CONFIG object (must have a .colors map matching colorRoles)
   onChange: called after any color/palette edit (typically render)
   extra(host): optional hook to append tool-specific controls (e.g. a
   siding-type select) into the same host as the palette dropdown.
   exportName: filename for the "Export palette" button's download.
   getExportExtra(): optional, returns extra fields (e.g. { siding }) to
   include in the exported JSON alongside colors. */
function buildAppearanceSection({ paletteHostId, swatchHostId, palettes, colorRoles, config, onChange, extra, exportName, getExportExtra }) {
  const paletteHost = document.getElementById(paletteHostId);

  const paletteLabel = document.createElement("label");
  paletteLabel.innerHTML = `<span>Color palette</span>`;
  const paletteSel = document.createElement("select");
  paletteSel.innerHTML = `<option value="">Custom</option>` +
    palettes.map((p, i) => `<option value="${i}">${p.name}</option>`).join("");
  paletteLabel.appendChild(paletteSel);
  paletteHost.appendChild(paletteLabel);

  const exportLabel = document.createElement("label");
  exportLabel.innerHTML = `<span>&nbsp;</span>`;
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.textContent = "Export palette";
  exportBtn.addEventListener("click", () => openPaletteModal({
    colors: config.colors,
    colorRoles,
    extra: getExportExtra ? getExportExtra() : {},
    filename: exportName || "palette.png"
  }));
  exportLabel.appendChild(exportBtn);
  paletteHost.appendChild(exportLabel);

  if (extra) extra(paletteHost);

  const swatchHost = document.getElementById(swatchHostId);
  const inputs = {};
  colorRoles.forEach(([key, label]) => {
    const l = document.createElement("label");
    l.className = "swatch";
    l.innerHTML = `<span>${label}</span>`;
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = config.colors[key];
    inputs[key] = inp;
    inp.addEventListener("input", () => {
      config.colors[key] = inp.value;
      syncPaletteSelect();
      onChange();
    });
    l.appendChild(inp);

    // "copy from" — pick another role to pull its current color into this one
    const copy = document.createElement("select");
    copy.className = "copyfrom";
    copy.innerHTML = `<option value="">Copy from…</option>` +
      colorRoles.filter(([k]) => k !== key)
        .map(([k, lbl]) => `<option value="${k}">${lbl}</option>`).join("");
    copy.addEventListener("change", () => {
      if (!copy.value) return;
      config.colors[key] = config.colors[copy.value];
      inp.value = config.colors[key];
      copy.value = "";
      syncPaletteSelect();
      onChange();
    });
    l.appendChild(copy);

    swatchHost.appendChild(l);
  });

  function refreshSwatches() {
    colorRoles.forEach(([key]) => { inputs[key].value = config.colors[key]; });
  }
  // matching a palette exactly re-selects it in the dropdown; editing any
  // swatch afterward falls back to "Custom"
  function syncPaletteSelect() {
    const idx = palettes.findIndex(p =>
      colorRoles.every(([key]) => p.c[key] === config.colors[key]));
    paletteSel.value = idx === -1 ? "" : String(idx);
  }
  paletteSel.addEventListener("change", () => {
    if (paletteSel.value === "") return;
    Object.assign(config.colors, palettes[+paletteSel.value].c);
    refreshSwatches();
    onChange();
  });
  syncPaletteSelect();
}
