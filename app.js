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
  const RACK_SEP = "｜"; // location に「店内在庫｜<ラック名>」の形でラックを含める（スキーマ変更なし）
  const RACK_BASE = "店内在庫"; // ラック選択の対象は店内のみ
  const baseLocation = (loc) => String(loc || "").split(RACK_SEP)[0];
  const rackOf = (loc) => { const p = String(loc || "").split(RACK_SEP); return p.length > 1 ? p.slice(1).join(RACK_SEP) : ""; };
  // 表示用の短いラベル
  function locLabel(loc) {
    const base = baseLocation(loc), rack = rackOf(loc);
    const short = base === "店内在庫" ? "店内" : base === "バックヤード在庫" ? "BY" : base;
    return rack ? `${short}・${rack}` : short;
  }
  // 実際に記録するロケーション（店内でラック指定があれば付与）
  function effectiveLocation() {
    if (state.location === RACK_BASE && state.rack.trim()) return RACK_BASE + RACK_SEP + state.rack.trim();
    return state.location;
  }
  const LS_ACTIVE = "fi_active_session";
  const LS_LOC = "fi_location";
  const LS_RACK = "fi_rack";

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
    rack: localStorage.getItem(LS_RACK) || "",
    pickOpen: false,
    pendingSku: "",
    reportStore: "",
    lastScan: null, // 直前の読取（取消用）: { sku, location, qty }
    rackChecks: {}, // { rack: {status, first_by, first_at, checked_by, checked_at} }
    rackTableMissing: false,
    rackProgOpen: false,
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
    haptic(kind);
  }

  // 振動/ハプティクス。
  // ・Android等: navigator.vibrate（標準）
  // ・iOS 17.4+: <input switch> のトグルで微振動を出せる小技（Safariは
  //   navigator.vibrate 非対応のため）。未対応iOSでは無反応（無害）。
  let _hapticLabel = null;
  function ensureHaptic() {
    if (_hapticLabel) return _hapticLabel;
    try {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", ""); // Safari独自: スイッチ表示＋トグルでハプティクス
      label.appendChild(input);
      document.body.appendChild(label);
      _hapticLabel = label;
    } catch {}
    return _hapticLabel;
  }
  function haptic(kind) {
    try { if (navigator.vibrate) navigator.vibrate(kind === "bad" ? [80, 40, 80] : 45); } catch {}
    try { const l = ensureHaptic(); if (l) l.click(); } catch {}
  }

  // iOSは音源/ハプティクスをユーザー操作中に用意しないと出ない。カメラ開始タップで呼ぶ。
  function unlockAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
    } catch {}
    // ハプティクス用の要素も操作中に用意（iOS）
    try { const l = ensureHaptic(); if (l) l.click(); } catch {}
  }

  // カメラ全面フラッシュ＋大きな確認テキスト（音/振動が出ない端末の主フィードバック）
  let flashT;
  function flashScan(kind, text) {
    const f = document.getElementById("scan-flash");
    if (!f) return;
    const t = document.getElementById("scan-flash-text");
    if (t) t.textContent = text || "";
    f.className = "scan-flash " + kind;
    void f.offsetWidth; // アニメ再起動
    f.classList.add("go");
    clearTimeout(flashT);
    flashT = setTimeout(() => { f.className = "scan-flash"; }, 650);
  }

  // 総点数カウンタを一瞬拡大（増えたことを分かりやすく）
  function pulseTotal() {
    const el = $("#stat-total");
    if (!el) return;
    el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
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
    if (v === "report") reload(); // レポートは常に最新の全店データを取り直す
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
      // ラック確認ステータス（テーブル未作成なら静かに空扱い＋フラグ）
      if (state.activeSessionId) {
        try { state.rackChecks = await DB.getRackChecks(state.activeSessionId); state.rackTableMissing = false; }
        catch (e2) { state.rackChecks = {}; state.rackTableMissing = true; console.warn("rack_checks 未作成の可能性:", e2.message || e2); }
      } else { state.rackChecks = {}; }
    } catch (e) { console.error(e); toast("読込エラー: " + (e.message || e)); }
    finally { loading = false; }
    render();
  }

  function activeSession() { return state.sessions.find((s) => s.id === state.activeSessionId) || null; }
  function setActiveSession(id, doReload = true) {
    state.activeSessionId = id; localStorage.setItem(LS_ACTIVE, id);
    hideUndoLast(); // セッションを切り替えたら直前取消は無効化
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

  // 店内選択時だけラック入力欄を表示し、既出ラックを候補に出す
  function renderRackRow() {
    const row = $("#rack-row"); if (!row) return;
    const show = state.location === RACK_BASE;
    row.hidden = !show;
    $("#rack-status").hidden = !show;
    $("#rackprog-toggle").hidden = !show;
    $("#rackprog-panel").hidden = !show || !state.rackProgOpen;
    if (!show) return;
    const input = $("#rack-input");
    if (document.activeElement !== input) input.value = state.rack;
    // このセッションで既に使われた/ステータス登録済みの店内ラックを候補に
    const racks = rackNames();
    $("#rack-datalist").innerHTML = racks.map((r) => `<option value="${esc(r)}"></option>`).join("");
    renderRackStatus();
    if (state.rackProgOpen) renderRackProgress();
  }

  // このセッションで登場した店内ラック名（読取済み＋ステータス登録済み）
  function rackNames() {
    const set = new Set();
    state.scans.forEach((sc) => { if (baseLocation(sc.location) === RACK_BASE) { const r = rackOf(sc.location); if (r) set.add(r); } });
    Object.keys(state.rackChecks || {}).forEach((r) => set.add(r));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ja"));
  }

  const rackQty = (rack) => state.scans.reduce((a, sc) => a + (baseLocation(sc.location) === RACK_BASE && rackOf(sc.location) === rack ? sc.qty : 0), 0);
  const fmtTime = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

  // 現在入力中ラックの確認ステータス＋操作ボタン
  function renderRackStatus() {
    const el = $("#rack-status"); if (!el) return;
    if (state.rackTableMissing) {
      el.className = "rack-status warn";
      el.innerHTML = `⚠️ ラック確認機能はクラウド側の準備が必要です（設定→SQLを1回実行）。`;
      return;
    }
    const rack = (state.rack || "").trim();
    if (!rack) { el.className = "rack-status"; el.innerHTML = `<span class="rs-hint">ラック名を入れると、仮登録／ダブルチェックの操作ができます。</span>`; return; }
    const c = state.rackChecks[rack];
    const qty = rackQty(rack);
    const status = c ? c.status : "none";
    if (status === "checked") {
      el.className = "rack-status done";
      el.innerHTML = `<div class="rs-info">✅ <b>ダブルチェック完了</b>（${esc(c.checked_by || "?")} ${fmtTime(c.checked_at)}）<br>
        <span class="rs-sub">仮登録: ${esc(c.first_by || "?")} ${fmtTime(c.first_at)} ・ ${qty}点</span></div>
        <button class="btn btn-ghost rs-reset" data-rack-action="reset">取消</button>`;
    } else if (status === "provisional") {
      el.className = "rack-status prov";
      el.innerHTML = `<div class="rs-info">🕒 <b>仮登録済み</b>（${esc(c.first_by || "?")} ${fmtTime(c.first_at)} ・ ${qty}点）<br>
        <span class="rs-sub">別の人がダブルチェックしてください</span></div>
        <button class="btn btn-primary rs-check" data-rack-action="check">ダブルチェック完了</button>
        <button class="btn btn-ghost rs-reset" data-rack-action="reset">取消</button>`;
    } else {
      el.className = "rack-status none";
      el.innerHTML = `<div class="rs-info">このラック「${esc(rack)}」：<b>未確認</b>（${qty}点）</div>
        <button class="btn btn-primary rs-prov" data-rack-action="prov">仮登録（1回目完了）</button>`;
    }
  }

  // ラック進捗一覧（他の人の状況が見える）
  function renderRackProgress() {
    const ul = $("#rackprog-list"); if (!ul) return;
    const racks = rackNames();
    if (!racks.length) { ul.innerHTML = `<li class="empty">まだラックがありません。店内でラック名を入れて読み取ると表示されます。</li>`; return; }
    ul.innerHTML = racks.map((r) => {
      const c = state.rackChecks[r];
      const st = c ? c.status : "none";
      const label = st === "checked" ? "✅ 完了" : st === "provisional" ? "🕒 仮登録" : "⬜ 未確認";
      const who = st === "checked" ? `${esc(c.checked_by || "?")} ${fmtTime(c.checked_at)}` : st === "provisional" ? `${esc(c.first_by || "?")} ${fmtTime(c.first_at)}` : "";
      return `<li class="row rackprog-item rp-${st}" data-rack-pick="${esc(r)}">
        <div class="row-main"><div class="row-name">${esc(r)} <span class="rp-badge rp-badge-${st}">${label}</span></div>
        <div class="row-sub">${rackQty(r)}点${who ? " ・ " + who : ""}</div></div>
        <span class="chev">›</span></li>`;
    }).join("");
  }

  function requireStaff() {
    const name = (DB.getDeviceName() || "").trim();
    if (!name) { toast("先に担当者名を入力してください"); const s = $("#staff-name"); if (s) s.focus(); return null; }
    return name;
  }

  async function markRackProvisional() {
    const rack = (state.rack || "").trim(); if (!rack) { toast("ラック名を入れてください"); return; }
    const who = requireStaff(); if (!who) return;
    try {
      await DB.setRackCheck(state.activeSessionId, rack, { status: "provisional", first_by: who, first_at: new Date().toISOString() });
      haptic("ok"); toast(`「${rack}」を仮登録しました`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId); renderRackRow();
    } catch (e) { toast("仮登録に失敗: " + (e.message || e)); }
  }

  async function markRackChecked() {
    const rack = (state.rack || "").trim(); if (!rack) return;
    const who = requireStaff(); if (!who) return;
    const c = state.rackChecks[rack];
    if (c && c.first_by && c.first_by === who) {
      if (!confirm("仮登録と同じ担当者です。ダブルチェックは別の人が推奨です。このまま完了にしますか？")) return;
    }
    try {
      await DB.setRackCheck(state.activeSessionId, rack, { status: "checked", checked_by: who, checked_at: new Date().toISOString() });
      haptic("ok"); toast(`「${rack}」のダブルチェック完了`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId); renderRackRow();
    } catch (e) { toast("完了処理に失敗: " + (e.message || e)); }
  }

  async function resetRack() {
    const rack = (state.rack || "").trim(); if (!rack) return;
    if (!confirm(`「${rack}」の確認ステータスを取り消しますか？（点数は消えません）`)) return;
    try {
      await DB.removeRackCheck(state.activeSessionId, rack);
      toast(`「${rack}」の確認ステータスを取消しました`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId); renderRackRow();
    } catch (e) { toast("取消に失敗: " + (e.message || e)); }
  }

  function renderScan() {
    $("#session-select").innerHTML =
      state.sessions.map((s) => `<option value="${s.id}" ${s.id === state.activeSessionId ? "selected" : ""}>${esc(sessionLabel(s))}</option>`).join("")
      || `<option value="">セッションなし</option>`;

    $$(".loc-btn").forEach((b) => b.classList.toggle("active", b.dataset.loc === state.location));
    renderRackRow();

    const totalQty = state.scans.reduce((a, s) => a + s.qty, 0);
    const kinds = new Set(state.scans.map((s) => s.sku)).size;
    const unknown = new Set(state.scans.filter((s) => !state.itemMap[s.sku]).map((s) => s.sku)).size;
    $("#stat-total").textContent = totalQty;
    $("#stat-kinds").textContent = kinds;
    $("#stat-unknown").textContent = unknown;

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
        <div class="row-sub"><span class="loc-tag">${esc(locLabel(sc.location))}</span> ${esc(sc.sku)}${sc.device ? " · " + esc(sc.device) : ""}</div></div>
        <span class="row-qty">×${sc.qty}</span>
        <button class="scan-adj" data-action="minus" title="1点減らす" aria-label="1点減らす">−1</button>
        <button class="scan-del" data-action="del" title="この行を削除" aria-label="この行を削除">✕</button></li>`;
    }).join("");
  }

  /* ---------- 手入力モーダル（カテゴリ×価格×着数） ---------- */
  const manualCategories = () =>
    Array.from(new Set(state.items.map((it) => it.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
  const pricesForCategory = (cat) =>
    Array.from(new Set(state.items.filter((it) => it.category === cat && it.price != null && it.price !== "").map((it) => Number(it.price)))).sort((a, b) => a - b);
  function resolveManualSku() {
    const cat = $("#mm-category").value, price = $("#mm-price").value;
    const it = state.items.find((x) => x.category === cat && String(x.price) === String(price));
    return it ? it.sku : null;
  }
  function updateManualHint() {
    const el = $("#mm-hint");
    if (!$("#mm-category").value) { el.textContent = ""; el.className = "mm-hint"; return; }
    const sku = resolveManualSku();
    el.textContent = sku ? `コード: ${sku}` : "⚠️ この組み合わせの商品がマスタにありません";
    el.className = "mm-hint" + (sku ? " ok" : " warn");
  }
  function fillManualPrices() {
    const prices = pricesForCategory($("#mm-category").value);
    $("#mm-price").innerHTML = prices.map((p) => `<option value="${p}">¥${p.toLocaleString("ja-JP")}</option>`).join("")
      || `<option value="">（価格なし）</option>`;
    updateManualHint();
  }
  function openManualModal() {
    if (!activeSession()) { openSessionModal(); return; }
    const cats = manualCategories();
    if (!cats.length) { toast("先にマスタ（商品）を取り込んでください"); return; }
    $("#mm-category").innerHTML = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    fillManualPrices();
    $("#mm-qty").value = "1";
    $("#mm-sub").textContent = "登録先: " + locLabel(effectiveLocation());
    $("#manual-modal").hidden = false;
  }
  function closeManualModal() { $("#manual-modal").hidden = true; }
  async function addManual() {
    const sku = resolveManualSku();
    if (!sku) { toast("該当する商品がマスタにありません"); return; }
    const qty = Math.max(1, parseInt($("#mm-qty").value, 10) || 1);
    closeManualModal();
    await handleScan(sku, qty);
  }

  async function handleScan(rawText, qty) {
    const sku = (rawText || "").trim();
    if (!sku) return;
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const s = activeSession();
    if (!s) { toast("先に棚卸しセッションを作成してください"); showFeedback("bad", "セッション未選択", ""); return; }
    try {
      const loc = effectiveLocation();
      const res = await DB.addScan(state.activeSessionId, sku, DB.getDeviceName(), loc, n);
      const it = res.item;
      const locTag = locLabel(loc);
      const plus = n > 1 ? ` +${n}` : "";
      if (res.status === "matched") { beep("ok"); flashScan("ok", `✓ ＋${n}　${it && it.name ? it.name : "一致"}`); showFeedback("ok", (it && it.name ? it.name : "一致") + " / " + locTag + plus, sku); pulseTotal(); }
      else if (res.status === "new") { beep("ok"); flashScan("new", `✓ ＋${n}　マスタ外（新規）`); showFeedback("new", "マスタ外（新規） / " + locTag + plus, sku); pulseTotal(); }
      else { beep("dup"); flashScan("dup", `＋${n} → 合計 ×${res.qty}　${it && it.name ? it.name : ""}`); showFeedback("dup", `${locTag} ×${res.qty}` + (it && it.name ? " · " + it.name : ""), sku); pulseTotal(); }
      state.lastScan = { sku, location: loc, qty: n };
      showUndoLast(it && it.name ? it.name : (state.itemMap[sku] ? "" : "マスタ外"), n);
      state.scans = await DB.getScans(state.activeSessionId);
      renderScan();
    } catch (e) { beep("bad"); flashScan("bad", "✕ エラー"); showFeedback("bad", "登録エラー", sku); toast(e.message || String(e)); }
  }

  function showUndoLast(name, qty) {
    const b = $("#undo-last"); if (!b) return;
    b.textContent = `↩ 直前を取り消す（${name || ""}${qty > 1 ? " ×" + qty : ""}）`;
    b.hidden = false;
  }
  function hideUndoLast() { const b = $("#undo-last"); if (b) b.hidden = true; state.lastScan = null; }

  async function undoLastScan() {
    const ls = state.lastScan; if (!ls) return;
    try {
      await DB.adjustScan(state.activeSessionId, ls.sku, ls.location, -ls.qty);
      hideUndoLast();
      state.scans = await DB.getScans(state.activeSessionId);
      renderScan(); pulseTotal(); haptic("dup"); toast("直前の読取を取り消しました");
    } catch (err) { toast("取消に失敗: " + (err.message || err)); }
  }

  /* ---------- 数量入力モーダル ---------- */
  function openQtyModal(sku) {
    const it = state.itemMap[sku];
    state.pendingSku = sku;
    $("#qty-title").textContent = it ? (it.name || it.category || "数量を入力") : "数量を入力";
    $("#qty-sub").textContent = `${sku} / ${locLabel(effectiveLocation())}`;
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
    el.className = "scan-feedback " + kind;
    el.innerHTML = `<span>${esc(msg)}</span>` + (sku ? ` <span class="fb-sku">${esc(sku)}</span>` : "");
    void el.offsetWidth; // ポップアニメを毎回再生
    el.classList.add("show");
    clearTimeout(fbT); fbT = setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function toggleCamera() {
    const btn = $("#cam-toggle"), wrap = $("#scanner-wrap"), torchBtn = $("#torch-toggle"), zoomRow = $("#zoom-row");
    if (Scanner.isScanning()) {
      await Scanner.stop(); wrap.classList.remove("scanning");
      btn.textContent = "カメラ開始"; torchBtn.hidden = true; zoomRow.hidden = true;
    } else {
      if (!activeSession()) { openSessionModal(); return; }
      unlockAudio(); // iOSの音を解錠（ユーザー操作中に実行）
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
    scans.forEach((sc) => { const b = baseLocation(sc.location); locSum[b] = (locSum[b] || 0) + sc.qty; });

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
    // 既定は「今開いているセッションの店舗」。無ければ空（先頭店舗を勝手に入れない＝取り違え防止）。
    const cur = activeSession();
    $("#sm-store").value = cur ? (cur.store || "") : "";
    $("#sm-name").value = new Date().toISOString().slice(0, 10); // 棚卸日（既定＝本日）
    $("#sm-close-session").style.display = activeSession() ? "" : "none";
    m.hidden = false;
    setTimeout(() => $("#sm-store").focus(), 50);
  }
  function closeSessionModal() { $("#session-modal").hidden = true; }
  async function createSessionFromModal() {
    const store = $("#sm-store").value.trim();
    const name = $("#sm-name").value.trim() || new Date().toISOString().slice(0, 10);
    if (!store && !confirm("店舗が未選択です。このまま作成しますか？（レポートでは「店舗未設定」に集計されます）")) {
      $("#sm-store").focus(); return;
    }
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
    const rows = [["店舗", "ロケーション", "ラック", "コード", "商品名", "カテゴリ", "単価", "数量"]];
    const sorted = [...scans].sort((a, b) =>
      storeKey(a.store).localeCompare(storeKey(b.store), "ja") ||
      (a.location || "").localeCompare(b.location || "") || (b.qty - a.qty));
    sorted.forEach((sc) => {
      const it = state.itemMap[sc.sku] || {};
      rows.push([storeKey(sc.store), baseLocation(sc.location), rackOf(sc.location), sc.sku, it.name || "", it.category || "", it.price ?? "", sc.qty]);
    });
    const safe = (state.reportStore || "全店舗").replace(/[^\w\-一-龠ぁ-んァ-ヶー]/g, "_");
    download("tanaoroshi_" + safe + ".csv", toCSV(rows));
  }

  /* ---------- イベント配線 ---------- */
  function wire() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

    $("#session-select").addEventListener("change", (e) => setActiveSession(e.target.value));
    $("#new-session-btn").addEventListener("click", openSessionModal);

    // 担当者名（スキャン画面から常時編集可・設定と同期）
    const staffInput = $("#staff-name");
    if (staffInput) {
      staffInput.value = DB.getDeviceName();
      staffInput.addEventListener("input", (e) => {
        DB.setDeviceName(e.target.value);
        const d = $("#device-name"); if (d) d.value = e.target.value;
      });
    }
    $("#undo-last").addEventListener("click", undoLastScan);

    $$(".loc-btn").forEach((b) => b.addEventListener("click", () => {
      state.location = b.dataset.loc; localStorage.setItem(LS_LOC, state.location);
      $$(".loc-btn").forEach((x) => x.classList.toggle("active", x === b));
      renderRackRow();
      toast("ロケーション: " + (state.location === RACK_BASE && state.rack ? "店内・" + state.rack : state.location));
    }));

    // ラック入力（店内のみ）。値は端末に保持。
    const rackInput = $("#rack-input");
    if (rackInput) {
      rackInput.value = state.rack;
      const saveRack = (e) => { state.rack = e.target.value; localStorage.setItem(LS_RACK, state.rack); };
      rackInput.addEventListener("input", (e) => { saveRack(e); renderRackStatus(); });
      rackInput.addEventListener("change", (e) => { saveRack(e); renderRackRow(); });
    }

    // ラック確認ステータスの操作
    $("#rack-status").addEventListener("click", (e) => {
      const a = e.target.closest("[data-rack-action]"); if (!a) return;
      const act = a.dataset.rackAction;
      if (act === "prov") markRackProvisional();
      else if (act === "check") markRackChecked();
      else if (act === "reset") resetRack();
    });

    // ラック進捗パネルの開閉
    $("#rackprog-toggle").addEventListener("click", () => {
      state.rackProgOpen = !state.rackProgOpen;
      $("#rackprog-panel").hidden = !state.rackProgOpen;
      $("#rackprog-toggle").classList.toggle("open", state.rackProgOpen);
      if (state.rackProgOpen) renderRackProgress();
    });
    // 進捗リストのラックをタップ → そのラックを選択
    $("#rackprog-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-rack-pick]"); if (!li) return;
      state.rack = li.dataset.rackPick; localStorage.setItem(LS_RACK, state.rack);
      const ri = $("#rack-input"); if (ri) ri.value = state.rack;
      renderRackRow();
    });

    $("#cam-toggle").addEventListener("click", toggleCamera);
    $("#zoom-range").addEventListener("input", (e) => { Scanner.setZoom(parseFloat(e.target.value)); });
    $("#torch-toggle").addEventListener("click", async function () {
      this._on = !this._on; await Scanner.toggleTorch(this._on);
      this.classList.toggle("btn-primary", this._on);
    });
    // 手入力モーダル
    $("#manual-open").addEventListener("click", openManualModal);
    $("#mm-category").addEventListener("change", fillManualPrices);
    $("#mm-price").addEventListener("change", updateManualHint);
    $("#mm-minus").addEventListener("click", () => { const v = $("#mm-qty"); v.value = Math.max(1, (parseInt(v.value, 10) || 1) - 1); });
    $("#mm-plus").addEventListener("click", () => { const v = $("#mm-qty"); v.value = (parseInt(v.value, 10) || 0) + 1; });
    $$("#manual-modal .qty-quick button").forEach((b) => b.addEventListener("click", () => {
      const v = $("#mm-qty"); v.value = (parseInt(v.value, 10) || 0) + (parseInt(b.dataset.q, 10) || 0);
    }));
    $("#mm-add").addEventListener("click", addManual);
    $("#mm-cancel").addEventListener("click", closeManualModal);
    $("#manual-modal").addEventListener("click", (e) => { if (e.target.id === "manual-modal") closeManualModal(); });

    $("#recent-list").addEventListener("click", async (e) => {
      const li = e.target.closest("[data-sku]"); if (!li) return;
      const sku = li.dataset.sku, loc = li.dataset.loc;
      const act = e.target.closest("[data-action]") && e.target.closest("[data-action]").dataset.action;
      if (act === "minus") {
        try {
          await DB.adjustScan(state.activeSessionId, sku, loc, -1);
          state.scans = await DB.getScans(state.activeSessionId);
          renderScan(); pulseTotal(); beep("dup"); toast("1点取り消しました");
        } catch (err) { toast("取消に失敗: " + (err.message || err)); }
        return;
      }
      if (act === "del") {
        if (!confirm("この行の読取をまとめて削除しますか？")) return;
        try {
          await DB.removeScan(state.activeSessionId, sku, loc);
          state.scans = await DB.getScans(state.activeSessionId);
          renderScan(); pulseTotal(); toast("削除しました");
        } catch (err) { toast("削除に失敗: " + (err.message || err)); }
        return;
      }
      // 行本体タップ: マスタ外なら商品登録モーダル
      if (!state.itemMap[sku]) openItemModal(sku);
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
    $("#device-name").addEventListener("change", (e) => { DB.setDeviceName(e.target.value); const s = $("#staff-name"); if (s) s.value = e.target.value; toast("担当者名を保存"); });
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
