create table if not exists public.users (
  id bigint generated always as identity primary key,
  microsoft_sub text,
  minecraft_uuid text not null unique,
  minecraft_name text not null,
  email text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  rank_name text not null,
  amount_eur_cents integer not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded')),
  provider_ref text,
  created_at timestamptz not null default timezone('utc', now()),
  paid_at timestamptz
);

create index if not exists payments_user_id_idx on public.payments(user_id);
create index if not exists payments_status_idx on public.payments(status);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();
