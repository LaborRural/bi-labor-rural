# -*- coding: utf-8 -*-
"""
Script Oficial de Sanitização e Reconciliação das Tabelas Fato no Supabase
Projeto: BI Labor Rural / SmartQuestion (lr-analytics-db)

Finalidade:
- Inspecionar e sanitizar registros órfãos e inconsistentes em TODAS as tabelas fato:
  1. 'sq_fato_consistencia'
  2. 'sq_fato_visitas'
  3. 'sq_fato_movimentacao'
  4. 'sq_dim_fazendas_ativas' (Base analítica de ativos)
- Garantir a sincronização estrita com as tabelas de staging/raw (sq_raw_*).
"""
from __future__ import annotations

import os
import sys
import collections
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client

FUSO_SP = ZoneInfo("America/Sao_Paulo")

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def detectar_raiz(caminho_base: Path | None = None) -> Path:
    """Localiza a raiz do projeto de forma robusta."""
    caminho_atual = (caminho_base or Path.cwd()).resolve()
    for candidato in [caminho_atual, *caminho_atual.parents]:
        if (candidato / "scripts").is_dir() and ((candidato / "db").is_dir() or (candidato / "dashboard").is_dir()):
            return candidato
        if (candidato / "SCRIPTS").is_dir() and (candidato / "DB").is_dir():
            return candidato
    return caminho_atual


def obter_cliente_supabase(raiz_projeto: Path) -> Client:
    """Inicializa cliente do Supabase."""
    for env_path in [
        raiz_projeto / "scripts" / "config" / ".env",
        raiz_projeto / "dashboard" / ".env.local",
        raiz_projeto / "SCRIPTS" / "CONFIG" / ".env",
        raiz_projeto / "DASHBOARD" / ".env.local",
        raiz_projeto / ".env",
    ]:
        if env_path.is_file():
            load_dotenv(env_path)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        raise ValueError("❌ Credenciais do Supabase não encontradas no arquivo .env!")

    return create_client(supabase_url, supabase_key)


def buscar_todos_paginado(supabase: Client, tabela: str, colunas: str = "*", filtros: list | None = None) -> list[dict]:
    """Busca todos os registros de uma tabela paginando em lotes de 1.000."""
    todos = []
    chunk_size = 1000
    offset = 0
    while True:
        query = supabase.table(tabela).select(colunas).range(offset, offset + chunk_size - 1)
        if filtros:
            for op, col, val in filtros:
                if op == "eq":
                    query = query.eq(col, val)
                elif op == "gte":
                    query = query.gte(col, val)
                elif op == "lte":
                    query = query.lte(col, val)
                elif op == "in":
                    query = query.in_(col, val)
        res = query.execute()
        if not res.data:
            break
        todos.extend(res.data)
        if len(res.data) < chunk_size:
            break
        offset += chunk_size
    return todos


