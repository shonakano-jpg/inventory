// クラウド共有の接続設定（アプリ本体に埋め込み）。
// これを設定しておくと、各端末はアプリURLを開くだけで自動的にクラウド接続されます。
// （設定画面での手入力は不要。anonキーは公開前提・RLSで保護されている鍵です）
window.APP_CONFIG = {
  supabaseUrl: "https://qtzdfcqfgbrjqsofphzk.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0emRmY3FmZ2JyanFzb2ZwaHprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5NjQ4NDcsImV4cCI6MjEwMDU0MDg0N30.dDohoR6eJvVRflVkiGiqE-a1Wx5svvVeDcwZHy7gsiE",
};
