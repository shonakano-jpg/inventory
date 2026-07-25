/* ============================================================
   バーコード読取（html5-qrcode ラッパ）。
   店独自の値札に多い 1次元コード中心に、QRも対応。
   ============================================================ */
(function () {
  "use strict";

  function supportedFormats() {
    const F = window.Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    // 値札のインハウスコードは店内用JAN-13(EAN-13, 先頭2)。
    // 誤読を抑えるため対応形式を絞る（EAN-13主、Code128とQRを予備）。
    return [F.EAN_13, F.CODE_128, F.QR_CODE];
  }

  const Scanner = {
    h5: null,
    running: false,
    _onDecode: null,
    _lastText: "",
    _lastAt: 0,
    cooldownMs: 2000, // 1回読んだら、この時間は次の読取を受け付けない（全コード共通）

    isScanning() { return this.running; },

    async start(elementId, onDecode) {
      if (this.running) return;
      if (!window.Html5Qrcode) throw new Error("スキャナライブラリ未読込");
      this._onDecode = onDecode;

      // Html5Qrcode は start() が失敗すると内部状態が「遷移中」のままになり、
      // 同じインスタンスで再度 start() すると
      // "Cannot transition to a new state, already under transition" になる。
      // そのため試行ごとにインスタンスを作り直す。
      const makeInstance = () => new window.Html5Qrcode(elementId, {
        formatsToSupport: supportedFormats(),
        useBarCodeDetectorIfSupported: true,
        verbose: false,
      });

      const success = (text) => {
        const t = (text || "").trim();
        if (!t) return;
        const ts = Date.now();
        // 直近の読取から cooldownMs（既定2秒）経つまでは、どのコードも受け付けない。
        // カメラは動いたまま連続でスキャンでき、2秒ごとに1点ずつ確定する。
        if (ts - this._lastAt < this.cooldownMs) return;
        this._lastAt = ts; this._lastText = t;
        this._onDecode && this._onDecode(t);
      };
      const fail = () => {}; // フレーム毎の未検出は無視

      const config = {
        fps: 12,
        qrbox: (vw, vh) => {
          // 1次元バーコード向けに横長・広めの枠（合焦と位置合わせの許容度UP）
          const w = Math.min(vw, vh) * 0.9;
          return { width: Math.round(w), height: Math.round(w * 0.55) };
        },
        aspectRatio: 1.4,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      };

      // 値札のバーコードは細い（Code128/EAN-13）ため、既定の低解像度だと
      // ピンボケで読めない。解像度を ideal で上げてバー1本あたりの画素を稼ぐ。
      // ideal 指定は拒否されない（best-effort）。合焦(focusMode)は getUserMedia で
      // 弾かれる端末があるので初回制約には入れず、起動後に別途適用する。
      const attempts = [
        { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        { facingMode: "environment" },
      ];

      let started = false, lastErr = null;
      for (const cam of attempts) {
        this.h5 = makeInstance();
        try {
          await this.h5.start(cam, config, success, fail);
          started = true; break;
        } catch (e) {
          lastErr = e;
          try { await this.h5.stop(); } catch {}
          try { await this.h5.clear(); } catch {}
        }
      }

      if (!started) {
        // 背面カメラをID指定で最終フォールバック
        this.h5 = makeInstance();
        const cams = await window.Html5Qrcode.getCameras();
        if (!cams || !cams.length) throw lastErr || new Error("カメラが見つかりません");
        const back = cams.find((c) => /back|rear|environment|背面/i.test(c.label)) || cams[cams.length - 1];
        await this.h5.start(back.id, config, success, fail);
      }

      this.running = true;
      // 起動後にフォーカス・ズームを最適化（対応端末のみ・失敗は無視）
      this._tuneCamera();
    },

    _zoomCap: null,

    async _tuneCamera() {
      // 連続オートフォーカス（対応端末のみ）
      try { await this.h5.applyVideoConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
      // ズーム対応端末なら初期倍率を上げ、細いバーコードを大きく写して画素を稼ぐ
      this._zoomCap = null;
      try {
        const caps = this.h5.getRunningTrackCapabilities && this.h5.getRunningTrackCapabilities();
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
      if (!this.h5 || !this.running) return false;
      try { await this.h5.applyVideoConstraints({ advanced: [{ zoom: v }] }); return true; }
      catch { return false; }
    },

    currentZoom() {
      try {
        const s = this.h5 && this.h5.getRunningTrackSettings && this.h5.getRunningTrackSettings();
        return s && typeof s.zoom === "number" ? s.zoom : null;
      } catch { return null; }
    },

    async stop() {
      if (!this.h5 || !this.running) return;
      try { await this.h5.stop(); } catch {}
      try { await this.h5.clear(); } catch {}
      this.running = false;
    },

    async toggleTorch(on) {
      if (!this.h5 || !this.running) return false;
      try {
        await this.h5.applyVideoConstraints({ advanced: [{ torch: !!on }] });
        return true;
      } catch { return false; }
    },

    torchSupported() {
      try {
        const caps = this.h5 && this.h5.getRunningTrackCapabilities && this.h5.getRunningTrackCapabilities();
        return !!(caps && "torch" in caps);
      } catch { return false; }
    },
  };

  window.Scanner = Scanner;
})();
