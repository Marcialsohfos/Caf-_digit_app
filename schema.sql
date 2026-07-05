-- ============================================================
-- Café_digit — schéma de base de données (Supabase / Postgres)
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- PROFILS (1 profil = 1 utilisateur Supabase Auth) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  tier text not null default 'standard' check (tier in ('standard','premium')),
  created_at timestamptz not null default now()
);

-- Crée automatiquement un profil (tier standard par défaut) dès qu'un
-- utilisateur Supabase Auth est créé. La fonction redeem-key ajustera
-- ensuite le tier réel juste après.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- CLÉS D'ACCÈS ----------
create table if not exists public.access_keys (
  id uuid primary key default gen_random_uuid(),
  key_code text unique not null,
  email text not null,
  tier text not null default 'standard' check (tier in ('standard','premium')),
  status text not null default 'issued' check (status in ('issued','redeemed','revoked')),
  issued_at timestamptz not null default now(),
  redeemed_at timestamptz,
  expires_at timestamptz
);
create index if not exists idx_access_keys_lookup on public.access_keys (key_code, email);

-- ---------- CONTENU : cours > modules > leçons ----------
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  description text,
  order_index int not null default 0
);

create table if not exists public.modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  order_index int not null default 0,
  required_tier text not null default 'standard' check (required_tier in ('standard','premium'))
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete cascade,
  title text not null,
  content_type text not null default 'text' check (content_type in ('text','video','table','quiz')),
  content jsonb not null default '{}'::jsonb,
  order_index int not null default 0,
  required_tier text not null default 'standard' check (required_tier in ('standard','premium'))
);

-- ---------- PROGRESSION ----------
create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started','in_progress','completed')),
  percent int not null default 0 check (percent between 0 and 100),
  updated_at timestamptz not null default now(),
  unique (user_id, lesson_id)
);

-- ---------- CERTIFICATS ----------
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  issued_at timestamptz not null default now(),
  certificate_url text
);

-- ---------- Fonction utilitaire : classement des tiers ----------
create or replace function public.tier_rank(t text) returns int
language sql immutable as $$
  select case t when 'premium' then 2 else 1 end;
$$;

create or replace function public.my_tier() returns text
language sql stable security definer as $$
  select tier from public.profiles where id = auth.uid();
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles enable row level security;
alter table public.access_keys enable row level security;
alter table public.courses enable row level security;
alter table public.modules enable row level security;
alter table public.lessons enable row level security;
alter table public.progress enable row level security;
alter table public.certificates enable row level security;

-- profiles : chacun voit/modifie seulement son propre profil
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- access_keys : AUCUN accès direct depuis le client.
-- Seules les Edge Functions (clé service_role, qui contourne RLS) y touchent.

-- courses / modules : lecture libre pour tout utilisateur connecté
create policy "courses_select_authenticated" on public.courses
  for select using (auth.role() = 'authenticated');

create policy "modules_select_by_tier" on public.modules
  for select using (
    auth.role() = 'authenticated'
    and tier_rank(required_tier) <= tier_rank(my_tier())
  );

-- lessons : lecture réservée aux utilisateurs dont le tier suffit
create policy "lessons_select_by_tier" on public.lessons
  for select using (
    auth.role() = 'authenticated'
    and tier_rank(required_tier) <= tier_rank(my_tier())
  );

-- progress : chacun lit/écrit uniquement sa propre progression
create policy "progress_select_own" on public.progress
  for select using (auth.uid() = user_id);
create policy "progress_upsert_own" on public.progress
  for insert with check (auth.uid() = user_id);
create policy "progress_update_own" on public.progress
  for update using (auth.uid() = user_id);

-- certificates : chacun voit seulement les siens (émis côté serveur uniquement)
create policy "certificates_select_own" on public.certificates
  for select using (auth.uid() = user_id);

-- ============================================================
-- DONNÉES DE DÉPART (reprend le contenu du prototype)
-- ============================================================
insert into public.courses (slug, title, description, order_index) values
  ('modelisation-appliquee', 'Modélisation appliquée & Automates cellulaires pour l''urbanisme',
   'Du signal faible à la prédiction : construire et calibrer un modèle prédictif d''expansion urbaine.', 1)
on conflict (slug) do nothing;

-- Récupère l'id du cours pour créer modules/leçons
do $$
declare c_id uuid;
declare m1 uuid; declare m2 uuid; declare m3 uuid;
begin
  select id into c_id from public.courses where slug = 'modelisation-appliquee';

  insert into public.modules (course_id, title, order_index, required_tier)
    values (c_id, '1. Fondations', 1, 'standard') returning id into m1;
  insert into public.modules (course_id, title, order_index, required_tier)
    values (c_id, '2. Modélisation appliquée', 2, 'standard') returning id into m2;
  insert into public.modules (course_id, title, order_index, required_tier)
    values (c_id, '3. IA & Big Data terrain', 3, 'premium') returning id into m3;

  insert into public.lessons (module_id, title, content_type, order_index, required_tier, content) values
    (m1, 'Qu''est-ce que la modélisation ?', 'text', 1, 'standard', '{}'),
    (m1, 'Panorama des outils (R, Python, QGIS)', 'text', 2, 'standard', '{}'),
    (m1, 'Vérifiez vos acquis (non noté)', 'quiz', 3, 'standard', '{}'),
    (m2, 'L''indice de pression d''équipement (IPE)', 'table', 1, 'standard',
      '{"intro":"L''IPE combine plusieurs signaux faibles pour estimer le degré de saturation d''un quartier.","rows":[["Antennes relais","Nouvelles installations télécoms sur 6–12 mois","Élevé"],["Forages privés","Multiplication des points d''eau individuels","Élevé"],["Densité de bâti","Captée par imagerie drone, évolution trimestrielle","Très élevé"],["Flux motos / taxis","Fréquentation et régularité des dessertes","Moyen"],["Positions foncières informelles","Déclarations et occupations non enregistrées","Moyen"]],"source":"Lab_Math — Méthodologie de l''Indice de Pression d''Équipement (IPE), Café_digit."}'),
    (m2, 'Automates cellulaires : principes', 'text', 2, 'standard', '{}'),
    (m2, 'Calibrer un modèle sur un quartier connu', 'text', 3, 'standard', '{}'),
    (m2, 'Auto-évaluation (non noté)', 'quiz', 4, 'standard', '{}'),
    (m3, 'IA supervisée pour la prédiction', 'text', 1, 'premium', '{}'),
    (m3, 'Collecte terrain (Kobo, drones)', 'text', 2, 'premium', '{}'),
    (m3, 'Étude de cas : quartier hors-piste', 'text', 3, 'premium', '{}');
end $$;
