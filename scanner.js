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
      this.h5 = new window.Html5Qrcode(elementId, {
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
          const w = Math.min(vw, vh) * 0.82;
          return { width: Math.round(w), height: Math.round(w * 0.62) };
        },
        aspectRatio: 1.4,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      };

      try {
        await this.h5.start({ facingMode: "environment" }, config, success, fail);
      } catch (e) {
        // 背面指定が失敗する端末向けフォールバック
        const cams = await window.Html5Qrcode.getCameras();
        if (!cams || !cams.length) throw new Error("カメラが見つかりません");
        const back = cams.find((c) => /back|rear|environment|背面/i.test(c.label)) || cams[cams.length - 1];
        await this.h5.start(back.id, config, success, fail);
      }
      this.running = true;
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
