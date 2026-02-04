-- A-Lister initial schema

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key,
  auth_provider_id text unique not null,
  handle text unique not null,
  display_name text,
  bio text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists lists (
  id uuid primary key,
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  type text not null,
  visibility text not null default 'public',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key,
  list_id uuid not null references lists(id) on delete cascade,
  title text not null,
  note text,
  url text,
  status text not null default 'active',
  order_index int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bookmarks (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  source_item_id uuid not null,
  source_list_id uuid not null,
  source_user_id uuid not null,
  created_item_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_lists_owner on lists(owner_id);
create index if not exists idx_items_list on items(list_id);
create index if not exists idx_items_status on items(status);
create index if not exists idx_users_handle on users(handle);
create index if not exists idx_bookmarks_user on bookmarks(user_id);
