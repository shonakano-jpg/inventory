/* ============================================================
   バーコード読取。
   デコードは zxing-wasm（zxing-cpp のブラウザ/WASM版＝強力）を使用。
   html5-qrcode 内蔵の ZXing-JS では実物の値札（小さめのCode128）が
   読めなかったため、カメラ制御は getUserMedia で自前実装し、
   フレームを zxing-wasm に渡して読み取る。
   値札は先頭「230」の13桁（Code128 / 一部EAN-13想定）。
   ============================================================ */
(function () {
  "use strict";

  // 強力デコーダ（WASM）。ESMを動的import。wasm本体は同バージョンを
  // jsDelivr から自動取得（locateFile 既定）。
  const READER_URL = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.2/dist/es/reader/index.js";
  let _readerPromise = null;
  function loadReader() {
    if (!_readerPromise) _readerPromise = import(READER_URL);
    return _readerPromise;
  }

  // 誤読低減のため対応形式を絞る（値札はCode128主、EAN-13/QR予備）。
  const FORMATS = ["Code128", "EAN13", "QRCode"];

  const Scanner = {
    running: false,
    _onDecode: null,
    _lastText: "",
    _lastAt: 0,
    cooldownMs: 2000, // 同じコードを連続で受け付けない時間（重複カウント防止）
    minGapMs: 500,    // 別のコードでも、最低これだけは間隔をあける（暴走防止）

    video: null,
    stream: null,
    track: null,
    canvas: null,
    cctx: null,
    _timer: null,
    _busy: false,
    _reader: null,
    _zoomCap: null,

    isScanning() { return this.running; },

    async start(elementId, onDecode) {
      if (this.running) return;
      this._onDecode = onDecode;

      // デコードエンジン（WASM）を先に読み込む
      let reader;
      try { reader = await loadReader(); }
      catch (e) { throw new Error("読取エンジンの読込に失敗しました（通信環境をご確認ください）"); }
      this._reader = reader;

      const container = document.getElementById(elementId);
      if (!container) throw new Error("表示領域が見つかりません");
      let video = container.querySelector("video");
      if (!video) {
        video = document.createElement("video");
        video.setAttribute("playsinline", "true");
        video.setAttribute("webkit-playsinline", "true");
        video.setAttribute("muted", "true");
        video.muted = true;
        video.playsInline = true;
        container.innerHTML = "";
        container.appendChild(video);
      }
      this.video = video;

      // 背面カメラ＋高解像度を要求（ideal 指定は拒否されない best-effort）。
      // 弾かれる端末向けに段階的フォールバック。
      const tries = [
        { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
        { audio: false, video: { facingMode: "environment" } },
        { audio: false, video: true },
      ];
      let stream = null, lastErr = null;
      for (const c of tries) {
        try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
        catch (e) { lastErr = e; }
      }
      if (!stream) throw lastErr || new Error("カメラを起動できません");
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];

      video.srcObject = stream;
      try { await video.play(); } catch {}

      this.canvas = document.createElement("canvas");
      this.cctx = this.canvas.getContext("2d", { willReadFrequently: true });

      this.running = true;
      this._tuneCamera();
      // 定間隔でフレームを取り込みデコード（_busyで多重実行を防止）
      this._timer = setInterval(() => this._tick(), 150);
    },

    async _tick() {
      if (!this.running || this._busy) return;
      const v = this.video;
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      this._busy = true;
      try {
        const vw = v.videoWidth, vh = v.videoHeight;
        // 画面に見えている帯の範囲だけを読取対象にする。
        // 表示は object-fit: cover なので、その切り出し矩形を映像座標で再現する。
        // （帯外にあるバーコードを誤って読まないため）
        const dispW = v.clientWidth || vw, dispH = v.clientHeight || vh;
        const cover = Math.max(dispW / vw, dispH / vh) || 1;
        const srcW = Math.min(vw, dispW / cover);
        const srcH = Math.min(vh, dispH / cover);
        const srcX = (vw - srcW) / 2, srcY = (vh - srcH) / 2;
        // 取り込みは最大1920幅（細いバーの解像度を落とさないよう極力縮小しない）
        const outScale = Math.min(1, 1920 / srcW);
        const cw = Math.max(1, Math.round(srcW * outScale));
        const ch = Math.max(1, Math.round(srcH * outScale));
        if (this.canvas.width !== cw) this.canvas.width = cw;
        if (this.canvas.height !== ch) this.canvas.height = ch;
        this.cctx.drawImage(v, srcX, srcY, srcW, srcH, 0, 0, cw, ch);
        const img = this.cctx.getImageData(0, 0, cw, ch);

        const results = await this._reader.readBarcodes(img, {
          formats: FORMATS,
          tryHarder: true,
          tryRotate: true,
          tryDownscale: true,
        });

        if (results && results.length) {
          const r = results.find((x) => x && x.text) || results[0];
          const t = ((r && r.text) || "").trim();
          if (t) {
            const ts = Date.now();
            const gap = ts - this._lastAt;
            const sameAsLast = (t === this._lastText);
            // 同じコード: cooldownMs 待つ / 別のコード: minGapMs だけ待てば即受付
            if (gap >= this.cooldownMs || (!sameAsLast && gap >= this.minGapMs)) {
              this._lastAt = ts; this._lastText = t;
              this._onDecode && this._onDecode(t);
            }
          }
        }
      } catch (e) {
        // デコード失敗フレームは無視
      } finally {
        this._busy = false;
      }
    },

    async _tuneCamera() {
      const track = this.track;
      if (!track || !track.applyConstraints) return;
      // 連続オートフォーカス（対応端末のみ）
      try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
      // ズーム対応端末なら初期倍率を上げ、細いバーコードを大きく写して画素を稼ぐ
      this._zoomCap = null;
      try {
        const caps = track.getCapabilities && track.getCapabilities();
        if (caps && caps.zoom && typeof caps.zoom.max === "number") {
          const min = (typeof caps.zoom.min === "number") ? caps.zoom.min : 1;
          const max = caps.zoom.max;
          const step = caps.zoom.step || 0.1;
          this._zoomCap = { min, max, step };
          const target = Math.min(max, Math.max(min, 2)); // 既定2倍
          await this.setZoom(target);
        }
      } catch {}
    },

    zoomCap() { return this._zoomCap; },

    async setZoom(v) {
      if (!this.track || !this.running) return false;
      try { await this.track.applyConstraints({ advanced: [{ zoom: v }] }); return true; }
      catch { return false; }
    },

    currentZoom() {
      try {
        const s = this.track && this.track.getSettings && this.track.getSettings();
        return s && typeof s.zoom === "number" ? s.zoom : null;
      } catch { return null; }
    },

    async stop() {
      if (!this.running) return;
      this.running = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      try { if (this.video) { this.video.pause(); this.video.srcObject = null; } } catch {}
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch {}
      this.stream = null; this.track = null; this._zoomCap = null;
    },

    async toggleTorch(on) {
      if (!this.track) return false;
      try { await this.track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; }
      catch { return false; }
    },

    torchSupported() {
      try {
        const caps = this.track && this.track.getCapabilities && this.track.getCapabilities();
        return !!(caps && "torch" in caps);
      } catch { return false; }
    },
  };

  window.Scanner = Scanner;
})();
