/* ============================================================
   古着棚卸し PWA — メインロジック
   - 複数店舗（セッションに店舗）
   - ロケーション大分類（店内在庫 / バックヤード在庫 / その他倉庫）
   - バーコード無し商品はマスタから選んで登録
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LOCATIONS = ["店内在庫", "バックヤード在庫", "その他倉庫"];
  const LS_ACTIVE = "fi_active_session";
  const LS_LOC = "fi_location";

  const state = {
    view: "scan",
    sessions: [],
    activeSessionId: localStorage.getItem(LS_ACTIVE) || "",
    itemMap: {},
    items: [],
    scans: [],
    stores: [],
    allScans: [],
    location: localStorage.getItem(LS_LOC) || "店内在庫",
    pickOpen: false,
    pendingSku: "",
    reportStore: "",
  };

  /* ---------- トースト ---------- */
  let toastT;
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 2200);
  }

  /* ---------- 効果音 & 振動 ---------- */
  let actx;
  function beep(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = kind === "bad" ? 200 : kind === "dup" ? 520 : 880; o.type = "sine";
      o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.18);
      o.start(); o.stop(actx.currentTime + 0.19);
    } catch {}
    if (navigator.vibrate) navigator.vibrate(kind === "bad" ? [80, 40, 80] : 50);
  }

  function renderBadge() {
    const b = $("#conn-badge");
    if (DB.mode === "cloud") { b.textContent = "クラウド共有"; b.className = "badge badge-cloud"; }
    else { b.textContent = "未接続"; b.className = "badge badge-error"; }
  }

  function switchView(v) {
    state.view = v;
    $$(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
    $$(".tab").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
    render();
  }

  /* ---------- データ再取得 ---------- */
  let loading = false;
  async function reload() {
    if (loading) return; loading = true;
    try {
      state.sessions = await DB.getSessions();
      if (!state.activeSessionId && state.sessions[0]) setActiveSession(state.sessions[0].id, false);
      state.itemMap = await DB.getItemMap();
      state.items = Object.values(state.itemMap).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
      state.stores = await DB.getStores();
      state.scans = state.activeSessionId ? await DB.getScans(state.activeSessionId) : [];
      state.allScans = await DB.getAllScans();
    } catch (e) { console.error(e); toast("読込エラー: " + (e.message || e)); }
    finally { loading = false; }
    render();
  }

  function activeSession() { return state.sessions.find((s) => s.id === state.activeSessionId) || null; }
  function setActiveSession(id, doReload = true) {
    state.activeSessionId = id; localStorage.setItem(LS_ACTIVE, id);
    if (doReload) reload();
  }
  function knownStores() {
    const set = new Set(state.stores.map((s) => s.name));
    state.sessions.forEach((s) => { if (s.store) set.add(s.store); });
    return Array.from(set);
  }

  /* ---------- 描画 ---------- */
  function render() {
    renderBadge();
    if (state.view === "scan") renderScan();
    else if (state.view === "master") renderMaster();
    else if (state.view === "report") renderReport();
    else if (state.view === "settings") renderSettings();
  }

  /* === スキャン === */
  function sessionLabel(s) { return (s.store ? s.store + " / " : "") + s.name + (s.status === "closed" ? "（完了）" : ""); }

  function renderScan() {
    $("#session-select").innerHTML =
      state.sessions.map((s) => `<option value="${s.id}" ${s.id === state.activeSessionId ? "selected" : ""}>${esc(sessionLabel(s))}</option>`).join("")
      || `<option value="">セッションなし</option>`;

    $$(".loc-btn").forEach((b) => b.classList.toggle("active", b.dataset.loc === state.location));

    const totalQty = state.scans.reduce((a, s) => a + s.qty, 0);
    const kinds = new Set(state.scans.map((s) => s.sku)).size;
    const unknown = new Set(state.scans.filter((s) => !state.itemMap[s.sku]).map((s) => s.sku)).size;
    $("#stat-total").textContent = totalQty;
    $("#stat-kinds").textContent = kinds;
    $("#stat-unknown").textContent = unknown;

    if (state.pickOpen) renderPickList();

    const list = $("#recent-list");
    if (!state.scans.length) {
      list.innerHTML = `<li class="empty">まだ読み取りがありません。<br>上でロケーションを選び「カメラ開始」。</li>`;
      return;
    }
    list.innerHTML = state.scans.slice(0, 40).map((sc) => {
      const it = state.itemMap[sc.sku];
      const name = it ? esc(it.name || "(名称なし)") : "マスタ外の商品";
      const pill = it ? `<span class="pill pill-ok">一致</span>` : `<span class="pill pill-new">マスタ外</span>`;
      return `<li class="row" data-sku="${esc(sc.sku)}" data-loc="${esc(sc.location)}">
        <div class="row-main"><div class="row-name">${name} ${pill}</div>
        <div class="row-sub"><span class="loc-tag">${esc(sc.location)}</span> ${esc(sc.sku)}${sc.device ? " · " + esc(sc.device) : ""}</div></div>
        <span class="row-qty">×${sc.qty}</span></li>`;
    }).join("");
  }

  const normSearch = (s) => String(s || "").toLowerCase().replace(/[\s¥￥,、]/g, "");
  function renderPickList() {
    const q = normSearch($("#pick-search").value);
    const rows = state.items.filter((it) => {
      if (!q) return true;
      const hay = normSearch((it.name || "") + (it.category || "") + (it.sku || "") + (it.price ?? ""));
      return hay.includes(q);
    }).slice(0, 80);
    const ul = $("#pick-list");
    ul.innerHTML = rows.map((it) => `
      <li class="pick-row" data-pick="${esc(it.sku)}">
        <div class="pk-main"><div class="pk-name">${esc(it.name || it.category || "(名称なし)")}</div>
        <div class="pk-sub">${esc(it.sku)}</div></div><div class="pk-add">＋</div></li>`).join("")
      || `<li class="empty">該当なし</li>`;
  }

  async function handleScan(rawText, qty) {
    const sku = (rawText || "").trim();
    if (!sku) return;
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const s = activeSession();
    if (!s) { toast("先に棚卸しセッションを作成してください"); showFeedback("bad", "セッション未選択", ""); return; }
    try {
      const res = await DB.addScan(state.activeSessionId, sku, DB.getDeviceName(), state.location, n);
      const it = res.item;
      const locTag = state.location;
      const plus = n > 1 ? ` +${n}` : "";
      if (res.status === "matched") { beep("ok"); showFeedback("ok", (it && it.name ? it.name : "一致") + " / " + locTag + plus, sku); }
      else if (res.status === "new") { beep("ok"); showFeedback("new", "マスタ外（新規） / " + locTag + plus, sku); }
      else { beep("dup"); showFeedback("dup", `${locTag} ×${res.qty}` + (it && it.name ? " · " + it.name : ""), sku); }
      state.scans = await DB.getScans(state.activeSessionId);
      renderScan();
    } catch (e) { beep("bad"); showFeedback("bad", "登録エラー", sku); toast(e.message || String(e)); }
  }

  /* ---------- 数量入力モーダル ---------- */
  function openQtyModal(sku) {
    const it = state.itemMap[sku];
    state.pendingSku = sku;
    $("#qty-title").textContent = it ? (it.name || it.category || "数量を入力") : "数量を入力";
    $("#qty-sub").textContent = `${sku} / ${state.location}`;
    $("#qty-value").value = "1";
    $("#qty-modal").hidden = false;
    setTimeout(() => { const v = $("#qty-value"); v.focus(); v.select(); }, 50);
  }
  function closeQtyModal() { $("#qty-modal").hidden = true; state.pendingSku = ""; }
  async function confirmQty() {
    const sku = state.pendingSku;
    const qty = Math.max(1, parseInt($("#qty-value").value, 10) || 1);
    closeQtyModal();
    await handleScan(sku, qty);
  }

  let fbT;
  function showFeedback(kind, msg, sku) {
    const el = $("#scan-feedback");
    el.className = "scan-feedback show " + kind;
    el.innerHTML = `<span>${esc(msg)}</span>` + (sku ? ` <span class="fb-sku">${esc(sku)}</span>` : "");
    clearTimeout(fbT); fbT = setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function toggleCamera() {
    const btn = $("#cam-toggle"), wrap = $("#scanner-wrap"), torchBtn = $("#torch-toggle"), zoomRow = $("#zoom-row");
    if (Scanner.isScanning()) {
      await Scanner.stop(); wrap.classList.remove("scanning");
      btn.textContent = "カメラ開始"; torchBtn.hidden = true; zoomRow.hidden = true;
    } else {
      if (!activeSession()) { openSessionModal(); return; }
      try {
        btn.textContent = "起動中…";
        await Scanner.start("reader", handleScan);
        wrap.classList.add("scanning"); btn.textContent = "カメラ停止";
        setTimeout(() => {
          if (Scanner.torchSupported()) torchBtn.hidden = false;
          const zc = Scanner.zoomCap();
          if (zc) {
            const r = $("#zoom-range");
            r.min = zc.min; r.max = zc.max; r.step = zc.step || 0.1;
            const cur = Scanner.currentZoom();
            if (cur != null) r.value = cur;
            zoomRow.hidden = false;
          } else { zoomRow.hidden = true; }
        }, 500);
      } catch (e) {
        btn.textContent = "カメラ開始";
        toast("カメラ起動失敗: " + (e.message || e) + "（HTTPSまたはlocalhostで開いてください）");
      }
    }
  }

  /* === マスタ === */
  function renderMaster() {
    const q = ($("#master-search").value || "").toLowerCase();
    const rows = state.items.filter((it) =>
      !q || (it.sku || "").toLowerCase().includes(q) || (it.name || "").toLowerCase().includes(q) || (it.category || "").toLowerCase().includes(q));
    $("#master-count").textContent = `${state.items.length}件`;
    const list = $("#master-list");
    if (!rows.length) { list.innerHTML = `<li class="empty">商品がありません。「＋商品」またはCSV取込で登録。</li>`; return; }
    list.innerHTML = rows.slice(0, 400).map((it) => `
      <li class="row" data-edit="${esc(it.sku)}">
        <div class="row-main"><div class="row-name">${esc(it.name || "(名称なし)")}</div>
        <div class="row-sub">${esc(it.sku)}${it.category ? " · " + esc(it.category) : ""}${it.price != null && it.price !== "" ? " · ¥" + esc(it.price) : ""}</div></div>
        ${it.expected != null && it.expected !== "" ? `<span class="row-qty">${it.expected}</span>` : ""}
      </li>`).join("");
  }

  /* === レポート（店舗単位） === */
  const jnum = (n) => n.toLocaleString("ja-JP");
  const storeKey = (st) => st || "（店舗未設定）";

  function renderReport() {
    const back = $("#report-back"), title = $("#report-title"), body = $("#report-body");
    if (state.reportStore) { back.hidden = false; renderStoreDetail(title, body); }
    else { back.hidden = true; title.textContent = "店舗別レポート"; renderStoreOverview(body); }
  }

  // 店舗一覧（各店舗の合計点数）
  function renderStoreOverview(body) {
    const byStore = {};
    state.allScans.forEach((sc) => {
      const k = storeKey(sc.store);
      byStore[k] = (byStore[k] || 0) + sc.qty;
    });
    const rows = Object.entries(byStore).sort((a, b) => b[1] - a[1]);
    const grand = rows.reduce((a, r) => a + r[1], 0);
    if (!rows.length) { body.innerHTML = `<div class="empty">まだ読み取りデータがありません。</div>`; return; }
    body.innerHTML =
      `<div class="report-cards">
         <div class="rcard"><div class="n">${jnum(grand)}</div><div class="l">全店 総点数</div></div>
         <div class="rcard"><div class="n">${rows.length}</div><div class="l">店舗数</div></div>
       </div>
       <ul class="report-list">` +
      rows.map(([store, qty]) => `
        <li class="row store-row" data-store="${esc(store)}">
          <div class="row-main"><div class="row-name">${esc(store)}</div>
          <div class="row-sub">タップで内訳・比率を表示</div></div>
          <span class="row-qty">${jnum(qty)}</span><span class="chev">›</span></li>`).join("") +
      `</ul>`;
  }

  // 店舗詳細（ロケーション内訳＋カテゴリ比率＋価格帯比率）
  function renderStoreDetail(title, body) {
    const store = state.reportStore;
    title.textContent = store;
    const scans = state.allScans.filter((sc) => storeKey(sc.store) === store);
    const total = scans.reduce((a, x) => a + x.qty, 0);

    // ① ロケーション内訳
    const locSum = {}; LOCATIONS.forEach((l) => (locSum[l] = 0));
    scans.forEach((sc) => { locSum[sc.location] = (locSum[sc.location] || 0) + sc.qty; });

    // ② カテゴリ比率
    const catSum = {};
    scans.forEach((sc) => {
      const it = state.itemMap[sc.sku];
      const c = it ? (it.category || "未分類") : "マスタ外";
      catSum[c] = (catSum[c] || 0) + sc.qty;
    });
    // ③ 価格帯比率
    const priceSum = {};
    scans.forEach((sc) => {
      const it = state.itemMap[sc.sku];
      const p = it && it.price != null && it.price !== "" ? "¥" + jnum(Number(it.price)) : "不明";
      priceSum[p] = (priceSum[p] || 0) + sc.qty;
    });

    const locCards = LOCATIONS.map((l) =>
      `<div class="rcard"><div class="n">${jnum(locSum[l] || 0)}</div><div class="l">${l}</div></div>`).join("");

    body.innerHTML =
      `<div class="report-cards report-cards-4">
         <div class="rcard rcard-total"><div class="n">${jnum(total)}</div><div class="l">合計</div></div>
         ${locCards}
       </div>
       <h3 class="chart-title">カテゴリ比率</h3>
       ${barChart(catSum, total, "cat")}
       <h3 class="chart-title">価格帯比率</h3>
       ${barChart(priceSum, total, "price")}`;
  }

  // 横棒＋割合の簡易チャート
  function barChart(sumMap, total, kind) {
    let entries = Object.entries(sumMap).filter(([, q]) => q > 0);
    if (!entries.length) return `<div class="empty">データなし</div>`;
    if (kind === "price") {
      // 価格の昇順（不明は末尾）
      entries.sort((a, b) => {
        const pa = a[0] === "不明" ? Infinity : Number(a[0].replace(/[¥,]/g, ""));
        const pb = b[0] === "不明" ? Infinity : Number(b[0].replace(/[¥,]/g, ""));
        return pa - pb;
      });
    } else {
      entries.sort((a, b) => b[1] - a[1]);
    }
    return `<div class="bars">` + entries.map(([label, qty]) => {
      const pct = total ? Math.round((qty / total) * 100) : 0;
      return `<div class="bar-row">
        <div class="bar-label">${esc(label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-val">${jnum(qty)}<span class="bar-pct">${pct}%</span></div>
      </div>`;
    }).join("") + `</div>`;
  }

  /* === 設定 === */
  function renderSettings() {
    $("#device-name").value = DB.getDeviceName();
    renderStoreList();
    const { url, key } = DB.getSavedCreds();
    $("#sb-url").value = url; $("#sb-key").value = key;
    const st = $("#sb-status");
    st.textContent = DB.mode === "cloud" ? "● 接続中（クラウド共有）" : "⚠ 未接続 — URLとanonキーを入力して接続してください";
    st.style.color = DB.mode === "cloud" ? "var(--green)" : "var(--amber)";
  }

  function renderStoreList() {
    const ul = $("#store-list-ui");
    if (!state.stores.length) { ul.innerHTML = `<li class="muted">店舗が未登録です。「公式店舗リストを読込」または追加してください。</li>`; return; }
    let html = "", lastBrand = null;
    state.stores.forEach((s) => {
      if (s.brand !== lastBrand) { html += `<li class="store-group-h">${esc(s.brand || "その他")}</li>`; lastBrand = s.brand; }
      html += `<li class="store-item">
        <div class="st-main"><div class="st-name">${esc(s.name)}</div>${s.area ? `<div class="st-sub">${esc(s.area)}</div>` : ""}</div>
        ${s.brand ? `<span class="st-brand">${esc(s.brand)}</span>` : ""}
        <button class="store-del" data-delstore="${esc(s.name)}" title="削除">×</button></li>`;
    });
    ul.innerHTML = html;
  }
  async function seedStoresIfEmpty() {
    try {
      if ((await DB.getStores()).length) return;
      const res = await fetch("stores.json");
      if (!res.ok) return;
      await DB.bulkUpsertStores(await res.json());
    } catch {}
  }
  async function loadOfficialStores() {
    try {
      const res = await fetch("stores.json");
      if (!res.ok) { toast("stores.json が見つかりません"); return; }
      const list = await res.json();
      await DB.bulkUpsertStores(list);
      toast(`公式店舗 ${list.length}件を登録しました`); await reload();
    } catch (e) { toast("読込失敗: " + (e.message || e)); }
  }

  /* ---------- セッションモーダル ---------- */
  function openSessionModal() {
    const m = $("#session-modal");
    const stores = knownStores();
    $("#store-datalist").innerHTML = stores.map((s) => `<option value="${esc(s)}">`).join("");
    const lastStore = stores[0] || "";
    $("#sm-store").value = lastStore;
    $("#sm-name").value = new Date().toISOString().slice(0, 10); // 棚卸日（既定＝本日）
    $("#sm-close-session").style.display = activeSession() ? "" : "none";
    m.hidden = false;
    setTimeout(() => $("#sm-store").focus(), 50);
  }
  function closeSessionModal() { $("#session-modal").hidden = true; }
  async function createSessionFromModal() {
    const store = $("#sm-store").value.trim();
    const name = $("#sm-name").value.trim() || new Date().toISOString().slice(0, 10);
    if (store && !state.stores.some((s) => s.name === store)) {
      await DB.upsertStore({ name: store, brand: "", area: "" });
      state.stores = await DB.getStores();
    }
    const sess = await DB.createSession(name, store);
    state.sessions = await DB.getSessions();
    closeSessionModal();
    setActiveSession(sess.id);
    toast("セッションを作成しました");
  }

  /* ---------- 商品モーダル ---------- */
  function openItemModal(sku) {
    const it = sku ? state.itemMap[sku] : null;
    $("#item-modal-title").textContent = it ? "商品を編集" : "商品を追加";
    $("#im-sku").value = it ? it.sku : sku || "";
    $("#im-sku").disabled = !!it;
    $("#im-name").value = it ? it.name || "" : "";
    $("#im-category").value = it ? it.category || "" : "";
    $("#im-price").value = it && it.price != null ? it.price : "";
    $("#im-expected").value = it && it.expected != null ? it.expected : "";
    $("#im-delete").style.display = it ? "" : "none";
    $("#item-modal").hidden = false;
  }
  function closeItemModal() { $("#item-modal").hidden = true; }
  async function saveItemModal() {
    const sku = $("#im-sku").value.trim();
    if (!sku) { toast("コード/バーコードは必須です"); return; }
    const expRaw = $("#im-expected").value.trim();
    await DB.upsertItem({
      sku, name: $("#im-name").value.trim(), category: $("#im-category").value.trim(),
      price: $("#im-price").value.trim(), expected: expRaw === "" ? null : parseInt(expRaw, 10),
    });
    closeItemModal(); toast("保存しました"); await reload();
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = []; let row = [], field = "", q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else {
        if (c === '"') q = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (c === "\r") {}
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c !== ""));
  }
  const HEADER_ALIAS = {
    sku: "sku", barcode: "sku", "バーコード": "sku", "コード": "sku", jan: "sku", "インハウスコード": "sku",
    name: "name", "商品名": "name", "品名": "name", "名称": "name",
    category: "category", "カテゴリ": "category", "分類": "category", "商品分類": "category",
    price: "price", "単価": "price", "価格": "price", "値段": "price",
    expected: "expected", "想定数": "expected", "在庫数": "expected", "数量": "expected",
  };
  async function importItemsFromText(text) {
    const rows = parseCSV(text);
    if (rows.length < 1) return 0;
    const header = rows[0].map((h) => HEADER_ALIAS[h.trim().toLowerCase()] || HEADER_ALIAS[h.trim()] || h.trim().toLowerCase());
    let body = rows.slice(1);
    if (header.indexOf("sku") === -1) { header[0] = "sku"; body = rows; }
    const iSku = header.indexOf("sku"), iName = header.indexOf("name"),
      iCat = header.indexOf("category"), iPrice = header.indexOf("price"), iExp = header.indexOf("expected");
    const items = [];
    for (const r of body) {
      const sku = (r[iSku] || "").trim(); if (!sku) continue;
      const expRaw = iExp > -1 ? (r[iExp] || "").trim() : "";
      items.push({
        sku,
        name: iName > -1 ? (r[iName] || "").trim() : "",
        category: iCat > -1 ? (r[iCat] || "").trim() : "",
        price: iPrice > -1 ? (r[iPrice] || "").trim() : "",
        expected: expRaw === "" ? null : parseInt(expRaw, 10),
      });
    }
    if (!items.length) return 0;
    await DB.bulkUpsertItems(items);
    return items.length;
  }
  async function importCSV(file) {
    const n = await importItemsFromText(await file.text());
    if (!n) { toast("取り込める行がありません"); return; }
    toast(`${n}件を取込みました`); await reload();
  }
  async function seedMasterIfEmpty() {
    try {
      if ((await DB.getItems()).length) return;
      const res = await fetch("master.csv");
      if (!res.ok) return;
      const n = await importItemsFromText(await res.text());
      if (n) toast(`初期マスタ ${n}件を読込みました`);
    } catch {}
  }
  function toCSV(rows) {
    return rows.map((r) => r.map((c) => {
      const s = String(c ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");
  }
  function download(name, text) {
    const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportMasterCSV() {
    const rows = [["sku", "name", "category", "price", "expected"]];
    state.items.forEach((it) => rows.push([it.sku, it.name || "", it.category || "", it.price ?? "", it.expected ?? ""]));
    download("master.csv", toCSV(rows));
  }
  function exportReportCSV() {
    // レポート表示中の範囲を出力（店舗選択中はその店舗、一覧なら全店舗）
    let scans = state.allScans;
    if (state.reportStore) scans = scans.filter((sc) => storeKey(sc.store) === state.reportStore);
    const rows = [["店舗", "ロケーション", "コード", "商品名", "カテゴリ", "単価", "数量"]];
    const sorted = [...scans].sort((a, b) =>
      storeKey(a.store).localeCompare(storeKey(b.store), "ja") ||
      (a.location || "").localeCompare(b.location || "") || (b.qty - a.qty));
    sorted.forEach((sc) => {
      const it = state.itemMap[sc.sku] || {};
      rows.push([storeKey(sc.store), sc.location, sc.sku, it.name || "", it.category || "", it.price ?? "", sc.qty]);
    });
    const safe = (state.reportStore || "全店舗").replace(/[^\w\-一-龠ぁ-んァ-ヶー]/g, "_");
    download("tanaoroshi_" + safe + ".csv", toCSV(rows));
  }

  /* ---------- イベント配線 ---------- */
  function wire() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

    $("#session-select").addEventListener("change", (e) => setActiveSession(e.target.value));
    $("#new-session-btn").addEventListener("click", openSessionModal);

    $$(".loc-btn").forEach((b) => b.addEventListener("click", () => {
      state.location = b.dataset.loc; localStorage.setItem(LS_LOC, state.location);
      $$(".loc-btn").forEach((x) => x.classList.toggle("active", x === b));
      toast("ロケーション: " + state.location);
    }));

    $("#cam-toggle").addEventListener("click", toggleCamera);
    $("#zoom-range").addEventListener("input", (e) => { Scanner.setZoom(parseFloat(e.target.value)); });
    $("#torch-toggle").addEventListener("click", async function () {
      this._on = !this._on; await Scanner.toggleTorch(this._on);
      this.classList.toggle("btn-primary", this._on);
    });
    $("#manual-form").addEventListener("submit", (e) => {
      e.preventDefault(); const inp = $("#manual-input"); const qi = $("#manual-qty");
      handleScan(inp.value, qi.value); inp.value = ""; qi.value = "1"; inp.focus();
    });
    $("#recent-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-sku]"); if (!li) return;
      if (!state.itemMap[li.dataset.sku]) openItemModal(li.dataset.sku);
    });

    // マスタ選択（バーコード無し）
    $("#pick-toggle").addEventListener("click", () => {
      if (!activeSession()) { openSessionModal(); return; }
      state.pickOpen = !state.pickOpen;
      $("#pick-panel").hidden = !state.pickOpen;
      if (state.pickOpen) { renderPickList(); $("#pick-search").focus(); }
    });
    $("#pick-search").addEventListener("input", renderPickList);
    $("#pick-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-pick]"); if (!li) return;
      openQtyModal(li.dataset.pick); // 数量を入力して登録
    });

    // 数量モーダル
    $("#qty-minus").addEventListener("click", () => { const v = $("#qty-value"); v.value = Math.max(1, (parseInt(v.value, 10) || 1) - 1); });
    $("#qty-plus").addEventListener("click", () => { const v = $("#qty-value"); v.value = (parseInt(v.value, 10) || 0) + 1; });
    $$("#qty-modal .qty-quick button").forEach((b) => b.addEventListener("click", () => {
      const v = $("#qty-value"); v.value = (parseInt(v.value, 10) || 0) + parseInt(b.dataset.q, 10);
    }));
    $("#qty-add").addEventListener("click", confirmQty);
    $("#qty-cancel").addEventListener("click", closeQtyModal);
    $("#qty-modal").addEventListener("click", (e) => { if (e.target.id === "qty-modal") closeQtyModal(); });

    $("#master-search").addEventListener("input", renderMaster);
    $("#master-add-btn").addEventListener("click", () => openItemModal(""));
    $("#master-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-edit]"); if (li) openItemModal(li.dataset.edit);
    });
    $("#csv-input").addEventListener("change", (e) => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ""; });
    $("#csv-export-btn").addEventListener("click", exportMasterCSV);

    $("#report-export-btn").addEventListener("click", exportReportCSV);
    $("#report-back").addEventListener("click", () => { state.reportStore = ""; renderReport(); });
    $("#report-body").addEventListener("click", (e) => {
      const li = e.target.closest("[data-store]"); if (!li) return;
      state.reportStore = li.dataset.store; renderReport();
    });

    // セッションモーダル
    $("#sm-create").addEventListener("click", createSessionFromModal);
    $("#sm-cancel").addEventListener("click", closeSessionModal);
    $("#sm-close-session").addEventListener("click", async () => {
      const s = activeSession(); if (!s) return;
      if (confirm(`「${sessionLabel(s)}」を完了にしますか？`)) {
        await DB.setSessionStatus(s.id, "closed"); closeSessionModal(); await reload(); toast("セッションを完了にしました");
      }
    });
    $("#session-modal").addEventListener("click", (e) => { if (e.target.id === "session-modal") closeSessionModal(); });

    // 商品モーダル
    $("#im-save").addEventListener("click", saveItemModal);
    $("#im-cancel").addEventListener("click", closeItemModal);
    $("#im-delete").addEventListener("click", async () => {
      const sku = $("#im-sku").value.trim();
      if (sku && confirm("この商品を削除しますか？")) { await DB.deleteItem(sku); closeItemModal(); await reload(); }
    });
    $("#item-modal").addEventListener("click", (e) => { if (e.target.id === "item-modal") closeItemModal(); });

    // 設定
    $("#device-name").addEventListener("change", (e) => { DB.setDeviceName(e.target.value); toast("端末名を保存"); });
    $("#store-add-btn").addEventListener("click", async () => {
      const name = $("#store-name").value.trim();
      if (!name) { toast("店舗名を入力してください"); return; }
      await DB.upsertStore({ name, brand: $("#store-brand").value.trim(), area: $("#store-area").value.trim() });
      $("#store-name").value = ""; $("#store-brand").value = ""; $("#store-area").value = "";
      toast("店舗を追加しました"); await reload();
    });
    $("#store-load-official").addEventListener("click", loadOfficialStores);
    $("#store-list-ui").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-delstore]"); if (!b) return;
      const name = b.dataset.delstore;
      if (confirm(`店舗「${name}」を削除しますか？`)) { await DB.deleteStore(name); await reload(); }
    });
    $("#sb-save-btn").addEventListener("click", async () => {
      const btn = $("#sb-save-btn"); btn.disabled = true; btn.textContent = "接続中…";
      try {
        await DB.connectAndSave($("#sb-url").value, $("#sb-key").value);
        // クラウドが空なら初期マスタ・店舗を投入
        await seedMasterIfEmpty();
        await seedStoresIfEmpty();
        toast("クラウドに接続しました"); await reload();
      }
      catch (e) { toast("接続失敗: " + (e.message || e)); }
      finally { btn.disabled = false; btn.textContent = "接続して保存"; renderSettings(); }
    });
    $("#sb-clear-btn").addEventListener("click", async () => { DB.disconnectCloud(); toast("接続を解除しました"); await reload(); });
    $("#wipe-btn").addEventListener("click", () => {
      if (confirm("この端末のローカルデータ（マスタ・セッション・読取）を消去しますか？\nクラウド共有中のデータは消えません。")) {
        DB.wipeLocal(); state.activeSessionId = ""; localStorage.removeItem(LS_ACTIVE); reload();
      }
    });

    DB.onChange(() => reload());
  }

  /* ---------- 起動 ---------- */
  async function main() {
    wire();
    await DB.init();
    renderBadge();
    await seedMasterIfEmpty();
    await seedStoresIfEmpty();
    await reload();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  document.addEventListener("DOMContentLoaded", main);
})();
