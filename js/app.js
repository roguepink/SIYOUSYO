"use strict";

/* ===================== Storage keys & defaults ===================== */
const DOCS_KEY = "siyousyo.documents";
const SETTINGS_KEY = "siyousyo.settings";
const OLD_KEY = "formData";
const TUTORIAL_KEY = "siyousyo.tutorialSeen";

const DEFAULT_SETTINGS = {
  theme: "auto",
  company: { name: "", person: "", tel: "", logo: "" },
  presets: {
    clients: [],
    constructions: ["内装工事", "電気工事", "給排水工事", "外壁塗装工事", "解体工事", "リフォーム工事"],
    tasks: [
      { content: "内装解体", material: "" },
      { content: "クロス張替え", material: "ビニールクロス" },
      { content: "床材張替え", material: "フローリング材" },
      { content: "電気配線", material: "" },
      { content: "給排水設備", material: "" },
      { content: "塗装", material: "" },
      { content: "建具交換", material: "" },
      { content: "クリーニング", material: "" },
    ],
  },
  defaultCautions: "",
};

const FORM_FIELDS = ["clientName", "siteName", "siteAddress", "constructionName", "constructionDays", "surveyDate", "cautions", "contacts", "remarks"];

let documentsCache = [];
let currentDocId = null;
let currentStep = 1;
let editingTaskId = null;
let speechSupported = false;
let recognition = null;
let voiceTarget = null;
let lastTranscript = "";
let liveSettings = null;
let pendingPhotoId = null;
let taskSheetSnapshot = null;
let navDepth = 0;

/* ===================== Utilities ===================== */
function genId() {
  return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) + " " + d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
function $(id) { return document.getElementById(id); }
function vibrate(ms) {
  try { navigator.vibrate && navigator.vibrate(ms || 10); } catch (e) { /* unsupported */ }
}

/* ===================== Toast ===================== */
function showToast(message, opts = {}) {
  const wrap = $("toastWrap");
  const el = document.createElement("div");
  el.className = "toast" + (opts.type ? " " + opts.type : "");
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (opts.actionLabel) {
    const btn = document.createElement("button");
    btn.textContent = opts.actionLabel;
    btn.onclick = () => { opts.onAction && opts.onAction(); el.remove(); };
    el.appendChild(btn);
  }
  wrap.appendChild(el);
  setTimeout(() => el.remove(), opts.duration || 3500);
}

/* ===================== Ephemeral overlays (action sheet / confirm) ===================== */
function openEphemeral(innerHtml, { center = false } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay show" + (center ? " center" : "");
  overlay.innerHTML = `<div class="sheet">${innerHtml}</div>`;
  function close() { overlay.remove(); }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  return { overlay, close };
}

function showConfirmDialog(message, confirmLabel, onConfirm, danger = false) {
  const { overlay, close } = openEphemeral(
    `<div class="sheet-header"><h3>確認</h3></div>
     <p style="font-size:14.5px;line-height:1.7;margin-bottom:18px;white-space:pre-line;">${escapeHtml(message)}</p>
     <div style="display:flex;gap:10px;">
       <button class="btn btn-secondary" data-act="cancel">キャンセル</button>
       <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${escapeHtml(confirmLabel)}</button>
     </div>`,
    { center: true }
  );
  overlay.querySelector('[data-act="cancel"]').onclick = close;
  overlay.querySelector('[data-act="ok"]').onclick = () => { close(); onConfirm(); };
}

function showDocActions(doc) {
  const { overlay, close } = openEphemeral(
    `<div class="sheet-handle"></div>
     <div class="sheet-header"><h3>${escapeHtml(doc.siteName || doc.constructionName || "指図書")}</h3><button class="icon-btn" data-act="close">✕</button></div>
     <button class="btn btn-secondary mt-8" data-act="edit">✏️ 編集する</button>
     <button class="btn btn-secondary mt-8" data-act="dup">⧉ 複製して新規作成</button>
     <button class="btn btn-danger mt-8" data-act="del">🗑 削除する</button>`
  );
  overlay.querySelector('[data-act="close"]').onclick = close;
  overlay.querySelector('[data-act="edit"]').onclick = () => { close(); openDoc(doc.id); };
  overlay.querySelector('[data-act="dup"]').onclick = () => { close(); duplicateDoc(doc.id); };
  overlay.querySelector('[data-act="del"]').onclick = () => { close(); confirmDeleteDoc(doc.id); };
}

/* ===================== Back-button navigation (overlays only) =====================
   #overlayTask / #overlaySettings / #overlayVoice each push one history entry when
   opened, so the hardware/gesture back button closes them instead of leaving the app. */
function pushNav() { navDepth++; history.pushState({ appNav: navDepth }, ""); }
function goBackOneLevel() { if (navDepth > 0) history.back(); }
window.addEventListener("popstate", () => {
  if (navDepth > 0) navDepth--;
  handleBackNavigation();
});
function handleBackNavigation() {
  if ($("overlayVoice").classList.contains("show")) { cancelVoiceUI(); return; }
  if ($("overlayTask").classList.contains("show")) { requestCloseTaskSheet(true); return; }
  if ($("overlaySettings").classList.contains("show")) { closeSettingsSheet(); return; }
}

