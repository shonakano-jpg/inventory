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
  const TEST_STORE = "テスト店舗"; // 動作確認用の店舗（選択肢に常に出す）
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
  // 登録ラックのテキスト（改行/カンマ区切り・範囲A1-A20対応）を展開して一覧化
  function expandRackTokens(text) {
    const out = [], seen = new Set();
    String(text || "").split(/[\n,、，]/).forEach((raw) => {
      const t = raw.trim(); if (!t) return;
      const m = t.match(/^(.*?)(\d+)\s*[-〜~－ｰ]\s*(\d+)$/);
      if (m) {
        const pre = m[1], a = m[2], b = m[3];
        const s = parseInt(a, 10), e = parseInt(b, 10), pad = a.length;
        if (!isNaN(s) && !isNaN(e) && e >= s && e - s <= 999) {
          for (let i = s; i <= e; i++) { const nm = pre + String(i).padStart(pad, "0"); if (!seen.has(nm)) { seen.add(nm); out.push(nm); } }
          return;
        }
      }
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    });
    return out;
  }
  const racksForStore = (storeName) => {
    const st = (state.stores || []).find((x) => x.name === storeName);
    return st ? expandRackTokens(st.racks || "") : [];
  };
  const currentStoreRacks = () => { const s = activeSession(); return s ? racksForStore(s.store) : []; };
  const LS_ACTIVE = "fi_active_session";
  const LS_LOC = "fi_location";
  const LS_RACK = "fi_rack";
  const LS_RECV_RACK = "fi_recv_rack";
  const LS_PIN = "fi_login_pin";

  const state = {
    view: "home",
    homeStep: 0, // ホームのステップ（0:開始 1:担当者 2:店舗/日付）
    sessions: [],
    activeSessionId: localStorage.getItem(LS_ACTIVE) || "",
    itemMap: {},
    items: [],
    scans: [],
    stores: [],
    allScans: [],
    location: localStorage.getItem(LS_LOC) || "店内在庫",
    rack: localStorage.getItem(LS_RACK) || "",
    recvRack: localStorage.getItem(LS_RECV_RACK) || "入荷",
    pickOpen: false,
    pendingSku: "",
    reportKey: null, // 選択中の店舗×日付グループ { store, date }（null=一覧）
    reportLoc: "", // 詳細でのロケーション絞り込み（""=全体）
    reportStore: null, // レポート一覧の店舗フィルタ（null=未設定→開いた時にアクティブ店舗、""=すべて）
    rackChecks: {}, // { rack: {...} } アクティブセッションのラック確認
    allRackChecks: {}, // { "session_id|rack": {...} } レポート用（全セッション）
    rackTableMissing: false,
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
    // スキャン画面から離れる時はカメラを確実に停止（誤スキャン防止）
    if (v !== "scan" && (Scanner.isScanning() || !$("#cam-modal").hidden)) closeCam();
    state.view = v;
    $$(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
    // マスタは設定内の機能なので、マスタ表示中は「設定」タブを点灯
    const tabFor = (v === "master") ? "settings" : v;
    $$(".tab").forEach((el) => el.classList.toggle("active", el.dataset.view === tabFor));
    document.body.classList.toggle("home-active", v === "home"); // ホームではタブバーを隠す
    // レポートを開いた時、店舗フィルタ未設定なら「選択中（棚卸し中）の店舗」に絞る
    if (v === "report" && state.reportStore === null) {
      const s = activeSession();
      state.reportStore = (s && s.store) ? storeKey(s.store) : "";
    }
    render();
    if (v === "report" || v === "check" || v === "home" || v === "receiving") reload(); // 最新データを取り直す
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
      try { state.allRackChecks = await DB.getAllRackChecks(); } catch { state.allRackChecks = {}; }
    } catch (e) { console.error(e); toast("読込エラー: " + (e.message || e)); }
    finally { loading = false; }
    _confirmCtx = null; // 確認状態キャッシュを作り直す
    render();
    if (state.view === "home") renderPsList(); // ホーム表示中は入力中一覧も更新
  }

  function activeSession() { return state.sessions.find((s) => s.id === state.activeSessionId) || null; }
  // セッション状態: open（作業中）/ final（本確定=変更不可）。'closed'も変更不可扱い。
  function sessionLocked(s) { const st = (s || activeSession()); const v = st && st.status; return v === "final" || v === "closed"; }
  function ensureEditable() {
    if (sessionLocked()) { toast("本確定済みのため変更できません（レポートで解除できます）"); return false; }
    return true;
  }
  // クラウド未接続なら読み取り不可（この端末だけに保存されて共有されない事故を防ぐ）
  function ensureOnline() {
    if (DB.mode !== "cloud") { toast("クラウド未接続のため読み取りできません。通信を確認して画面を再読み込みしてください"); return false; }
    return true;
  }
  function setActiveSession(id, doReload = true) {
    state.activeSessionId = id; localStorage.setItem(LS_ACTIVE, id);
    if (doReload) reload();
  }
  function knownStores() {
    const set = new Set(state.stores.map((s) => s.name));
    state.sessions.forEach((s) => { if (s.store) set.add(s.store); });
    set.add(TEST_STORE); // 動作確認用の店舗を常に候補に
    return Array.from(set);
  }

  /* ---------- 描画 ---------- */
  function render() {
    renderBadge();
    renderCheckBadge();
    if (state.view === "home") renderHome();
    else if (state.view === "scan") renderScan();
    else if (state.view === "check") renderCheckView();
    else if (state.view === "receiving") renderReceiving();
    else if (state.view === "master") renderMaster();
    else if (state.view === "report") renderReport();
    else if (state.view === "settings") renderSettings();
  }

  // 「確認待ち」タブの件数バッジ
  function renderCheckBadge() {
    const b = $("#check-badge"); if (!b) return;
    const n = state.rackTableMissing ? 0 : provisionalRacks().length;
    if (n > 0) { b.textContent = n; b.hidden = false; } else { b.hidden = true; }
  }

  // 確認待ち（ダブルチェック）ビュー
  function renderCheckView() {
    const sub = $("#check-sub");
    if (sub) {
      const s = activeSession();
      if (state.rackTableMissing) sub.textContent = "クラウド側の準備が必要です（設定→SQLを1回実行）。";
      else sub.textContent = s ? `${s.store || "（店舗未設定）"} / ${s.name}` : "棚卸しを選んでください。";
    }
    renderRackProgress();
    renderUnconfirmedList();
    renderDcList();
  }

  // 登録ラックの進捗（漏れチェック）
  function renderRackProgress() {
    const box = $("#rack-progress"); if (!box) return;
    const regs = currentStoreRacks();
    if (!regs.length) { box.innerHTML = `<div class="muted" style="font-size:13px">この店舗はラック未登録です。設定→店舗マスタ→「🧱 ラック」で登録すると、ここに漏れチェックが出ます。</div>`; return; }
    const counts = { checked: 0, provisional: 0, read: 0, none: 0 };
    const chips = regs.map((r) => {
      const st = rackStatusOf(r); counts[st]++;
      const icon = st === "checked" ? "✅" : st === "provisional" ? "🕒" : st === "read" ? "🔶" : "⬜";
      return `<span class="rack-chip st-${st}">${icon} ${esc(r)}</span>`;
    }).join("");
    const done = counts.checked, remain = regs.length - done;
    box.innerHTML =
      `<div class="rack-prog-sum">確認済 <b>${done}</b> / 登録 <b>${regs.length}</b>本${remain ? `　残り ${remain}（⬜未読取 ${counts.none}・🔶読取のみ ${counts.read}・🕒仮登録 ${counts.provisional}）` : "　🎉 全ラック確認済み"}</div>
       <div class="rack-chips show">${chips}</div>`;
  }

  /* === スキャン === */
  function sessionLabel(s) { return (s.store ? s.store + " / " : "") + s.name + (s.status === "closed" ? "（完了）" : ""); }

  // 確認単位: 店内=ラック / バックヤード・その他倉庫=そのロケーション全体
  const LOC_BY = "バックヤード在庫", LOC_OTHER = "その他倉庫";
  const isLocUnit = (u) => u === LOC_BY || u === LOC_OTHER;
  function currentUnit() {
    if (state.location === RACK_BASE) return (state.rack || "").trim();
    return state.location; // "バックヤード在庫" / "その他倉庫"
  }
  const unitLabel = (unit) => unit === LOC_BY ? "バックヤード" : unit === LOC_OTHER ? "その他倉庫" : "ラック " + unit;
  function unitScans(unit) {
    if (isLocUnit(unit)) return state.scans.filter((sc) => baseLocation(sc.location) === unit);
    return state.scans.filter((sc) => baseLocation(sc.location) === RACK_BASE && rackOf(sc.location) === unit);
  }
  const unitQty = (unit) => unitScans(unit).reduce((a, sc) => a + sc.qty, 0);

  // 店内=ラック入力欄を表示。確認ステータス欄はどのロケーションでも表示。
  function renderRackRow() {
    const inStore = state.location === RACK_BASE;
    $("#rack-row").hidden = !inStore;
    $("#rack-status").hidden = false;
    if (inStore) {
      const input = $("#rack-input");
      if (document.activeElement !== input) input.value = state.rack;
      $("#rack-datalist").innerHTML = rackNames().map((r) => `<option value="${esc(r)}"></option>`).join("");
      renderRackChips();
    } else { const box = $("#rack-chips"); if (box) { box.hidden = true; box.innerHTML = ""; } }
    renderRackStatus();
  }

  // このセッションで登場した店内ラック名（登録ラック＋読取済み＋ステータス登録済み）
  function rackNames() {
    const set = new Set(currentStoreRacks());
    state.scans.forEach((sc) => { if (baseLocation(sc.location) === RACK_BASE) { const r = rackOf(sc.location); if (r) set.add(r); } });
    Object.keys(state.rackChecks || {}).forEach((r) => { if (!isLocUnit(r)) set.add(r); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  }
  // ラックの状態（このセッション）: checked / provisional / read（読取のみ）/ none（未読取）
  function rackStatusOf(rack) {
    const c = state.rackChecks[rack];
    if (c && c.status === "checked") return "checked";
    if (c && c.status === "provisional") return "provisional";
    const has = state.scans.some((sc) => baseLocation(sc.location) === RACK_BASE && rackOf(sc.location) === rack);
    return has ? "read" : "none";
  }
  // 登録ラックをチップ表示（状態色つき・タップで選択）
  function renderRackChips() {
    const box = $("#rack-chips"); if (!box) return;
    const regs = currentStoreRacks();
    if (!regs.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const cur = (state.rack || "").trim();
    box.innerHTML = regs.map((r) => {
      const st = rackStatusOf(r);
      const icon = st === "checked" ? "✅" : st === "provisional" ? "🕒" : st === "read" ? "🔶" : "⬜";
      return `<button class="rack-chip st-${st}${r === cur ? " sel" : ""}" data-rack="${esc(r)}">${icon} ${esc(r)}</button>`;
    }).join("");
  }

  const fmtTime = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const fmtDateTime = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`; };

  // 現在の単位の確認ステータス＋操作（仮登録／取消）。BY・その他は「ラック」表記なし。
  function renderRackStatus() {
    const el = $("#rack-status"); if (!el) return;
    if (state.rackTableMissing) {
      el.className = "rack-status warn";
      el.innerHTML = `⚠️ 仮登録／ダブルチェックはクラウド側の準備が必要です（設定→SQLを1回実行）。`;
      return;
    }
    const inStore = state.location === RACK_BASE;
    const unit = currentUnit();
    if (inStore && !unit) { el.className = "rack-status"; el.innerHTML = `<span class="rs-hint">ラック名を入れて読み取り、終わったら「仮登録」を押してください。ダブルチェックは「確認待ち」タブから別の人が行います。</span>`; return; }
    const c = state.rackChecks[unit];
    const qty = unitQty(unit);
    const status = c ? c.status : "none";
    const title = inStore ? `ラック「${esc(unit)}」` : esc(unitLabel(unit));
    if (status === "checked") {
      el.className = "rack-status done";
      el.innerHTML = `<div class="rs-info">✅ <b>ダブルチェック完了</b>（${esc(c.checked_by || "?")} ${fmtTime(c.checked_at)}）<br>
        <span class="rs-sub">${title}・仮登録 ${esc(c.first_by || "?")} ・ ${qty}点</span></div>
        <button class="btn btn-ghost rs-reset" data-rack-action="reset">取消</button>`;
    } else if (status === "provisional") {
      el.className = "rack-status prov";
      el.innerHTML = `<div class="rs-info">🕒 <b>仮登録済み</b>（${esc(c.first_by || "?")} ${fmtTime(c.first_at)} ・ ${qty}点）<br>
        <span class="rs-sub">別の人が「確認待ち」からダブルチェックします</span></div>
        <button class="btn btn-ghost rs-reset" data-rack-action="reset">取消</button>`;
    } else {
      el.className = "rack-status none";
      el.innerHTML = `<div class="rs-info">${title}：<b>未確認</b>（${qty}点）</div>
        <button class="btn btn-primary rs-prov" data-rack-action="prov">仮登録（1回目完了）</button>`;
    }
  }

  /* ---------- ダブルチェック待ち（仮登録済みを別の人が確認） ---------- */
  let dcDrafts = {}; // rack -> 確認者名の入力中テキスト
  const provisionalRacks = () => Object.entries(state.rackChecks || {})
    .filter(([, c]) => c && c.status === "provisional")
    .map(([rack, c]) => ({ rack, c }))
    .sort((a, b) => (a.c.first_at || "").localeCompare(b.c.first_at || ""));

  function renderDcList() {
    const ul = $("#dc-list"); if (!ul) return;
    // 名前を入力中は再描画しない（入力が消えないように）
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("dc-checker")) return;
    const rows = provisionalRacks();
    if (!rows.length) { ul.innerHTML = `<li class="empty">ダブルチェック待ちはありません。</li>`; return; }
    ul.innerHTML = rows.map(({ rack, c }) => {
      const qty = unitQty(rack);
      return `<li class="dc-row" data-rack="${esc(rack)}">
        <div class="dc-head">
          <div class="dc-name"><b>${esc(unitLabel(rack))}</b></div>
          <div class="dc-qty">仮登録の着数 <b>${qty}点</b></div>
        </div>
        <div class="dc-sub">仮登録: ${esc(c.first_by || "?")} ${fmtTime(c.first_at)}</div>
        <div class="dc-q">この着数で合っていますか？</div>
        <div class="dc-act">
          <input class="dc-checker" data-rack="${esc(rack)}" placeholder="確認した人の名前" value="${esc(dcDrafts[rack] || "")}" autocomplete="off" />
          <button class="btn btn-primary dc-done" data-rack="${esc(rack)}">ダブルチェック完了</button>
        </div>
        <button class="btn dc-recheck" data-rack="${esc(rack)}">数が違う → 再確認（読み直す）</button>
      </li>`;
    }).join("");
  }

  // まだ仮登録していない場所（読取はあるが確認ステータスが無い＝未確認）
  function unconfirmedUnits() {
    const map = {}; // key -> { label, qty, unit, orphan }
    state.scans.forEach((sc) => {
      const base = baseLocation(sc.location);
      const unit = base === RACK_BASE ? rackOf(sc.location) : base;
      if (base === RACK_BASE && !unit) {
        const m = map["__orphan__"] || (map["__orphan__"] = { label: "店内（ラック未設定）", qty: 0, orphan: true });
        m.qty += sc.qty; return;
      }
      const c = state.rackChecks[unit];
      if (c && (c.status === "provisional" || c.status === "checked")) return; // 既に仮登録/確認済み
      const m = map[unit] || (map[unit] = { label: base === RACK_BASE ? "ラック " + unit : unitLabel(unit), qty: 0, unit });
      m.qty += sc.qty;
    });
    return Object.values(map).sort((a, b) => b.qty - a.qty);
  }
  function renderUnconfirmedList() {
    const ul = $("#unconfirmed-list"); if (!ul) return;
    const rows = unconfirmedUnits();
    if (!rows.length) { ul.innerHTML = `<li class="empty">未確認の場所はありません。</li>`; return; }
    ul.innerHTML = rows.map((m) => {
      if (m.orphan) {
        return `<li class="dc-row"><div class="dc-head"><div class="dc-name"><b>⚠️ ${esc(m.label)}</b></div><div class="dc-qty"><b>${m.qty}点</b></div></div>
          <div class="dc-sub">ラックが無いため確定（ダブルチェック）できません。ラックを付けると、仮登録→ダブルチェックできるようになります。</div>
          <button class="btn btn-primary uc-assign">ラックを付ける</button></li>`;
      }
      return `<li class="dc-row"><div class="dc-head"><div class="dc-name"><b>${esc(m.label)}</b></div><div class="dc-qty">読取 <b>${m.qty}点</b></div></div>
        <div class="dc-sub">まだ仮登録していません。数え終わっていれば仮登録してください。</div>
        <button class="btn btn-primary uc-prov" data-unit="${esc(m.unit)}" data-label="${esc(m.label)}">仮登録（1回目完了）</button></li>`;
    }).join("");
  }
  // 「確認待ち」タブから任意の単位を仮登録
  async function markUnitProvisional(unit, label) {
    if (!ensureEditable()) return;
    unit = (unit || "").trim(); if (!unit) return;
    const who = requireStaff(); if (!who) return;
    const qty = unitQty(unit);
    if (!confirm(`${label}（${qty}点）を仮登録します。よろしいですか？\n（この後は別の人がダブルチェックします）`)) return;
    try {
      await DB.setRackCheck(state.activeSessionId, unit, { status: "provisional", first_by: who, first_at: new Date().toISOString() });
      haptic("ok"); toast(`${label}を仮登録しました`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId);
      renderCheckView(); renderCheckBadge();
      if (state.view === "scan") renderScan();
    } catch (e) { toast("仮登録に失敗: " + (e.message || e)); }
  }

  // 店内でラック名なしの読取に、後からラック名を付ける（確定できるようにする）
  async function assignRackToOrphans() {
    if (!ensureEditable()) return;
    const orphans = state.scans.filter((sc) => baseLocation(sc.location) === RACK_BASE && !rackOf(sc.location));
    if (!orphans.length) { toast("対象の読取がありません"); return; }
    const qty = orphans.reduce((a, s) => a + s.qty, 0);
    const rack = (prompt(`店内でラック名なしの読取（${qty}点）にラック名を付けます。\nラック名を入力してください（例：店内その他）`, "店内その他") || "").trim();
    if (!rack) return;
    const newLoc = RACK_BASE + RACK_SEP + rack;
    try {
      for (const sc of orphans) {
        // 先に付け替え先へ加算 → 元を削除（途中で失敗してもデータは消えない）
        await DB.addScan(state.activeSessionId, sc.sku, sc.device || DB.getDeviceName(), newLoc, sc.qty);
        await DB.removeScan(state.activeSessionId, sc.sku, sc.location);
      }
      state.scans = await DB.getScans(state.activeSessionId);
      toast(`ラック「${rack}」に付け替えました。確認待ちで仮登録→ダブルチェックしてください`);
      renderCheckView(); renderCheckBadge();
      if (state.view === "scan") renderScan();
    } catch (e) { toast("付け替えに失敗: " + (e.message || e)); }
  }

  function requireStaff() {
    const name = (DB.getDeviceName() || "").trim();
    if (!name) { toast("先に担当者名を入力してください"); const s = $("#staff-name"); if (s) s.focus(); return null; }
    return name;
  }

  async function markRackProvisional() {
    if (!ensureEditable()) return;
    const inStore = state.location === RACK_BASE;
    const unit = currentUnit();
    if (inStore && !unit) { toast("ラック名を入れてください"); return; }
    const who = requireStaff(); if (!who) return;
    const qty = unitQty(unit);
    if (!confirm(`${unitLabel(unit)}（${qty}点）を仮登録します。よろしいですか？\n（この後は別の人がダブルチェックします）`)) return;
    try {
      await DB.setRackCheck(state.activeSessionId, unit, { status: "provisional", first_by: who, first_at: new Date().toISOString() });
      haptic("ok");
      toast(inStore ? `「${unit}」を仮登録しました。次のラックへどうぞ` : `${unitLabel(unit)}を仮登録しました`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId);
      if (inStore) { // 店内は本人が次のラックへ → ラック欄クリア
        state.rack = ""; localStorage.setItem(LS_RACK, "");
        const ri = $("#rack-input"); if (ri) ri.value = "";
      }
      renderScan(); renderCheckBadge(); // 最近の読取から仮登録分を消す（リセット）
    } catch (e) { toast("仮登録に失敗: " + (e.message || e)); }
  }

  // ダブルチェック完了（「確認待ち」タブから任意の単位を確認）
  async function markRackChecked(unit, who) {
    if (!ensureEditable()) return false;
    unit = (unit || "").trim(); who = (who || "").trim();
    if (!unit) return false;
    if (!who) { toast("確認した人の名前を入れてください"); return false; }
    const c = state.rackChecks[unit];
    if (c && c.first_by && c.first_by === who) {
      if (!confirm("仮登録と同じ担当者です。ダブルチェックは別の人が推奨です。このまま完了にしますか？")) return false;
    }
    try {
      await DB.setRackCheck(state.activeSessionId, unit, { status: "checked", checked_by: who, checked_at: new Date().toISOString() });
      delete dcDrafts[unit];
      haptic("ok"); toast(`${unitLabel(unit)} ダブルチェック完了（${who}）`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId);
      renderRackRow(); renderCheckBadge();
      if (state.view === "check") renderCheckView();
      if (state.view === "scan") renderScan();
      return true;
    } catch (e) { toast("完了処理に失敗: " + (e.message || e)); return false; }
  }

  // 再確認（数が違う）→ その単位の読取を全消去＋確認ステータス取消し（0にして読み直す）
  async function reCheckUnit(unit) {
    if (!ensureEditable()) return;
    unit = (unit || "").trim(); if (!unit) return;
    const qty = unitQty(unit);
    if (!confirm(`${unitLabel(unit)}の読取（${qty}点）をすべて消して、最初から読み直しますか？（元に戻せません）`)) return;
    try {
      const scans = unitScans(unit);
      for (const sc of scans) await DB.removeScan(state.activeSessionId, sc.sku, sc.location);
      await DB.removeRackCheck(state.activeSessionId, unit);
      delete dcDrafts[unit];
      state.scans = await DB.getScans(state.activeSessionId);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId);
      toast(`${unitLabel(unit)}をリセットしました。もう一度読み込んでください。`);
      renderScan(); renderCheckBadge();
      if (state.view === "check") renderCheckView();
    } catch (e) { toast("再確認に失敗: " + (e.message || e)); }
  }

  async function resetRack() {
    const unit = currentUnit(); if (!unit) return;
    if (!confirm(`${unitLabel(unit)}の確認ステータスを取り消しますか？（点数は消えません）`)) return;
    try {
      await DB.removeRackCheck(state.activeSessionId, unit);
      toast(`${unitLabel(unit)}の確認ステータスを取消しました`);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId);
      renderScan(); renderCheckBadge();
    } catch (e) { toast("取消に失敗: " + (e.message || e)); }
  }

  function renderScan() {
    $("#session-select").innerHTML =
      state.sessions.map((s) => `<option value="${s.id}" ${s.id === state.activeSessionId ? "selected" : ""}>${esc(sessionLabel(s))}</option>`).join("")
      || `<option value="">セッションなし</option>`;

    $$(".loc-btn").forEach((b) => b.classList.toggle("active", b.dataset.loc === state.location));
    const offline = (DB.mode !== "cloud"); // 未接続なら読み取り不可＋警告
    const ob = $("#offline-banner"); if (ob) ob.hidden = !offline;
    renderRackRow();

    // 確定ステータス（バッジ・ロック表示・操作可否）
    const sess = activeSession();
    const st = sess ? (sess.status || "open") : "open";
    const locked = st === "final" || st === "closed";
    const badge = $("#session-status");
    if (locked) { badge.hidden = false; badge.textContent = "🔒 本確定"; badge.className = "session-status st-final"; }
    else { badge.hidden = true; }
    $("#locked-banner").hidden = !locked;
    [["#cam-open", locked || offline], ["#manual-open", locked || offline]]
      .forEach(([sel, dis]) => { const el = $(sel); if (el) el.disabled = !!dis; });

    const totalQty = state.scans.reduce((a, s) => a + s.qty, 0);
    const kinds = new Set(state.scans.map((s) => s.sku)).size;
    const unknown = new Set(state.scans.filter((s) => !state.itemMap[s.sku]).map((s) => s.sku)).size;
    $("#stat-total").textContent = totalQty;
    $("#stat-kinds").textContent = kinds;
    $("#stat-unknown").textContent = unknown;
    updateCamCount();

    renderRecentList(locked);
  }

  // 仮登録／ダブルチェック済みの単位の読取か（＝最近の読取から消す対象）
  function isUnitRegistered(sc) {
    const base = baseLocation(sc.location);
    const unit = (base === RACK_BASE) ? rackOf(sc.location) : base;
    if (base === RACK_BASE && !unit) return false; // 店内でラック未設定は消さない
    const c = state.rackChecks[unit];
    return !!(c && (c.status === "provisional" || c.status === "checked"));
  }

  // 最近の読取（店内 / バックヤード / その他倉庫 に分割）
  //  店内ラックは仮登録すると一覧から消して次のラックへ。
  //  バックヤード・その他倉庫は仮登録後も残し、1点ずつ修正（−1/✕）できるようにする。
  function renderRecentList(locked) {
    const list = $("#recent-list");
    const groups = { "店内在庫": [], "バックヤード在庫": [], "その他倉庫": [] };
    let shown = 0;
    state.scans.forEach((sc) => {
      const base = baseLocation(sc.location);
      if (base === RACK_BASE && isUnitRegistered(sc)) return; // 店内ラックだけ仮登録で非表示
      if (groups[base]) { groups[base].push(sc); shown++; }
    });
    if (!state.scans.length) {
      list.innerHTML = `<li class="empty">まだ読み取りがありません。<br>上でロケーションを選び「カメラ開始」。</li>`;
      return;
    }
    if (!shown) {
      list.innerHTML = `<li class="empty">表示する読取はありません。<br>（店内は仮登録すると最近の読取から消えます）</li>`;
      return;
    }
    // その単位の確認状態タグ（BY/その他は仮登録後も表示されるので、状態が分かるように）
    const regTag = (sc) => {
      const base = baseLocation(sc.location);
      const unit = base === RACK_BASE ? rackOf(sc.location) : base;
      const c = unit && state.rackChecks[unit];
      if (!c) return "";
      return c.status === "checked"
        ? `<span class="pill pill-done">確認済</span>`
        : `<span class="pill pill-prov">仮登録済</span>`;
    };
    const rowHtml = (sc) => {
      const it = state.itemMap[sc.sku];
      const name = it ? esc(it.name || "(名称なし)") : "マスタ外の商品";
      const pill = it ? `<span class="pill pill-ok">一致</span>` : `<span class="pill pill-new">マスタ外</span>`;
      const actions = locked ? "" :
        `<button class="scan-adj" data-action="minus" title="1点減らす" aria-label="1点減らす">−1</button>
        <button class="scan-del" data-action="del" title="この行を削除" aria-label="この行を削除">✕</button>`;
      return `<li class="row" data-sku="${esc(sc.sku)}" data-loc="${esc(sc.location)}">
        <div class="row-main"><div class="row-name">${name} ${pill}${regTag(sc)}</div>
        <div class="row-sub"><span class="loc-tag">${esc(locLabel(sc.location))}</span> ${esc(sc.sku)}${sc.device ? " · " + esc(sc.device) : ""}</div></div>
        <span class="row-qty">×${sc.qty}</span>
        ${actions}</li>`;
    };
    const secLabel = { "店内在庫": "店内", "バックヤード在庫": "バックヤード", "その他倉庫": "その他倉庫" };
    list.innerHTML = LOCATIONS.map((key) => {
      const arr = groups[key]; if (!arr.length) return "";
      const q = arr.reduce((a, s) => a + s.qty, 0);
      return `<li class="recent-sec">${secLabel[key]}（${arr.length}品目・${q}点）</li>` + arr.slice(0, 40).map(rowHtml).join("");
    }).join("");
  }

  /* ---------- 手入力モーダル（カテゴリ×価格×着数） ---------- */
  const UNKNOWN_PRICE = "__unknown__"; // 価格帯「不明」の選択肢の値
  const manualCategories = () =>
    Array.from(new Set(state.items.map((it) => it.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
  const pricesForCategory = (cat) =>
    Array.from(new Set(state.items.filter((it) => it.category === cat && it.price != null && it.price !== "").map((it) => Number(it.price)))).sort((a, b) => a - b);
  // そのカテゴリの「価格不明」マスタ品を探す（無ければnull）
  const unknownPriceItem = (cat) => state.items.find((x) => x.category === cat && (x.price == null || x.price === "")) || null;
  function resolveManualSku() {
    const cat = $("#mm-category").value, price = $("#mm-price").value;
    if (price === UNKNOWN_PRICE) { const it = unknownPriceItem(cat); return it ? it.sku : null; }
    const it = state.items.find((x) => x.category === cat && String(x.price) === String(price));
    return it ? it.sku : null;
  }
  function updateManualHint() {
    const el = $("#mm-hint");
    const cat = $("#mm-category").value;
    if (!cat) { el.textContent = ""; el.className = "mm-hint"; return; }
    if ($("#mm-price").value === UNKNOWN_PRICE) {
      el.textContent = `価格不明として登録します（カテゴリ: ${cat}）`;
      el.className = "mm-hint ok";
      return;
    }
    const sku = resolveManualSku();
    el.textContent = sku ? `コード: ${sku}` : "⚠️ この組み合わせの商品がマスタにありません";
    el.className = "mm-hint" + (sku ? " ok" : " warn");
  }
  function fillManualPrices() {
    const prices = pricesForCategory($("#mm-category").value);
    const opts = prices.map((p) => `<option value="${p}">¥${p.toLocaleString("ja-JP")}</option>`);
    opts.push(`<option value="${UNKNOWN_PRICE}">不明（価格が分からない）</option>`);
    $("#mm-price").innerHTML = opts.join("");
    updateManualHint();
  }
  // カテゴリの「価格不明」コードを用意（無ければマスタに作成）してskuを返す
  async function ensureUnknownPriceSku(cat) {
    const existing = unknownPriceItem(cat);
    if (existing) return existing.sku;
    const sku = "UNK-" + cat; // 手入力専用のテキストコード（バーコードとは衝突しない）
    await DB.upsertItem({ sku, name: cat + " ¥不明", category: cat, price: "", expected: "" });
    state.itemMap = await DB.getItemMap();
    state.items = Object.values(state.itemMap).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
    return sku;
  }
  function openManualModal() {
    if (!activeSession()) { openPickSession(); return; }
    if (!ensureOnline()) return;
    if (!ensureEditable()) return;
    if (state.location === RACK_BASE && !state.rack.trim()) { toast("店内は先にラック名を入れてください"); const ri = $("#rack-input"); if (ri) ri.focus(); return; }
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
    const cat = $("#mm-category").value;
    const priceVal = $("#mm-price").value;
    const qty = Math.max(1, parseInt($("#mm-qty").value, 10) || 1);
    let sku;
    if (priceVal === UNKNOWN_PRICE) {
      if (!cat) { toast("カテゴリを選んでください"); return; }
      try { sku = await ensureUnknownPriceSku(cat); }
      catch (e) { toast("登録準備に失敗: " + (e.message || e)); return; }
    } else {
      sku = resolveManualSku();
      if (!sku) { toast("該当する商品がマスタにありません"); return; }
    }
    closeManualModal();
    await handleScan(sku, qty);
  }

  async function handleScan(rawText, qty) {
    const sku = (rawText || "").trim();
    if (!sku) return;
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const s = activeSession();
    if (!s) { toast("先に棚卸しセッションを作成してください"); showFeedback("bad", "セッション未選択", ""); return; }
    if (!ensureOnline()) { showFeedback("bad", "クラウド未接続（共有されません）", ""); return; }
    if (!ensureEditable()) { showFeedback("bad", "本確定済み（変更不可）", ""); return; }
    // 店内はラック名が無いと確定（ダブルチェック）できないため、読み取り自体を止める
    if (state.location === RACK_BASE && !state.rack.trim()) {
      beep("bad"); flashScan("bad", "✕ ラック名を入れてください");
      showFeedback("bad", "店内は先にラック名を入力してください", "");
      const ri = $("#rack-input"); if (ri) ri.focus();
      return;
    }
    try {
      const loc = effectiveLocation();
      const res = await DB.addScan(state.activeSessionId, sku, DB.getDeviceName(), loc, n);
      const it = res.item;
      const locTag = locLabel(loc);
      const plus = n > 1 ? ` +${n}` : "";
      if (res.status === "matched") { beep("ok"); flashScan("ok", `✓ ＋${n}　${it && it.name ? it.name : "一致"}`); showFeedback("ok", (it && it.name ? it.name : "一致") + " / " + locTag + plus, sku); pulseTotal(); }
      else if (res.status === "new") { beep("ok"); flashScan("new", `✓ ＋${n}　マスタ外（新規）`); showFeedback("new", "マスタ外（新規） / " + locTag + plus, sku); pulseTotal(); }
      else { beep("dup"); flashScan("dup", `＋${n} → 合計 ×${res.qty}　${it && it.name ? it.name : ""}`); showFeedback("dup", `${locTag} ×${res.qty}` + (it && it.name ? " · " + it.name : ""), sku); pulseTotal(); }
      state.scans = await DB.getScans(state.activeSessionId);
      renderScan();
      // 仮登録／確認済みの場所に追加した時は、気づけるように警告（黙って足さない）
      const b = baseLocation(loc);
      const unit = b === RACK_BASE ? rackOf(loc) : b;
      const rc = unit && state.rackChecks[unit];
      if (rc && (rc.status === "provisional" || rc.status === "checked")) {
        toast(`⚠️ ${unitLabel(unit)}は${rc.status === "checked" ? "確認済み" : "仮登録済み"}です。追加しました（間違いなら −1／✕ で修正）`);
      }
    } catch (e) { beep("bad"); flashScan("bad", "✕ エラー"); showFeedback("bad", "登録エラー", sku); toast(e.message || String(e)); }
  }

  /* ---------- 入荷（店内在庫に追加。即カウント＝ダブルチェック不要） ---------- */
  const recvRackName = () => (state.recvRack || "入荷").trim() || "入荷";
  async function handleReceivingScan(rawText, qty) {
    const sku = (rawText || "").trim(); if (!sku) return;
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const s = activeSession();
    if (!s) { toast("先に店舗（棚卸し）を選んでください"); showFeedback("bad", "店舗未選択", ""); return; }
    if (!ensureOnline()) { showFeedback("bad", "クラウド未接続", ""); return; }
    const rack = recvRackName();
    const loc = RACK_BASE + RACK_SEP + rack;
    try {
      const res = await DB.addScan(state.activeSessionId, sku, DB.getDeviceName(), loc, n);
      // 入荷ラックは自動でダブルチェック完了扱い（すぐ比率に反映）
      const c = state.rackChecks[rack];
      if (!c || c.status !== "checked") {
        const nowIso = new Date().toISOString();
        await DB.setRackCheck(state.activeSessionId, rack, { status: "checked", first_by: "入荷", first_at: nowIso, checked_by: "入荷", checked_at: nowIso });
      }
      const it = res.item;
      beep("ok"); flashScan("ok", `✓ 入荷 ＋${n}　${it && it.name ? it.name : "マスタ外"}`);
      showFeedback("ok", `入荷「${rack}」に追加${it && it.name ? " ・ " + it.name : ""}`, sku);
      state.scans = await DB.getScans(state.activeSessionId);
      state.rackChecks = await DB.getRackChecks(state.activeSessionId);
      _confirmCtx = null;
      renderReceiving();
    } catch (e) { beep("bad"); flashScan("bad", "✕ エラー"); showFeedback("bad", "入荷の登録エラー", sku); toast(e.message || String(e)); }
  }
  // アクティブセッションの「店内・確定済み」読取
  function inStoreConfirmedScans() {
    return state.scans.filter((sc) => {
      if (baseLocation(sc.location) !== RACK_BASE) return false;
      const r = rackOf(sc.location); if (!r) return false;
      const c = state.rackChecks[r];
      return !!(c && c.status === "checked");
    });
  }
  function renderReceiving() {
    const s = activeSession();
    const sub = $("#recv-store");
    if (sub) sub.textContent = s ? `${s.store || "（店舗未設定）"} / ${s.name}` : "先に店舗（棚卸し）を選んでください。";
    const ob = $("#recv-offline"); if (ob) ob.hidden = (DB.mode === "cloud");
    const ri = $("#recv-rack");
    if (ri && document.activeElement !== ri) ri.value = state.recvRack || "";
    const dl = $("#recv-rack-list"); if (dl) dl.innerHTML = rackNames().map((r) => `<option value="${esc(r)}"></option>`).join("");
    const cam = $("#recv-cam"); if (cam) cam.disabled = (DB.mode !== "cloud" || !s);
    const rack = recvRackName();
    const recvQty = state.scans.filter((sc) => baseLocation(sc.location) === RACK_BASE && rackOf(sc.location) === rack).reduce((a, x) => a + x.qty, 0);
    $("#recv-total").textContent = recvQty;
    // 店内比率（確定済み・小物除く。入荷分を含む）
    const conf = inStoreConfirmedScans();
    const g = conf.filter((sc) => !isKomono(sc));
    const gt = sumQty(g);
    $("#recv-instore").textContent = gt;
    const box = $("#recv-ratio");
    if (box) box.innerHTML = gt
      ? `<h3 class="chart-title">店内のカテゴリ比率（入荷を含む）</h3>${barChart(catSumOf(g), gt, "cat")}
         <h3 class="chart-title">店内の価格帯比率</h3>${barChart(priceSumOf(g), gt, "price")}`
      : `<div class="empty">まだ確定済みの店内在庫がありません。入荷を読み取ると比率が出ます。</div>`;
  }

  /* ---------- 確定ワークフロー ---------- */
  async function finalizeStore() {
    if (!state.reportKey) return;
    const { store, date } = state.reportKey;
    const sess = reportGroupSessions();
    if (!sess.length) { toast("対象のセッションがありません"); return; }
    if (!confirm(`「${store} / ${date}」を本確定します。以後この棚卸しは変更できなくなります。よろしいですか？`)) return;
    try {
      for (const s of sess) await DB.setSessionStatus(s.id, "final");
      state.sessions = await DB.getSessions();
      toast("本確定しました（変更不可）"); renderReport();
    } catch (e) { toast("本確定に失敗: " + (e.message || e)); }
  }

  async function unfinalizeStore() {
    if (!state.reportKey) return;
    const { store, date } = state.reportKey;
    const sess = reportGroupSessions();
    if (!confirm(`「${store} / ${date}」の本確定を解除して、編集できる状態に戻しますか？`)) return;
    try {
      for (const s of sess) await DB.setSessionStatus(s.id, "open");
      state.sessions = await DB.getSessions();
      toast("本確定を解除しました"); renderReport();
    } catch (e) { toast("解除に失敗: " + (e.message || e)); }
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
    const el = state.view === "receiving" ? $("#scan-feedback-recv") : $("#scan-feedback");
    if (!el) return;
    el.className = "scan-feedback " + kind;
    el.innerHTML = `<span>${esc(msg)}</span>` + (sku ? ` <span class="fb-sku">${esc(sku)}</span>` : "");
    void el.offsetWidth; // ポップアニメを毎回再生
    el.classList.add("show");
    clearTimeout(fbT); fbT = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // カメラ読取モーダルを開いてスキャン開始（開いている時だけ動作＝誤スキャン防止）
  async function openCam(handler) {
    const recv = handler === handleReceivingScan;
    if (!activeSession()) { openPickSession(); return; }
    if (!ensureOnline()) return;
    if (!recv && !ensureEditable()) return; // 入荷は本確定済みでも可
    if (!recv && state.location === RACK_BASE && !state.rack.trim()) { toast("店内は先にラック名を入れてください"); const ri = $("#rack-input"); if (ri) ri.focus(); return; }
    if (Scanner.isScanning()) return;
    unlockAudio(); // iOSの音を解錠（ユーザー操作中に実行）
    const modal = $("#cam-modal"), wrap = $("#cam-modal .cam-stage"), torchBtn = $("#torch-toggle"), zoomRow = $("#zoom-row");
    modal.hidden = false;
    modal.classList.add("scanning"); // カメラ表示ON
    updateCamCount();
    try {
      await Scanner.start("reader", handler || handleScan);
      setTimeout(() => {
        if (Scanner.torchSupported()) torchBtn.hidden = false; else torchBtn.hidden = true;
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
      await closeCam();
      toast("カメラ起動失敗: " + (e.message || e) + "（HTTPSまたはlocalhostで開いてください）");
    }
  }
  async function closeCam() {
    try { await Scanner.stop(); } catch {}
    const modal = $("#cam-modal");
    modal.classList.remove("scanning");
    modal.hidden = true;
    $("#torch-toggle").hidden = true;
    $("#zoom-row").hidden = true;
  }
  function updateCamCount() {
    const el = $("#cam-count"); if (!el) return;
    el.textContent = state.scans.reduce((a, s) => a + s.qty, 0) + "点";
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

  const sessionDateMap = () => { const m = {}; state.sessions.forEach((s) => (m[s.id] = s.name || "")); return m; };
  const scanDate = (sc, dmap) => (dmap[sc.session_id] || "（日付不明）");
  // 選択中グループ（店舗×日付）のセッション一覧
  function reportGroupSessions() {
    if (!state.reportKey) return [];
    const { store, date } = state.reportKey;
    return state.sessions.filter((s) => storeKey(s.store) === store && (s.name || "") === date);
  }

  function renderReport() {
    const back = $("#report-back"), title = $("#report-title"), body = $("#report-body");
    if (state.reportKey) { back.hidden = false; renderGroupDetail(title, body); }
    else { back.hidden = true; title.textContent = "棚卸しレポート（店舗×日付）"; renderGroupOverview(body); }
  }

  // レポートは「ダブルチェック完了」分のみ反映。
  // 単位＝店内はラック / バックヤード・その他倉庫はそのロケーション全体。
  // その単位がダブルチェック完了なら計上（店内でラック未設定は除外）。
  // 確認状態は「店舗×日付×単位」で照合する（セッションが分かれていても、
  //   同じ店舗・日付で同じラックがダブルチェックされていれば確定扱いにする）。
  //   ラック名は前後空白を無視して比較（表記ゆれ対策）。
  const CKEY = "";
  let _confirmCtx = null; // { status: {key: "checked"|"provisional"}, dmap }
  function unitKeyParts(store, date, unit) { return store + CKEY + date + CKEY + String(unit || "").trim(); }
  function buildConfirmCtx() {
    const dmap = sessionDateMap();
    const storeById = {};
    state.sessions.forEach((s) => { storeById[s.id] = storeKey(s.store); });
    const status = {};
    Object.values(state.allRackChecks).forEach((c) => {
      if (!c || (c.status !== "checked" && c.status !== "provisional")) return;
      const unit = String(c.rack || "").trim();
      if (!unit) return;
      const key = unitKeyParts(storeById[c.session_id] || "（店舗未設定）", dmap[c.session_id] || "（日付不明）", unit);
      if (c.status === "checked" || status[key] !== "checked") status[key] = c.status; // checked優先
    });
    return { status, dmap };
  }
  function unitStatusOf(sc) {
    if (!_confirmCtx) _confirmCtx = buildConfirmCtx();
    const base = baseLocation(sc.location);
    const unit = base === "店内在庫" ? rackOf(sc.location).trim() : base;
    if (base === "店内在庫" && !unit) return "none";
    const key = unitKeyParts(storeKey(sc.store), _confirmCtx.dmap[sc.session_id] || "（日付不明）", unit);
    return _confirmCtx.status[key] || "none";
  }
  function scanConfirmed(sc) { return unitStatusOf(sc) === "checked"; }
  const sumQty = (arr) => arr.reduce((a, x) => a + x.qty, 0);
  // 小物（雑貨/小物など、カテゴリ名に「小物」を含む）は「着数」に含めず別集計する
  const isKomono = (sc) => { const it = state.itemMap[sc.sku]; return !!(it && String(it.category || "").includes("小物")); };
  const priceLabel = (it) => (it && it.price != null && it.price !== "" ? "¥" + jnum(Number(it.price)) : "不明");
  function catSumOf(scans) {
    const m = {};
    scans.forEach((sc) => { const it = state.itemMap[sc.sku]; const c = it ? (it.category || "未分類") : "マスタ外"; m[c] = (m[c] || 0) + sc.qty; });
    return m;
  }
  function priceSumOf(scans) {
    const m = {};
    scans.forEach((sc) => { m[priceLabel(state.itemMap[sc.sku])] = (m[priceLabel(state.itemMap[sc.sku])] || 0) + sc.qty; });
    return m;
  }

  // 一覧（店舗×日付ごとの合計点数）
  function renderGroupOverview(body) {
    const dmap = sessionDateMap();
    const groups = {}; // key -> {store, date, qty}
    state.allScans.forEach((sc) => {
      const store = storeKey(sc.store), date = scanDate(sc, dmap);
      const key = store + " " + date;
      const g = (groups[key] = groups[key] || { store, date, qty: 0, komono: 0 });
      if (scanConfirmed(sc)) { if (isKomono(sc)) g.komono += sc.qty; else g.qty += sc.qty; }
    });
    let rows = Object.values(groups).sort((a, b) =>
      a.store.localeCompare(b.store, "ja") || b.date.localeCompare(a.date));

    // 店舗フィルタ（データに登場する店舗＋選択中の店舗。既定は棚卸し中の店舗）
    const filter = state.reportStore || ""; // ""=すべて
    const storeVals = new Set(rows.map((r) => r.store));
    if (filter) storeVals.add(filter); // データが無くても選択中の店舗は選べるように
    const storeSet = Array.from(storeVals).sort((a, b) => a.localeCompare(b, "ja"));
    const filterHtml =
      `<div class="report-filter"><label for="report-store">店舗で絞り込み</label>
         <select id="report-store"><option value="">すべての店舗</option>` +
      storeSet.map((s) => `<option value="${esc(s)}" ${s === filter ? "selected" : ""}>${esc(s)}</option>`).join("") +
      `</select></div>`;

    if (filter) rows = rows.filter((r) => r.store === filter);
    const grand = rows.reduce((a, r) => a + r.qty, 0);
    const grandKomono = rows.reduce((a, r) => a + r.komono, 0);
    if (!rows.length) {
      body.innerHTML = filterHtml +
        `<div class="empty">${filter ? "「" + esc(filter) + "」の棚卸しデータはありません。" : "まだ読み取りデータがありません。"}</div>`;
      return;
    }
    body.innerHTML = filterHtml +
      `<div class="report-note">※ ダブルチェック完了分のみ集計。着数は<b>小物を除く</b>数です。</div>
       <div class="report-cards">
         <div class="rcard"><div class="n">${jnum(grand)}</div><div class="l">${filter ? esc(filter) + " 確定着数" : "全体 確定着数"}</div></div>
         <div class="rcard"><div class="n">${jnum(grandKomono)}</div><div class="l">小物（別集計）</div></div>
         <div class="rcard"><div class="n">${rows.length}</div><div class="l">${filter ? "棚卸し（日付）" : "店舗×日付"}</div></div>
       </div>
       <ul class="report-list">` +
      rows.map((g) => `
        <li class="row store-row" data-store="${esc(g.store)}" data-date="${esc(g.date)}">
          <div class="row-main"><div class="row-name">${esc(g.store)}</div>
          <div class="row-sub">🗓 ${esc(g.date)}　着数 ${jnum(g.qty)}${g.komono ? " ・ 小物 " + jnum(g.komono) : ""}</div></div>
          <span class="row-qty">${jnum(g.qty)}</span><span class="chev">›</span></li>`).join("") +
      `</ul>`;
  }

  // 詳細（店舗×日付単位。ロケーション内訳・タップで絞込・店内はラック別着数）
  function renderGroupDetail(title, body) {
    const { store, date } = state.reportKey;
    title.textContent = store;
    const dmap = sessionDateMap();
    const groupAll = state.allScans.filter((sc) => storeKey(sc.store) === store && scanDate(sc, dmap) === date);
    const scans = groupAll.filter(scanConfirmed); // ダブルチェック完了分のみ
    const gScans = scans.filter((sc) => !isKomono(sc)); // 着数（衣類）
    const kScans = scans.filter(isKomono);              // 小物（別集計）
    const byBase = (arr, base) => arr.filter((sc) => baseLocation(sc.location) === base);
    const inStore = byBase(gScans, "店内在庫");
    const byyard = byBase(gScans, "バックヤード在庫");
    const other = byBase(gScans, "その他倉庫");
    const total = sumQty(gScans);
    const komonoTotal = sumQty(kScans);

    // 本確定（変更不可）状態
    const groupSessions = reportGroupSessions();
    const allFinal = groupSessions.length > 0 && groupSessions.every((s) => s.status === "final" || s.status === "closed");
    const finalizeHtml = allFinal
      ? `<span class="fin-badge">🔒 本確定済み（変更不可）</span><button id="unfinalize-btn" class="btn btn-ghost sm">解除</button>`
      : `<button id="finalize-btn" class="btn btn-primary">本確定（変更不可にする）</button>`;
    // 終了時刻＝この店舗×日付で最後にダブルチェック完了した時刻
    const gsIds = new Set(groupSessions.map((s) => s.id));
    let endAt = "";
    Object.values(state.allRackChecks).forEach((c) => {
      if (c && gsIds.has(c.session_id) && c.status === "checked" && c.checked_at && c.checked_at > endAt) endAt = c.checked_at;
    });
    const endHtml = endAt ? `　🕒 終了 ${fmtDateTime(endAt)}` : "";
    const subHtml = `<div class="report-sub">🏬 ${esc(store)}　🗓 ${esc(date)}${endHtml}</div><div class="report-finalize">${finalizeHtml}</div>`;

    if (!scans.length) {
      body.innerHTML = subHtml +
        `<div class="empty">ダブルチェック完了分がまだありません。<br>店内は「確認待ち」タブでラックのダブルチェックを完了すると集計されます。</div>`;
      return;
    }

    // ①-1 サマリーカード（合計着数は小物を除く）
    const cards =
      `<div class="report-cards report-cards-4">
         <div class="rcard rcard-total"><div class="n">${jnum(total)}</div><div class="l">合計着数<br><span class="rcard-note">（小物除く）</span></div></div>
         <div class="rcard"><div class="n">${jnum(sumQty(inStore))}</div><div class="l">店内</div></div>
         <div class="rcard"><div class="n">${jnum(sumQty(byyard))}</div><div class="l">バックヤード</div></div>
         <div class="rcard"><div class="n">${jnum(sumQty(other))}</div><div class="l">その他倉庫</div></div>
       </div>`;

    // 小物（着数とは別集計）
    const komonoHtml =
      `<h3 class="chart-title">小物（着数とは別集計）</h3>
       <div class="report-cards report-cards-4">
         <div class="rcard rcard-total"><div class="n">${jnum(komonoTotal)}</div><div class="l">小物 合計</div></div>
         <div class="rcard"><div class="n">${jnum(sumQty(byBase(kScans, "店内在庫")))}</div><div class="l">店内</div></div>
         <div class="rcard"><div class="n">${jnum(sumQty(byBase(kScans, "バックヤード在庫")))}</div><div class="l">バックヤード</div></div>
         <div class="rcard"><div class="n">${jnum(sumQty(byBase(kScans, "その他倉庫")))}</div><div class="l">その他倉庫</div></div>
       </div>
       ${komonoTotal ? `<h4 class="chart-sub">小物の価格帯比率</h4>${barChart(priceSumOf(kScans), komonoTotal, "price")}` : ""}`;

    // ①-5 カテゴリ×価格帯 ランキング上位5（衣類のみ）
    const cpMap = {};
    gScans.forEach((sc) => {
      const it = state.itemMap[sc.sku];
      const cat = it ? (it.category || "未分類") : "マスタ外";
      const key = cat + " / " + priceLabel(it);
      cpMap[key] = (cpMap[key] || 0) + sc.qty;
    });
    const ranking = Object.entries(cpMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const rankingHtml = ranking.length
      ? `<ol class="rank-list">` + ranking.map(([label, qty]) =>
          `<li class="rank-item"><span class="rank-label">${esc(label)}</span><span class="rank-qty">${jnum(qty)}点</span></li>`).join("") + `</ol>`
      : `<div class="empty">データなし</div>`;

    // ② カテゴリごとの価格帯比率（衣類のみ。小物は上の別集計）
    const catTotals = catSumOf(gScans);
    const catsOrdered = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const perCatHtml = catsOrdered.map((cat) => {
      const catScans = gScans.filter((sc) => { const it = state.itemMap[sc.sku]; const c = it ? (it.category || "未分類") : "マスタ外"; return c === cat; });
      return `<h4 class="cat-title">${esc(cat)}（${jnum(catTotals[cat])}点）</h4>${barChart(priceSumOf(catScans), catTotals[cat], "price")}`;
    }).join("");

    // ③ 確認済みの単位一覧（抜け漏れチェック＋登録者・ダブルチェック者）
    // 店内=ラック別、BY/その他=まとめて。単位ごとに qty と確認記録（登録者/確認者）をまとめる。
    const unitAgg = {}; // unit -> { base, qty, check }
    scans.forEach((sc) => {
      const base = baseLocation(sc.location);
      const unit = base === "店内在庫" ? (rackOf(sc.location) || "（ラック名なし）") : base;
      const m = unitAgg[unit] || (unitAgg[unit] = { base, qty: 0, check: null });
      m.qty += sc.qty;
      if (!m.check) m.check = state.allRackChecks[sc.session_id + "|" + unit] || null;
    });
    // 登録者・確認者の表示（記録が無ければ「—」）
    const whoLine = (check) => {
      const reg = (check && check.first_by) ? esc(check.first_by) : "—";
      const chk = (check && check.checked_by) ? esc(check.checked_by) : "—";
      return `<div class="unit-who">登録: <b>${reg}</b>　ダブルチェック: <b>${chk}</b></div>`;
    };
    const rackUnits = Object.entries(unitAgg).filter(([, m]) => m.base === "店内在庫")
      .sort((a, b) => a[0].localeCompare(b[0], "ja", { numeric: true }));
    const rackListHtml = rackUnits.length
      ? `<ul class="unit-list">` + rackUnits.map(([r, m]) =>
          `<li class="unit-item"><div class="unit-top"><span class="unit-name">✅ ラック ${esc(r)}</span><span class="unit-qty">${jnum(m.qty)}点</span></div>${whoLine(m.check)}</li>`).join("") + `</ul>`
      : `<div class="empty">確認済みのラックがありません。</div>`;
    const locRow = (label, locName) => {
      const m = unitAgg[locName];
      const has = !!m;
      if (!has) return `<li class="unit-item unit-missing"><div class="unit-top"><span class="unit-name">⚠️ ${esc(label)}</span><span class="unit-qty">未確認</span></div></li>`;
      return `<li class="unit-item"><div class="unit-top"><span class="unit-name">✅ ${esc(label)}</span><span class="unit-qty">${jnum(m.qty)}点</span></div>${whoLine(m.check)}</li>`;
    };
    const unitsHtml =
      `<h4 class="chart-sub">店内（確認済みラック ${rackUnits.length}本）</h4>
       ${rackListHtml}
       <h4 class="chart-sub">バックヤード・その他倉庫</h4>
       <ul class="unit-list">
         ${locRow("バックヤード", "バックヤード在庫")}
         ${locRow("その他倉庫", "その他倉庫")}
       </ul>`;

    // ④ マスタ外の商品（マスタに無いコード＝要登録）。未確認も含めた全読取から抽出。
    const extMap = {}; // sku -> qty
    groupAll.forEach((sc) => { if (!state.itemMap[sc.sku]) extMap[sc.sku] = (extMap[sc.sku] || 0) + sc.qty; });
    const extRows = Object.entries(extMap).sort((a, b) => b[1] - a[1]);
    const extHtml = extRows.length
      ? `<ul class="unit-list">` + extRows.map(([sku, q]) =>
          `<li class="unit-item ext-row" data-ext-sku="${esc(sku)}"><div class="unit-top"><span class="unit-name">🏷 ${esc(sku)}</span><span class="unit-qty">${jnum(q)}点 ›</span></div><div class="unit-who">タップして商品マスタに登録</div></li>`).join("") + `</ul>`
      : `<div class="empty">マスタ外の商品はありません（すべてマスタに登録済み）。</div>`;
    const unknownPriceTotal = sumQty(scans.filter((sc) => { const it = state.itemMap[sc.sku]; return it && (it.price == null || it.price === ""); }));

    // ⑤ 未反映（レポート外）の内訳＝全読取 − 確定（小物含む）。差がある理由を見える化。
    const allTotal = sumQty(groupAll);
    const confirmedTotal = sumQty(scans); // 着数＋小物の確定合計
    const gap = allTotal - confirmedTotal;
    let orphanQty = 0;           // 店内でラック名なし（確定不可）
    const pendMap = {};          // 未確認/仮登録の場所ごと
    groupAll.forEach((sc) => {
      if (scanConfirmed(sc)) return;
      const base = baseLocation(sc.location);
      const unit = base === "店内在庫" ? rackOf(sc.location) : base;
      if (base === "店内在庫" && !unit) { orphanQty += sc.qty; return; }
      const status = unitStatusOf(sc) === "provisional" ? "仮登録" : "未確認";
      const label = base === "店内在庫" ? "ラック " + unit : unitLabel(unit);
      const m = pendMap[base + "|" + unit] || (pendMap[base + "|" + unit] = { label, qty: 0, status });
      m.qty += sc.qty;
    });
    const pendRows = Object.values(pendMap).sort((a, b) => b.qty - a.qty);
    let gapHtml = "";
    if (gap > 0) {
      gapHtml = `<h3 class="chart-title">⑤ 未反映（レポートに出ていない ${jnum(gap)}点）</h3>
        <div class="report-note">全読取 ${jnum(allTotal)} − 確定 ${jnum(confirmedTotal)}（着数${jnum(total)}＋小物${jnum(komonoTotal)}） = <b>${jnum(gap)}点</b>。下記を解消すると確定に反映されます。</div>
        <ul class="unit-list">` +
        (orphanQty > 0
          ? `<li class="unit-item unit-missing"><div class="unit-top"><span class="unit-name">⚠️ 店内でラック名なし</span><span class="unit-qty">${jnum(orphanQty)}点</span></div><div class="unit-who">ラックが無いと確定できません。「全明細CSV」で<b>場所=店内在庫・ラック空</b>の行を確認し、正しいラックで読み直してください。</div></li>`
          : "") +
        pendRows.map((m) =>
          `<li class="unit-item"><div class="unit-top"><span class="unit-name">${m.status === "仮登録" ? "🕒" : "◻️"} ${esc(m.label)}</span><span class="unit-qty">${jnum(m.qty)}点</span></div><div class="unit-who">${m.status}：ダブルチェック完了で反映されます</div></li>`).join("") +
        `</ul>`;
    }

    // ロケーション別のカテゴリ比率（着数＝小物除く）。データがある時だけ表示。
    const locCatHtml = (label, arr) => { const t = sumQty(arr); return t ? `<h4 class="chart-sub">${label}のカテゴリ比率（${jnum(t)}点）</h4>${barChart(catSumOf(arr), t, "cat")}` : ""; };

    body.innerHTML = subHtml +
      `<div class="report-note">※ ダブルチェック完了分のみ集計（店内はラックのダブルチェック完了が対象。BY/その他は全数）。</div>
       <h3 class="chart-title">① サマリー（着数＝小物を除く）</h3>
       ${cards}
       <h4 class="chart-sub">全体のカテゴリ比率</h4>
       ${barChart(catSumOf(gScans), total, "cat")}
       ${locCatHtml("店内", inStore)}
       <h4 class="chart-sub">店内の価格帯比率</h4>
       ${barChart(priceSumOf(inStore), sumQty(inStore), "price")}
       ${locCatHtml("バックヤード", byyard)}
       ${locCatHtml("その他倉庫", other)}
       <h4 class="chart-sub">カテゴリ×価格帯 ランキング（上位5）</h4>
       ${rankingHtml}
       ${komonoHtml}
       <h3 class="chart-title">② カテゴリごとの価格帯比率</h3>
       ${perCatHtml}
       <h3 class="chart-title">③ 確認済みの一覧（抜け漏れチェック）</h3>
       <div class="report-note">ダブルチェック完了した場所だけが出ます。⚠️や、あるはずのラックが出ていない場合は未確認です。抜けがないか確認してください。</div>
       ${unitsHtml}
       <h3 class="chart-title">④ マスタ外の商品（要登録）</h3>
       <div class="report-note">商品マスタに<b>無いコード</b>です（未確認分も含む）。カテゴリ・価格が分からないため、レポートでは「マスタ外／不明」に集計されます。<b>各行をタップすると商品マスタに登録</b>でき、登録するとカテゴリ・価格が正しく集計されます。${unknownPriceTotal ? `<br>※ このほか、マスタにあるが価格が空の「価格不明」が ${jnum(unknownPriceTotal)}点 あります（カテゴリは集計されます）。` : ""}</div>
       ${extHtml}
       ${gapHtml}`;
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
    $("#login-pin").value = localStorage.getItem(LS_PIN) || "";
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
      const rc = expandRackTokens(s.racks || "").length;
      html += `<li class="store-item">
        <div class="st-main"><div class="st-name">${esc(s.name)}</div>${s.area ? `<div class="st-sub">${esc(s.area)}</div>` : ""}</div>
        ${s.brand ? `<span class="st-brand">${esc(s.brand)}</span>` : ""}
        <button class="store-racks btn btn-ghost sm" data-racks="${esc(s.name)}">🧱 ラック${rc ? "(" + rc + ")" : ""}</button>
        <button class="store-del" data-delstore="${esc(s.name)}" title="削除">×</button></li>`;
    });
    ul.innerHTML = html;
  }
  // 店舗ごとのラック登録モーダル
  let racksEditStore = "";
  function openRacksModal(name) {
    racksEditStore = name;
    const st = state.stores.find((x) => x.name === name);
    $("#racks-modal-title").textContent = `ラックを登録：${name}`;
    $("#racks-text").value = st ? (st.racks || "") : "";
    updateRacksPreview();
    $("#racks-modal").hidden = false;
  }
  function updateRacksPreview() {
    const list = expandRackTokens($("#racks-text").value);
    const el = $("#racks-preview");
    el.innerHTML = list.length
      ? `展開結果：<b>${list.length}本</b> ／ ${list.slice(0, 30).map(esc).join("・")}${list.length > 30 ? " …" : ""}`
      : "（まだありません）";
  }
  async function saveRacksModal() {
    if (!racksEditStore) return;
    try {
      await DB.setStoreRacks(racksEditStore, $("#racks-text").value);
      state.stores = await DB.getStores();
      $("#racks-modal").hidden = true;
      renderStoreList();
      if (state.view === "scan") renderRackRow();
      toast(`「${racksEditStore}」のラックを保存しました`);
    } catch (e) {
      toast("保存に失敗: " + (e.message || e) + "（クラウドに racks 列の追加が必要な場合は設定のSQLを実行）");
    }
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

  /* ---------- 起動ホーム: 棚卸しを始める ---------- */
  const todayStr = () => new Date().toISOString().slice(0, 10);
  function syncStaff(name) {
    const s = $("#staff-name"); if (s) s.value = name;
    const d = $("#device-name"); if (d) d.value = name;
  }
  // ホーム画面へ移動（最初のステップから）
  function openPickSession() { hidePsError(); state.homeStep = 0; switchView("home"); }
  function applyHomeStep() {
    $("#home-s0").hidden = state.homeStep !== 0;
    $("#home-s1").hidden = state.homeStep !== 1;
    $("#home-s2").hidden = state.homeStep !== 2;
  }
  function goHomeStep(n) {
    state.homeStep = n; applyHomeStep();
    if (n === 1) setTimeout(() => { const el = $("#ps-staff"); if (el) el.focus(); }, 60);
  }
  // ホーム画面の描画（担当者・店舗リスト・日付・入力中一覧）
  function renderHome() {
    applyHomeStep();
    const staffEl = $("#ps-staff");
    if (staffEl && document.activeElement !== staffEl) staffEl.value = DB.getDeviceName() || "";
    // ② 店舗は設定で登録済みの店舗のみをリスト表示
    const stores = state.stores.map((s) => s.name);
    const sel = $("#ps-store");
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = stores.length
        ? stores.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")
        : `<option value="">（設定で店舗を登録してください）</option>`;
      const cur = activeSession();
      if (prev && stores.includes(prev)) sel.value = prev;
      else if (cur && cur.store && stores.includes(cur.store)) sel.value = cur.store;
    }
    const dateEl = $("#ps-date");
    if (dateEl && !dateEl.value) dateEl.value = todayStr();
    renderPsList();
  }
  function showPsError(msg) { const e = $("#ps-error"); if (e) { e.textContent = msg; e.hidden = false; } }
  function hidePsError() { const e = $("#ps-error"); if (e) e.hidden = true; }

  // 同じ店舗×日付が既にあれば作らずエラー表示。無ければ作成して参加。
  async function createOrJoinSession(store, date) {
    date = (date || "").trim() || todayStr();
    hidePsError();
    try { state.sessions = await DB.getSessions(); } catch {}
    const dup = state.sessions.find((s) => (s.store || "") === store && (s.name || "") === date && s.status !== "final" && s.status !== "closed");
    if (dup) {
      showPsError(`「${store} / ${date}」はすでにあります。下の一覧から選んで参加してください。`);
      renderPsList();
      return;
    }
    try {
      if (!state.stores.some((s) => s.name === store)) {
        await DB.upsertStore({ name: store, brand: store === TEST_STORE ? "テスト" : "", area: "" });
        state.stores = await DB.getStores();
      }
      const sess = await DB.createSession(date, store);
      state.sessions = await DB.getSessions();
      setActiveSession(sess.id);
      switchView("scan");
      toast(`棚卸しを開始しました（${store} / ${date}）`);
    } catch (e) { showPsError("作成に失敗: " + (e.message || e)); }
  }

  // ホームから開始（②店舗③日付）
  async function startFromHome() {
    const staff = $("#ps-staff").value.trim();
    DB.setDeviceName(staff); syncStaff(staff);
    const store = $("#ps-store").value.trim();
    const date = $("#ps-date").value.trim() || todayStr();
    if (!store) { showPsError("店舗を選んでください（設定で登録できます）"); return; }
    await createOrJoinSession(store, date);
  }

  async function startTestSession() {
    const staff = $("#ps-staff").value.trim();
    DB.setDeviceName(staff); syncStaff(staff);
    await createOrJoinSession(TEST_STORE, $("#ps-date").value.trim() || todayStr());
  }

  const DEFAULT_PIN = "0913"; // 初期の管理者暗証番号
  // 設定（管理者画面）は暗証番号が必要。未設定なら初期値0913。
  function openSettings() {
    const saved = (localStorage.getItem(LS_PIN) || DEFAULT_PIN).trim();
    const entered = prompt("設定を開くには暗証番号を入力してください");
    if (entered == null) return;
    if (entered.trim() !== saved) { toast("暗証番号が違います"); return; }
    switchView("settings");
  }

  function renderPsList() {
    const ul = $("#ps-list"); if (!ul) return;
    const list = state.sessions.filter((s) => s.status !== "final" && s.status !== "closed")
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    if (!list.length) { ul.innerHTML = `<li class="empty">入力中の棚卸しはありません。上で店舗・日付を入れて始めてください。</li>`; return; }
    const qtyBySession = {};
    state.allScans.forEach((sc) => { qtyBySession[sc.session_id] = (qtyBySession[sc.session_id] || 0) + sc.qty; });
    ul.innerHTML = list.map((s) => `
      <li class="ps-row row${s.id === state.activeSessionId ? " active" : ""}" data-sid="${esc(s.id)}">
        <div class="row-main"><div class="row-name">${esc(s.store || "（店舗未設定）")}</div>
        <div class="row-sub">🗓 ${esc(s.name || "")} ・ ${qtyBySession[s.id] || 0}点</div></div>
        <span class="chev">›</span></li>`).join("");
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
    // レポート表示中の範囲を出力（店舗×日付を選択中はその範囲、一覧なら全体）
    const dmap = sessionDateMap();
    let scans = state.allScans.filter(scanConfirmed); // ダブルチェック完了分のみ
    if (state.reportKey) {
      const { store, date } = state.reportKey;
      scans = scans.filter((sc) => storeKey(sc.store) === store && scanDate(sc, dmap) === date);
    } else if (state.reportStore) {
      scans = scans.filter((sc) => storeKey(sc.store) === state.reportStore);
    }
    const rows = [["店舗", "棚卸日", "ロケーション", "ラック", "コード", "商品名", "カテゴリ", "単価", "数量", "登録者", "ダブルチェック者"]];
    const sorted = [...scans].sort((a, b) =>
      storeKey(a.store).localeCompare(storeKey(b.store), "ja") ||
      scanDate(a, dmap).localeCompare(scanDate(b, dmap)) ||
      (a.location || "").localeCompare(b.location || "") || (b.qty - a.qty));
    sorted.forEach((sc) => {
      const it = state.itemMap[sc.sku] || {};
      const base = baseLocation(sc.location);
      const unit = base === "店内在庫" ? rackOf(sc.location) : base;
      const chk = state.allRackChecks[sc.session_id + "|" + unit] || {};
      rows.push([storeKey(sc.store), scanDate(sc, dmap), base, rackOf(sc.location), sc.sku, it.name || "", it.category || "", it.price ?? "", sc.qty, chk.first_by || "", chk.checked_by || ""]);
    });
    const safe = (state.reportKey ? state.reportKey.store + "_" + state.reportKey.date : (state.reportStore || "全体")).replace(/[^\w\-一-龠ぁ-んァ-ヶー]/g, "_");
    download("tanaoroshi_" + safe + ".csv", toCSV(rows));
  }

  // その読取の単位の確認状態ラベル
  function unitConfirmLabel(sc) {
    const s = unitStatusOf(sc);
    return s === "checked" ? "確認済" : s === "provisional" ? "仮登録" : "未確認";
  }
  // 全明細CSV（ダブルチェック未完了も含む＝スキャン画面の総点数と一致する範囲）
  function exportAllScansCSV() {
    const dmap = sessionDateMap();
    let scans = state.allScans.slice();
    if (state.reportKey) {
      const { store, date } = state.reportKey;
      scans = scans.filter((sc) => storeKey(sc.store) === store && scanDate(sc, dmap) === date);
    } else if (state.reportStore) {
      scans = scans.filter((sc) => storeKey(sc.store) === state.reportStore);
    }
    const rows = [["店舗", "棚卸日", "ロケーション", "ラック", "コード", "商品名", "カテゴリ", "単価", "数量", "確認状態", "登録者", "ダブルチェック者"]];
    const sorted = [...scans].sort((a, b) =>
      storeKey(a.store).localeCompare(storeKey(b.store), "ja") ||
      scanDate(a, dmap).localeCompare(scanDate(b, dmap)) ||
      (a.location || "").localeCompare(b.location || "") || (b.qty - a.qty));
    sorted.forEach((sc) => {
      const it = state.itemMap[sc.sku] || {};
      const base = baseLocation(sc.location);
      const unit = base === "店内在庫" ? rackOf(sc.location) : base;
      const chk = state.allRackChecks[sc.session_id + "|" + unit] || {};
      rows.push([storeKey(sc.store), scanDate(sc, dmap), base, rackOf(sc.location), sc.sku, it.name || "", it.category || "", it.price ?? "", sc.qty, unitConfirmLabel(sc), chk.first_by || "", chk.checked_by || ""]);
    });
    const safe = (state.reportKey ? state.reportKey.store + "_" + state.reportKey.date : (state.reportStore || "全体")).replace(/[^\w\-一-龠ぁ-んァ-ヶー]/g, "_");
    download("tanaoroshi_全明細_" + safe + ".csv", toCSV(rows));
  }

  /* ---------- イベント配線 ---------- */
  function wire() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => {
      const v = t.dataset.view;
      if (v === "settings") openSettings(); // 設定は暗証番号ゲート
      else switchView(v);
    }));
    $("#home-btn").addEventListener("click", openPickSession);

    $("#session-select").addEventListener("change", (e) => setActiveSession(e.target.value));
    $("#new-session-btn").addEventListener("click", openPickSession);

    // 起動ホーム（3ステップ）
    $("#home-start-btn").addEventListener("click", () => goHomeStep(1));
    $("#home-back-1").addEventListener("click", () => goHomeStep(0));
    $("#home-back-2").addEventListener("click", () => goHomeStep(1));
    $("#ps-next").addEventListener("click", () => {
      const staff = ($("#ps-staff").value || "").trim();
      if (!staff) { toast("担当者名を入力してください"); $("#ps-staff").focus(); return; }
      DB.setDeviceName(staff); syncStaff(staff);
      goHomeStep(2); renderHome();
    });
    $("#ps-staff").addEventListener("input", (e) => { DB.setDeviceName(e.target.value); syncStaff(e.target.value); });
    $("#ps-start").addEventListener("click", startFromHome);
    $("#ps-test").addEventListener("click", startTestSession);
    $("#ps-admin").addEventListener("click", openSettings);
    $("#ps-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-sid]"); if (!li) return;
      setActiveSession(li.dataset.sid); switchView("scan");
    });

    // 担当者名（スキャン画面から常時編集可・設定と同期）
    const staffInput = $("#staff-name");
    if (staffInput) {
      staffInput.value = DB.getDeviceName();
      staffInput.addEventListener("input", (e) => {
        DB.setDeviceName(e.target.value);
        const d = $("#device-name"); if (d) d.value = e.target.value;
      });
    }

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
      rackInput.addEventListener("input", (e) => { saveRack(e); renderRackStatus(); renderRackChips(); });
      rackInput.addEventListener("change", (e) => { saveRack(e); renderRackRow(); });
    }
    // 登録ラックのチップをタップで選択
    $("#rack-chips").addEventListener("click", (e) => {
      const chip = e.target.closest(".rack-chip"); if (!chip) return;
      state.rack = chip.dataset.rack; localStorage.setItem(LS_RACK, state.rack);
      const ri = $("#rack-input"); if (ri) ri.value = state.rack;
      renderRackRow();
    });

    // ラック確認ステータスの操作（仮登録／取消）
    $("#rack-status").addEventListener("click", (e) => {
      const a = e.target.closest("[data-rack-action]"); if (!a) return;
      const act = a.dataset.rackAction;
      if (act === "prov") markRackProvisional();
      else if (act === "reset") resetRack();
    });

    // 確認待ち（ダブルチェック）タブのリスト操作
    $("#dc-list").addEventListener("input", (e) => {
      if (e.target.classList.contains("dc-checker")) dcDrafts[e.target.dataset.rack] = e.target.value;
    });
    $("#dc-list").addEventListener("click", (e) => {
      const recheck = e.target.closest(".dc-recheck");
      if (recheck) { reCheckUnit(recheck.dataset.rack); return; }
      const btn = e.target.closest(".dc-done"); if (!btn) return;
      const rack = btn.dataset.rack;
      const li = btn.closest(".dc-row");
      const inp = li ? li.querySelector(".dc-checker") : null;
      markRackChecked(rack, inp ? inp.value : (dcDrafts[rack] || ""));
    });
    $("#unconfirmed-list").addEventListener("click", (e) => {
      if (e.target.closest(".uc-assign")) { assignRackToOrphans(); return; }
      const prov = e.target.closest(".uc-prov");
      if (prov) markUnitProvisional(prov.dataset.unit, prov.dataset.label);
    });

    $("#cam-open").addEventListener("click", () => openCam(handleScan));
    $("#recv-cam").addEventListener("click", () => openCam(handleReceivingScan));
    $("#recv-rack").addEventListener("input", (e) => {
      state.recvRack = e.target.value;
      localStorage.setItem(LS_RECV_RACK, e.target.value);
      renderReceiving();
    });
    $("#cam-close").addEventListener("click", closeCam);
    $("#cam-done").addEventListener("click", closeCam);
    // アプリが背面に回ったらカメラ停止（誤スキャン防止）
    document.addEventListener("visibilitychange", () => { if (document.hidden && !$("#cam-modal").hidden) closeCam(); });
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
      if ((act === "minus" || act === "del") && !ensureEditable()) return;
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
    $("#open-master").addEventListener("click", () => switchView("master"));
    $("#master-back").addEventListener("click", () => switchView("settings"));
    $("#master-add-btn").addEventListener("click", () => openItemModal(""));
    $("#master-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-edit]"); if (li) openItemModal(li.dataset.edit);
    });
    $("#csv-input").addEventListener("change", (e) => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ""; });
    $("#csv-export-btn").addEventListener("click", exportMasterCSV);

    $("#report-export-btn").addEventListener("click", exportReportCSV);
    $("#report-export-all-btn").addEventListener("click", exportAllScansCSV);
    $("#report-back").addEventListener("click", () => { state.reportKey = null; state.reportLoc = ""; renderReport(); });
    $("#report-body").addEventListener("click", (e) => {
      if (e.target.id === "finalize-btn") { finalizeStore(); return; }
      if (e.target.id === "unfinalize-btn") { unfinalizeStore(); return; }
      const ext = e.target.closest("[data-ext-sku]");
      if (ext) { openItemModal(ext.dataset.extSku); return; } // マスタ外→登録
      const locEl = e.target.closest("[data-rloc]");
      if (locEl) { const l = locEl.dataset.rloc; state.reportLoc = (state.reportLoc === l) ? "" : l; renderReport(); return; }
      const li = e.target.closest("[data-store]"); if (!li) return;
      state.reportKey = { store: li.dataset.store, date: li.dataset.date }; state.reportLoc = ""; renderReport();
    });
    $("#report-body").addEventListener("change", (e) => {
      if (e.target.id === "report-store") { state.reportStore = e.target.value; renderReport(); }
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
    $("#login-pin").addEventListener("change", (e) => { const v = (e.target.value || "").trim(); if (v) localStorage.setItem(LS_PIN, v); else localStorage.removeItem(LS_PIN); toast(v ? "暗証番号を保存しました" : "暗証番号を無効にしました"); });
    $("#store-add-btn").addEventListener("click", async () => {
      const name = $("#store-name").value.trim();
      if (!name) { toast("店舗名を入力してください"); return; }
      await DB.upsertStore({ name, brand: $("#store-brand").value.trim(), area: $("#store-area").value.trim() });
      $("#store-name").value = ""; $("#store-brand").value = ""; $("#store-area").value = "";
      toast("店舗を追加しました"); await reload();
    });
    $("#store-load-official").addEventListener("click", loadOfficialStores);
    $("#store-list-ui").addEventListener("click", async (e) => {
      const rk = e.target.closest("[data-racks]");
      if (rk) { openRacksModal(rk.dataset.racks); return; }
      const b = e.target.closest("[data-delstore]"); if (!b) return;
      const name = b.dataset.delstore;
      if (confirm(`店舗「${name}」を削除しますか？`)) { await DB.deleteStore(name); await reload(); }
    });
    $("#racks-cancel").addEventListener("click", () => { $("#racks-modal").hidden = true; });
    $("#racks-modal").addEventListener("click", (e) => { if (e.target.id === "racks-modal") $("#racks-modal").hidden = true; });
    $("#racks-text").addEventListener("input", updateRacksPreview);
    $("#racks-save").addEventListener("click", saveRacksModal);
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
    DB.setDeviceName(""); // 担当者名はリロードごとに空欄にする（毎回入力してもらう）
    wire();
    await DB.init();
    renderBadge();
    await seedMasterIfEmpty();
    await seedStoresIfEmpty();
    await reload();
    // 起動時はホーム（1ページ目）を表示
    switchView("home");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  document.addEventListener("DOMContentLoaded", main);
})();