def sanitizar_fato_consistencia(supabase: Client, modo_execucao: str = "dry_run") -> dict:
    """
    Sanitiza 'sq_fato_consistencia':
    Remove registros em 'sq_fato_consistencia' que não possuem correspondência
    em 'sq_raw_consistencia_mensal' ou 'sq_raw_consistencia_anual' (para a mesma chave (codigo_lr, mes_referencia)).
    Também limpa duplicatas históricas acumuladas por timestamps de processamento antigos.
    """
    print("\n" + "=" * 75)
    print("📌 1. SANITIZAÇÃO DA TABELA FATO: sq_fato_consistencia")
    print("=" * 75)

    print("📖 Carregando chaves válidas de 'sq_raw_consistencia_mensal'...")
    raw_m = buscar_todos_paginado(supabase, "sq_raw_consistencia_mensal", "codigo_lr, mes_referencia")
    keys_m = {(r["codigo_lr"].strip(), str(r["mes_referencia"])[:10]) for r in raw_m if r.get("codigo_lr") and r.get("mes_referencia")}
    print(f"   -> {len(keys_m)} chaves de consistência mensal encontradas.")

    print("📖 Carregando chaves válidas de 'sq_raw_consistencia_anual'...")
    raw_a = buscar_todos_paginado(supabase, "sq_raw_consistencia_anual", "codigo_lr, mes_referencia")
    keys_a = {(r["codigo_lr"].strip(), str(r["mes_referencia"])[:10]) for r in raw_a if r.get("codigo_lr") and r.get("mes_referencia")}
    print(f"   -> {len(keys_a)} chaves de consistência anual encontradas.")

    chaves_validas = keys_m | keys_a
    print(f"✅ Total de chaves válidas únicas (raw mensal + anual): {len(chaves_validas)}")

    print("📖 Carregando registros de 'sq_fato_consistencia'...")
    fato_rows = buscar_todos_paginado(
        supabase,
        "sq_fato_consistencia",
        "codigo_lr, nome_consultor, mes_referencia, data_processamento, consistencia_mensal, consistencia_anual, projeto, data_carencia_fim, mes_elabore, status_code, excecao, meses_sequenciais, profissao_consultor, detalhamento_inconsistencia"
    )
    print(f"📊 Total de registros atuais em 'sq_fato_consistencia': {len(fato_rows)}")

    orfaos = []
    por_consultor = collections.Counter()
    por_mes = collections.Counter()

    df_fato = pd.DataFrame(fato_rows)
    if not df_fato.empty:
        df_fato["codigo_lr_clean"] = df_fato["codigo_lr"].astype(str).str.strip()
        df_fato["mes_ref_clean"] = df_fato["mes_referencia"].astype(str).str.slice(0, 10)
        df_fato["chave"] = list(zip(df_fato["codigo_lr_clean"], df_fato["mes_ref_clean"]))

        for _, r in df_fato.iterrows():
            chave = r["chave"]
            if chave not in chaves_validas:
                orfaos.append(r)
                por_consultor[r["nome_consultor"]] += 1
                por_mes[r["mes_ref_clean"]] += 1

    print(f"\n⚠️ Total de registros órfãos / descontinuados identificados: {len(orfaos)}")
    if por_mes:
        print("   Exemplos de órfãos por mês de referência:")
        for m, count in sorted(por_mes.items())[:10]:
            print(f"     - {m}: {count} registros órfãos")
    if por_consultor:
        print("   Top 5 consultores impactados por órfãos:")
        for c, count in por_consultor.most_common(5):
            print(f"     - {c}: {count} registros órfãos")

    if modo_execucao == "aplicar" and orfaos:
        print(f"\n🧹 Removendo {len(orfaos)} registros órfãos de 'sq_fato_consistencia'...")
        meses_afetados = sorted(set(r["mes_ref_clean"] for r in orfaos))
        total_removidos = 0
        for m in meses_afetados:
            try:
                # Filtrar válidos para o mês
                validos_m = [
                    r for r in fato_rows
                    if str(r.get("mes_referencia"))[:10] == m and (r.get("codigo_lr", "").strip(), m) in chaves_validas
                ]
                df_validos_m = pd.DataFrame(validos_m)
                if not df_validos_m.empty:
                    df_validos_m.sort_values(by="data_processamento", ascending=False, inplace=True)
                    df_validos_m.drop_duplicates(subset=["codigo_lr", "nome_consultor", "mes_referencia"], keep="first", inplace=True)
                    records_validos = df_validos_m.to_dict(orient="records")
                else:
                    records_validos = []

                # Deletar mês completo no Supabase
                supabase.table("sq_fato_consistencia").delete().gte("mes_referencia", m).lte("mes_referencia", f"{m}T23:59:59").execute()
                
                # Re-inserir registros válidos sanitizados
                if records_validos:
                    chunk_size = 1000
                    for i in range(0, len(records_validos), chunk_size):
                        chunk = records_validos[i : i + chunk_size]
                        # Limpar campos internos
                        for c_item in chunk:
                            c_item.pop("codigo_lr_clean", None)
                            c_item.pop("mes_ref_clean", None)
                            c_item.pop("chave", None)
                        supabase.table("sq_fato_consistencia").upsert(
                            chunk, on_conflict="codigo_lr,nome_consultor,mes_referencia"
                        ).execute()
                total_removidos += (len([r for r in fato_rows if str(r.get("mes_referencia"))[:10] == m]) - len(records_validos))
                print(f"   ✅ Mês {m} sanitizado com sucesso.")
            except Exception as e_del:
                print(f"   ❌ Erro ao sanitizar mês {m}: {e_del}")

        print(f"✨ Concluído! {total_removidos} registros órfãos limpos de 'sq_fato_consistencia'.")

    return {"tabela": "sq_fato_consistencia", "total": len(fato_rows), "orfaos": len(orfaos)}


def sanitizar_fato_visitas(supabase: Client, modo_execucao: str = "dry_run") -> dict:
    """Sanitiza 'sq_fato_visitas'."""
    print("\n" + "=" * 75)
    print("📌 2. SANITIZAÇÃO DA TABELA FATO: sq_fato_visitas")
    print("=" * 75)

    print("📖 Carregando registros de 'sq_fato_visitas'...")
    fato_visitas = buscar_todos_paginado(supabase, "sq_fato_visitas", "id_composto, codigo_lr, data_visita, nome_consultor")
    print(f"📊 Total de registros em 'sq_fato_visitas': {len(fato_visitas)}")

    df_vis = pd.DataFrame(fato_visitas)
    duplicados = 0
    nulos_hash = 0

    if not df_vis.empty:
        nulos_hash = df_vis["id_composto"].isna().sum() if "id_composto" in df_vis.columns else 0
        duplicados = df_vis.duplicated(subset=["id_composto"]).sum() if "id_composto" in df_vis.columns else 0

    print(f"ℹ️ Registros com 'id_composto' nulo: {nulos_hash}")
    print(f"ℹ️ Duplicatas por 'id_composto': {duplicados}")

    return {"tabela": "sq_fato_visitas", "total": len(fato_visitas), "duplicados": duplicados, "nulos": nulos_hash}