/* ===================== IndexedDB photo store ===================== */
const PHOTO_DB_NAME = "siyousyoPhotos";
const PHOTO_STORE = "photos";
function openPhotoDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no-indexeddb"));
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PHOTO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function savePhotoBlob(id, blob) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, "readwrite");
    tx.objectStore(PHOTO_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getPhotoBlob(id) {
  if (!id) return null;
  try {
    const db = await openPhotoDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, "readonly");
      const req = tx.objectStore(PHOTO_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}
async function deletePhotoBlob(id) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, "readwrite");
    tx.objectStore(PHOTO_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getAllPhotoIds() {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, "readonly");
    const req = tx.objectStore(PHOTO_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function cleanupOrphanPhotos() {
  try {
    const referenced = new Set();
    documentsCache.forEach((d) => d.tasks.forEach((t) => { if (t.photoId) referenced.add(t.photoId); }));
    const allIds = await getAllPhotoIds();
    const toDelete = allIds.filter((id) => !referenced.has(id));
    await Promise.all(toDelete.map((id) => deletePhotoBlob(id)));
  } catch (e) { /* IndexedDB unavailable — skip cleanup */ }
}

/* ===================== Image helpers ===================== */
function resizeImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else { width = Math.round((width * maxDim) / height); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => { URL.revokeObjectURL(url); blob ? resolve(blob) : reject(new Error("toBlob failed")); }, "image/jpeg", quality);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ===================== JSONP (for zipcloud, which has no CORS headers) ===================== */
let jsonpCounter = 0;
function jsonpRequest(url) {
  return new Promise((resolve, reject) => {
    const cbName = "siyousyoJsonp" + jsonpCounter++;
    const script = document.createElement("script");
    const cleanup = () => { delete window[cbName]; script.remove(); };
    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cbName;
    script.onerror = () => { cleanup(); reject(new Error("jsonp failed")); };
    document.body.appendChild(script);
    setTimeout(() => { if (window[cbName]) { cleanup(); reject(new Error("timeout")); } }, 8000);
  });
}

/* ===================== Documents store ===================== */
function loadDocumentsFromStorage() {
  try {
    documentsCache = JSON.parse(localStorage.getItem(DOCS_KEY)) || [];
  } catch (e) {
    documentsCache = [];
  }
}
function saveDocuments() {
  localStorage.setItem(DOCS_KEY, JSON.stringify(documentsCache));
}
const debouncedSaveDocuments = debounce(saveDocuments, 500);
function getCurrentDoc() {
  return documentsCache.find((d) => d.id === currentDocId);
}
function newDocTemplate() {
  const now = Date.now();
  return {
    id: genId(), createdAt: now, updatedAt: now,
    clientName: "", siteName: "", siteAddress: "", siteLatLng: null, constructionName: "",
    constructionDays: "", surveyDate: "",
    cautions: getSettings().defaultCautions || "", contacts: "", remarks: "",
    tasks: [],
  };
}
function migrateOldData() {
  if (localStorage.getItem(DOCS_KEY)) return;
  const old = localStorage.getItem(OLD_KEY);
  if (!old) return;
  try {
    const d = JSON.parse(old);
    const doc = newDocTemplate();
    ["clientName", "siteName", "siteAddress", "constructionName", "constructionDays", "surveyDate", "cautions", "contacts", "remarks"].forEach((k) => { doc[k] = d[k] || ""; });
    doc.tasks = (d.tasks || []).map((t) => ({ id: genId(), content: t.content || "", location: t.location || "", quantity: t.quantity || "", material: t.material || "", notes: t.notes || "", photoId: null }));
    documentsCache = [doc];
    saveDocuments();
    localStorage.removeItem(OLD_KEY);
  } catch (e) { /* ignore corrupt legacy data */ }
}

function duplicateDoc(id) {
  const src = documentsCache.find((d) => d.id === id);
  if (!src) return;
  const now = Date.now();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = genId();
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.siteName = src.siteName ? src.siteName + "（コピー）" : "";
  copy.tasks = copy.tasks.map((t) => ({ ...t, id: genId() }));
  documentsCache.unshift(copy);
  saveDocuments();
  renderDocList();
  showToast("⧉ 複製しました");
}

function confirmDeleteDoc(id) {
  showConfirmDialog("この指図書を削除しますか？", "削除する", () => {
    const idx = documentsCache.findIndex((d) => d.id === id);
    if (idx === -1) return;
    const removed = documentsCache.splice(idx, 1)[0];
    saveDocuments();
    renderDocList();
    showToast("🗑 削除しました", {
      actionLabel: "元に戻す",
      onAction: () => { documentsCache.splice(idx, 0, removed); saveDocuments(); renderDocList(); },
    });
  }, true);
}

/* ===================== Settings store ===================== */
function cloneDefaultSettings() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
function mergeSettings(s) {
  const d = cloneDefaultSettings();
  s = s || {};
  const rawTasks = Array.isArray(s.presets && s.presets.tasks) ? s.presets.tasks : d.presets.tasks;
  const tasks = rawTasks.map((t) => (typeof t === "string" ? { content: t, material: "" } : { content: t.content || "", material: t.material || "" }));
  return {
    theme: s.theme || d.theme,
    company: { ...d.company, ...(s.company || {}) },
    presets: {
      clients: Array.isArray(s.presets && s.presets.clients) ? s.presets.clients : d.presets.clients,
      constructions: Array.isArray(s.presets && s.presets.constructions) ? s.presets.constructions : d.presets.constructions,
      tasks,
    },
    defaultCautions: s.defaultCautions || d.defaultCautions,
  };
}
function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return cloneDefaultSettings();
    return mergeSettings(JSON.parse(raw));
  } catch (e) {
    return cloneDefaultSettings();
  }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
const debouncedSaveSettings = debounce(() => { if (liveSettings) saveSettings(liveSettings); }, 500);

function applyTheme(theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  const isDark = theme === "dark" || (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = $("themeColorMeta");
  if (meta) meta.setAttribute("content", isDark ? "#10151f" : "#1f4788");
}
function highlightThemeChips(theme) {
  document.querySelectorAll("[data-theme-choice]").forEach((c) => c.classList.toggle("selected", c.dataset.themeChoice === theme));
}

/* ===================== Screen / navigation ===================== */
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $("screen-" + name).classList.add("active");
  $("btnBack").classList.toggle("hidden", name === "home");
  $("wizardBar").classList.toggle("hidden", name !== "wizard");
  if (name !== "wizard") $("fabAddTask").classList.add("hidden");
  window.scrollTo({ top: 0 });
  if (name === "home") {
    $("topbarTitle").textContent = "工事手配指図書メーカー";
    renderDocList();
  }
}

function goToHome() {
  currentDocId = null;
  showScreen("home");
}

function openDoc(id) {
  currentDocId = id;
  const doc = getCurrentDoc();
  if (!doc) return goToHome();
  $("topbarTitle").textContent = doc.siteName || "新規指図書";
  loadDocIntoForm(doc);
  showScreen("wizard");
  goToStep(1);
}

function loadDocIntoForm(doc) {
  FORM_FIELDS.forEach((id) => { $(id).value = doc[id] || ""; });
  updateMapPreview();
  renderClientConstructionChips();
  renderTasks();
}

function goToStep(n) {
  currentStep = n;
  document.querySelectorAll(".wizard-step").forEach((s) => (s.style.display = "none"));
  $("step-" + n).style.display = "block";
  document.querySelectorAll(".step-dot").forEach((d) => {
    const s = parseInt(d.dataset.step, 10);
    d.classList.toggle("active", s === n);
    d.classList.toggle("done", s < n);
  });
  $("fabAddTask").classList.toggle("hidden", n !== 2);
  $("btnNextStep").classList.toggle("hidden", n === 3);
  $("btnMakePdf").classList.toggle("hidden", n !== 3);
  $("btnPrevStep").textContent = n === 1 ? "ホームへ" : "戻る";
  if (n === 2) renderTasks();
  if (n === 3) renderReview();
  window.scrollTo({ top: 0 });
}

/* ===================== Field autosave ===================== */
function handleFieldChange(id) {
  const doc = getCurrentDoc();
  if (!doc) return;
  doc[id] = $(id).value;
  doc.updatedAt = Date.now();
  if (id === "siteAddress") doc.siteLatLng = null;
  debouncedSaveDocuments();
  if (id === "siteAddress") debouncedMapUpdate();
  if (id === "clientName" || id === "constructionName") renderClientConstructionChips();
}
const debouncedMapUpdate = debounce(updateMapPreview, 700);

/* ===================== Home / document list ===================== */
function renderDocList() {
  const totalDocs = documentsCache.length;
  const filter = (($("docSearch") && $("docSearch").value) || "").trim().toLowerCase();
  let docs = documentsCache.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  if (filter) {
    docs = docs.filter((d) => [d.siteName, d.clientName, d.constructionName].some((v) => (v || "").toLowerCase().includes(filter)));
  }
  if (totalDocs > 0 && filter && docs.length === 0) {
    $("docList").innerHTML = `<p class="muted text-center mt-16">🔍 該当する指図書が見つかりませんでした</p>`;
  } else {
    $("docList").innerHTML = docs.map(cardHtml).join("");
  }
  $("docListEmpty").classList.toggle("hidden", totalDocs > 0);
  $("docSearchRow").classList.toggle("hidden", totalDocs === 0);
}
function cardHtml(doc) {
  const title = doc.siteName || doc.constructionName || "名称未設定の指図書";
  const meta = [];
  if (doc.constructionName) meta.push(escapeHtml(doc.constructionName));
  meta.push(formatDate(doc.updatedAt));
  meta.push(`作業${doc.tasks.length}件`);
  return `<div class="doc-card" data-doc-id="${escapeAttr(doc.id)}">
    <div class="doc-icon">📋</div>
    <div class="doc-info">
      <div class="doc-title">${escapeHtml(title)}</div>
      <div class="doc-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
    </div>
    <button class="doc-menu-btn" data-doc-menu="${escapeAttr(doc.id)}" aria-label="メニュー">⋮</button>
  </div>`;
}

/* ===================== Client / construction chips (step1) ===================== */
function renderClientConstructionChips() {
  const s = getSettings();
  const doc = getCurrentDoc();
  const clientChips = $("chipsClient");
  clientChips.innerHTML = s.presets.clients.length
    ? s.presets.clients.map((v) => `<div class="chip ${doc && doc.clientName === v ? "selected" : ""}" data-chip-client="${escapeAttr(v)}">${escapeHtml(v)}</div>`).join("")
    : `<span class="muted">⚙️ 設定画面からよく使う会社名を登録できます</span>`;
  const constrChips = $("chipsConstruction");
  constrChips.innerHTML = s.presets.constructions.map((v) => `<div class="chip ${doc && doc.constructionName === v ? "selected" : ""}" data-chip-constr="${escapeAttr(v)}">${escapeHtml(v)}</div>`).join("");
}

/* ===================== Map / address ===================== */
function getMapQueryForDoc(doc) {
  if (doc.siteLatLng) return doc.siteLatLng.lat + "," + doc.siteLatLng.lng;
  return (doc.siteAddress || "").trim();
}
function addressBlockHtml(query, displayText) {
  if (!query) return "";
  const mapsUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
  const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=" + encodeURIComponent(mapsUrl);
  const label = displayText || query;
  return `<div class="address-card">
    <div class="qr-wrap"><img src="${qrUrl}" alt="QRコード" loading="lazy" onerror="this.parentElement.style.display='none'"></div>
    <div class="addr-text">📍 ${escapeHtml(label)}<br><a href="${mapsUrl}" target="_blank" rel="noopener">Googleマップで開く ↗</a></div>
  </div>`;
}
function updateMapPreview() {
  const doc = getCurrentDoc();
  const container = $("mapContainer");
  if (!doc) { container.innerHTML = ""; return; }
  const query = getMapQueryForDoc(doc);
  container.innerHTML = query ? addressBlockHtml(query, doc.siteLatLng ? "📍 現在地のピンを設定しました" : doc.siteAddress) : "";
}
function useGpsForAddress() {
  if (!navigator.geolocation) { showToast("⚠️ この端末は位置情報に対応していません", { type: "error" }); return; }
  const doc = getCurrentDoc();
  if (!doc) return;
  showToast("📍 現在地を取得中...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      doc.siteLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      doc.updatedAt = Date.now();
      saveDocuments();
      updateMapPreview();
      vibrate(10);
      showToast("✅ 現在地を地図ピンに設定しました");
    },
    (err) => { showToast("❌ 位置情報を取得できませんでした：" + (err.message || ""), { type: "error" }); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}
function openZipLookup() {
  const { overlay } = openEphemeral(
    `<div class="sheet-header"><h3>郵便番号で住所を検索</h3></div>
     <div class="field"><input type="text" id="zipInput" inputmode="numeric" placeholder="例：1500001（ハイフンなし）"></div>
     <button class="btn btn-primary" data-act="search">住所を検索</button>
     <p class="small-note mt-8" id="zipResultNote"></p>`,
    { center: true }
  );
  overlay.querySelector('[data-act="search"]').onclick = async () => {
    const zip = overlay.querySelector("#zipInput").value.replace(/[^0-9]/g, "");
    const note = overlay.querySelector("#zipResultNote");
    if (zip.length !== 7) { note.textContent = "7桁の数字で入力してください"; return; }
    note.textContent = "検索中...";
    try {
      const data = await jsonpRequest("https://zipcloud.ibsnet.co.jp/api/search?zipcode=" + zip);
      const r = data.results && data.results[0];
      if (!r) { note.textContent = "該当する住所が見つかりませんでした"; return; }
      const addr = r.address1 + r.address2 + r.address3;
      $("siteAddress").value = addr;
      handleFieldChange("siteAddress");
      overlay.remove();
      showToast("✅ 住所を入力しました。番地・建物名は音声などで追加してください");
    } catch (e) {
      note.textContent = "通信エラーが発生しました";
    }
  };
}

/* ===================== Tasks ===================== */
function renderTasks() {
  const doc = getCurrentDoc();
  if (!doc) return;
  $("tasksContainer").innerHTML = doc.tasks.map((t, i) => taskCardHtml(t, i, doc.tasks.length)).join("");
  $("tasksEmpty").classList.toggle("hidden", doc.tasks.length > 0);
  loadTaskThumbnails();
}
function loadTaskThumbnails() {
  document.querySelectorAll(".task-thumb[data-photo-id]").forEach((img) => {
    getPhotoBlob(img.dataset.photoId).then((blob) => { if (blob) img.src = URL.createObjectURL(blob); });
  });
}
function taskCardHtml(t, i, total) {
  const detail = [];
  if (t.location) detail.push(`<span>📍 ${escapeHtml(t.location)}</span>`);
  if (t.quantity) detail.push(`<span>📦 ${escapeHtml(t.quantity)}</span>`);
  if (t.material) detail.push(`<span>🧱 ${escapeHtml(t.material)}</span>`);
  const photoThumb = t.photoId ? `<img class="task-thumb" data-photo-id="${escapeAttr(t.photoId)}" alt="現場写真">` : "";
  return `<div class="task-card" data-task-id="${escapeAttr(t.id)}">
    <div class="task-num">${i + 1}</div>
    ${photoThumb}
    <div class="task-body" data-open-task="${escapeAttr(t.id)}">
      <div class="task-content">${escapeHtml(t.content) || "(内容未入力)"}</div>
      <div class="task-detail">${detail.join("")}</div>
    </div>
    <div class="task-actions">
      <button data-move-up="${escapeAttr(t.id)}" ${i === 0 ? "disabled" : ""} aria-label="上に移動">↑</button>
      <button data-dup-task="${escapeAttr(t.id)}" aria-label="複製">⧉</button>
      <button data-move-down="${escapeAttr(t.id)}" ${i === total - 1 ? "disabled" : ""} aria-label="下に移動">↓</button>
      <button data-del-task="${escapeAttr(t.id)}" aria-label="削除">🗑</button>
    </div>
  </div>`;
}
function moveTask(id, dir) {
  const doc = getCurrentDoc();
  const idx = doc.tasks.findIndex((t) => t.id === id);
  const swap = idx + dir;
  if (idx === -1 || swap < 0 || swap >= doc.tasks.length) return;
  [doc.tasks[idx], doc.tasks[swap]] = [doc.tasks[swap], doc.tasks[idx]];
  saveDocuments();
  renderTasks();
}
function duplicateTask(id) {
  const doc = getCurrentDoc();
  const idx = doc.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const copy = { ...doc.tasks[idx], id: genId() };
  doc.tasks.splice(idx + 1, 0, copy);
  saveDocuments();
  renderTasks();
  showToast("⧉ 複製しました");
}
function deleteTask(id) {
  const doc = getCurrentDoc();
  const idx = doc.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const removed = doc.tasks.splice(idx, 1)[0];
  saveDocuments();
  renderTasks();
  showToast("🗑 作業を削除しました", {
    actionLabel: "元に戻す",
    onAction: () => { doc.tasks.splice(idx, 0, removed); saveDocuments(); renderTasks(); },
  });
}

function renderTaskTemplateChips() {
  const tasks = getSettings().presets.tasks;
  $("chipsTaskTemplate").innerHTML = tasks.map((v) => `<div class="chip" data-tpl-content="${escapeAttr(v.content)}" data-tpl-material="${escapeAttr(v.material || "")}">${escapeHtml(v.content)}</div>`).join("")
    || `<span class="muted">⚙️ 設定画面からよく使う作業を登録できます</span>`;
}

function currentTaskSheetSnapshot() {
  return JSON.stringify([$("taskContent").value, $("taskLocation").value, $("taskQuantity").value, $("taskMaterial").value, $("taskNotes").value, pendingPhotoId]);
}
function isTaskSheetDirty() {
  return taskSheetSnapshot !== null && currentTaskSheetSnapshot() !== taskSheetSnapshot;
}
function renderTaskPhotoUI() {
  const row = $("taskPhotoRow");
  if (pendingPhotoId) {
    row.innerHTML = `<div class="photo-thumb-wrap"><img id="taskPhotoThumb" class="photo-thumb" alt="現場写真"><button class="photo-remove-btn" id="btnRemoveTaskPhoto" aria-label="写真を削除">✕</button></div>`;
    getPhotoBlob(pendingPhotoId).then((blob) => { if (blob) $("taskPhotoThumb").src = URL.createObjectURL(blob); });
    $("btnRemoveTaskPhoto").onclick = () => { pendingPhotoId = null; renderTaskPhotoUI(); };
  } else {
    row.innerHTML = `<button class="btn btn-secondary btn-sm" id="btnAddTaskPhoto">📷 写真を追加</button>`;
    $("btnAddTaskPhoto").onclick = () => $("taskPhotoInput").click();
  }
}

function openTaskSheet(taskId) {
  editingTaskId = taskId || null;
  const doc = getCurrentDoc();
  renderTaskTemplateChips();
  if (editingTaskId) {
    const t = doc.tasks.find((t) => t.id === editingTaskId);
    $("taskSheetTitle").textContent = "作業を編集";
    $("taskContent").value = t.content;
    $("taskLocation").value = t.location;
    $("taskQuantity").value = t.quantity;
    $("taskMaterial").value = t.material;
    $("taskNotes").value = t.notes;
    pendingPhotoId = t.photoId || null;
  } else {
    $("taskSheetTitle").textContent = "作業を追加";
    ["taskContent", "taskLocation", "taskQuantity", "taskMaterial", "taskNotes"].forEach((id) => { $(id).value = ""; });
    pendingPhotoId = null;
  }
  renderTaskPhotoUI();
  $("overlayTask").classList.add("show");
  taskSheetSnapshot = currentTaskSheetSnapshot();
  pushNav();
}
function actualCloseTaskSheet() {
  $("overlayTask").classList.remove("show");
  editingTaskId = null;
  pendingPhotoId = null;
  taskSheetSnapshot = null;
}
function requestCloseTaskSheet(fromHistory) {
  if (isTaskSheetDirty()) {
    showConfirmDialog("保存していない内容があります。閉じますか？", "閉じる", () => {
      actualCloseTaskSheet();
      if (!fromHistory) goBackOneLevel();
    }, true);
  } else {
    actualCloseTaskSheet();
    if (!fromHistory) goBackOneLevel();
  }
}
function saveTaskFromSheet() {
  const content = $("taskContent").value.trim();
  if (!content) {
    showToast("⚠️ 作業内容を入力してください", { type: "error" });
    $("taskContent").focus();
    return;
  }
  const doc = getCurrentDoc();
  const data = {
    content,
    location: $("taskLocation").value.trim(),
    quantity: $("taskQuantity").value.trim(),
    material: $("taskMaterial").value.trim(),
    notes: $("taskNotes").value.trim(),
    photoId: pendingPhotoId || null,
  };
  if (editingTaskId) {
    const t = doc.tasks.find((t) => t.id === editingTaskId);
    if (t) Object.assign(t, data);
  } else {
    doc.tasks.push({ id: genId(), ...data });
  }
  doc.updatedAt = Date.now();
  saveDocuments();
  renderTasks();
  vibrate(10);
  actualCloseTaskSheet();
  goBackOneLevel();
  showToast("✅ 作業を保存しました");
}

/* ===================== Review (step 3) ===================== */
function renderReview() {
  const doc = getCurrentDoc();
  if (!doc) return;
  let html = "";
  const query = getMapQueryForDoc(doc);
  if (query) html += addressBlockHtml(query, doc.siteLatLng ? "📍 現在地のピン" : doc.siteAddress);
  html += `<div class="review-card"><h4>基本情報</h4>
    <div class="review-row"><span class="k">元請会社名</span><span class="v">${escapeHtml(doc.clientName) || "ー"}</span></div>
    <div class="review-row"><span class="k">現場名</span><span class="v">${escapeHtml(doc.siteName) || "ー"}</span></div>
    <div class="review-row"><span class="k">工事名称</span><span class="v">${escapeHtml(doc.constructionName) || "ー"}</span></div>
    <div class="review-row"><span class="k">工事日数</span><span class="v">${escapeHtml(doc.constructionDays) || "ー"}</span></div>
    <div class="review-row"><span class="k">現場調査日</span><span class="v">${doc.surveyDate || "ー"}</span></div>
  </div>`;
  html += `<div class="review-card"><h4>作業内容（${doc.tasks.length}件）</h4>${
    doc.tasks.length
      ? doc.tasks.map((t, i) => `<div class="review-row"><span class="k">作業${i + 1}</span><span class="v">${escapeHtml(t.content) || "(内容未入力)"}${t.photoId ? " 📷" : ""}</span></div>`).join("")
      : '<p class="muted">まだ登録されていません</p>'
  }</div>`;
  $("reviewArea").innerHTML = html;
}

/* ===================== PDF ===================== */
function waitForImages(container, timeoutMs) {
  const imgs = Array.from(container.querySelectorAll("img"));
  if (!imgs.length) return Promise.resolve();
  return Promise.all(
    imgs.map((img) => new Promise((resolve) => {
      if (img.complete) return resolve();
      const done = () => { img.removeEventListener("load", done); img.removeEventListener("error", done); resolve(); };
      img.addEventListener("load", done);
      img.addEventListener("error", done);
      setTimeout(done, timeoutMs);
    }))
  );
}
async function fillPdfPhotos(container) {
  const imgs = Array.from(container.querySelectorAll("img[data-pdf-photo]"));
  await Promise.all(imgs.map(async (img) => {
    try {
      const blob = await getPhotoBlob(img.dataset.pdfPhoto);
      if (blob) img.src = await blobToDataUrl(blob);
      else { const wrap = img.closest(".pdf-photo-wrap"); if (wrap) wrap.remove(); }
    } catch (e) { const wrap = img.closest(".pdf-photo-wrap"); if (wrap) wrap.remove(); }
  }));
}
function buildPdfHtml(doc, settings) {
  const today = new Date().toLocaleDateString("ja-JP");
  const c = settings.company;
  const logoLine = c.logo ? `<img src="${c.logo}" style="height:44px;display:block;margin:0 auto 10px;">` : "";
  const companyLine = c.name
    ? `<div style="margin-top:26px;padding-top:14px;border-top:1px solid #ccc;font-size:12px;color:#444;">作成：${escapeHtml(c.name)}${c.person ? " 担当 " + escapeHtml(c.person) : ""}${c.tel ? " TEL " + escapeHtml(c.tel) : ""}</div>`
    : "";
  const query = getMapQueryForDoc(doc);
  return `<div style="font-size:14px;line-height:1.8;color:#111;max-width:900px;margin:0 auto;padding:24px;background:#fff;">
    <div style="text-align:center;margin-bottom:24px;border-bottom:2px solid #333;padding-bottom:16px;">
      ${logoLine}
      <h1 style="font-size:26px;margin-bottom:8px;">工事手配指図書</h1>
      <p style="font-size:12px;color:#666;">作成日：${today}</p>
    </div>
    <div style="margin-bottom:18px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 20px;margin-bottom:14px;">
        <div><strong>元請会社名：</strong>${escapeHtml(doc.clientName) || "ー"}</div>
        <div><strong>工事名称：</strong>${escapeHtml(doc.constructionName) || "ー"}</div>
        <div><strong>現場名：</strong>${escapeHtml(doc.siteName) || "ー"}</div>
        <div><strong>工事日数：</strong>${escapeHtml(doc.constructionDays) || "ー"}</div>
        <div><strong>現場調査日：</strong>${doc.surveyDate || "ー"}</div>
      </div>
      ${doc.siteAddress ? `<div style="margin-bottom:10px;"><strong>現場住所：</strong>${escapeHtml(doc.siteAddress)}</div>` : ""}
      ${query ? addressBlockHtml(query, doc.siteLatLng ? "現在地のピン" : doc.siteAddress) : ""}
      ${doc.cautions ? `<div style="margin-top:14px;padding:12px;background:#fff3cd;border-left:4px solid #ffc107;">⚠️ <strong>注意事項：</strong>${escapeHtml(doc.cautions)}</div>` : ""}
    </div>
    <div style="margin-top:32px;">
      <h2 style="font-size:17px;margin-bottom:16px;border-bottom:2px solid #333;padding-bottom:8px;">作業内容</h2>
      ${
        doc.tasks.length
          ? doc.tasks.map((t, i) => `<div style="margin-bottom:16px;padding:12px 14px;border:1px solid #ddd;border-radius:6px;">
              <div style="font-weight:bold;margin-bottom:8px;font-size:15px;">作業 ${i + 1}：${escapeHtml(t.content)}</div>
              <table style="width:100%;font-size:12.5px;">
                ${t.location ? `<tr><td style="font-weight:bold;padding:5px 0;width:26%;">施工箇所：</td><td>${escapeHtml(t.location)}</td></tr>` : ""}
                ${t.quantity ? `<tr><td style="font-weight:bold;padding:5px 0;">数量：</td><td>${escapeHtml(t.quantity)}</td></tr>` : ""}
                ${t.material ? `<tr><td style="font-weight:bold;padding:5px 0;">材料：</td><td>${escapeHtml(t.material)}</td></tr>` : ""}
                ${t.notes ? `<tr><td style="font-weight:bold;padding:5px 0;">備考：</td><td>${escapeHtml(t.notes)}</td></tr>` : ""}
              </table>
              ${t.photoId ? `<div class="pdf-photo-wrap" style="margin-top:8px;"><img data-pdf-photo="${escapeAttr(t.photoId)}" style="max-width:260px;max-height:200px;border-radius:6px;border:1px solid #ccc;display:block;"></div>` : ""}
            </div>`).join("")
          : '<p style="color:#999;">作業内容が登録されていません</p>'
      }
    </div>
    ${(doc.contacts || doc.remarks) ? `<div style="margin-top:26px;">
      <h2 style="font-size:17px;margin-bottom:16px;border-bottom:2px solid #333;padding-bottom:8px;">その他</h2>
      ${doc.contacts ? `<div style="margin-bottom:12px;"><strong>連絡事項：</strong><br>${escapeHtml(doc.contacts)}</div>` : ""}
      ${doc.remarks ? `<div><strong>備考欄：</strong><br>${escapeHtml(doc.remarks)}</div>` : ""}
    </div>` : ""}
    ${companyLine}
  </div>`;
}
function showPdfAreaOffscreen() {
  const el = $("pdfPrintArea");
  el.style.display = "block";
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.width = "800px";
  el.style.zIndex = "-1";
}
function hidePdfArea() {
  const el = $("pdfPrintArea");
  el.style.display = "none";
  el.style.position = "";
  el.style.left = "";
  el.style.top = "";
  el.style.width = "";
  el.style.zIndex = "";
}
async function makePdf() {
  const doc = getCurrentDoc();
  if (!doc) return;
  const warnings = [];
  if (!doc.tasks.length) warnings.push("作業内容が1件も登録されていません");
  if (!doc.siteName && !doc.clientName) warnings.push("現場名・会社名が未入力です");
  if (warnings.length) {
    showConfirmDialog(warnings.join("\n") + "\n\nこのままPDFを作成しますか？", "作成する", () => proceedMakePdf(doc));
    return;
  }
  proceedMakePdf(doc);
}
async function proceedMakePdf(doc) {
  vibrate(15);
  const settings = getSettings();
  $("pdfDoc").innerHTML = buildPdfHtml(doc, settings);
  await fillPdfPhotos($("pdfDoc"));
  await waitForImages($("pdfDoc"), 2500);
  showToast("📄 PDFを作成しています...");
  await tryGenerateAndSharePdf(doc);
}
async function tryGenerateAndSharePdf(doc) {
  try {
    if (typeof html2canvas === "undefined" || typeof window.jspdf === "undefined") throw new Error("lib-not-loaded");
    showPdfAreaOffscreen();
    const pdfDocEl = $("pdfDoc");
    const canvas = await html2canvas(pdfDocEl, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 0;
    const imgData = canvas.toDataURL("image/jpeg", 0.92);
    pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    const filename = `指図書_${(doc.siteName || "無題").replace(/[\\/:*?"<>|]/g, "")}.pdf`;
    const blob = pdf.output("blob");
    const file = new File([blob], filename, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename, text: "工事手配指図書" });
      showToast("✅ 共有しました");
    } else {
      pdf.save(filename);
      showToast("✅ PDFを保存しました");
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
    showToast("🖨️ 印刷画面から保存してください");
    setTimeout(() => window.print(), 150);
  } finally {
    hidePdfArea();
  }
}

/* ===================== Voice input ===================== */
const VOICE_FIELD_LABELS = { clientName: "元請会社名", siteName: "現場名", siteAddress: "現場住所", constructionName: "工事名称", cautions: "注意事項", contacts: "連絡事項", remarks: "備考欄" };
const VOICE_TASKFIELD_LABELS = { content: "作業内容", location: "施工箇所", quantity: "数量", material: "材料", notes: "備考" };

function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    speechSupported = false;
    document.querySelectorAll(".mic-btn").forEach((b) => b.classList.add("disabled"));
    return;
  }
  speechSupported = true;
  recognition = new SR();
  recognition.lang = "ja-JP";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (e) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    lastTranscript = text;
    $("voiceTranscript").textContent = text || "聞き取り中...";
  };
  recognition.onerror = (e) => {
    voiceTarget = null;
    cancelVoiceUI();
    showToast("❌ 音声入力エラー：" + translateSpeechError(e.error), { type: "error" });
  };
  recognition.onend = () => {
    if (voiceTarget && lastTranscript.trim()) applyVoiceResult(voiceTarget, lastTranscript.trim());
    voiceTarget = null;
    goBackOneLevel();
  };
}
function translateSpeechError(err) {
  const map = { "no-speech": "音声が検出されませんでした", "audio-capture": "マイクが見つかりません", "not-allowed": "マイクの使用が許可されていません", network: "ネットワークエラーが発生しました" };
  return map[err] || err;
}
function voiceTargetLabel(target) {
  if (target.type === "field") return (VOICE_FIELD_LABELS[target.id] || "") + "を話してください";
  if (target.type === "wholeTask") return "作業内容を話してください";
  return (VOICE_TASKFIELD_LABELS[target.id] || "") + "を話してください";
}
function startVoice(target) {
  if (!speechSupported) {
    showToast("⚠️ お使いのブラウザは音声入力に対応していません。テキストで入力してください。", { type: "error" });
    return;
  }
  vibrate(10);
  voiceTarget = target;
  lastTranscript = "";
  $("voiceTranscript").textContent = "お話しください...";
  $("voiceFieldLabel").textContent = voiceTargetLabel(target);
  $("overlayVoice").classList.add("show");
  pushNav();
  try { recognition.start(); } catch (e) { /* already running */ }
}
function cancelVoiceUI() {
  voiceTarget = null;
  lastTranscript = "";
  try { recognition && recognition.abort(); } catch (e) {}
  $("overlayVoice").classList.remove("show");
}
function finishVoice() {
  try { recognition && recognition.stop(); } catch (e) {}
}
function applyVoiceResult(target, text) {
  if (target.type === "field") {
    $(target.id).value = text;
    $(target.id).dispatchEvent(new Event("input"));
  } else if (target.type === "taskfield") {
    const map = { content: "taskContent", location: "taskLocation", quantity: "taskQuantity", material: "taskMaterial", notes: "taskNotes" };
    $(map[target.id]).value = text;
  } else if (target.type === "wholeTask") {
    $("taskContent").value = text;
  }
  showToast("✅ 入力しました");
}

