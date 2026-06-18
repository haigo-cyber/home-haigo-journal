/* ============================================================
   haigo-journal – App-Logik (vanilla JS, buildless)
   Speicherung: Google Drive (Scope drive.file) ueber Google Identity Services.
   Die App legt einen eigenen Ordner an und schreibt Eintraege als
   einzelne, lesbare Markdown-Dateien hinein.
   ============================================================ */

/* ====== KONFIGURATION =====================================================
   HIER deine Google-Client-ID eintragen (aus der Google Cloud Console,
   OAuth-2.0-Client-ID vom Typ "Webanwendung"). Sonst startet der Login nicht.
   ========================================================================= */
const CLIENT_ID = "22658520266-72537b3ef6bi63gmfaavt4r5snnjv0ln.apps.googleusercontent.com";

const FOLDER_NAME = "haigo-journal";          // Name des Drive-Ordners, den die App anlegt
const SCOPES = "https://www.googleapis.com/auth/drive.file";

// Feste Abschnittsueberschriften des Job-Journals (auch im Dateitext sichtbar)
const JOB_SECTIONS = [
  { key: "situation",  label: "Situation / Anlass" },
  { key: "inhalt",     label: "Gesprächsinhalt" },
  { key: "ziele",      label: "Vereinbarungen / Ziele" },
];

const LS = {
  root:   "hj_root_id",
  privat: "hj_privat_id",
  job:    "hj_job_id",
  tagsId: "hj_tags_id",
  journal:"hj_journal",
};

/* ====== ZUSTAND ========================================================== */
let tokenClient = null;
let accessToken = null;
let tokenResolve = null;
let tokenReject = null;

let folders = { root: null, privat: null, job: null };
let tagsFileId = null;
let tags = { privat: [], job: [] };

let currentJournal = localStorage.getItem(LS.journal) || "privat";
let entries = { privat: [], job: [] };   // geladene Eintraege (Metadaten je Eintrag)
let loaded  = { privat: false, job: false };

let editingId = null;                    // null = neuer Eintrag
let editorSelectedTags = new Set();
let activeTagFilter = null;              // aktiver Tag in der Liste (oder null)
let listSearchTerm = "";

/* ====== KLEINE HELFER ==================================================== */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}
function deDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const [y,m,d] = iso.split("-");
  return d + "." + m + "." + y;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.innerHTML = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isErr ? 5000 : 2200);
}
function toastBusy(msg) {
  const t = $("#toast");
  t.innerHTML = '<span class="spinner"></span>' + esc(msg);
  t.classList.remove("err");
  t.classList.add("show");
  clearTimeout(toastTimer);
}

/* ====== AUTHENTIFIZIERUNG (Google Identity Services) ===================== */
function waitForGoogle() {
  return new Promise((resolve) => {
    const tick = () => {
      if (window.google && google.accounts && google.accounts.oauth2) resolve();
      else setTimeout(tick, 60);
    };
    tick();
  });
}

async function initAuth() {
  await waitForGoogle();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp && resp.error) {
        if (tokenReject) tokenReject(resp);
      } else {
        accessToken = resp.access_token;
        if (tokenResolve) tokenResolve(accessToken);
      }
      tokenResolve = tokenReject = null;
    },
  });
}

// Fordert ein Token an. prompt:'' = nach erster Zustimmung still.
function requestToken() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) { reject(new Error("Auth nicht bereit")); return; }
    tokenResolve = resolve;
    tokenReject = reject;
    try { tokenClient.requestAccessToken({ prompt: "" }); }
    catch (e) { tokenResolve = tokenReject = null; reject(e); }
  });
}

