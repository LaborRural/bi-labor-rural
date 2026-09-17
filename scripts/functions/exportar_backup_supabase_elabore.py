# -*- coding: utf-8 -*-
"""
Script Oficial de Exportação e Backup Completo do Supabase
Exporta todas as tabelas e visões existentes no Supabase para arquivos locais (.parquet e .csv/.xlsx).
Cumpre a regra estrita de acesso SOMENTE LEITURA (Read-Only).
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import pandas as pd
import requests

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Ajuste do path
raiz_projeto = Path(__file__).resolve().parents[2]
for p in [
    raiz_projeto,
    raiz_projeto / "scripts",
    raiz_projeto / "scripts" / "functions",
    raiz_projeto / "SCRIPTS",
    raiz_projeto / "SCRIPTS" / "FUNCTIONS",
]:
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

try:
    from functions.function import carregar_env, obter_cliente_supabase
except ImportError:
    from FUNCTIONS.function import carregar_env, obter_cliente_supabase

def obter_lista_todas_tabelas(url: str, key: str) -> list[str]:
    """Obtém a lista de todas as tabelas e views expostas no OpenAPI do Supabase."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    r = requests.get(f"{url}/rest/v1/", headers=headers, timeout=15)
    if r.status_code == 200:
        spec = r.json()
        definitions = spec.get("definitions", {})
        return sorted(list(definitions.keys()))
    return []

def exportar_todas_tabelas():
    env = carregar_env(raiz_projeto)
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_KEY") or env.get("SUPABASE_KEY") or env.get("SUPABASE_ANON_KEY")
    
    if not url or not key:
        print("[ERRO] Credenciais do Supabase nao encontradas.")
        return
        
    sb = obter_cliente_supabase(raiz_projeto)
    
    timestamp = datetime.now().strftime("%Y_%m_%d_%H%M%S")
    pasta_output = raiz_projeto / "db" / "output"
    if not pasta_output.exists() and (raiz_projeto / "DB" / "OUTPUT").exists():
        pasta_output = raiz_projeto / "DB" / "OUTPUT"
    pasta_backup = pasta_output / f"{timestamp}_BACKUP_COMPLETO_ELABORE"
    pasta_parquet = pasta_backup / "PARQUET"
    pasta_csv = pasta_backup / "CSV"
    pasta_excel = pasta_backup / "EXCEL"
    
    pasta_parquet.mkdir(parents=True, exist_ok=True)
    pasta_csv.mkdir(parents=True, exist_ok=True)
    pasta_excel.mkdir(parents=True, exist_ok=True)
    
    tabelas = obter_lista_todas_tabelas(url, key)
    print("=" * 70)
    print(f"[INFO] INICIANDO BACKUP LOCAL COMPLETO DO SUPABASE ({len(tabelas)} TABELAS)")
    print(f"[INFO] Pasta de Destino: {pasta_backup}")
    print("=" * 70)
    
    resumo = []
    chunk_size = 1000
    
    for idx, tabela in enumerate(tabelas, 1):
        print(f"[{idx:02d}/{len(tabelas):02d}] Baixando '{tabela}'...", end=" ", flush=True)
        inicio_tab = time.time()
        
        registros = []
        offset = 0
        erro = None
        
        while True:
            try:
                res = sb.table(tabela).select("*").range(offset, offset + chunk_size - 1).execute()
                dados = res.data or []
                if not dados:
                    break
                registros.extend(dados)
                if len(dados) < chunk_size:
                    break
                offset += chunk_size
            except Exception as e:
                erro = str(e)
                break
                
        duracao = time.time() - inicio_tab
        
        if erro:
            print(f"[AVISO] Erro ao consultar: {erro}")
            resumo.append({"tabela": tabela, "status": "Erro", "linhas": 0, "duracao_s": round(duracao, 2), "erro": erro})
            continue
            
        total_linhas = len(registros)
        print(f"[OK] {total_linhas} linhas ({duracao:.2f}s)")
        
        if total_linhas > 0:
            df = pd.DataFrame(registros)
            
            # 1. Salvar em Parquet (preserva tipos exatos)
            try:
                df_parquet = df.copy()
                for c in df_parquet.columns:
                    if df_parquet[c].apply(lambda x: isinstance(x, (dict, list))).any():
                        df_parquet[c] = df_parquet[c].astype(str)
                df_parquet.to_parquet(pasta_parquet / f"{tabela}.parquet", index=False)
            except Exception as ep:
                pass
                
            # 2. Salvar em CSV (compativel com qualquer ferramenta)
            df.to_csv(pasta_csv / f"{tabela}.csv", index=False, encoding="utf-8-sig", sep=";")
            
            # 3. Salvar em Excel se <= 50.000 linhas
            if total_linhas <= 50000:
                try:
                    df.to_excel(pasta_excel / f"{tabela}.xlsx", index=False)
                except Exception:
                    pass
                    
        resumo.append({
            "tabela": tabela,
            "status": "OK",
            "linhas": total_linhas,
            "duracao_s": round(duracao, 2),
            "erro": None
        })
        
    df_resumo = pd.DataFrame(resumo)
    df_resumo.to_excel(pasta_backup / "_RESUMO_DO_BACKUP.xlsx", index=False)
    df_resumo.to_csv(pasta_backup / "_RESUMO_DO_BACKUP.csv", index=False, sep=";", encoding="utf-8-sig")
    
    total_linhas_geral = df_resumo["linhas"].sum()
    print("\n" + "=" * 70)
    print("[SUCESSO] BACKUP CONCLUIDO COM SUCESSO NO SEU COMPUTADOR!")
    print(f"Total de tabelas processadas: {len(tabelas)}")
    print(f"Total de registros exportados: {total_linhas_geral:,}")
    print(f"Local dos arquivos: {pasta_backup}")
    print("=" * 70)

if __name__ == "__main__":
    exportar_todas_tabelas()