def sanitizar_fato_movimentacao(supabase: Client, modo_execucao: str = "dry_run") -> dict:
    """Sanitiza 'sq_fato_movimentacao'."""
    print("\n" + "=" * 75)
    print("📌 3. SANITIZAÇÃO DA TABELA FATO: sq_fato_movimentacao")
    print("=" * 75)

    print("📖 Carregando registros de 'sq_fato_movimentacao'...")
    mov = buscar_todos_paginado(supabase, "sq_fato_movimentacao", "id_composto, codigo_lr, movimentacao, data_movimentacao")
    print(f"📊 Total de registros em 'sq_fato_movimentacao': {len(mov)}")

    df_mov = pd.DataFrame(mov)
    duplicados = 0
    if not df_mov.empty and "id_composto" in df_mov.columns:
        duplicados = df_mov.duplicated(subset=["id_composto"]).sum()

    print(f"ℹ️ Duplicatas de 'id_composto' em movimentação: {duplicados}")
    return {"tabela": "sq_fato_movimentacao", "total": len(mov), "duplicados": duplicados}


def sanitizar_dim_fazendas_ativas(supabase: Client, modo_execucao: str = "dry_run") -> dict:
    """Sanitiza 'sq_dim_fazendas_ativas'."""
    print("\n" + "=" * 75)
    print("📌 4. SANITIZAÇÃO DA TABELA BASE/DIMENSÃO: sq_dim_fazendas_ativas")
    print("=" * 75)

    print("📖 Carregando registros de 'sq_dim_fazendas_ativas'...")
    faz = buscar_todos_paginado(supabase, "sq_dim_fazendas_ativas", "id, codigo_produtor, mes_referencia, status")
    print(f"📊 Total de registros em 'sq_dim_fazendas_ativas': {len(faz)}")

    df_faz = pd.DataFrame(faz)
    duplicados = 0
    if not df_faz.empty and "id" in df_faz.columns:
        duplicados = df_faz.duplicated(subset=["id"]).sum()

    print(f"ℹ️ Duplicatas de 'id' em fazendas ativas: {duplicados}")
    return {"tabela": "sq_dim_fazendas_ativas", "total": len(faz), "duplicados": duplicados}


def executar_sanitizacao_completa(modo_execucao: str = "dry_run") -> bool:
    """
    Executa o diagnóstico e a sanitização completa de todas as tabelas fato.
    - modo_execucao: 'dry_run' (apenas diagnostica) ou 'aplicar' (executa a limpeza no Supabase).
    """
    raiz = detectar_raiz()
    supabase = obter_cliente_supabase(raiz)

    print("\n" + "=" * 80)
    print("🚀 PIPELINE OFICIAL DE SANITIZAÇÃO E DIAGNÓSTICO DE TABELAS FATO (SUPABASE)")
    print(f"⏰ Horário: {datetime.now(FUSO_SP).strftime('%d/%m/%Y %H:%M:%S')}")
    print(f"⚙️ Modo: {modo_execucao.upper()} {'(Simulação sem alteração)' if modo_execucao == 'dry_run' else '(GRAVAÇÃO/LIMPEZA ATIVA)'}")
    print("=" * 80)

    try:
        r1 = sanitizar_fato_consistencia(supabase, modo_execucao)
        r2 = sanitizar_fato_visitas(supabase, modo_execucao)
        r3 = sanitizar_fato_movimentacao(supabase, modo_execucao)
        r4 = sanitizar_dim_fazendas_ativas(supabase, modo_execucao)

        print("\n" + "=" * 80)
        print("📊 RESUMO GERAL DO DIAGNÓSTICO E SANITIZAÇÃO")
        print("=" * 80)
        print(f"1. sq_fato_consistencia:   {r1['total']} registros | {r1['orfaos']} órfãos identificados")
        print(f"2. sq_fato_visitas:        {r2['total']} registros | {r2['duplicados']} duplicados")
        print(f"3. sq_fato_movimentacao:   {r3['total']} registros | {r3['duplicados']} duplicados")
        print(f"4. sq_dim_fazendas_ativas: {r4['total']} registros | {r4['duplicados']} duplicados")
        print("=" * 80 + "\n")

        return True
    except Exception as e:
        print(f"\n❌ ERRO DURANTE A SANITIZAÇÃO: {e}")
        return False


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "dry_run"
    sucesso = executar_sanitizacao_completa(modo)
    sys.exit(0 if sucesso else 1)