/* ===================== Settings UI ===================== */
function renderSettingsUI() {
  liveSettings = getSettings();
  $("setCompanyName").value = liveSettings.company.name;
  $("setCompanyPerson").value = liveSettings.company.person;
  $("setCompanyTel").value = liveSettings.company.tel;
  $("setDefaultCautions").value = liveSettings.defaultCautions;
  renderLogoPreview();
  highlightThemeChips(liveSettings.theme);
  renderPresetList("presetClientList", "clients");
  renderPresetList("presetConstructionList", "constructions");
  renderPresetList("presetTaskList", "tasks");
}
function closeSettingsSheet() {
  $("overlaySettings").classList.remove("show");
  if (liveSettings) saveSettings(liveSettings);
}
function renderLogoPreview() {
  const row = $("logoPreviewRow");
  if (liveSettings.company.logo) {
    row.innerHTML = `<div class="photo-thumb-wrap logo-thumb-wrap"><img src="${liveSettings.company.logo}" class="photo-thumb logo-thumb" alt="ロゴ"><button class="photo-remove-btn" id="btnRemoveLogo" aria-label="ロゴを削除">✕</button></div>`;
    $("btnRemoveLogo").onclick = () => { liveSettings.company.logo = ""; saveSettings(liveSettings); renderLogoPreview(); };
  } else {
    row.innerHTML = "";
  }
}
function renderPresetList(containerId, key) {
  const arr = liveSettings.presets[key];
  if (key === "tasks") {
    $(containerId).innerHTML = arr.map((v, i) => `<div class="preset-item preset-item-task">
      <div class="preset-item-inputs">
        <input type="text" value="${escapeAttr(v.content)}" data-idx="${i}" data-pfield="content" placeholder="作業内容">
        <input type="text" value="${escapeAttr(v.material)}" data-idx="${i}" data-pfield="material" placeholder="材料（任意）">
      </div>
      <button data-remove-idx="${i}" aria-label="削除">✕</button>
    </div>`).join("") || `<p class="muted">まだ登録されていません</p>`;
  } else {
    $(containerId).innerHTML = arr.map((v, i) => `<div class="preset-item">
      <input type="text" value="${escapeAttr(v)}" data-idx="${i}" placeholder="未入力">
      <button data-remove-idx="${i}" aria-label="削除">✕</button>
    </div>`).join("") || `<p class="muted">まだ登録されていません</p>`;
  }
}
function bindPresetContainer(containerId, key) {
  const el = $(containerId);
  el.addEventListener("input", (e) => {
    if (!liveSettings) return;
    const inp = e.target.closest("input[data-idx]");
    if (!inp) return;
    const idx = Number(inp.dataset.idx);
    if (key === "tasks") liveSettings.presets.tasks[idx][inp.dataset.pfield] = inp.value;
    else liveSettings.presets[key][idx] = inp.value;
    debouncedSaveSettings();
    if (key === "clients" || key === "constructions") renderClientConstructionChips();
  });
  el.addEventListener("click", (e) => {
    if (!liveSettings) return;
    const btn = e.target.closest("button[data-remove-idx]");
    if (!btn) return;
    liveSettings.presets[key].splice(Number(btn.dataset.removeIdx), 1);
    saveSettings(liveSettings);
    renderPresetList(containerId, key);
    if (key === "clients" || key === "constructions") renderClientConstructionChips();
  });
}
function addPreset(containerId, key) {
  if (!liveSettings) return;
  liveSettings.presets[key].push(key === "tasks" ? { content: "", material: "" } : "");
  saveSettings(liveSettings);
  renderPresetList(containerId, key);
  const inputs = document.querySelectorAll("#" + containerId + " input");
  if (inputs.length) inputs[inputs.length - 1].focus();
}

