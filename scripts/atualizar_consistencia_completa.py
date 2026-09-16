# -*- coding: utf-8 -*-
"""
Script: atualizar_consistencia_completa.py
Objetivo: Atualizar exclusivamente as tabelas de consistência do projeto:
  1. sq_raw_consistencia_mensal (carga a partir da planilha mensal do Elabore)
  2. sq_raw_consistencia_anual  (carga a partir da planilha anual do Elabore)
  3. sq_fato_consistencia       (processamento, carência de vínculos e carga da fato analítica)

Uso:
  python scripts/atualizar_consistencia_completa.py
"""
from __future__ import annotations

import calendar
import os
import sys
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import pandas as pd
import yaml
from dotenv import load_dotenv
from supabase import create_client

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


def carregar_configuracao(raiz_projeto: Path) -> dict:
    """Carrega o config.yaml oficial."""
    config_file = raiz_projeto / "scripts" / "config" / "config.yaml"
    if not config_file.is_file():
        config_file = raiz_projeto / "SCRIPTS" / "CONFIG" / "config.yaml"
    if not config_file.is_file():
        raise FileNotFoundError(f"❌ Arquivo de configuração não encontrado: {config_file}")
    with open(config_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def obter_cliente_supabase(raiz_projeto: Path):
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


def normalizar_texto(texto: str | None) -> str:
    """Remove acentuação e padroniza para maiúsculas."""
    if not texto or pd.isna(texto):
        return ""
    nfkd = unicodedata.normalize("NFKD", str(texto))
    return "".join([c for c in nfkd if not unicodedata.combining(c)]).strip().upper()


def buscar_todos_registros(supabase, tabela: str, select_cols: str = "*", filtros: list | None = None) -> list:
    """Busca todos os registros de uma tabela do Supabase paginando com .range()."""
    todos_registros = []
    chunk_size = 1000
    offset = 0

    while True:
        query = supabase.table(tabela).select(select_cols).range(offset, offset + chunk_size - 1)
        if filtros:
            for op, col, val in filtros:
                if op == "gte":
                    query = query.gte(col, val)
                elif op == "lte":
                    query = query.lte(col, val)
                elif op == "eq":
                    query = query.eq(col, val)
                elif op == "in":
                    query = query.in_(col, val)

        res = query.execute()
        if not res.data:
            break

        todos_registros.extend(res.data)
        if len(res.data) < chunk_size:
            break
        offset += chunk_size

    return todos_registros


def processar_carga_fato_consistencia(supabase, raiz_projeto: Path, config: dict):
    """Executa a geração e o upsert da tabela sq_fato_consistencia."""
    print("\n" + "=" * 70)
    print("🚀 PROCESSANDO TABELA FATO: sq_fato_consistencia")
    print("=" * 70)

    tabelas_cfg = config.get("supabase", {}).get("tabelas", {})
    tab_vinculos = tabelas_cfg.get("vinculos_staging", "sq_raw_vinculos")
    tab_fato_consistencia = tabelas_cfg.get("consistencia_fato", "sq_fato_consistencia")
    
    data_inicial_elabore = config.get("referencia", {}).get("data_inicial_elabore", "2025-12-01")

    hoje = date.today()
    _, ultimo_dia = calendar.monthrange(hoje.year, hoje.month)
    data_limite = datetime(hoje.year, hoje.month, ultimo_dia, 23, 59, 59)
    data_final_str = data_limite.strftime("%Y-%m-%d")

    projetos_leite = ["REGENERA", "ALVOAR ECO", "ALVOAR ASSIST", "SEMEAR", "ATEG_CCPR", "Alvoar", "LPA"]
    grupos_cft = [
        "DAYANNE UCHOA VEIGA / DEBORA LIMA DE OLIVEIRA / MARIO BARBOSA ROSA FILHO / MATEUS CARNIELLI / TALITA FONTES / THAYNAN FERREIRA DE ARAUJO",
        "HUGO LOPES / MATEUS CARNIELLI / ROMARCIO PAULO DE OLIVEIRA / THAYNAN FERREIRA DE ARAUJO",
        "BRUNO ANTONIO FERRONI RODRIGUES / HUGO LOPES / MATEUS CARNIELLI / THAYNAN FERREIRA DE ARAUJO",
        "MATHEUS GOMIDES GONCALVES",
        "TALITA FONTES",
    ]

    # 1. Carregar Vínculos
    print("\n🔍 1. Carregando dados de vínculos (sq_raw_vinculos)...")
    vinculos_raw = buscar_todos_registros(
        supabase,
        tab_vinculos,
        select_cols="*",
        filtros=[("in", "projeto", projetos_leite)]
    )

    if not vinculos_raw:
        print("⚠️ Nenhum vínculo encontrado em sq_raw_vinculos.")
        df_vinculos_com_carencia = pd.DataFrame()
    else:
        df_vinculos = pd.DataFrame(vinculos_raw)
        if "codigo_produtor" in df_vinculos.columns:
            df_vinculos.rename(columns={"codigo_produtor": "codigo_lr", "mes_referencia": "data_referencia"}, inplace=True)
        if "consultor_grupo_atendimento" in df_vinculos.columns and "nome_consultor" not in df_vinculos.columns:
            df_vinculos.rename(columns={"consultor_grupo_atendimento": "nome_consultor"}, inplace=True)
        elif "consultor" in df_vinculos.columns and "nome_consultor" not in df_vinculos.columns:
            df_vinculos.rename(columns={"consultor": "nome_consultor"}, inplace=True)

        if "data_referencia" not in df_vinculos.columns:
            df_vinculos["data_referencia"] = pd.to_datetime(df_vinculos.get("data_processamento", df_vinculos.get("data_associacao", pd.Timestamp.now())))
        else:
            df_vinculos["data_referencia"] = pd.to_datetime(df_vinculos["data_referencia"])

        if "nome_consultor" in df_vinculos.columns:
            df_vinculos = df_vinculos[~df_vinculos["nome_consultor"].isin(grupos_cft)]

        df_vinculos["mes_referencia"] = df_vinculos["data_referencia"].dt.tz_localize(None).dt.to_period("M").dt.to_timestamp()

        # Cálculo de Carência
        df_min_vinculo_ativo = df_vinculos.groupby(["codigo_lr", "nome_consultor"])["data_referencia"].min().reset_index()
        df_min_vinculo_ativo.rename(columns={"data_referencia": "data_referencia_min_ativo"}, inplace=True)

        if "data_associacao" in df_vinculos.columns:
            df_vinculos["dt_assoc_tmp"] = pd.to_datetime(df_vinculos["data_associacao"]).dt.tz_localize(None).dt.to_period("M").dt.to_timestamp()
            df_min_solic = df_vinculos.groupby(["codigo_lr", "nome_consultor"])["dt_assoc_tmp"].min().reset_index()
            df_min_solic.rename(columns={"dt_assoc_tmp": "data_solicitacao_min"}, inplace=True)
            df_min_vinculo_completo = df_min_vinculo_ativo.merge(df_min_solic, on=["codigo_lr", "nome_consultor"], how="left")
            df_min_vinculo_completo["data_inicio_vinculo"] = df_min_vinculo_completo.apply(
                lambda r: min(r["data_referencia_min_ativo"], r["data_solicitacao_min"]) if pd.notna(r.get("data_solicitacao_min")) else r["data_referencia_min_ativo"],
                axis=1
            )
        else:
            df_min_vinculo_completo = df_min_vinculo_ativo.copy()
            df_min_vinculo_completo["data_inicio_vinculo"] = df_min_vinculo_completo["data_referencia_min_ativo"]

        df_min_vinculo_completo["data_carencia_fim"] = df_min_vinculo_completo["data_inicio_vinculo"] + pd.DateOffset(months=2)

        df_vinculos_com_carencia = df_vinculos.merge(
            df_min_vinculo_completo[["codigo_lr", "nome_consultor", "data_carencia_fim", "data_inicio_vinculo"]],
            on=["codigo_lr", "nome_consultor"],
            how="left"
        )
        print(f"✅ Vínculos ativos processados com carência: {len(df_vinculos_com_carencia)} registros.")

    # 2. Carregar sq_raw_consistencia_mensal
    print("\n🔍 2. Carregando dados da sq_raw_consistencia_mensal...")
    raw_m = buscar_todos_registros(
        supabase,
        "sq_raw_consistencia_mensal",
        select_cols="*",
        filtros=[("gte", "mes_referencia", data_inicial_elabore), ("lte", "mes_referencia", data_final_str)]
    )
    df_consistencia_mes = pd.DataFrame(raw_m) if raw_m else pd.DataFrame()

    codigos_invalidos = ["Teste", "Teste Gestor", "Labor Rural"]
    if not df_consistencia_mes.empty:
        df_consistencia_mes["mes_referencia"] = pd.to_datetime(df_consistencia_mes["mes_referencia"]).dt.tz_localize(None).dt.to_period("M").dt.to_timestamp()
        df_consistencia_mes["mes_elabore"] = pd.to_datetime(df_consistencia_mes["mes_elabore"]).dt.tz_localize(None).dt.to_period("M").dt.to_timestamp()
        df_consistencia_mes = df_consistencia_mes[
            df_consistencia_mes["codigo_lr"].notna() &
            ~df_consistencia_mes["codigo_lr"].astype(str).isin(codigos_invalidos) &
            ~df_consistencia_mes["codigo_lr"].astype(str).str.lower().str.contains("teste", na=False) &
            ~df_consistencia_mes["codigo_lr"].astype(str).str.lower().str.contains("labor", na=False)
        ]
        print(f"✅ Consistência mensal carregada: {len(df_consistencia_mes)} registros.")
    else:
        print("⚠️ Nenhum registro encontrado em sq_raw_consistencia_mensal.")

    # 3. Carregar sq_raw_consistencia_anual
    print("\n🔍 3. Carregando dados da sq_raw_consistencia_anual...")
    raw_a = buscar_todos_registros(
        supabase,
        "sq_raw_consistencia_anual",
        select_cols="*",
        filtros=[("gte", "mes_referencia", data_inicial_elabore), ("lte", "mes_referencia", data_final_str)]
    )
    df_consistencia_anual = pd.DataFrame(raw_a) if raw_a else pd.DataFrame()
    if not df_consistencia_anual.empty:
        df_consistencia_anual["mes_referencia"] = pd.to_datetime(df_consistencia_anual["mes_referencia"]).dt.tz_localize(None).dt.to_period("M").dt.to_timestamp()
        df_consistencia_anual["mes_elabore"] = pd.to_datetime(df_consistencia_anual["mes_elabore"]).dt.tz_localize(None).dt.to_period("M").dt.to_timestamp()
        df_consistencia_anual = df_consistencia_anual[
            df_consistencia_anual["codigo_lr"].notna() &
            ~df_consistencia_anual["codigo_lr"].astype(str).isin(codigos_invalidos) &
            ~df_consistencia_anual["codigo_lr"].astype(str).str.lower().str.contains("teste", na=False) &
            ~df_consistencia_anual["codigo_lr"].astype(str).str.lower().str.contains("labor", na=False)
        ]
        print(f"✅ Consistência anual carregada: {len(df_consistencia_anual)} registros.")
    else:
        print("⚠️ Nenhum registro encontrado em sq_raw_consistencia_anual.")

    # 4. Integrar Consistência Mensal + Vínculos + Anual
    print("\n⚙️ 4. Integrando dados para a Fato Consistência...")
    if df_consistencia_mes.empty:
        print("❌ Sem dados mensais para processar a fato.")
        return False

    # Incluir nome_consultor da raw mensal (para usar como fallback)
    cols_consist_raw = [c for c in ["codigo_lr", "mes_referencia", "mes_elabore", "consistencia_mensal", "status_code", "detalhamento_inconsistencia", "nome_consultor"] if c in df_consistencia_mes.columns]
    df_final = df_consistencia_mes[cols_consist_raw].copy()
    # Renomear nome_consultor da raw para referência posterior
    if "nome_consultor" in df_final.columns:
        df_final.rename(columns={"nome_consultor": "nome_consultor_raw"}, inplace=True)
    else:
        df_final["nome_consultor_raw"] = None

    if not df_vinculos_com_carencia.empty:
        meta_cols = [c for c in ["codigo_lr", "nome_consultor", "projeto", "data_carencia_fim", "data_inicio_vinculo"] if c in df_vinculos_com_carencia.columns]
        df_meta_prod = df_vinculos_com_carencia[meta_cols].drop_duplicates(subset=["codigo_lr"], keep="last")
        df_final = df_final.merge(df_meta_prod, on=["codigo_lr"], how="left")
    else:
        df_final["nome_consultor"] = None
        df_final["projeto"] = None
        df_final["data_carencia_fim"] = None
        df_final["data_inicio_vinculo"] = None

    # Fallback: priorizar vínculo, depois raw, depois constante
    df_final["nome_consultor"] = (
        df_final["nome_consultor"]
        .combine_first(df_final["nome_consultor_raw"])
    )
    # Limpar valores inválidos: 'nan', 'None', strings internas, etc.
    _invalidos_consultor = {"nan", "none", "2222", "internolennon", "interno", "labor rural"}
    def _sanitizar_consultor(v):
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return "NÃO INFORMADO"
        s = str(v).strip()
        if s == "" or s.lower() in _invalidos_consultor:
            return "NÃO INFORMADO"
        return s.upper()
    df_final["nome_consultor"] = df_final["nome_consultor"].apply(_sanitizar_consultor)
    df_final.drop(columns=["nome_consultor_raw"], inplace=True)

    if not df_consistencia_anual.empty:
        df_anual_merge = df_consistencia_anual[["codigo_lr", "mes_referencia", "consistencia_anual"]].copy()
        df_final = df_final.merge(df_anual_merge, on=["codigo_lr", "mes_referencia"], how="left")
    else:
        df_final["consistencia_anual"] = None

    # Exceções (default 0)
    df_final["excecao"] = 0

    # 5. Profissão do Consultor (sq_dim_consultor)
    print("\n🔍 5. Buscando profissão dos consultores (sq_dim_consultor)...")
    try:
        res_consultor = supabase.table("sq_dim_consultor").select("nome_consultor, formacao_consultor").eq("excluido", 0).execute()
        if res_consultor.data:
            df_consultores = pd.DataFrame(res_consultor.data)
            df_consultores.rename(columns={"formacao_consultor": "profissao_consultor"}, inplace=True)
            df_consultores["nome_norm"] = df_consultores["nome_consultor"].apply(normalizar_texto)
            df_consultores = df_consultores.drop_duplicates(subset=["nome_norm"], keep="first")

            df_final["nome_norm"] = df_final["nome_consultor"].apply(normalizar_texto)
            df_final = df_final.merge(df_consultores[["nome_norm", "profissao_consultor"]], on="nome_norm", how="left")
            df_final.drop(columns=["nome_norm"], inplace=True)
            print(f"✅ Dimensão de consultores associada com sucesso.")
        else:
            df_final["profissao_consultor"] = None
    except Exception as e_cons:
        print(f"⚠️ Aviso ao buscar consultores: {e_cons}")
        df_final["profissao_consultor"] = None

    # 6. Formatação Final e Tipagens
    agora_iso = datetime.now(timezone.utc).isoformat()
    df_final["data_processamento"] = agora_iso

    date_cols = ["mes_referencia", "data_carencia_fim", "mes_elabore", "data_inicio_vinculo"]
    for col in date_cols:
        if col in df_final.columns:
            df_final[col] = pd.to_datetime(df_final[col], errors="coerce").dt.strftime("%Y-%m-%d")
            df_final[col] = df_final[col].replace({pd.NaT: None, "NaT": None, "nan": None})

    df_final = df_final[df_final["codigo_lr"].notna() & df_final["mes_referencia"].notna()].copy()
    df_final = df_final.drop_duplicates(subset=["codigo_lr", "nome_consultor", "mes_referencia"], keep="first")

    colunas_oficiais_fato = [
        "codigo_lr", "nome_consultor", "profissao_consultor", "projeto",
        "mes_referencia", "data_carencia_fim", "mes_elabore",
        "consistencia_mensal", "consistencia_anual", "status_code", "excecao",
        "detalhamento_inconsistencia", "data_processamento"
    ]
    cols_existentes = [c for c in colunas_oficiais_fato if c in df_final.columns]
    df_final = df_final[cols_existentes].copy()

    print(f"\n📊 Total de registros consolidados para sq_fato_consistencia: {len(df_final)}")

    # 7. Sanitização estrita contra NaN (JSON compliant) e Upsert em lotes
    df_final = df_final.where(pd.notnull(df_final), None)
    records_brutos = df_final.to_dict(orient="records")
    records = []
    for r in records_brutos:
        clean_row = {}
        for k, v in r.items():
            if pd.isna(v) or (isinstance(v, float) and (pd.isna(v) or v != v)):
                clean_row[k] = None
            else:
                clean_row[k] = v
        records.append(clean_row)

    print(f"🚀 Enviando registros para o Supabase ({tab_fato_consistencia})...")
    chunk_size = config.get("execucao", {}).get("chunk_size_upsert", 1000)
    sucessos = 0

    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        try:
            supabase.table(tab_fato_consistencia).upsert(
                chunk,
                on_conflict="codigo_lr,nome_consultor,mes_referencia"
            ).execute()
            sucessos += len(chunk)
            print(f"   ✅ Lote {i // chunk_size + 1}: {len(chunk)} registros atualizados na Fato.")
        except Exception as e_upsert:
            print(f"   ❌ Erro no lote {i // chunk_size + 1}: {e_upsert}")

    print(f"\n✨ Carga de {tab_fato_consistencia} finalizada com sucesso! {sucessos} registros processados.")
    return True


def main():
    print("\n" + "=" * 70)
    print("🔄 ATUALIZAÇÃO EXCLUSIVA DE CONSISTÊNCIA: RAW (MENSAL/ANUAL) E FATO")
    print(f"⏰ Início: {datetime.now(ZoneInfo('America/Sao_Paulo')).strftime('%d/%m/%Y %H:%M:%S')}")
    print("=" * 70)

    raiz = detectar_raiz()
    config = carregar_configuracao(raiz)
    supabase = obter_cliente_supabase(raiz)

    # 1. Sincronizar as tabelas RAW (mensal e anual a partir dos Excels do Elabore)
    try:
        from functions.atualizar_detalhamento_consistencia import executar_sincronizacao_consistencia
    except ImportError:
        from FUNCTIONS.atualizar_detalhamento_consistencia import executar_sincronizacao_consistencia

    print("\n📥 [ETAPA 1/2] Sincronizando relatórios do Elabore em sq_raw_consistencia_mensal e anual...")
    ok_raw = executar_sincronizacao_consistencia(raiz, limpar_antes=True)

    if not ok_raw:
        print("⚠️ Atenção: Carga das tabelas RAW finalizou com avisos, prosseguindo com a Fato...")

    # 2. Processar e carregar a tabela sq_fato_consistencia
    print("\n📊 [ETAPA 2/2] Processando e carregando sq_fato_consistencia...")
    ok_fato = processar_carga_fato_consistencia(supabase, raiz, config)

    if ok_fato:
        print("\n" + "=" * 70)
        print("🎉 PROCESSO CONCLUÍDO COM SUCESSO!")
        print("As tabelas sq_raw_consistencia_mensal, sq_raw_consistencia_anual e sq_fato_consistencia foram atualizadas.")
        print("=" * 70 + "\n")
        sys.exit(0)
    else:
        print("\n❌ Falha no processamento da tabela sq_fato_consistencia.")
        sys.exit(1)


if __name__ == "__main__":
    main()
