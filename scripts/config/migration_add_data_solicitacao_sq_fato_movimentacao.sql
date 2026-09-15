-- Adicionar coluna data_solicitacao na tabela sq_fato_movimentacao
ALTER TABLE IF EXISTS public.sq_fato_movimentacao 
ADD COLUMN IF NOT EXISTS data_solicitacao text;

COMMENT ON COLUMN public.sq_fato_movimentacao.data_solicitacao IS 'Data original em que a solicitacao de vinculo ou inativacao foi registrada';
