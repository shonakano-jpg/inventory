-- ============================================================
--  古着棚卸し PWA — Supabase スキーマ
--  Supabase の SQL Editor に貼り付けて実行してください。
--  （複数店舗 / ロケーション大分類対応版）
-- ============================================================

-- 商品マスタ（インハウスコード = sku。カテゴリ×価格のバーコード）
create table if not exists public.items (
  sku        text primary key,
  name       text not null default '',
  category   text not null default '',
  price      numeric,
  expected   integer,                       -- 想定数（任意。空なら欠品判定しない）
  updated_at timestamptz not null default now()
);

-- 店舗マスタ
create table if not exists public.stores (
  name       text primary key,
  brand      text not null default '',
  area       text not null default '',
  created_at timestamptz not null default now()
);

-- 店舗ごとの登録ラック一覧（カウント漏れ防止用）。改行/カンマ区切り・範囲(A1-A20)可。
alter table public.stores add column if not exists racks text not null default '';

-- 棚卸しセッション（どの店舗の棚卸しか）
create table if not exists public.sessions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '棚卸し',
  store      text not null default '',       -- 店舗名
  status     text not null default 'open',   -- 'open' | 'closed'
  created_at timestamptz not null default now()
);

-- 読取（セッション × ロケーション大分類 × SKU で1行、qtyを加算）
create table if not exists public.scans (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  location   text not null default '店内在庫',  -- 店内在庫 / バックヤード在庫 / その他倉庫
  sku        text not null,
  qty        integer not null default 1,
  device     text not null default '',
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  unique (session_id, location, sku)
);

create index if not exists scans_session_idx on public.scans (session_id);

-- ラック確認ステータス（複数人での二重チェック防止。店内ラック単位）
--   status: 'provisional'（仮登録=1回目完了） / 'checked'（ダブルチェック完了）
create table if not exists public.rack_checks (
  session_id uuid not null references public.sessions(id) on delete cascade,
  rack       text not null,
  status     text not null default 'provisional',
  first_by   text not null default '',
  first_at   timestamptz,
  checked_by text not null default '',
  checked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id, rack)
);

-- 読取加算（なければ挿入）。p_qtyだけ加算。読取後の行を返す。
create or replace function public.add_scan(
  p_session uuid, p_sku text, p_device text default '', p_location text default '店内在庫', p_qty integer default 1
) returns public.scans
language plpgsql
as $$
declare r public.scans; n integer := greatest(1, coalesce(p_qty, 1));
begin
  insert into public.scans (session_id, location, sku, qty, device)
  values (p_session, coalesce(nullif(p_location,''),'店内在庫'), p_sku, n, coalesce(p_device, ''))
  on conflict (session_id, location, sku)
  do update set qty = public.scans.qty + n,
                last_at = now(),
                device = coalesce(nullif(excluded.device, ''), public.scans.device)
  returning * into r;
  return r;
end;
$$;

-- リアルタイム配信を有効化（再実行してもエラーにならないよう存在チェック）
do $$
declare t text;
begin
  foreach t in array array['items','stores','sessions','scans','rack_checks'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
--  アクセス制御（RLS）: anonキーを持つ全員が読み書き可（店舗内運用向け最小構成）
-- ------------------------------------------------------------
alter table public.items       enable row level security;
alter table public.stores      enable row level security;
alter table public.sessions    enable row level security;
alter table public.scans       enable row level security;
alter table public.rack_checks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='items' and policyname='items_all') then
    create policy items_all on public.items for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='stores' and policyname='stores_all') then
    create policy stores_all on public.stores for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='sessions' and policyname='sessions_all') then
    create policy sessions_all on public.sessions for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='scans' and policyname='scans_all') then
    create policy scans_all on public.scans for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='rack_checks' and policyname='rack_checks_all') then
    create policy rack_checks_all on public.rack_checks for all using (true) with check (true);
  end if;
end $$;
