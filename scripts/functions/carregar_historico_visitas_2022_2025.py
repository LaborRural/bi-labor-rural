# -*- coding: utf-8 -*-
"""
Script: carregar_historico_visitas_2022_2025.py
Objetivo: Ingerir exclusivamente o histórico de visitas do arquivo
          BD_SMARTQUESTION/BACKUPS/VISITAS/LISTA_GERAL_VISITAS_2022_2025.xlsx (42.776 registros)
          nas tabelas sq_raw_visitas e sq_fato_visitas do Supabase.

Uso:
  python scripts/functions/carregar_historico_visitas_2022_2025.py
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
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
    caminho_atual = (caminho_base or Path(__file__).resolve()).parent
    for candidato in [caminho_atual, *caminho_atual.parents]:
        if (candidato / "scripts").is_dir() and ((candidato / "db").is_dir() or (candidato / "dashboard").is_dir()):
            return candidato
        if (candidato / "SCRIPTS").is_dir() and (candidato / "DB").is_dir():
            return candidato
    return caminho_atual


raiz_projeto = detectar_raiz()
for p in [
    raiz_projeto,
    raiz_projeto / "scripts",
    raiz_projeto / "scripts" / "functions",
    raiz_projeto / "SCRIPTS",
    raiz_projeto / "SCRIPTS" / "FUNCTIONS",
]:
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


def carregar_configuracao(raiz: Path) -> dict:
    config_file = raiz / "scripts" / "config" / "config.yaml"
    if not config_file.is_file():
        config_file = raiz / "SCRIPTS" / "CONFIG" / "config.yaml"
    with open(config_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def obter_cliente_supabase(raiz: Path):
    for env_path in [
        raiz / "scripts" / "config" / ".env",
        raiz / "dashboard" / ".env.local",
        raiz / ".env",
    ]:
        if env_path.is_file():
            load_dotenv(env_path)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        raise ValueError("❌ Credenciais do Supabase não encontradas!")

    return create_client(supabase_url, supabase_key)


def normalizar_texto(texto: str | None) -> str:
    if not texto or pd.isna(texto):
        return ""
    nfkd = unicodedata.normalize("NFKD", str(texto))
    return "".join([c for c in nfkd if not unicodedata.combining(c)]).strip().upper()


def extrair_codigo_lr(ponto_atendimento: str | None) -> str | None:
    if not ponto_atendimento or pd.isna(ponto_atendimento):
        return None
    match = re.search(r"(LR\d{4,6})", str(ponto_atendimento), re.IGNORECASE)
    return match.group(1).upper() if match else None


def extrair_nome_produtor(ponto_atendimento: str | None) -> str | None:
    if not ponto_atendimento or pd.isna(ponto_atendimento):
        return None
    text = str(ponto_atendimento).strip()
    if " - " in text:
        parts = text.split(" - ", 1)
        return parts[1].strip()
    return text


def extrair_projeto(tipo_visita: str | None, ponto_atendimento: str | None) -> str:
    t = normalizar_texto(tipo_visita)
    p = normalizar_texto(ponto_atendimento)
    combined = f"{t} {p}"

    if "REGENERA" in combined or "NESTLE" in combined:
        return "REGENERA"
    if "ALVOAR" in combined:
        if "ECO" in combined:
            return "ALVOAR ECO"
        return "ALVOAR ASSIST"
    if "SEMEAR" in combined or "DANONE" in combined:
        return "SEMEAR"
    if "CCPR" in combined or "ATEG" in combined:
        return "ATEG_CCPR"
    if "LPA" in combined or "PORTO ALEGRE" in combined:
        return "LPA"
    return "GERAL"


def eh_cadeia_leite(projeto: str) -> bool:
    p = normalizar_texto(projeto)
    termos_nao_leite = ["MAIS GRAOS", "GRAOS", "MIMC", "CAFE", "CACAU", "AGRICULTURA"]
    for t in termos_nao_leite:
        if t in p:
            return False
    return True


def executar_carga_historico_visitas():
    print("\n" + "=" * 70)
    print("🚀 INGESTÃO DO HISTÓRICO DE VISITAS: LISTA_GERAL_VISITAS_2022_2025.xlsx")
    print(f"⏰ Início: {datetime.now(ZoneInfo('America/Sao_Paulo')).strftime('%d/%m/%Y %H:%M:%S')}")
    print("=" * 70)

    raiz = detectar_raiz()
    config = carregar_configuracao(raiz)
    supabase = obter_cliente_supabase(raiz)

    bd_cfg_path = config.get("caminhos", {}).get("bd_smartquestion", "")
    candidatos = [
        raiz / "BD_SMARTQUESTION" / "BACKUPS" / "VISITAS" / "LISTA_GERAL_VISITAS_2022_2025.xlsx",
        raiz.parent / "BD_SMARTQUESTION" / "BACKUPS" / "VISITAS" / "LISTA_GERAL_VISITAS_2022_2025.xlsx",
        (Path(bd_cfg_path) / "BACKUPS" / "VISITAS" / "LISTA_GERAL_VISITAS_2022_2025.xlsx") if bd_cfg_path else None,
    ]
    caminho_arquivo = None
    for cand in candidatos:
        if cand and cand.is_file():
            caminho_arquivo = cand
            break

    if not caminho_arquivo:
        print(f"❌ Arquivo não encontrado nas buscas: {[str(c) for c in candidatos if c]}")
        sys.exit(1)

    print(f"\n📥 Lendo planilha histórica: {caminho_arquivo.name}...")
    df_raw = pd.read_excel(caminho_arquivo, sheet_name="Atendimento", skiprows=3)
    print(f"📊 Registros brutos lidos: {len(df_raw)}")

    # Mapeamento de colunas
    col_atendimento = [c for c in df_raw.columns if "atendimento" in str(c).lower() and "ponto" not in str(c).lower()][0]
    col_ponto = [c for c in df_raw.columns if "ponto" in str(c).lower()][0]
    col_tipo = [c for c in df_raw.columns if "tipo" in str(c).lower()][0]
    col_usuario = [c for c in df_raw.columns if "usu" in str(c).lower() or "consultor" in str(c).lower()][0]
    col_data_fim = [c for c in df_raw.columns if "data fim" in str(c).lower() or "fim" in str(c).lower()][0]
    col_data_inicio = [c for c in df_raw.columns if "data in" in str(c).lower() or "inicio" in str(c).lower()][0]
    col_status = [c for c in df_raw.columns if "status" in str(c).lower()][0]

    df = pd.DataFrame()
    df["id_atendimento"] = pd.to_numeric(df_raw[col_atendimento], errors="coerce").astype("Int64")
    df["ponto_atendimento_raw"] = df_raw[col_ponto]
    df["tipo_visita"] = df_raw[col_tipo].fillna("VISITA TECNICA")
    df["nome_consultor"] = df_raw[col_usuario].apply(normalizar_texto)
    df["data_fim"] = pd.to_datetime(df_raw[col_data_fim], errors="coerce")
    df["data_inicio"] = pd.to_datetime(df_raw[col_data_inicio], errors="coerce")
    df["status_visita"] = df_raw[col_status].fillna("CONCLUIDO")

    df["data_visita_dt"] = df["data_fim"].combine_first(df["data_inicio"])
    df = df[df["data_visita_dt"].notna()].copy()

    df["codigo_lr"] = df["ponto_atendimento_raw"].apply(extrair_codigo_lr)
    df["nome_produtor"] = df["ponto_atendimento_raw"].apply(extrair_nome_produtor)
    df["projeto"] = df.apply(lambda r: extrair_projeto(r["tipo_visita"], r["ponto_atendimento_raw"]), axis=1)

    # Filtrar apenas cadeia do leite
    df = df[df["projeto"].apply(eh_cadeia_leite)].copy()

    # Formatação de datas ISO
    df["data_visita"] = df["data_visita_dt"].dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    df["mes_referencia_dt"] = df["data_visita_dt"].dt.to_period("M").dt.to_timestamp()
    df["mes_referencia"] = df["mes_referencia_dt"].dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    agora_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    df["data_processamento"] = agora_iso
    df["origem_dados"] = "LISTA_GERAL_VISITAS_2022_2025"

    # Cálculo do SHA-256 id_composto (paridade estrita com carregar_fato_visitas.py)
    df_hash = pd.DataFrame()
    df_hash["codigo_lr"] = df["codigo_lr"].astype(str).replace({"None": "NULL_VAL", "nan": "NULL_VAL"})
    df_hash["nome_consultor"] = df["nome_consultor"].astype(str).replace({"None": "NULL_VAL", "nan": "NULL_VAL"})
    df_hash["mes_referencia_str"] = df["mes_referencia"].astype(str).replace({"None": "NULL_VAL", "nan": "NULL_VAL"})
    df_hash["id_atendimento"] = df["id_atendimento"].astype(str).replace({"<NA>": "NULL_VAL", "None": "NULL_VAL", "nan": "NULL_VAL"})

    hash_input = df_hash.agg("".join, axis=1)
    df["id_composto"] = hash_input.apply(lambda x: hashlib.sha256(x.encode()).hexdigest())

    # Deduplicação por id_composto
    total_antes = len(df)
    df = df.drop_duplicates(subset=["id_composto"], keep="first").copy()
    print(f"✅ Registros filtrados e deduplicados por id_composto: {len(df)} (removidas {total_antes - len(df)} duplicatas)")

    # Sanitização de NaNs para dicionários
    def sanitizar_records(dataframe, colunas):
        df_sub = dataframe[colunas].copy()
        records_raw = df_sub.to_dict(orient="records")
        clean_records = []
        for r in records_raw:
            cleaned = {}
            for k, v in r.items():
                if pd.isna(v) or v is None:
                    cleaned[k] = None
                elif k == "id_atendimento":
                    try:
                        cleaned[k] = int(v)
                    except Exception:
                        cleaned[k] = None
                else:
                    cleaned[k] = v
            clean_records.append(cleaned)
        return clean_records

    # 1. Payload sq_raw_visitas
    colunas_raw = [
        "id_atendimento", "nome_consultor", "codigo_lr", "nome_produtor",
        "data_visita", "data_processamento", "origem_dados", "id_composto", "tipo_visita"
    ]
    records_raw = sanitizar_records(df, colunas_raw)

    print(f"\n⬆️ Enviando {len(records_raw)} registros históricos para sq_raw_visitas...")
    chunk_size = 1000
    for i in range(0, len(records_raw), chunk_size):
        chunk = records_raw[i : i + chunk_size]
        try:
            supabase.table("sq_raw_visitas").upsert(
                chunk,
                on_conflict="id_composto"
            ).execute()
            print(f"   ✅ sq_raw_visitas - Lote {i // chunk_size + 1}/{(len(records_raw) + chunk_size - 1) // chunk_size}: {len(chunk)} registros.")
        except Exception as e_raw:
            print(f"   ❌ Erro ao enviar sq_raw_visitas lote {i // chunk_size + 1}: {e_raw}")

    # 2. Payload sq_fato_visitas (requer codigo_lr NAO NULO na constraint do PostgreSQL)
    df_fato = df[df["codigo_lr"].notna() & (df["codigo_lr"].astype(str).str.strip() != "")].copy()
    colunas_fato = [
        "id_atendimento", "codigo_lr", "nome_consultor", "mes_referencia",
        "nome_produtor", "projeto", "data_visita", "data_processamento",
        "id_composto", "tipo_visita"
    ]
    records_fato = sanitizar_records(df_fato, colunas_fato)

    print(f"\n⬆️ Enviando {len(records_fato)} registros históricos para sq_fato_visitas...")
    for i in range(0, len(records_fato), chunk_size):
        chunk = records_fato[i : i + chunk_size]
        try:
            supabase.table("sq_fato_visitas").upsert(
                chunk,
                on_conflict="id_composto"
            ).execute()
            print(f"   ✅ sq_fato_visitas - Lote {i // chunk_size + 1}/{(len(records_fato) + chunk_size - 1) // chunk_size}: {len(chunk)} registros.")
        except Exception as e_fato:
            print(f"   ❌ Erro ao enviar sq_fato_visitas lote {i // chunk_size + 1}: {e_fato}")

    print("\n" + "=" * 70)
    print("✨ CARGA HISTÓRICA DE VISITAS CONCLUÍDA COM SUCESSO!")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    executar_carga_historico_visitas()