/* ===================== Export / Import ===================== */
function exportData() {
  const settings = liveSettings || getSettings();
  const payload = { version: 3, exportedAt: new Date().toISOString(), documents: documentsCache, settings };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  a.href = url;
  a.download = `siyousyo-backup-${ymd}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast("⬇️ バックアップを書き出しました");
}
function handleImportFile(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try {
      payload = JSON.parse(reader.result);
      if (!Array.isArray(payload.documents)) throw new Error("invalid");
    } catch (err) {
      showToast("❌ ファイルの読み込みに失敗しました", { type: "error" });
      return;
    }
    showConfirmDialog("現在のデータに、読み込んだバックアップを追加します。よろしいですか？", "読み込む", () => {
      documentsCache = documentsCache.concat(payload.documents.map((d) => ({ ...d, id: genId(), tasks: (d.tasks || []).map((t) => ({ ...t, id: genId() })) })));
      saveDocuments();
      if (payload.settings) { saveSettings(mergeSettings(payload.settings)); renderSettingsUI(); }
      renderDocList();
      showToast("⬆️ 読み込みました");
    });
  };
  reader.readAsText(file);
}

/* ===================== First-run tutorial ===================== */
function maybeShowTutorial() {
  if (localStorage.getItem(TUTORIAL_KEY)) return;
  localStorage.setItem(TUTORIAL_KEY, "1");
  const { overlay } = openEphemeral(
    `<div class="sheet-header"><h3>👷 ようこそ！</h3></div>
     <div class="tutorial-slides">
       <p>📝 <b>「＋ 新しい指図書を作成」</b>から始めましょう。</p>
       <p>🎤 <b>マイクのアイコン</b>をタップすれば、話すだけで入力できます。</p>
       <p>⚙️ <b>右上の歯車（設定）</b>で、よく使う会社名や作業を登録しておくと、次からもっと簡単になります。</p>
     </div>
     <button class="btn btn-primary mt-16" data-act="ok">はじめる</button>`,
    { center: true }
  );
  overlay.querySelector('[data-act="ok"]').onclick = () => overlay.remove();
}

/* ===================== Service worker update notice ===================== */
function watchForAppUpdates(reg) {
  reg.addEventListener("updatefound", () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener("statechange", () => {
      if (nw.state === "installed" && navigator.serviceWorker.controller) {
        showToast("🆕 新しいバージョンがあります", { actionLabel: "更新する", onAction: () => location.reload(), duration: 10000 });
      }
    });
  });
}

/* ===================== Init & event binding ===================== */
function bindStaticEvents() {
  $("btnBack").addEventListener("click", goToHome);
  $("btnNewDoc").addEventListener("click", () => {
    const doc = newDocTemplate();
    documentsCache.unshift(doc);
    saveDocuments();
    openDoc(doc.id);
  });

  $("docSearch").addEventListener("input", () => renderDocList());

  $("docList").addEventListener("click", (e) => {
    const menuBtn = e.target.closest("[data-doc-menu]");
    if (menuBtn) {
      const doc = documentsCache.find((d) => d.id === menuBtn.dataset.docMenu);
      if (doc) showDocActions(doc);
      return;
    }
    const card = e.target.closest(".doc-card");
    if (card) openDoc(card.dataset.docId);
  });

  document.querySelectorAll(".step-dot").forEach((d) => d.addEventListener("click", () => goToStep(parseInt(d.dataset.step, 10))));
  $("btnPrevStep").addEventListener("click", () => { if (currentStep === 1) goToHome(); else goToStep(currentStep - 1); });
  $("btnNextStep").addEventListener("click", () => { if (currentStep < 3) goToStep(currentStep + 1); });
  $("btnMakePdf").addEventListener("click", makePdf);

  FORM_FIELDS.forEach((id) => {
    $(id).addEventListener("input", () => handleFieldChange(id));
    $(id).addEventListener("change", () => handleFieldChange(id));
  });

  $("btnUseGps").addEventListener("click", useGpsForAddress);
  $("btnZipLookup").addEventListener("click", openZipLookup);

  $("chipsClient").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-chip-client]");
    if (!chip) return;
    $("clientName").value = chip.dataset.chipClient;
    handleFieldChange("clientName");
    renderClientConstructionChips();
  });
  $("chipsConstruction").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-chip-constr]");
    if (!chip) return;
    $("constructionName").value = chip.dataset.chipConstr;
    handleFieldChange("constructionName");
    renderClientConstructionChips();
  });

  $("fabAddTask").addEventListener("click", () => openTaskSheet(null));
  $("btnCloseTaskSheet").addEventListener("click", () => requestCloseTaskSheet(false));
  $("btnSaveTask").addEventListener("click", saveTaskFromSheet);
  $("btnVoiceWholeTask").addEventListener("click", () => startVoice({ type: "wholeTask" }));
  $("chipsTaskTemplate").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tpl-content]");
    if (!chip) return;
    $("taskContent").value = chip.dataset.tplContent;
    if (chip.dataset.tplMaterial && !$("taskMaterial").value.trim()) $("taskMaterial").value = chip.dataset.tplMaterial;
  });
  $("overlayTask").addEventListener("click", (e) => { if (e.target.id === "overlayTask") requestCloseTaskSheet(false); });
  $("taskPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const blob = await resizeImageFile(file, 1000, 0.72);
      const id = genId();
      await savePhotoBlob(id, blob);
      pendingPhotoId = id;
      renderTaskPhotoUI();
    } catch (err) {
      showToast("❌ 写真の読み込みに失敗しました", { type: "error" });
    }
  });

  $("tasksContainer").addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-open-task]");
    if (openBtn) { openTaskSheet(openBtn.dataset.openTask); return; }
    const up = e.target.closest("[data-move-up]");
    if (up) return moveTask(up.dataset.moveUp, -1);
    const down = e.target.closest("[data-move-down]");
    if (down) return moveTask(down.dataset.moveDown, 1);
    const dup = e.target.closest("[data-dup-task]");
    if (dup) return duplicateTask(dup.dataset.dupTask);
    const del = e.target.closest("[data-del-task]");
    if (del) return deleteTask(del.dataset.delTask);
  });

  document.querySelectorAll(".mic-btn[data-field]").forEach((b) => b.addEventListener("click", () => startVoice({ type: "field", id: b.dataset.field })));
  document.querySelectorAll(".mic-btn[data-tfield]").forEach((b) => b.addEventListener("click", () => startVoice({ type: "taskfield", id: b.dataset.tfield })));
  $("btnVoiceCancel").addEventListener("click", goBackOneLevel);
  $("btnVoiceDone").addEventListener("click", finishVoice);
  $("overlayVoice").addEventListener("click", (e) => { if (e.target.id === "overlayVoice") goBackOneLevel(); });

  $("btnSettings").addEventListener("click", () => { renderSettingsUI(); $("overlaySettings").classList.add("show"); pushNav(); });
  $("btnCloseSettings").addEventListener("click", goBackOneLevel);
  $("overlaySettings").addEventListener("click", (e) => { if (e.target.id === "overlaySettings") goBackOneLevel(); });

  document.querySelectorAll("[data-theme-choice]").forEach((chip) => chip.addEventListener("click", () => {
    if (!liveSettings) liveSettings = getSettings();
    liveSettings.theme = chip.dataset.themeChoice;
    saveSettings(liveSettings);
    applyTheme(liveSettings.theme);
    highlightThemeChips(liveSettings.theme);
  }));

  $("setCompanyName").addEventListener("input", (e) => { if (!liveSettings) return; liveSettings.company.name = e.target.value; debouncedSaveSettings(); });
  $("setCompanyPerson").addEventListener("input", (e) => { if (!liveSettings) return; liveSettings.company.person = e.target.value; debouncedSaveSettings(); });
  $("setCompanyTel").addEventListener("input", (e) => { if (!liveSettings) return; liveSettings.company.tel = e.target.value; debouncedSaveSettings(); });
  $("setDefaultCautions").addEventListener("input", (e) => { if (!liveSettings) return; liveSettings.defaultCautions = e.target.value; debouncedSaveSettings(); });

  $("btnSetCompanyLogo").addEventListener("click", () => $("setCompanyLogoInput").click());
  $("setCompanyLogoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !liveSettings) return;
    try {
      const blob = await resizeImageFile(file, 240, 0.82);
      liveSettings.company.logo = await blobToDataUrl(blob);
      saveSettings(liveSettings);
      renderLogoPreview();
      showToast("✅ ロゴを設定しました");
    } catch (err) {
      showToast("❌ 画像の読み込みに失敗しました", { type: "error" });
    }
  });

  bindPresetContainer("presetClientList", "clients");
  bindPresetContainer("presetConstructionList", "constructions");
  bindPresetContainer("presetTaskList", "tasks");
  $("btnAddClientPreset").addEventListener("click", () => addPreset("presetClientList", "clients"));
  $("btnAddConstructionPreset").addEventListener("click", () => addPreset("presetConstructionList", "constructions"));
  $("btnAddTaskPreset").addEventListener("click", () => addPreset("presetTaskList", "tasks"));

  $("btnExportData").addEventListener("click", exportData);
  $("btnImportData").addEventListener("click", () => $("importFileInput").click());
  $("importFileInput").addEventListener("change", handleImportFile);
  $("btnResetAll").addEventListener("click", () => {
    showConfirmDialog("保存されているすべての指図書と設定を削除します。この操作は元に戻せません。", "すべて削除する", () => {
      localStorage.removeItem(DOCS_KEY);
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(TUTORIAL_KEY);
      location.reload();
    }, true);
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getSettings().theme === "auto") applyTheme("auto");
  });
}

function init() {
  loadDocumentsFromStorage();
  migrateOldData();
  applyTheme(getSettings().theme);
  bindStaticEvents();
  initSpeech();
  showScreen("home");
  cleanupOrphanPhotos();
  maybeShowTutorial();
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => watchForAppUpdates(reg)).catch(() => {});
    });
  }
}

window.addEventListener("DOMContentLoaded", init);
