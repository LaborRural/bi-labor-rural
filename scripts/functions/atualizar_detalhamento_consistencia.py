# -*- coding: utf-8 -*-
"""
Módulo Oficial de Carga e Sincronização de Consistência (Mensal e Anual)
Lê os relatórios mais recentes exportados pelo Elabore e executa a carga completa
nas tabelas 'sq_raw_consistencia_mensal' e 'sq_raw_consistencia_anual' do Supabase.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from datetime import datetime
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


def ler_excel_seguro(caminho_arquivo: Path) -> pd.DataFrame:
    """Lê um arquivo Excel com cópia temporária para evitar locks do Windows."""
    tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
    tmp.close()
    try:
        shutil.copy2(caminho_arquivo, tmp.name)
        df = pd.read_excel(tmp.name)
        return df
    finally:
        try:
            os.remove(tmp.name)
        except Exception:
            pass


def obter_mapa_idfazenda(supabase) -> dict[str, int]:
    """
    Busca o mapeamento existente de 'codigo_lr' -> 'idfazenda' para garantir
    a integridade referencial e consistência dos IDs.
    """
    print("🔍 Buscando mapeamento histórico de 'idfazenda' no Supabase...")
    id_map = {}
    try:
        res_map = (
            supabase.table("sq_raw_consistencia_mensal")
            .select("codigo_lr, idfazenda")
            .not_.is_("idfazenda", "null")
            .execute()
        )
        if res_map.data:
            df_map = (
                pd.DataFrame(res_map.data)
                .dropna(subset=["codigo_lr", "idfazenda"])
                .drop_duplicates(subset=["codigo_lr"])
            )
            id_map = dict(zip(df_map["codigo_lr"].astype(str).str.strip(), df_map["idfazenda"].astype(int)))
    except Exception as e:
        print(f"⚠️ Aviso ao obter mapeamento de idfazenda: {e}")

    print(f"✅ Mapeamento carregado para {len(id_map)} produtores.")
    return id_map


def atribuir_idfazenda(df: pd.DataFrame, col_codigo: str, id_map: dict[str, int]) -> tuple[pd.DataFrame, dict[str, int]]:
    """Atribui idfazenda ao DataFrame, gerando novos IDs sequenciais se necessário."""
    max_id = max(id_map.values(), default=0)
    novos_codigos = set(df[col_codigo].dropna().astype(str).str.strip()) - set(id_map.keys())

    if novos_codigos:
        print(f"ℹ️ {len(novos_codigos)} novos produtores detectados sem 'idfazenda'. Atribuindo IDs sequenciais...")
        for cod in sorted(novos_codigos):
            max_id += 1
            id_map[cod] = max_id

    df["idfazenda"] = df[col_codigo].astype(str).str.strip().map(id_map)
    df = df[df["idfazenda"].notna()].copy()
    df["idfazenda"] = df["idfazenda"].astype(int)
    return df, id_map


def localizar_arquivo_recente(diretorio_principal: Path, fallback_dirs: list[Path], padrao_glob: str) -> Path:
    """Busca o arquivo mais recente que casa com o padrão glob."""
    pastas_busca = [diretorio_principal] + fallback_dirs
    for pasta in pastas_busca:
        if pasta.is_dir():
            arquivos = list(pasta.glob(padrao_glob))
            if arquivos:
                recente = max(arquivos, key=lambda f: f.stat().st_mtime)
                print(f"📖 Arquivo localizado ({recente.parent.name}): {recente.name}")
                return recente

    raise FileNotFoundError(f"❌ Nenhum arquivo '{padrao_glob}' encontrado nas pastas: {[str(p) for p in pastas_busca]}")


def limpar_tabela_supabase(supabase, nome_tabela: str) -> bool:
    """Limpa todos os registros de uma tabela para carga do snapshot completo."""
    print(f"🧹 Limpando registros antigos em '{nome_tabela}'...")
    try:
        supabase.table(nome_tabela).delete().neq("idfazenda", 0).execute()
        print(f"✅ Tabela '{nome_tabela}' limpa com sucesso.")
        return True
    except Exception as e:
        print(f"⚠️ Erro ao limpar tabela '{nome_tabela}': {e}")
        return False


def atualizar_consistencia_mensal(
    supabase, raiz_projeto: Path, config: dict, id_map: dict[str, int], limpar_antes: bool = True
) -> int:
    """Processa e executa carga em 'sq_raw_consistencia_mensal'."""
    print("\n" + "=" * 70)
    print("📊 ETAPA: ATUALIZANDO TABELA DE CONSISTÊNCIA MENSAL (sq_raw_consistencia_mensal)")
    print("=" * 70)

    dir_elabore = Path(config.get("caminhos", {}).get("elabore_mensal", ""))
    fallbacks = [
        raiz_projeto / "DB" / "INPUT" / "TEMP",
        raiz_projeto / "DB" / "INPUT",
    ]

    arquivo_excel = localizar_arquivo_recente(dir_elabore, fallbacks, "*indicadores_mensais.xlsx")
    df_excel = ler_excel_seguro(arquivo_excel)

    col_codigo = next((c for c in df_excel.columns if "código" in c.lower() or "codigo" in c.lower()), None)
    col_mes = next((c for c in df_excel.columns if "mês de referência" in c.lower() or "mes de referencia" in c.lower() or "referência" in c.lower()), None)
    col_detalhe = next((c for c in df_excel.columns if "detalhamento" in c.lower()), None)
    col_status = next((c for c in df_excel.columns if "status de consistência" in c.lower() or "status de consistencia" in c.lower()), None)
    col_cadastral = next((c for c in df_excel.columns if "status cadastral" in c.lower() or "status_code" in c.lower()), None)
    
    col_produtor = next((c for c in df_excel.columns if c.strip().lower() == "fazenda - produtor"), None)
    if not col_produtor:
        col_produtor = next((c for c in df_excel.columns if "produtor" in c.lower() and "id" not in c.lower()), None)
    if not col_produtor:
        col_produtor = next((c for c in df_excel.columns if "fazenda" in c.lower() and "id" not in c.lower()), None)

    col_consultor = next((c for c in df_excel.columns if "consultor" in c.lower()), None)

    if not col_codigo or not col_mes:
        raise ValueError("❌ Colunas obrigatórias ('Código LR', 'Mês de Referência') não encontradas na planilha mensal.")

    df_carga = pd.DataFrame()
    df_carga["codigo_lr"] = df_excel[col_codigo].astype(str).str.strip()
    df_carga["mes_referencia"] = pd.to_datetime(df_excel[col_mes]).dt.strftime("%Y-%m-%d")
    df_carga["mes_elabore"] = (pd.to_datetime(df_carga["mes_referencia"]) - pd.DateOffset(months=1)).dt.to_period("M").dt.to_timestamp().dt.strftime("%Y-%m-%d")

    if col_produtor:
        df_carga["nome_produtor"] = df_excel[col_produtor].apply(lambda x: str(x).strip() if pd.notna(x) else None)
    else:
        df_carga["nome_produtor"] = None

    if col_consultor:
        df_carga["nome_consultor"] = df_excel[col_consultor].apply(lambda x: str(x).strip() if pd.notna(x) else None)
    else:
        df_carga["nome_consultor"] = None

    if col_status:
        df_carga["consistencia_mensal"] = df_excel[col_status].fillna("Inconsistente").astype(str).str.strip()
    else:
        df_carga["consistencia_mensal"] = "Inconsistente"

    if col_cadastral:
        df_carga["status_code"] = df_excel[col_cadastral].astype(str).str.strip()
    else:
        df_carga["status_code"] = "active_approved"

    if col_detalhe:
        df_carga["detalhamento_inconsistencia"] = df_excel[col_detalhe].apply(
            lambda x: None if pd.isna(x) or str(x).strip().lower() in ["nenhum", "nan", "", "none"] else str(x).strip()
        )
    else:
        df_carga["detalhamento_inconsistencia"] = None

    # Timestamp de processamento
    agora_iso = datetime.now(ZoneInfo("America/Sao_Paulo")).isoformat()
    df_carga["data_processamento"] = agora_iso

    # Atribuir idfazenda
    df_carga, _ = atribuir_idfazenda(df_carga, "codigo_lr", id_map)

    # Filtrar inválidos e deduplicar
    df_carga = df_carga[df_carga["codigo_lr"].notna() & df_carga["mes_referencia"].notna()].copy()
    df_carga.drop_duplicates(subset=["idfazenda", "mes_referencia"], keep="last", inplace=True)
    df_carga.drop_duplicates(subset=["codigo_lr", "mes_referencia"], keep="last", inplace=True)

    print(f"📊 Total de registros válidos para carga mensal: {len(df_carga)}")

    if limpar_antes:
        limpar_tabela_supabase(supabase, "sq_raw_consistencia_mensal")

    # Enviar ao Supabase em lotes
    records = df_carga.to_dict(orient="records")
    chunk_size = config.get("execucao", {}).get("chunk_size_upsert", 1000)
    sucessos = 0

    print("🚀 Enviando registros para o Supabase (sq_raw_consistencia_mensal)...")
    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        try:
            supabase.table("sq_raw_consistencia_mensal").upsert(
                chunk, on_conflict="idfazenda,mes_referencia"
            ).execute()
            sucessos += len(chunk)
            print(f"   ✅ Lote {i // chunk_size + 1}: {len(chunk)} registros inseridos/atualizados.")
        except Exception as e:
            print(f"   ❌ Erro no lote {i // chunk_size + 1}: {e}")

    print(f"✨ Concluído! {sucessos} registros sincronizados em 'sq_raw_consistencia_mensal'.")
    return sucessos


def atualizar_consistencia_anual(
    supabase, raiz_projeto: Path, config: dict, id_map: dict[str, int], limpar_antes: bool = True
) -> int:
    """Processa e executa carga em 'sq_raw_consistencia_anual'."""
    print("\n" + "=" * 70)
    print("📈 ETAPA: ATUALIZANDO TABELA DE CONSISTÊNCIA ANUAL (sq_raw_consistencia_anual)")
    print("=" * 70)

    dir_elabore = Path(config.get("caminhos", {}).get("elabore_anual", ""))
    fallbacks = [
        raiz_projeto / "DB" / "INPUT" / "TEMP",
        raiz_projeto / "DB" / "INPUT",
    ]

    arquivo_excel = localizar_arquivo_recente(dir_elabore, fallbacks, "*indicadores_anuais.xlsx")
    df_excel = ler_excel_seguro(arquivo_excel)

    col_codigo = next((c for c in df_excel.columns if c.strip().lower() in ["labor_rural_code", "codigo_lr", "código lr", "codigo"]), None)
    if not col_codigo:
        col_codigo = next((c for c in df_excel.columns if "labor_rural_code" in c.lower() or "codigo" in c.lower()), None)

    col_end = next((c for c in df_excel.columns if c.strip().lower() in ["annual_period_end", "mes_referencia", "fim"]), None)
    if not col_end:
        col_end = next((c for c in df_excel.columns if "annual_period_end" in c.lower() or "referência" in c.lower() or "referencia" in c.lower()), None)

    col_start = next((c for c in df_excel.columns if c.strip().lower() in ["annual_period_start", "mes_elabore", "inicio"]), None)
    if not col_start:
        col_start = next((c for c in df_excel.columns if "annual_period_start" in c.lower() or "elabore" in c.lower()), None)

    # Buscar exatamente annual_consistency_status (evitando colisão com property_status)
    col_status = next((c for c in df_excel.columns if c.strip().lower() == "annual_consistency_status"), None)
    if not col_status:
        col_status = next((c for c in df_excel.columns if "status de consistência" in c.lower() or "consistencia" in c.lower()), None)

    # Detalhamento de inconsistência / outliers anual (prioriza annual_violated_consistency_details e outlier_details_annual)
    col_violated = next((c for c in df_excel.columns if c.strip().lower() in ["annual_violated_consistency_details", "violated_consistency_details"]), None)
    col_outlier = next((c for c in df_excel.columns if c.strip().lower() in ["outlier_details_annual", "detalhamento_inconsistencia", "outlier_details"]), None)

    col_produtor = next((c for c in df_excel.columns if c.strip().lower() in ["property_name", "entrepreneur_name", "property_entrepreneur_label", "fazenda", "produtor"]), None)
    col_consultor = next((c for c in df_excel.columns if c.strip().lower() in ["consultant_name", "consultor"]), None)

    if not col_codigo or not col_end:
        raise ValueError("❌ Colunas obrigatórias ('labor_rural_code', 'annual_period_end') não encontradas na planilha anual.")

    df_carga = pd.DataFrame()
    df_carga["codigo_lr"] = df_excel[col_codigo].astype(str).str.strip()
    df_carga["mes_referencia"] = pd.to_datetime(df_excel[col_end]).dt.strftime("%Y-%m-%d")

    if col_start:
        df_carga["mes_elabore"] = pd.to_datetime(df_excel[col_start]).dt.strftime("%Y-%m-%d")
    else:
        df_carga["mes_elabore"] = df_carga["mes_referencia"]

    if col_produtor:
        df_carga["nome_produtor"] = df_excel[col_produtor].apply(lambda x: str(x).strip() if pd.notna(x) else None)
    else:
        df_carga["nome_produtor"] = None

    if col_consultor:
        df_carga["nome_consultor"] = df_excel[col_consultor].apply(lambda x: str(x).strip() if pd.notna(x) else None)
    else:
        df_carga["nome_consultor"] = None

    if col_status:
        df_carga["consistencia_anual"] = df_excel[col_status].fillna("Inconsistente").astype(str).str.strip()
    else:
        df_carga["consistencia_anual"] = "Inconsistente"

    def extrair_detalhe_anual(row):
        partes = []
        if col_violated and pd.notna(row[col_violated]):
            v = str(row[col_violated]).strip()
            if v and v.lower() not in ["nenhum", "nan", "none", ""]:
                partes.append(v)
        if col_outlier and pd.notna(row[col_outlier]):
            o = str(row[col_outlier]).strip()
            if o and o.lower() not in ["nenhum", "nan", "none", ""]:
                if o not in partes:
                    partes.append(o)
        return " | ".join(partes) if partes else None

    df_carga["detalhamento_inconsistencia"] = df_excel.apply(extrair_detalhe_anual, axis=1)

    agora_iso = datetime.now(ZoneInfo("America/Sao_Paulo")).isoformat()
    df_carga["data_processamento"] = agora_iso

    # Atribuir idfazenda
    df_carga, _ = atribuir_idfazenda(df_carga, "codigo_lr", id_map)

    # Filtrar inválidos e deduplicar
    df_carga = df_carga[df_carga["codigo_lr"].notna() & df_carga["mes_referencia"].notna()].copy()
    df_carga.drop_duplicates(subset=["idfazenda", "mes_referencia"], keep="last", inplace=True)
    df_carga.drop_duplicates(subset=["codigo_lr", "mes_referencia"], keep="last", inplace=True)

    print(f"📊 Total de registros válidos para carga anual: {len(df_carga)}")

    if limpar_antes:
        limpar_tabela_supabase(supabase, "sq_raw_consistencia_anual")

    # Enviar ao Supabase em lotes
    records = df_carga.to_dict(orient="records")
    chunk_size = config.get("execucao", {}).get("chunk_size_upsert", 1000)
    sucessos = 0

    print("🚀 Enviando registros para o Supabase (sq_raw_consistencia_anual)...")
    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        try:
            supabase.table("sq_raw_consistencia_anual").upsert(chunk).execute()
            sucessos += len(chunk)
            print(f"   ✅ Lote {i // chunk_size + 1}: {len(chunk)} registros inseridos/atualizados.")
        except Exception as e:
            print(f"   ❌ Erro no lote {i // chunk_size + 1}: {e}")

    print(f"✨ Concluído! {sucessos} registros sincronizados em 'sq_raw_consistencia_anual'.")
    return sucessos


def executar_sincronizacao_consistencia(raiz_projeto: Path | None = None, limpar_antes: bool = True) -> bool:
    """Função principal para executar a sincronização completa das duas tabelas."""
    raiz = detectar_raiz(raiz_projeto)
    config = carregar_configuracao(raiz)
    supabase = obter_cliente_supabase(raiz)

    print("\n" + "=" * 70)
    print("🔄 INICIANDO CARGA COMPLETA DAS TABELAS DE CONSISTÊNCIA")
    print(f"⏰ Início: {datetime.now(ZoneInfo('America/Sao_Paulo')).strftime('%d/%m/%Y %H:%M:%S')}")
    print("=" * 70)

    try:
        id_map = obter_mapa_idfazenda(supabase)
        total_m = atualizar_consistencia_mensal(supabase, raiz, config, id_map, limpar_antes=limpar_antes)
        total_a = atualizar_consistencia_anual(supabase, raiz, config, id_map, limpar_antes=limpar_antes)

        print("\n" + "=" * 70)
        print("🎉 SINCRONIZAÇÃO DE CONSISTÊNCIA FINALIZADA COM SUCESSO!")
        print(f"   - Mensal: {total_m} registros (Snapshot Atual)")
        print(f"   - Anual:  {total_a} registros (Snapshot Atual)")
        print("=" * 70 + "\n")
        return True

    except Exception as e:
        print(f"\n❌ ERRO NA SINCRONIZAÇÃO DE CONSISTÊNCIA: {e}")
        return False


if __name__ == "__main__":
    sucesso = executar_sincronizacao_consistencia()
    sys.exit(0 if sucesso else 1)
