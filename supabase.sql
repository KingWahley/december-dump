-- MGE: Run this once in the Supabase SQL Editor (safe to re-run).
-- 1. Create the admin user in Authentication > Users (kingwahley@gmail.com).
-- 2. Run this whole script. The final statement authorizes that admin.
-- IMPORTANT: The frontend uses only the publishable/anon key. NEVER embed service_role/secret keys.

create table if not exists public.ticket_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table if not exists public.tickets (
  ticket_id text primary key check (char_length(ticket_id) between 8 and 60),
  holder_name text not null check (char_length(trim(holder_name)) between 1 and 120),
  ticket_type text not null check (ticket_type in ('Standard', 'VIP', 'VVIP', 'Early Bird', 'Staff')),
  phone text,
  email text,
  event_name text not null,
  event_date date,
  venue text,
  delivery_status text not null default 'not_sent' check (delivery_status in ('not_sent', 'whatsapp_opened', 'sent_confirmed')),
  status text not null default 'valid' check (status in ('valid', 'checked_in', 'void')),
  created_at timestamptz not null default now(),
  issued_by uuid references auth.users(id) default auth.uid(),
  sent_at timestamptz,
  checked_in_at timestamptz,
  constraint ticket_has_contact check (nullif(trim(coalesce(phone, '')), '') is not null or nullif(trim(coalesce(email, '')), '') is not null)
);

create index if not exists tickets_created_at_idx on public.tickets(created_at desc);
create index if not exists tickets_holder_name_idx on public.tickets(holder_name);

-- Event details shared by all admins. The Settings page edits the active event.
-- Each ticket still keeps its own copy of event name/date/venue, so editing an
-- event never alters tickets that were already issued.
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null check (char_length(trim(event_name)) between 1 and 160),
  event_date date,
  venue text check (venue is null or char_length(venue) <= 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid()
);
-- At most one active event at a time.
create unique index if not exists events_single_active_idx on public.events(is_active) where is_active;

alter table public.tickets add column if not exists event_id uuid references public.events(id) on delete set null;
create index if not exists tickets_event_id_idx on public.tickets(event_id);

alter table public.ticket_admins enable row level security;
alter table public.tickets enable row level security;
alter table public.events enable row level security;

-- Authenticated users may see only their own admin membership record.
drop policy if exists "View own admin membership" on public.ticket_admins;
create policy "View own admin membership"
on public.ticket_admins for select to authenticated
using (user_id = (select auth.uid()));

-- All ticket CRUD from the browser is permitted ONLY to listed admins.
drop policy if exists "Admins view tickets" on public.tickets;
create policy "Admins view tickets" on public.tickets for select to authenticated
using (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())));

drop policy if exists "Admins issue tickets" on public.tickets;
create policy "Admins issue tickets" on public.tickets for insert to authenticated
with check (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())));

drop policy if exists "Admins update tickets" on public.tickets;
create policy "Admins update tickets" on public.tickets for update to authenticated
using (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())))
with check (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())));

revoke all on public.ticket_admins from anon;
revoke all on public.tickets from anon;
grant select on public.ticket_admins to authenticated;
grant select, insert, update on public.tickets to authenticated;
revoke delete on public.tickets from authenticated;

-- Event details: readable and editable ONLY by listed admins.
drop policy if exists "Admins view events" on public.events;
create policy "Admins view events" on public.events for select to authenticated
using (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())));

drop policy if exists "Admins create events" on public.events;
create policy "Admins create events" on public.events for insert to authenticated
with check (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())));

drop policy if exists "Admins update events" on public.events;
create policy "Admins update events" on public.events for update to authenticated
using (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())))
with check (exists (select 1 from public.ticket_admins where user_id = (select auth.uid())));

revoke all on public.events from anon;
grant select, insert, update on public.events to authenticated;
revoke delete on public.events from authenticated;

-- Authorize the administrator. Create this user FIRST in
-- Authentication > Users, then run this statement (re-running is safe).
insert into public.ticket_admins (user_id)
select id from auth.users where email = 'kingwahley@gmail.com'
on conflict (user_id) do nothing;

-- Make the new tables visible to the API immediately.
notify pgrst, 'reload schema';