/* ====== DRIVE-ZUGRIFF ==================================================== */
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// Zentraler Aufruf mit Token-Erneuerung bei 401.
async function api(url, options, isRetry) {
  options = options || {};
  if (!accessToken) await requestToken();
  const headers = Object.assign({}, options.headers || {}, { Authorization: "Bearer " + accessToken });
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401 && !isRetry) {
    accessToken = null;
    await requestToken();
    return api(url, options, true);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch (e) {}
    const err = new Error("Drive " + res.status + ": " + detail.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return res;
}

async function driveList(q, fields) {
  const params = new URLSearchParams({
    q: q,
    fields: fields || "files(id,name)",
    spaces: "drive",
    pageSize: "1000",
    orderBy: "name",
  });
  const res = await api(DRIVE + "/files?" + params.toString());
  const data = await res.json();
  return data.files || [];
}

async function driveCreateFolder(name, parentId) {
  const meta = { name: name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const res = await api(DRIVE + "/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  return (await res.json()).id;
}

function multipartBody(metadata, content, contentType) {
  const boundary = "hjboundary" + Date.now();
  const body =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: " + contentType + "; charset=UTF-8\r\n\r\n" +
    content + "\r\n" +
    "--" + boundary + "--";
  return { body: body, contentType: "multipart/related; boundary=" + boundary };
}

async function driveCreateFile(name, parentId, mimeType, content, appProperties) {
  const meta = { name: name, mimeType: mimeType, parents: [parentId] };
  if (appProperties) meta.appProperties = appProperties;
  const mp = multipartBody(meta, content, mimeType);
  const res = await api(UPLOAD + "/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": mp.contentType },
    body: mp.body,
  });
  return (await res.json()).id;
}

async function driveUpdateFile(id, name, mimeType, content, appProperties) {
  const meta = {};
  if (name) meta.name = name;
  if (appProperties) meta.appProperties = appProperties;
  const mp = multipartBody(meta, content, mimeType);
  await api(UPLOAD + "/files/" + id + "?uploadType=multipart&fields=id", {
    method: "PATCH",
    headers: { "Content-Type": mp.contentType },
    body: mp.body,
  });
}

async function driveGetContent(id) {
  const res = await api(DRIVE + "/files/" + id + "?alt=media");
  return await res.text();
}

async function driveTrash(id) {
  await api(DRIVE + "/files/" + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}

/* ====== ORDNERSTRUKTUR & TAGS SICHERSTELLEN ============================== */
function q_folderByName(name, parentId) {
  let q = "name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  if (parentId) q += " and '" + parentId + "' in parents";
  return q;
}

async function ensureStructure() {
  // Hauptordner
  let rootId = localStorage.getItem(LS.root);
  let found = await driveList(q_folderByName(FOLDER_NAME, null), "files(id,name)");
  if (found.length) rootId = found[0].id;
  else if (!rootId) rootId = await driveCreateFolder(FOLDER_NAME, null);
  folders.root = rootId;
  localStorage.setItem(LS.root, rootId);

  // Unterordner privat / job
  for (const j of ["privat", "job"]) {
    const sub = await driveList(q_folderByName(j, rootId), "files(id,name)");
    let id = sub.length ? sub[0].id : await driveCreateFolder(j, rootId);
    folders[j] = id;
    localStorage.setItem(LS[j], id);
  }

  // tags.json
  const tagFiles = await driveList(
    "name='tags.json' and trashed=false and '" + rootId + "' in parents",
    "files(id,name)"
  );
  if (tagFiles.length) {
    tagsFileId = tagFiles[0].id;
    try {
      const txt = await driveGetContent(tagsFileId);
      const parsed = JSON.parse(txt);
      tags.privat = Array.isArray(parsed.privat) ? parsed.privat : [];
      tags.job    = Array.isArray(parsed.job)    ? parsed.job    : [];
    } catch (e) { tags = { privat: [], job: [] }; }
  } else {
    tagsFileId = await driveCreateFile("tags.json", rootId, "application/json",
      JSON.stringify({ privat: [], job: [] }, null, 2));
  }
  localStorage.setItem(LS.tagsId, tagsFileId || "");
}

async function saveTags() {
  const content = JSON.stringify({ privat: tags.privat, job: tags.job }, null, 2);
  if (tagsFileId) await driveUpdateFile(tagsFileId, null, "application/json", content, null);
  else tagsFileId = await driveCreateFile("tags.json", folders.root, "application/json", content);
}

/* ====== EINTRAEGE: AUFBAU & PARSEN ====================================== */
// Baut den Dateitext (Frontmatter + lesbarer Inhalt).
function buildContent(e) {
  const fm = ["---"];
  fm.push("journal: " + e.journal);
  fm.push("datum: " + e.datum);
  if (e.journal === "job") {
    fm.push("uhrzeit: " + (e.uhrzeit || ""));
    fm.push("gespraechspartner: " + (e.partner || ""));
    fm.push("thema: " + (e.thema || ""));
    fm.push("ort: " + (e.ort || ""));
  }
  fm.push("tags: " + (e.tags || []).join(", "));
  fm.push("erstellt: " + (e.erstellt || new Date().toISOString()));
  fm.push("id: " + e.eid);
  fm.push("---");
  fm.push("");

  let body = "";
  if (e.journal === "job") {
    body = JOB_SECTIONS.map(s => "## " + s.label + "\n\n" + ((e.sections && e.sections[s.key]) || "").trim() + "\n").join("\n");
  } else {
    body = (e.text || "").trim() + "\n";
  }
  return fm.join("\n") + body;
}

function parseFrontmatter(txt) {
  const out = {};
  if (!txt.startsWith("---")) return { meta: out, body: txt.trim() };
  const lines = txt.split(/\r?\n/);
  let i = 1, end = -1;
  for (; i < lines.length; i++) { if (lines[i].trim() === "---") { end = i; break; } }
  if (end === -1) return { meta: out, body: txt.trim() };
  for (let k = 1; k < end; k++) {
    const line = lines[k];
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    out[key] = val;
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { meta: out, body: body };
}

function splitJobSections(body) {
  const result = { situation: "", inhalt: "", ziele: "" };
  const labels = JOB_SECTIONS.map(s => "## " + s.label);
  const positions = [];
  labels.forEach((lab, idx) => {
    const p = body.indexOf(lab);
    if (p !== -1) positions.push({ idx, p, len: lab.length });
  });
  positions.sort((a, b) => a.p - b.p);
  for (let n = 0; n < positions.length; n++) {
    const cur = positions[n];
    const startText = cur.p + cur.len;
    const endText = (n + 1 < positions.length) ? positions[n + 1].p : body.length;
    result[JOB_SECTIONS[cur.idx].key] = body.slice(startText, endText).trim();
  }
  return result;
}

// Wandelt ein Drive-File (Listeneintrag mit appProperties) in unser Modell.
function fileToEntry(f) {
  const ap = f.appProperties || {};
  return {
    fileId: f.id,
    name: f.name,
    journal: ap.journal || currentJournal,
    datum: ap.datum || "",
    uhrzeit: ap.uhrzeit || "",
    partner: ap.partner || "",
    thema: ap.thema || "",
    ort: ap.ort || "",
    tags: ap.tags ? ap.tags.split(",").map(s => s.trim()).filter(Boolean) : [],
    erstellt: ap.erstellt || "",
    eid: ap.eid || "",
    // Kein Index vorhanden (z.B. extern angelegte Datei oder Lang-Feld-Fallback):
    // dann werden die Felder bei Bedarf aus dem Dateitext nachgezogen.
    _needsBody: !ap.app,
  };
}

function appPropsFor(e) {
  const ap = {
    app: "haigo-journal",
    journal: e.journal,
    datum: e.datum,
    tags: (e.tags || []).join(","),
    erstellt: e.erstellt,
    eid: e.eid,
  };
  if (e.journal === "job") {
    ap.uhrzeit = e.uhrzeit || "";
    ap.partner = e.partner || "";
    ap.thema = e.thema || "";
    ap.ort = e.ort || "";
  }
  return ap;
}

function sortEntries(arr) {
  arr.sort((a, b) => {
    const ka = (a.datum || "") + "T" + (a.uhrzeit || "00:00") + "_" + (a.erstellt || "");
    const kb = (b.datum || "") + "T" + (b.uhrzeit || "00:00") + "_" + (b.erstellt || "");
    return kb.localeCompare(ka); // absteigend (neueste zuerst)
  });
}

/* ====== LADEN / SPEICHERN / LOESCHEN ==================================== */
async function loadEntries(journal) {
  const parentId = folders[journal];
  const q = "'" + parentId + "' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder' and name!='tags.json'";
  const files = await driveList(q, "files(id,name,appProperties,modifiedTime)");
  const list = files
    .filter(f => f.name !== "tags.json")
    .map(fileToEntry);

  // Eintraege ohne Index aus dem Dateitext vervollstaendigen.
  // Normalfall: keine (die App schreibt den Index immer mit).
  for (const e of list) {
    if (!e._needsBody) continue;
    try {
      const raw = await driveGetContent(e.fileId);
      const { meta } = parseFrontmatter(raw);
      e.datum = e.datum || meta.datum || e.name.slice(0, 10);
      e.erstellt = e.erstellt || meta.erstellt || "";
      e.eid = e.eid || meta.id || "";
      if (!e.tags.length && meta.tags) e.tags = meta.tags.split(",").map(s => s.trim()).filter(Boolean);
      if (journal === "job") {
        e.uhrzeit = e.uhrzeit || meta.uhrzeit || "";
        e.partner = e.partner || meta.gespraechspartner || "";
        e.thema = e.thema || meta.thema || "";
        e.ort = e.ort || meta.ort || "";
      }
      e._full = raw;
    } catch (err) { /* Eintrag bleibt minimal, Datum kommt aus dem Dateinamen */ }
  }

  sortEntries(list);
  entries[journal] = list;
  loaded[journal] = true;
  return list;
}

async function saveEntry(e) {
  const content = buildContent(e);
  const ap = appPropsFor(e);
  const fileName = e.datum + "_" + (e.uhrzeit ? e.uhrzeit.replace(":", "") : nowHHMM().replace(":", "")) + "_" + e.eid + ".md";
  try {
    if (e.fileId) {
      await driveUpdateFile(e.fileId, fileName, "text/markdown", content, ap);
    } else {
      e.fileId = await driveCreateFile(fileName, folders[e.journal], "text/markdown", content, ap);
    }
  } catch (err) {
    // Falls Drive die Metadaten ablehnt (z.B. sehr lange Felder): ohne Index
    // erneut speichern. Der Eintrag geht so nie verloren; die Liste zieht die
    // Daten dann bei Bedarf aus dem Dateitext nach.
    if (err && err.status === 400) {
      if (e.fileId) {
        await driveUpdateFile(e.fileId, fileName, "text/markdown", content, null);
      } else {
        e.fileId = await driveCreateFile(fileName, folders[e.journal], "text/markdown", content, null);
      }
    } else {
      throw err;
    }
  }
  return e;
}

/* ====== RENDERING: LISTE =============================================== */
function applyJournalTheme() {
  document.body.setAttribute("data-journal", currentJournal);
  $$(".switch button").forEach(b => b.classList.toggle("active", b.dataset.j === currentJournal));
}

function renderTagFilter() {
  const box = $("#tagFilter");
  const list = tags[currentJournal] || [];
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = list.map(t =>
    '<span class="chip' + (activeTagFilter === t ? " on" : "") + '" data-tag="' + esc(t) + '">' + esc(t) + "</span>"
  ).join("");
  $$("#tagFilter .chip").forEach(ch => ch.onclick = () => {
    const t = ch.dataset.tag;
    activeTagFilter = (activeTagFilter === t) ? null : t;
    renderTagFilter();
    renderList();
  });
}

function entryMatchesFilter(e) {
  if (activeTagFilter && !(e.tags || []).includes(activeTagFilter)) return false;
  if (listSearchTerm) {
    const t = listSearchTerm.toLowerCase();
    const hay = [e.datum, deDate(e.datum), e.uhrzeit, e.partner, e.thema, e.ort, (e.tags || []).join(" ")]
      .join(" ").toLowerCase();
    if (hay.indexOf(t) === -1) return false;
  }
  return true;
}

function renderList() {
  const wrap = $("#list");
  if (!loaded[currentJournal]) { wrap.innerHTML = ""; return; }
  const all = entries[currentJournal].filter(entryMatchesFilter);
  if (!all.length) {
    const reason = (activeTagFilter || listSearchTerm)
      ? "Keine Eintraege passen zum Filter."
      : "Noch keine Eintraege in diesem Journal.";
    wrap.innerHTML = '<div class="empty"><b>' + esc(reason) + "</b>" +
      (!activeTagFilter && !listSearchTerm ? "Tippe auf „Neuer Eintrag“, um zu beginnen." : "") + "</div>";
    return;
  }
  wrap.innerHTML = all.map(e => renderEntryCard(e)).join("");
  $$("#list .entry").forEach(card => card.onclick = () => openEditor(card.dataset.fid));
}

function tagChipsHTML(tagsArr) {
  if (!tagsArr || !tagsArr.length) return "";
  return '<div class="e-tags">' + tagsArr.map(t => '<span class="chip read on">' + esc(t) + "</span>").join("") + "</div>";
}

function renderEntryCard(e) {
  if (e.journal === "job") {
    const meta = [deDate(e.datum), e.uhrzeit, e.ort].filter(Boolean).join("  ·  ");
    return '<div class="entry" data-fid="' + esc(e.fileId) + '">' +
      '<div class="e-top"><div class="e-primary">' + (esc(e.partner) || "Ohne Name") + "</div>" +
      '<div class="e-date">' + esc(deDate(e.datum)) + "</div></div>" +
      (e.thema ? '<div class="e-secondary">' + esc(e.thema) + "</div>" : "") +
      '<div class="e-meta">' + esc(meta) + "</div>" +
      tagChipsHTML(e.tags) +
      "</div>";
  }
  // privat
  return '<div class="entry" data-fid="' + esc(e.fileId) + '">' +
    '<div class="e-top"><div class="e-primary">' + esc(deDate(e.datum)) + "</div></div>" +
    '<div class="e-snippet" data-fid="' + esc(e.fileId) + '">…</div>' +
    tagChipsHTML(e.tags) +
    "</div>";
}

/* Snippet fuer Privat-Karten nachladen (Body wird nur bei Bedarf geholt). */
async function fillPrivateSnippets() {
  if (currentJournal !== "privat") return;
  const cards = $$('#list .e-snippet[data-fid]');
  for (const el of cards) {
    const fid = el.dataset.fid;
    const e = entries.privat.find(x => x.fileId === fid);
    if (!e || !entryMatchesFilter(e)) continue;
    if (e._snippet != null) { el.textContent = e._snippet || "(kein Text)"; continue; }
    try {
      const raw = await driveGetContent(fid);
      const { body } = parseFrontmatter(raw);
      e._snippet = body.replace(/\s+/g, " ").trim().slice(0, 180);
      el.textContent = e._snippet || "(kein Text)";
    } catch (err) { el.textContent = ""; }
  }
}

/* ====== EDITOR ========================================================= */
function setEditorMode(journal) {
  $("#jobFields").classList.toggle("hidden", journal !== "job");
  $("#jobSections").classList.toggle("hidden", journal !== "job");
  $("#privatFields").classList.toggle("hidden", journal !== "privat");
}

function renderEditorTagPicker() {
  const box = $("#editorTags");
  const list = tags[currentJournal] || [];
  box.innerHTML = list.map(t =>
    '<span class="chip' + (editorSelectedTags.has(t) ? " on" : "") + '" data-tag="' + esc(t) + '">' + esc(t) + "</span>"
  ).join("");
  $$("#editorTags .chip").forEach(ch => ch.onclick = () => {
    const t = ch.dataset.tag;
    if (editorSelectedTags.has(t)) editorSelectedTags.delete(t); else editorSelectedTags.add(t);
    renderEditorTagPicker();
  });
}

async function openEditor(fileId) {
  editingId = fileId || null;
  editorSelectedTags = new Set();
  setEditorMode(currentJournal);

  // Felder zuruecksetzen
  $("#fDatum").value = todayISO();
  $("#fUhrzeit").value = nowHHMM();
  $("#fPartner").value = "";
  $("#fThema").value = "";
  $("#fOrt").value = "";
  $("#fText").value = "";
  JOB_SECTIONS.forEach(s => { $("#fSec_" + s.key).value = ""; });
  $("#newTagInput").value = "";
  $("#deleteBtn").classList.toggle("hidden", !fileId);
  $("#editorTitle").textContent = fileId ? "Eintrag bearbeiten" : "Neuer Eintrag";

  if (fileId) {
    const e = entries[currentJournal].find(x => x.fileId === fileId);
    if (e) {
      $("#fDatum").value = e.datum || todayISO();
      (e.tags || []).forEach(t => editorSelectedTags.add(t));
      if (e.journal === "job") {
        $("#fUhrzeit").value = e.uhrzeit || "";
        $("#fPartner").value = e.partner || "";
        $("#fThema").value = e.thema || "";
        $("#fOrt").value = e.ort || "";
      }
      // Inhalt nachladen
      openOverlay("editorView");
      renderEditorTagPicker();
      toastBusy("Lade Eintrag…");
      try {
        const raw = await driveGetContent(fileId);
        e._full = raw;
        const { meta, body } = parseFrontmatter(raw);
        if (e.journal === "job") {
          // Volle Werte aus dem Dateitext (ohne Laengenbegrenzung des Index)
          if (meta.uhrzeit) $("#fUhrzeit").value = meta.uhrzeit;
          if (meta.gespraechspartner) $("#fPartner").value = meta.gespraechspartner;
          if (meta.thema) $("#fThema").value = meta.thema;
          if (meta.ort) $("#fOrt").value = meta.ort;
          const sec = splitJobSections(body);
          JOB_SECTIONS.forEach(s => { $("#fSec_" + s.key).value = sec[s.key] || ""; });
        } else {
          $("#fText").value = body;
        }
        $("#toast").classList.remove("show");
      } catch (err) {
        toast("Konnte Eintrag nicht laden: " + esc(err.message), true);
      }
      return;
    }
  }

  renderEditorTagPicker();
  openOverlay("editorView");
  setTimeout(() => { (currentJournal === "job" ? $("#fPartner") : $("#fText")).focus(); }, 50);
}

async function handleSave() {
  const datum = $("#fDatum").value;
  if (!datum) { toast("Bitte ein Datum angeben.", true); return; }

  const existing = editingId ? entries[currentJournal].find(x => x.fileId === editingId) : null;
  const e = {
    fileId: editingId || null,
    journal: currentJournal,
    datum: datum,
    tags: Array.from(editorSelectedTags),
    erstellt: (existing && existing.erstellt) || new Date().toISOString(),
    eid: (existing && existing.eid) || makeId(),
  };

  if (currentJournal === "job") {
    e.uhrzeit = $("#fUhrzeit").value || "";
    e.partner = $("#fPartner").value.trim();
    e.thema = $("#fThema").value.trim();
    e.ort = $("#fOrt").value.trim();
    e.sections = {};
    JOB_SECTIONS.forEach(s => { e.sections[s.key] = $("#fSec_" + s.key).value; });
    if (!e.partner && !e.thema) { toast("Bitte mindestens Name oder Thema angeben.", true); return; }
  } else {
    e.text = $("#fText").value;
    if (!e.text.trim()) { toast("Bitte einen Text eingeben.", true); return; }
  }

  $("#saveBtn").disabled = true;
  toastBusy("Speichere…");
  try {
    await saveEntry(e);
    await loadEntries(currentJournal);
    closeOverlay("editorView");
    renderTagFilter();
    renderList();
    if (currentJournal === "privat") fillPrivateSnippets();
    toast("Gespeichert.");
  } catch (err) {
    toast("Speichern fehlgeschlagen: " + esc(err.message), true);
  } finally {
    $("#saveBtn").disabled = false;
  }
}

async function handleDelete() {
  if (!editingId) return;
  if (!confirm("Diesen Eintrag in den Papierkorb verschieben?")) return;
  toastBusy("Loesche…");
  try {
    await driveTrash(editingId);
    await loadEntries(currentJournal);
    closeOverlay("editorView");
    renderList();
    if (currentJournal === "privat") fillPrivateSnippets();
    toast("In den Papierkorb verschoben.");
  } catch (err) {
    toast("Loeschen fehlgeschlagen: " + esc(err.message), true);
  }
}

function addNewTagFromEditor() {
  const inp = $("#newTagInput");
  const val = inp.value.trim().replace(/,/g, " ");
  if (!val) return;
  if (!tags[currentJournal].includes(val)) {
    tags[currentJournal].push(val);
    tags[currentJournal].sort((a, b) => a.localeCompare(b, "de"));
    saveTags().catch(err => toast("Tag nicht gespeichert: " + esc(err.message), true));
  }
  editorSelectedTags.add(val);
  inp.value = "";
  renderEditorTagPicker();
}

/* ====== TAG-VERWALTUNG ================================================= */
function renderTagManager() {
  ["privat", "job"].forEach(j => {
    const box = $("#tagList_" + j);
    const list = tags[j] || [];
    box.innerHTML = list.length
      ? list.map(t => '<div class="tag-row"><span>' + esc(t) + "</span>" +
          '<button data-j="' + j + '" data-tag="' + esc(t) + '">entfernen</button></div>').join("")
      : '<div class="hint">Noch keine Tags.</div>';
  });
  $$('.tag-row button').forEach(b => b.onclick = () => {
    const j = b.dataset.j, t = b.dataset.tag;
    tags[j] = tags[j].filter(x => x !== t);
    if (activeTagFilter === t) activeTagFilter = null;
    renderTagManager();
    saveTags().then(() => { renderTagFilter(); toast("Tag entfernt."); })
      .catch(err => toast("Nicht gespeichert: " + esc(err.message), true));
  });
}

function addTagFromManager(journal) {
  const inp = $("#tagManagerInput_" + journal);
  const val = inp.value.trim().replace(/,/g, " ");
  if (!val) return;
  if (!tags[journal].includes(val)) {
    tags[journal].push(val);
    tags[journal].sort((a, b) => a.localeCompare(b, "de"));
    renderTagManager();
    saveTags().then(() => renderTagFilter())
      .catch(err => toast("Nicht gespeichert: " + esc(err.message), true));
  }
  inp.value = "";
}

/* ====== REPORT (Volltextsuche ueber Eintraege) ========================= */
let reportScope = "current"; // current | both

async function runReport() {
  const term = $("#reportTerm").value.trim();
  const meta = $("#reportMeta");
  const out = $("#reportResults");

  const journals = reportScope === "both" ? ["privat", "job"] : [currentJournal];

  meta.innerHTML = '<span class="spinner"></span>Durchsuche Eintraege…';
  out.innerHTML = "";

  try {
    // sicherstellen, dass die betroffenen Journale geladen sind
    for (const j of journals) { if (!loaded[j]) await loadEntries(j); }

    const termLow = term.toLowerCase();
    const hits = [];
    for (const j of journals) {
      for (const e of entries[j]) {
        if (activeTagFilter && reportScope === "current" && !(e.tags || []).includes(activeTagFilter)) continue;
        // Body laden (gecacht in _full)
        let body = e._full;
        if (body == null) {
          body = await driveGetContent(e.fileId);
          e._full = body;
        }
        const metaHay = [e.datum, deDate(e.datum), e.uhrzeit, e.partner, e.thema, e.ort, (e.tags || []).join(" ")].join(" ");
        const haystack = (metaHay + " " + body).toLowerCase();
        if (!term || haystack.indexOf(termLow) !== -1) hits.push(e);
      }
    }
    sortEntries(hits);

    const scopeText = reportScope === "both" ? "beide Journale" : "Journal " + currentJournal;
    const filterText = (activeTagFilter && reportScope === "current") ? ', Tag „' + esc(activeTagFilter) + '“' : "";
    meta.innerHTML = "<b>" + hits.length + "</b> Eintraege gefunden  ·  " +
      (term ? 'Suchtext „' + esc(term) + '“' : "alle Eintraege") + "  ·  " + esc(scopeText) + filterText;

    if (!hits.length) { out.innerHTML = '<div class="empty"><b>Keine Treffer.</b></div>'; return; }
    const html = [];
    for (const e of hits) html.push(renderReportEntry(e));
    out.innerHTML = html.join("");
  } catch (err) {
    meta.innerHTML = "";
    out.innerHTML = '<div class="empty"><b>Fehler bei der Suche</b>' + esc(err.message) + "</div>";
  }
}

function renderReportEntry(e) {
  const head = (e.journal === "job" ? "Job" : "Privat") + "  ·  " + deDate(e.datum) +
    (e.uhrzeit ? "  ·  " + e.uhrzeit : "");
  let inner = "";
  if (e.journal === "job") {
    const { body } = parseFrontmatter(e._full || "");
    const sec = splitJobSections(body);
    inner = '<h3>' + (esc(e.partner) || "Ohne Name") + "</h3>" +
      '<div class="r-sub">' + [esc(e.thema), esc(e.ort)].filter(Boolean).join("  ·  ") + "</div>" +
      JOB_SECTIONS.map(s => sec[s.key]
        ? '<div class="r-sec"><b>' + esc(s.label) + '</b><div class="r-body">' + esc(sec[s.key]) + "</div></div>"
        : "").join("");
  } else {
    const { body } = parseFrontmatter(e._full || "");
    inner = '<div class="r-body">' + esc(body) + "</div>";
  }
  const tagsHtml = (e.tags && e.tags.length)
    ? '<div class="r-tags">' + e.tags.map(t => '<span class="chip read on">' + esc(t) + "</span>").join("") + "</div>"
    : "";
  return '<div class="r-entry"><div class="r-head">' + esc(head) + "</div>" + inner + tagsHtml + "</div>";
}

function reportPlainText() {
  const out = [];
  $$("#reportResults .r-entry").forEach(el => {
    out.push(el.innerText.trim());
    out.push("\n----------------------------------------\n");
  });
  return out.join("\n");
}

/* ====== OVERLAY-STEUERUNG ============================================== */
function openOverlay(id) { $("#" + id).classList.add("open"); document.body.style.overflow = "hidden"; }
function closeOverlay(id) { $("#" + id).classList.remove("open"); document.body.style.overflow = ""; }

/* ====== JOURNAL WECHSELN =============================================== */
async function switchJournal(j) {
  if (j === currentJournal) return;
  currentJournal = j;
  localStorage.setItem(LS.journal, j);
  activeTagFilter = null;
  listSearchTerm = "";
  $("#searchInput").value = "";
  applyJournalTheme();
  renderTagFilter();
  if (!loaded[j]) {
    $("#list").innerHTML = '<div class="empty"><span class="spinner"></span>Lade…</div>';
    try { await loadEntries(j); } catch (err) { toast("Laden fehlgeschlagen: " + esc(err.message), true); }
  }
  renderList();
  if (j === "privat") fillPrivateSnippets();
}

/* ====== START / ANMELDUNG ============================================== */
async function startApp() {
  $("#authError").textContent = "";
  $("#loginBtn").disabled = true;
  $("#loginBtn").innerHTML = '<span class="spinner"></span>Verbinde…';
  try {
    await requestToken();
    toastBusy("Richte Ordner ein…");
    await ensureStructure();
    $("#toast").classList.remove("show");

    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");

    applyJournalTheme();
    renderTagFilter();
    $("#list").innerHTML = '<div class="empty"><span class="spinner"></span>Lade…</div>';
    await loadEntries(currentJournal);
    renderList();
    if (currentJournal === "privat") fillPrivateSnippets();
  } catch (err) {
    const msg = (err && err.message) ? err.message : "Anmeldung abgebrochen.";
    $("#authError").textContent = "Anmeldung fehlgeschlagen: " + msg;
    $("#toast").classList.remove("show");
  } finally {
    $("#loginBtn").disabled = false;
    $("#loginBtn").textContent = "Mit Google anmelden";
  }
}

function signOut() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
  }
  accessToken = null;
  loaded = { privat: false, job: false };
  entries = { privat: [], job: [] };
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
}

/* ====== EREIGNISSE VERDRAHTEN ========================================== */
function wireEvents() {
  $("#loginBtn").onclick = startApp;

  // Journal-Umschalter
  $$(".switch button").forEach(b => b.onclick = () => switchJournal(b.dataset.j));

  // Werkzeugleiste
  $("#newEntryBtn").onclick = () => openEditor(null);
  $("#openTagsBtn").onclick = () => { renderTagManager(); openOverlay("tagsView"); };
  $("#openReportBtn").onclick = () => {
    $("#reportTerm").value = listSearchTerm || "";
    $("#reportResults").innerHTML = "";
    $("#reportMeta").innerHTML = "";
    setReportScope(reportScope);
    openOverlay("reportView");
    setTimeout(() => $("#reportTerm").focus(), 50);
  };
  $("#signOutBtn").onclick = signOut;

  // Suche in der Liste
  $("#searchInput").oninput = (ev) => {
    listSearchTerm = ev.target.value.trim();
    renderList();
    if (currentJournal === "privat") fillPrivateSnippets();
  };

  // Editor
  $("#saveBtn").onclick = handleSave;
  $("#deleteBtn").onclick = handleDelete;
  $("#editorClose").onclick = () => closeOverlay("editorView");
  $("#addTagBtn").onclick = addNewTagFromEditor;
  $("#newTagInput").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addNewTagFromEditor(); } };

  // Tag-Verwaltung
  $("#tagsClose").onclick = () => { closeOverlay("tagsView"); renderTagFilter(); };
  ["privat", "job"].forEach(j => {
    $("#tagManagerAdd_" + j).onclick = () => addTagFromManager(j);
    $("#tagManagerInput_" + j).onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addTagFromManager(j); } };
  });

  // Report
  $("#reportClose").onclick = () => closeOverlay("reportView");
  $("#reportRun").onclick = runReport;
  $("#reportTerm").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); runReport(); } };
  $("#reportPrint").onclick = () => window.print();
  $("#reportCopy").onclick = async () => {
    const text = reportPlainText();
    if (!text) { toast("Erst einen Bericht erstellen.", true); return; }
    try { await navigator.clipboard.writeText(text); toast("In die Zwischenablage kopiert."); }
    catch (e) { toast("Kopieren nicht moeglich.", true); }
  };
  $$('#reportScope button').forEach(b => b.onclick = () => setReportScope(b.dataset.scope));

  // Escape schliesst offene Overlays
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") ["editorView", "tagsView", "reportView"].forEach(id => {
      if ($("#" + id).classList.contains("open")) closeOverlay(id);
    });
  });
}

function setReportScope(scope) {
  reportScope = scope;
  $$('#reportScope button').forEach(b => b.classList.toggle("on", b.dataset.scope === scope));
}

/* ====== INITIALISIERUNG ================================================ */
window.addEventListener("DOMContentLoaded", async () => {
  // Icon im Kopf / Anmeldekarte setzen
  $$(".app-mark, .auth-mark").forEach(el => el.style.backgroundImage = "url('icon-192.png')");

  wireEvents();

  if (CLIENT_ID.indexOf("HIER_DEINE") === 0) {
    $("#authError").textContent =
      "Hinweis: In app.js ist noch keine Google-Client-ID eingetragen. Der Login funktioniert erst danach.";
  }

  try { await initAuth(); }
  catch (e) { $("#authError").textContent = "Google-Anmeldedienst nicht erreichbar."; }

  // Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
});
