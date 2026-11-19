-- База знаний «Музыкальный интеллект» (D-134/D-137).
-- pgvector: косинусное расстояние <=>, similarity = 1 - (embedding <=> q).
-- HNSW, не ivfflat: на десятках строк ivfflat lists=100 работает плохо.
-- RLS включён без политик: anon-ключ REST не читает таблицу, доступ только
-- с сервера через прямое Postgres-подключение (креды в env).

create extension if not exists vector;

create table if not exists public.knowledge_entries (
  id text primary key,
  version integer not null default 1,
  title text not null,
  description text not null,
  strudel_code text not null,
  music_tags jsonb not null,
  cc0_preset_ids jsonb not null default '[]'::jsonb,
  rationale text not null,
  source jsonb not null,
  embedding vector(768),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_tags_gin
  on public.knowledge_entries using gin (music_tags);

create index if not exists knowledge_embedding_hnsw
  on public.knowledge_entries using hnsw (embedding vector_cosine_ops);

alter table public.knowledge_entries enable row level security;

-- Гибридный поиск: жёсткий фильтр по метаданным + косинусное ранжирование.
-- Пересечение жанров/ролей — jsonb_exists_any (функциональная форма ?|,
-- чтобы не конфликтовать с плейсхолдерами драйверов).
create or replace function public.match_knowledge(
  query_embedding vector(768),
  filter jsonb default '{}'::jsonb,
  match_count integer default 3
) returns table (
  id text,
  version integer,
  title text,
  description text,
  strudel_code text,
  music_tags jsonb,
  cc0_preset_ids jsonb,
  rationale text,
  source jsonb,
  similarity double precision
) language sql stable as $$
  select e.id, e.version, e.title, e.description, e.strudel_code,
         e.music_tags, e.cc0_preset_ids, e.rationale, e.source,
         1 - (e.embedding <=> query_embedding) as similarity
  from public.knowledge_entries e
  where e.embedding is not null
    and (filter->>'tonic' is null or e.music_tags->>'tonic' = filter->>'tonic')
    and (filter->>'mode' is null or e.music_tags->>'mode' = filter->>'mode')
    and (not jsonb_exists(filter, 'complexity') or e.music_tags->>'complexity' = filter->>'complexity')
    and (
      case when filter->>'matchAny' = 'true' then
        -- стадия genre-roles: достаточно пересечения по жанру ИЛИ роли
        (not jsonb_exists(filter, 'genre') and not jsonb_exists(filter, 'roles'))
        or (jsonb_exists(filter, 'genre') and jsonb_exists_any(e.music_tags->'genre',
              array(select jsonb_array_elements_text(filter->'genre'))))
        or (jsonb_exists(filter, 'roles') and jsonb_exists_any(e.music_tags->'roles',
              array(select jsonb_array_elements_text(filter->'roles'))))
      else
        (not jsonb_exists(filter, 'genre')
         or jsonb_exists_any(e.music_tags->'genre',
              array(select jsonb_array_elements_text(filter->'genre'))))
        and (not jsonb_exists(filter, 'roles')
         or jsonb_exists_any(e.music_tags->'roles',
              array(select jsonb_array_elements_text(filter->'roles'))))
      end
    )
  order by e.embedding <=> query_embedding
  limit match_count;
$$;