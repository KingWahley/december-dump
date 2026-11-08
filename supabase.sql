-- MGE: Run this once in the Supabase SQL Editor (safe to re-run).
-- All users created in Supabase Authentication > Users automatically receive full admin access.
-- IMPORTANT: The frontend uses only the publishable/anon key. NEVER embed service_role/secret keys.

create table if not exists public.ticket_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- Automatically grant admin access to every user created in Authentication > Users.
create or replace function public.handle_new_admin_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ticket_admins (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_admin on auth.users;
create trigger on_auth_user_created_admin
after insert on auth.users
for each row execute function public.handle_new_admin_user();

create table if not exists public.tickets (
  ticket_id text primary key check (char_length(ticket_id) between 8 and 60),
  holder_name text not null check (char_length(trim(holder_name)) between 1 and 120),
  ticket_type text not null check (ticket_type in ('Pair of two - Early bird', 'Regular - Early bird', 'Squad of three - Early birds', 'Squad of four - Early birds', 'Standard', 'VIP', 'VVIP', 'Early Bird', 'Staff')),
  phone text,
  email text,
  event_name text not null,
  event_date date,
  venue text,
  delivery_status text not null default 'not_sent' check (delivery_status in ('not_sent', 'whatsapp_opened', 'sent_confirmed')),
  status text not null default 'valid' check (status in ('valid', 'checked_in', 'void')),
  created_at timestamptz not null default now(),
  issued_by uuid references auth.users(id) default auth.uid(),
  issued_by_email text default (auth.jwt() ->> 'email'),
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
alter table public.tickets add column if not exists issued_by_email text default (auth.jwt() ->> 'email');
alter table public.tickets drop constraint if exists tickets_ticket_type_check;
alter table public.tickets add constraint tickets_ticket_type_check check (ticket_type in ('Pair of two - Early bird', 'Regular - Early bird', 'Squad of three - Early birds', 'Squad of four - Early birds', 'Standard', 'VIP', 'VVIP', 'Early Bird', 'Staff'));
create index if not exists tickets_event_id_idx on public.tickets(event_id);

-- Backfill issued_by_email for any existing tickets from auth.users.
update public.tickets t
set issued_by_email = u.email
from auth.users u
where t.issued_by = u.id and (t.issued_by_email is null or t.issued_by_email = '');

alter table public.ticket_admins enable row level security;
alter table public.tickets enable row level security;
alter table public.events enable row level security;

-- Authenticated users may see their own admin membership record.
drop policy if exists "View own admin membership" on public.ticket_admins;
create policy "View own admin membership"
on public.ticket_admins for select to authenticated
using (true);

-- All authenticated Supabase admins have full access to tickets.
drop policy if exists "Admins view tickets" on public.tickets;
create policy "Admins view tickets" on public.tickets for select to authenticated
using (true);

drop policy if exists "Admins issue tickets" on public.tickets;
create policy "Admins issue tickets" on public.tickets for insert to authenticated
with check (true);

drop policy if exists "Admins update tickets" on public.tickets;
create policy "Admins update tickets" on public.tickets for update to authenticated
using (true)
with check (true);

drop policy if exists "Admins delete tickets" on public.tickets;
create policy "Admins delete tickets" on public.tickets for delete to authenticated
using (true);

revoke all on public.ticket_admins from anon;
revoke all on public.tickets from anon;
grant select on public.ticket_admins to authenticated;
grant select, insert, update, delete on public.tickets to authenticated;

-- Event details: all authenticated Supabase admins have full access.
drop policy if exists "Admins view events" on public.events;
create policy "Admins view events" on public.events for select to authenticated
using (true);

drop policy if exists "Admins create events" on public.events;
create policy "Admins create events" on public.events for insert to authenticated
with check (true);

drop policy if exists "Admins update events" on public.events;
create policy "Admins update events" on public.events for update to authenticated
using (true)
with check (true);

drop policy if exists "Admins delete events" on public.events;
create policy "Admins delete events" on public.events for delete to authenticated
using (true);

revoke all on public.events from anon;
grant select, insert, update, delete on public.events to authenticated;

-- Authorize all existing users in Authentication > Users (re-running is safe).
insert into public.ticket_admins (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Make the new tables visible to the API immediately.
notify pgrst, 'reload schema';
