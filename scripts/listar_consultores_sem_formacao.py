# -*- coding: utf-8 -*-
"""
Script auxiliar para listar consultores ativos sem formação cadastrada em sq_dim_consultor.
"""
from __future__ import annotations
import sys
from pathlib import Path

caminho_atual = Path.cwd().resolve()
for candidato in [caminho_atual, *caminho_atual.parents]:
    if (candidato / "scripts").is_dir() and ((candidato / "db").is_dir() or (candidato / "dashboard").is_dir()):
        raiz_projeto = candidato
        break
else:
    raiz_projeto = caminho_atual

sys.path.insert(0, str(raiz_projeto))
sys.path.insert(0, str(raiz_projeto / "scripts"))
sys.path.insert(0, str(raiz_projeto / "scripts" / "functions"))

from functions.function import obter_cliente_supabase

def main():
    supabase = obter_cliente_supabase(raiz_projeto)
    res = supabase.table("sq_dim_consultor") \
        .select("id, nome_consultor, formacao_consultor, excluido") \
        .execute()
    
    if not res.data:
        print("⚠️ Nenhum registro encontrado em sq_dim_consultor.")
        return

    consultores = res.data
    sem_formacao = [
        c for c in consultores 
        if c.get("excluido") in (0, False, None) and (not c.get("formacao_consultor") or str(c.get("formacao_consultor")).strip() in ("", "None", "NULL"))
    ]
    
    print(f"\n📊 Total de consultores cadastrados: {len(consultores)}")
    print(f"⚠️ Consultores ativos SEM formação cadastrada: {len(sem_formacao)}\n")
    print("=" * 70)
    print(f"{'ID':<6} | {'NOME DO CONSULTOR':<50}")
    print("=" * 70)
    for c in sem_formacao:
        print(f"{str(c.get('id', '')): <6} | {str(c.get('nome_consultor', '')): <50}")
    print("=" * 70)

if __name__ == "__main__":
    main()
