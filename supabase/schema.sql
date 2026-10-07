-- 학생자치 의안정보시스템 데이터베이스
-- Supabase 대시보드 > SQL Editor 에 붙여 넣고 한 번 실행하세요.
-- 모든 표에 RLS(행 수준 보안)를 켜고 정책을 두지 않아, 브라우저에서는 직접 읽거나 쓸 수 없습니다.
-- 앱 서버(Vercel)가 service role 키로만 접근합니다.

create table if not exists spaces (
  id uuid primary key,
  code text not null unique,            -- 공간 코드 (열람용)
  name text not null,
  kind text not null check (kind in ('council', 'class')),
  body_name text not null,              -- 심의 기구 이름 (대의원회, 학급회의 등)
  units jsonb not null default '[]',    -- [{name, code}] 제안 단위와 제안 코드
  roles jsonb not null default '[]',    -- 직책 목록
  officer_code text not null,
  admin_code text not null,
  pass_rule text not null default 'majority' check (pass_rule in ('majority', 'two_thirds')),
  enrolled int not null default 0,      -- 재적 수 (0 = 정하지 않음)
  created_at timestamptz not null
);

create table if not exists bills (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  year int not null,
  seq int not null,
  title text not null,
  reason text not null default '',
  content text not null default '',
  category text not null,
  unit text not null,
  role text not null,
  stage text not null,
  result text,
  yes_count int,
  no_count int,
  abstain_count int,
  reply text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (space_id, year, seq)
);
create index if not exists bills_space on bills(space_id);

create table if not exists bill_events (
  id uuid primary key,
  bill_id uuid not null references bills(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  stage text not null,
  note text not null default '',
  by_role text not null,
  at timestamptz not null
);
create index if not exists bill_events_bill on bill_events(bill_id);

create table if not exists meetings (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  title text not null,
  held_on date not null,
  present int not null default 0,
  enrolled int not null default 0,
  items jsonb not null default '[]',    -- [{bill_id, summary, result}]
  notes text not null default '',
  created_at timestamptz not null
);
create index if not exists meetings_space on meetings(space_id);

create table if not exists votes (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  bill_id uuid references bills(id) on delete set null,
  title text not null,
  kind text not null check (kind in ('yesno', 'choice')),
  method text,                          -- choice 일 때 세는 방법
  options jsonb not null default '[]',
  open boolean not null,
  revealed boolean not null,
  applied boolean not null,
  created_at timestamptz not null
);
create index if not exists votes_space on votes(space_id);

create table if not exists ballots (
  vote_id uuid not null references votes(id) on delete cascade,
  voter text not null,
  choice jsonb not null,
  primary key (vote_id, voter)
);

-- 투표 방식 실험실(/vote/)의 투표방: 방 번호 6자리, 2일 뒤 만료 (새 방을 만들 때 지난 방을 지움)
create table if not exists rooms (
  code text primary key,
  q text not null default '',
  cands jsonb not null,
  method text not null,
  open boolean not null,
  revealed boolean not null,
  key_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null
);

create table if not exists room_ballots (
  room_code text not null references rooms(code) on delete cascade,
  voter text not null,
  choice jsonb not null,
  primary key (room_code, voter)
);

alter table rooms enable row level security;
alter table room_ballots enable row level security;
alter table spaces enable row level security;
alter table bills enable row level security;
alter table bill_events enable row level security;
alter table meetings enable row level security;
alter table votes enable row level security;
alter table ballots enable row level security;
