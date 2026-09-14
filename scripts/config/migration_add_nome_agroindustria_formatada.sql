-- ======================================================================
-- MIGRATION: ADICIONAR COLUNA NOME_AGROINDUSTRIA_FORMATADA NA SQ_DIM_AGROINDUSTRIA
-- EXECUTE ESTE SCRIPT NO SQL EDITOR DO SUPABASE (lr-analytics-db)
-- ======================================================================

-- 1. Adicionar coluna nome_agroindustria_formatada
ALTER TABLE IF EXISTS public.sq_dim_agroindustria 
ADD COLUMN IF NOT EXISTS nome_agroindustria_formatada text;

-- 2. Garantir inativação das agroindústrias fora do escopo de visitas ativas
UPDATE public.sq_dim_agroindustria
SET status = 'Inativo', excluido = 1
WHERE nome_agroindustria ILIKE '%Renova%' OR nome_agroindustria ILIKE '%Fazenda Eficiente%';

-- 3. Atualizar nomes formatados para cada agroindústria
UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Laticínios Porto Alegre (LPA)'
WHERE nome_agroindustria ILIKE '%Porto Alegre%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Nestlé'
WHERE nome_agroindustria ILIKE '%Nestl%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Alvoar'
WHERE nome_agroindustria ILIKE '%Alvoar%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'CCPR'
WHERE nome_agroindustria ILIKE '%CCPR%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Danone'
WHERE nome_agroindustria ILIKE '%Danone%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Copril'
WHERE nome_agroindustria ILIKE '%Copril%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'CAMPILEITE'
WHERE nome_agroindustria ILIKE '%Campileite%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Quillayes'
WHERE nome_agroindustria ILIKE '%Quillayes%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Piracanjuba'
WHERE nome_agroindustria ILIKE '%Piracanjuba%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'Independente'
WHERE nome_agroindustria ILIKE '%Independente%';

UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = 'NÃO INFORMADA'
WHERE nome_agroindustria ILIKE '%N%O INFORMADA%';

-- 4. Fallback para quaisquer outros registros
UPDATE public.sq_dim_agroindustria
SET nome_agroindustria_formatada = nome_agroindustria
WHERE nome_agroindustria_formatada IS NULL;
