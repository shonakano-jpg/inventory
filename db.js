/* ============================================================
   データ層。ローカル(localStorage) / クラウド(Supabase) を透過的に切替。
   app.js からは DB.* だけを使う。
   ============================================================ */
(function () {
  "use strict";

  const LS = {
    items: "fi_items",
    sessions: "fi_sessions",
    scans: "fi_scans",
    rackChecks: "fi_rackchecks",
    stores: "fi_stores",
    device: "fi_device",
    sbUrl: "fi_sb_url",
    sbKey: "fi_sb_key",
  };

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

  const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const writeJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const now = () => new Date().toISOString();

  /* ---------- ローカル実装 ---------- */
  const Local = {
    async getItems() {
      const m = readJSON(LS.items, {});
      return Object.values(m).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
    },
    async getItemMap() { return readJSON(LS.items, {}); },
    async upsertItem(it) {
      const m = readJSON(LS.items, {});
      m[it.sku] = { ...m[it.sku], ...it, updated_at: now() };
      writeJSON(LS.items, m); emit();
    },
    async deleteItem(sku) {
      const m = readJSON(LS.items, {}); delete m[sku]; writeJSON(LS.items, m); emit();
    },
    async bulkUpsertItems(items) {
      const m = readJSON(LS.items, {});
      for (const it of items) if (it.sku) m[it.sku] = { ...m[it.sku], ...it, updated_at: now() };
      writeJSON(LS.items, m); emit();
    },
    async getSessions() {
      return readJSON(LS.sessions, []).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    },
    async createSession(name, store) {
      const s = { id: uid(), name: name || "棚卸し " + now().slice(0, 10), store: store || "", status: "open", created_at: now() };
      const arr = readJSON(LS.sessions, []); arr.push(s); writeJSON(LS.sessions, arr); emit();
      return s;
    },
    async setSessionStatus(id, status) {
      const arr = readJSON(LS.sessions, []);
      const s = arr.find((x) => x.id === id); if (s) s.status = status;
      writeJSON(LS.sessions, arr); emit();
    },
    async getScans(sessionId) {
      const all = readJSON(LS.scans, {});
      return Object.values(all[sessionId] || {}).sort((a, b) => (b.last_at || "").localeCompare(a.last_at || ""));
    },
    async getAllScans() {
      const all = readJSON(LS.scans, {});
      const storeById = {};
      readJSON(LS.sessions, []).forEach((s) => (storeById[s.id] = s.store || ""));
      const out = [];
      Object.entries(all).forEach(([sid, bag]) => {
        Object.values(bag).forEach((r) => out.push({ session_id: sid, store: storeById[sid] || "", location: r.location, sku: r.sku, qty: r.qty }));
      });
      return out;
    },
    async addScan(sessionId, sku, device, location, qty) {
      const loc = location || "店内在庫";
      const n = Math.max(1, parseInt(qty, 10) || 1);
      const all = readJSON(LS.scans, {});
      const bag = all[sessionId] || (all[sessionId] = {});
      const key = loc + "|" + sku;
      const items = readJSON(LS.items, {});
      const inMaster = !!items[sku];
      let rec = bag[key];
      let status;
      if (!rec) {
        rec = bag[key] = { sku, location: loc, qty: n, first_at: now(), last_at: now(), device: device || "" };
        status = inMaster ? "matched" : "new";
      } else {
        rec.qty += n; rec.last_at = now(); rec.device = device || rec.device;
        status = "dup";
      }
      writeJSON(LS.scans, all); emit();
      return { status, qty: rec.qty, item: items[sku] || null };
    },
    async removeScan(sessionId, sku, location) {
      const all = readJSON(LS.scans, {});
      const key = (location || "店内在庫") + "|" + sku;
      if (all[sessionId]) { delete all[sessionId][key]; writeJSON(LS.scans, all); emit(); }
    },
    // qtyをdelta分だけ増減。0以下になったら行ごと削除。読取後のqty(削除なら0)を返す。
    async adjustScan(sessionId, sku, location, delta) {
      const all = readJSON(LS.scans, {});
      const key = (location || "店内在庫") + "|" + sku;
      const bag = all[sessionId]; if (!bag || !bag[key]) return { qty: 0, removed: true };
      const rec = bag[key];
      rec.qty += parseInt(delta, 10) || 0;
      rec.last_at = now();
      let removed = false;
      if (rec.qty <= 0) { delete bag[key]; removed = true; }
      writeJSON(LS.scans, all); emit();
      return { qty: removed ? 0 : rec.qty, removed };
    },
    async clearScans(sessionId) {
      const all = readJSON(LS.scans, {});
      if (all[sessionId]) { delete all[sessionId]; writeJSON(LS.scans, all); emit(); }
    },
    // ラック確認ステータス（複数人の二重チェック防止）
    async getRackChecks(sessionId) {
      const all = readJSON(LS.rackChecks, {});
      return all[sessionId] || {};
    },
    async setRackCheck(sessionId, rack, patch) {
      const all = readJSON(LS.rackChecks, {});
      const bag = all[sessionId] || (all[sessionId] = {});
      bag[rack] = { session_id: sessionId, rack, ...(bag[rack] || {}), ...patch, updated_at: now() };
      writeJSON(LS.rackChecks, all); emit();
      return bag[rack];
    },
    async removeRackCheck(sessionId, rack) {
      const all = readJSON(LS.rackChecks, {});
      if (all[sessionId]) { delete all[sessionId][rack]; writeJSON(LS.rackChecks, all); emit(); }
    },
    async getStores() {
      return readJSON(LS.stores, []).slice().sort((a, b) => (a.brand || "").localeCompare(b.brand || "", "ja") || (a.name || "").localeCompare(b.name || "", "ja"));
    },
    async upsertStore(s) {
      const arr = readJSON(LS.stores, []);
      const i = arr.findIndex((x) => x.name === s.name);
      const rec = { name: s.name, brand: s.brand || "", area: s.area || "" };
      if (i > -1) arr[i] = rec; else arr.push(rec);
      writeJSON(LS.stores, arr); emit();
    },
    async deleteStore(name) { writeJSON(LS.stores, readJSON(LS.stores, []).filter((x) => x.name !== name)); emit(); },
    async bulkUpsertStores(list) {
      const arr = readJSON(LS.stores, []);
      const map = {}; arr.forEach((x) => (map[x.name] = x));
      list.forEach((s) => { if (s.name) map[s.name] = { name: s.name, brand: s.brand || "", area: s.area || "" }; });
      writeJSON(LS.stores, Object.values(map)); emit();
    },
  };

  /* ---------- Supabase 実装 ---------- */
  let sb = null;
  function loadSupabaseLib() {
    return new Promise((resolve, reject) => {
      if (window.supabase && window.supabase.createClient) return resolve();
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Supabaseライブラリの読込に失敗"));
      document.head.appendChild(s);
    });
  }

  const Cloud = {
    async getItems() {
      const { data, error } = await sb.from("items").select("*").order("name");
      if (error) throw error; return data || [];
    },
    async getItemMap() {
      const arr = await this.getItems(); const m = {}; arr.forEach((x) => (m[x.sku] = x)); return m;
    },
    async upsertItem(it) {
      const row = { sku: it.sku, name: it.name || "", category: it.category || "", price: num(it.price), expected: intOr(it.expected, 1) };
      const { error } = await sb.from("items").upsert(row, { onConflict: "sku" }); if (error) throw error;
    },
    async deleteItem(sku) { const { error } = await sb.from("items").delete().eq("sku", sku); if (error) throw error; },
    async bulkUpsertItems(items) {
      const rows = items.filter((i) => i.sku).map((it) => ({ sku: it.sku, name: it.name || "", category: it.category || "", price: num(it.price), expected: intOr(it.expected, 1) }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from("items").upsert(rows.slice(i, i + 500), { onConflict: "sku" }); if (error) throw error;
      }
    },
    async getSessions() {
      const { data, error } = await sb.from("sessions").select("*").order("created_at", { ascending: false });
      if (error) throw error; return data || [];
    },
    async createSession(name, store) {
      const { data, error } = await sb.from("sessions").insert({ name: name || "棚卸し " + now().slice(0, 10), store: store || "" }).select().single();
      if (error) throw error; return data;
    },
    async setSessionStatus(id, status) { const { error } = await sb.from("sessions").update({ status }).eq("id", id); if (error) throw error; },
    async getScans(sessionId) {
      const { data, error } = await sb.from("scans").select("*").eq("session_id", sessionId).order("last_at", { ascending: false });
      if (error) throw error; return data || [];
    },
    async getAllScans() {
      const { data, error } = await sb.from("scans").select("session_id, location, sku, qty");
      if (error) throw error;
      const storeById = {};
      (await this.getSessions()).forEach((s) => (storeById[s.id] = s.store || ""));
      return (data || []).map((r) => ({ ...r, store: storeById[r.session_id] || "" }));
    },
    async addScan(sessionId, sku, device, location, qty) {
      const loc = location || "店内在庫";
      const n = Math.max(1, parseInt(qty, 10) || 1);
      const { data, error } = await sb.rpc("add_scan", { p_session: sessionId, p_sku: sku, p_device: device || "", p_location: loc, p_qty: n });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const items = await this.getItemMap();
      const inMaster = !!items[sku];
      const status = row.qty > n ? "dup" : inMaster ? "matched" : "new";
      return { status, qty: row.qty, item: items[sku] || null };
    },
    async removeScan(sessionId, sku, location) {
      const { error } = await sb.from("scans").delete().eq("session_id", sessionId).eq("sku", sku).eq("location", location || "店内在庫");
      if (error) throw error;
    },
    async adjustScan(sessionId, sku, location, delta) {
      const loc = location || "店内在庫";
      const { data, error } = await sb.from("scans").select("qty").eq("session_id", sessionId).eq("sku", sku).eq("location", loc).maybeSingle();
      if (error) throw error;
      if (!data) return { qty: 0, removed: true };
      const newQty = (data.qty || 0) + (parseInt(delta, 10) || 0);
      if (newQty > 0) {
        const { error: e2 } = await sb.from("scans").update({ qty: newQty, last_at: now() }).eq("session_id", sessionId).eq("sku", sku).eq("location", loc);
        if (e2) throw e2;
        return { qty: newQty, removed: false };
      }
      const { error: e3 } = await sb.from("scans").delete().eq("session_id", sessionId).eq("sku", sku).eq("location", loc);
      if (e3) throw e3;
      return { qty: 0, removed: true };
    },
    async clearScans(sessionId) {
      const { error } = await sb.from("scans").delete().eq("session_id", sessionId);
      if (error) throw error;
    },
    // ラック確認ステータス（複数人の二重チェック防止）
    async getRackChecks(sessionId) {
      const { data, error } = await sb.from("rack_checks").select("*").eq("session_id", sessionId);
      if (error) throw error;
      const m = {}; (data || []).forEach((r) => (m[r.rack] = r)); return m;
    },
    async setRackCheck(sessionId, rack, patch) {
      const row = { session_id: sessionId, rack, ...patch, updated_at: now() };
      const { data, error } = await sb.from("rack_checks").upsert(row, { onConflict: "session_id,rack" }).select().single();
      if (error) throw error; return data;
    },
    async removeRackCheck(sessionId, rack) {
      const { error } = await sb.from("rack_checks").delete().eq("session_id", sessionId).eq("rack", rack);
      if (error) throw error;
    },
    async getStores() {
      const { data, error } = await sb.from("stores").select("*").order("brand").order("name");
      if (error) throw error; return data || [];
    },
    async upsertStore(s) {
      const { error } = await sb.from("stores").upsert({ name: s.name, brand: s.brand || "", area: s.area || "" }, { onConflict: "name" });
      if (error) throw error;
    },
    async deleteStore(name) { const { error } = await sb.from("stores").delete().eq("name", name); if (error) throw error; },
    async bulkUpsertStores(list) {
      const rows = list.filter((s) => s.name).map((s) => ({ name: s.name, brand: s.brand || "", area: s.area || "" }));
      if (rows.length) { const { error } = await sb.from("stores").upsert(rows, { onConflict: "name" }); if (error) throw error; }
    },
  };

  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const intOr = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };

  /* ---------- ファサード ---------- */
  const DB = {
    mode: "local",
    impl: Local,
    _channel: null,

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    getDeviceName() { return localStorage.getItem(LS.device) || ""; },
    setDeviceName(v) { localStorage.setItem(LS.device, v || ""); },

    getSavedCreds() {
      return {
        url: localStorage.getItem(LS.sbUrl) || (window.APP_CONFIG && window.APP_CONFIG.supabaseUrl) || "",
        key: localStorage.getItem(LS.sbKey) || (window.APP_CONFIG && window.APP_CONFIG.supabaseAnonKey) || "",
      };
    },

    async init() {
      const { url, key } = this.getSavedCreds();
      if (url && key) {
        try { await this._connect(url, key); return; }
        catch (e) { console.warn("Supabase接続失敗、ローカルにフォールバック:", e); }
      }
      this.mode = "local"; this.impl = Local;
    },

    async _connect(url, key) {
      await loadSupabaseLib();
      sb = window.supabase.createClient(url, key, { realtime: { params: { eventsPerSecond: 5 } } });
      // 疎通確認
      const { error } = await sb.from("sessions").select("id").limit(1);
      if (error) throw error;
      this.mode = "cloud"; this.impl = Cloud;
      this._subscribeRealtime();
    },

    _subscribeRealtime() {
      if (this._channel) { try { sb.removeChannel(this._channel); } catch {} this._channel = null; }
      this._channel = sb.channel("fi_changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "scans" }, emit)
        .on("postgres_changes", { event: "*", schema: "public", table: "rack_checks" }, emit)
        .on("postgres_changes", { event: "*", schema: "public", table: "items" }, emit)
        .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, emit)
        .on("postgres_changes", { event: "*", schema: "public", table: "stores" }, emit)
        .subscribe();
    },

    // 設定画面から: 接続テストして保存
    async connectAndSave(url, key) {
      url = (url || "").trim().replace(/\/$/, "");
      key = (key || "").trim();
      if (!url || !key) throw new Error("URLとキーを入力してください");
      await this._connect(url, key);
      localStorage.setItem(LS.sbUrl, url);
      localStorage.setItem(LS.sbKey, key);
      emit();
    },

    disconnectCloud() {
      if (this._channel && sb) { try { sb.removeChannel(this._channel); } catch {} }
      this._channel = null; sb = null;
      localStorage.removeItem(LS.sbUrl); localStorage.removeItem(LS.sbKey);
      this.mode = "local"; this.impl = Local; emit();
    },

    wipeLocal() {
      [LS.items, LS.sessions, LS.scans].forEach((k) => localStorage.removeItem(k));
      emit();
    },

    // --- データAPI（現在の実装へ委譲） ---
    getItems() { return this.impl.getItems(); },
    getItemMap() { return this.impl.getItemMap(); },
    upsertItem(it) { return this.impl.upsertItem(it); },
    deleteItem(sku) { return this.impl.deleteItem(sku); },
    bulkUpsertItems(items) { return this.impl.bulkUpsertItems(items); },
    getSessions() { return this.impl.getSessions(); },
    createSession(name, store) { return this.impl.createSession(name, store); },
    setSessionStatus(id, s) { return this.impl.setSessionStatus(id, s); },
    getScans(sid) { return this.impl.getScans(sid); },
    getAllScans() { return this.impl.getAllScans(); },
    addScan(sid, sku, dev, loc, qty) { return this.impl.addScan(sid, sku, dev, loc, qty); },
    removeScan(sid, sku, loc) { return this.impl.removeScan(sid, sku, loc); },
    adjustScan(sid, sku, loc, delta) { return this.impl.adjustScan(sid, sku, loc, delta); },
    clearScans(sid) { return this.impl.clearScans(sid); },
    getRackChecks(sid) { return this.impl.getRackChecks(sid); },
    setRackCheck(sid, rack, patch) { return this.impl.setRackCheck(sid, rack, patch); },
    removeRackCheck(sid, rack) { return this.impl.removeRackCheck(sid, rack); },

    // 店舗マスタ
    getStores() { return this.impl.getStores(); },
    upsertStore(s) { return this.impl.upsertStore(s); },
    deleteStore(name) { return this.impl.deleteStore(name); },
    bulkUpsertStores(list) { return this.impl.bulkUpsertStores(list); },
  };

  window.DB = DB;
})();
