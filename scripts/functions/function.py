from __future__ import annotations

import importlib.util
import re
import sys
import unicodedata
import warnings
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

# Tentativa de carregar o módulo excel_format se disponível no projeto ou ambiente local
_CAMINHO_EXCEL_FORMAT = Path(__file__).resolve().parent / "excel_format.py"
if not _CAMINHO_EXCEL_FORMAT.exists():
    _candidato_lr = Path.cwd().parent / "lr-functions" / "functions" / "excel_format.py"
    if _candidato_lr.exists():
        _CAMINHO_EXCEL_FORMAT = _candidato_lr

if _CAMINHO_EXCEL_FORMAT.exists():
    try:
        _spec = importlib.util.spec_from_file_location("excel_format_ext", _CAMINHO_EXCEL_FORMAT)
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)

        aplicar_estilo_listrado_xlsx = getattr(_mod, "aplicar_estilo_listrado_xlsx", None)
        _exportar_varias_abas_xlsx = getattr(_mod, "exportar_varias_abas_xlsx", None)
        _exportar_xlsx_formatado = getattr(_mod, "exportar_xlsx_formatado", None)
        aplicar_formatacao_excel = getattr(_mod, "aplicar_formatacao_excel", None)
    except Exception:
        aplicar_estilo_listrado_xlsx = None
        _exportar_varias_abas_xlsx = None
        _exportar_xlsx_formatado = None
        aplicar_formatacao_excel = None
else:
    aplicar_estilo_listrado_xlsx = None
    _exportar_varias_abas_xlsx = None
    _exportar_xlsx_formatado = None
    aplicar_formatacao_excel = None


def detectar_raiz_projeto(inicio: str | Path | None = None) -> Path:
    """Localiza a raiz do projeto suportando a estrutura padrão (scripts, db)."""
    atual = Path(inicio or Path.cwd()).resolve()
    candidatos = [atual, *atual.parents]

    conjuntos_esperados = [
        ("scripts", "db"),
        ("scripts", "dashboard"),
        ("SCRIPTS", "DB"),
        ("app", "data"),
    ]

    for candidato in candidatos:
        for conjunto in conjuntos_esperados:
            if all((candidato / pasta).exists() for pasta in conjunto):
                return candidato

    raise FileNotFoundError(
        "Não foi possível localizar a raiz do projeto. "
        "A estrutura esperada contém as pastas scripts/ e db/. "
        f"Diretório inicial: {atual}"
    )


def ordenar_ano_mes_decrescente(df: pd.DataFrame) -> pd.DataFrame:
    """Ordena uma cópia do DataFrame do mês mais recente para o mais antigo."""
    if "ANO_MES" not in df.columns:
        return df.copy()

    return (
        df.sort_values(
            by="ANO_MES",
            ascending=False,
            na_position="last",
            kind="stable",
        )
        .reset_index(drop=True)
    )


def exportar_xlsx_formatado(*args, **kwargs):
    """Exporta XLSX aplicando a ordenação padrão por ANO_MES decrescente e estilo listrado verde."""
    if "df" in kwargs and isinstance(kwargs["df"], pd.DataFrame):
        kwargs["df"] = ordenar_ano_mes_decrescente(kwargs["df"])
    elif args and isinstance(args[0], pd.DataFrame):
        args = (ordenar_ano_mes_decrescente(args[0]), *args[1:])

    caminho = kwargs.get("caminho_saida") or kwargs.get("caminho") or (args[1] if len(args) > 1 else None)

    if _exportar_xlsx_formatado is not None:
        caminho_gerado = _exportar_xlsx_formatado(*args, **kwargs)
        caminho_alvo = caminho_gerado or caminho
    else:
        df = kwargs.get("df") if "df" in kwargs else args[0]
        if df is not None and caminho is not None:
            caminho_alvo = Path(caminho)
            caminho_alvo.parent.mkdir(parents=True, exist_ok=True)
            df.to_excel(caminho_alvo, index=False, engine="openpyxl")
        else:
            raise ValueError("Parâmetros inválidos para exportar_xlsx_formatado")
    
    # Aplicar o estilo listrado por padrão com cabeçalho verde #247B72 e texto branco negrito
    if aplicar_estilo_listrado_xlsx is not None and caminho_alvo and Path(caminho_alvo).exists():
        try:
            aplicar_estilo_listrado_xlsx(
                caminho_arquivo=caminho_alvo,
                cor_cabecalho="#247B72",
                cor_texto_cabecalho="#FFFFFF",
                cor_linha_alternada="#F2F2F2",
                cor_linha_base="#FFFFFF",
                primeira_linha_cinza=True,
            )
        except Exception as e:
            warnings.warn(f"Erro ao aplicar estilo listrado no Excel: {e}")

    return caminho_alvo


def exportar_varias_abas_xlsx(*args, **kwargs):
    """Exporta abas aplicando a ordenação padrão por ANO_MES decrescente."""
    abas = kwargs.get("abas") if "abas" in kwargs else (args[0] if args and isinstance(args[0], Mapping) else {})
    caminho = kwargs.get("caminho_saida") or kwargs.get("caminho") or (args[1] if len(args) > 1 else kwargs.get("caminho_arquivo"))

    if isinstance(abas, Mapping):
        abas = {
            nome: ordenar_ano_mes_decrescente(df) if isinstance(df, pd.DataFrame) else df
            for nome, df in abas.items()
        }

    if _exportar_varias_abas_xlsx is not None:
        if "abas" in kwargs:
            kwargs["abas"] = abas
        elif args:
            args = (abas, *args[1:])
        caminho_gerado = _exportar_varias_abas_xlsx(*args, **kwargs)
        caminho_alvo = caminho_gerado or caminho
    elif abas and caminho:
        caminho_alvo = Path(caminho)
        caminho_alvo.parent.mkdir(parents=True, exist_ok=True)
        with pd.ExcelWriter(caminho_alvo, engine="openpyxl") as writer:
            for nome_aba, df_aba in abas.items():
                if isinstance(df_aba, pd.DataFrame):
                    df_aba.to_excel(writer, sheet_name=str(nome_aba)[:31], index=False)
    else:
        raise ValueError("Parâmetros inválidos para exportar_varias_abas_xlsx")

    if aplicar_estilo_listrado_xlsx is not None and caminho_alvo and Path(caminho_alvo).exists():
        try:
            aplicar_estilo_listrado_xlsx(
                caminho_arquivo=caminho_alvo,
                cor_cabecalho="#247B72",
                cor_texto_cabecalho="#FFFFFF",
                cor_linha_alternada="#F2F2F2",
                cor_linha_base="#FFFFFF",
                primeira_linha_cinza=True,
            )
        except Exception as e:
            warnings.warn(f"Erro ao aplicar estilo listrado no Excel: {e}")

    return caminho_alvo


def extrair_data_nome_arquivo(caminho: str | Path) -> datetime | None:
    """
    Extrai datas no formato AAAA_MM_DD_HHMMSS ou AAAA_MM_DD presentes no nome do arquivo.
    """
    caminho = Path(caminho)
    nome = caminho.stem

    match = re.search(
        r"(?<!\d)(?P<ano>20\d{2})[_-](?P<mes>\d{2})[_-](?P<dia>\d{2})[_-](?P<hora>\d{2})(?P<minuto>\d{2})(?P<segundo>\d{2})(?!\d)",
        nome,
    )
    if match:
        try:
            return datetime(
                year=int(match.group("ano")),
                month=int(match.group("mes")),
                day=int(match.group("dia")),
                hour=int(match.group("hora")),
                minute=int(match.group("minuto")),
                second=int(match.group("segundo")),
            )
        except ValueError:
            return None

    match = re.search(
        r"(?<!\d)(?P<ano>20\d{2})[_-](?P<mes>\d{2})[_-](?P<dia>\d{2})(?!\d)",
        nome,
    )
    if match:
        try:
            return datetime(
                year=int(match.group("ano")),
                month=int(match.group("mes")),
                day=int(match.group("dia")),
            )
        except ValueError:
            return None

    return None


def buscar_arquivo_mais_recente(
    pastas: str | Path | Sequence[str | Path],
    padrao_nome: str,
    extensoes: Sequence[str] = ("xlsx", "xlsm", "xls", "csv", "parquet"),
    recursivo: bool = False,
) -> Path:
    """Busca o arquivo mais recente com base na data/hora no nome ou mtime."""
    if isinstance(pastas, (str, Path)):
        pastas = [pastas]

    pastas = [Path(pasta) for pasta in pastas]
    regex_nome = re.compile(padrao_nome, flags=re.IGNORECASE)
    extensoes_norm = {f".{ext.lower().lstrip('.')}" for ext in extensoes}
    candidatos: list[tuple[datetime, Path]] = []

    for pasta in pastas:
        if not pasta.exists():
            continue
        iterador = pasta.rglob("*") if recursivo else pasta.glob("*")

        for arquivo in iterador:
            if not arquivo.is_file():
                continue
            if arquivo.suffix.lower() not in extensoes_norm:
                continue
            if arquivo.stat().st_size == 0:
                continue
            if not regex_nome.search(arquivo.name):
                continue

            data_nome = extrair_data_nome_arquivo(arquivo)
            if data_nome is None:
                data_nome = datetime.fromtimestamp(arquivo.stat().st_mtime)

            candidatos.append((data_nome, arquivo))

    if not candidatos:
        pastas_txt = ", ".join(str(p) for p in pastas)
        raise FileNotFoundError(
            f"Nenhum arquivo encontrado para o padrão '{padrao_nome}'. Pastas: {pastas_txt}"
        )

    candidatos.sort(key=lambda item: item[0], reverse=True)
    return candidatos[0][1]


def converter_data_excel(serie: pd.Series) -> pd.Series:
    """Converte datas reais, textos e números seriais do Excel para datetime."""
    if pd.api.types.is_datetime64_any_dtype(serie):
        return pd.to_datetime(serie, errors="coerce").dt.normalize()

    numerica = pd.to_numeric(serie, errors="coerce")
    is_numeric_only = numerica.notna() & (~serie.astype(str).str.contains(r"[-/]", regex=True, na=False))

    resultado = pd.Series(index=serie.index, dtype="datetime64[ns]")

    if is_numeric_only.any():
        resultado.loc[is_numeric_only] = pd.Timestamp("1899-12-30") + pd.to_timedelta(
            numerica.loc[is_numeric_only], unit="D"
        )

    outras = ~is_numeric_only
    if outras.any():
        resultado.loc[outras] = pd.to_datetime(
            serie.loc[outras], errors="coerce", format="mixed", dayfirst=True
        )

    return resultado.dt.normalize()


def converter_numero_br(serie: pd.Series) -> pd.Series:
    """Converte valores numéricos em formato brasileiro (vírgula como decimal) ou internacional."""
    if pd.api.types.is_numeric_dtype(serie):
        return pd.to_numeric(serie, errors="coerce")

    texto = serie.astype("string").str.strip()
    nulos = texto.isna() | texto.str.lower().isin({"", "nan", "none", "nat", "<na>"})

    tem_virgula = texto.str.contains(",", na=False)
    convertido = texto.copy()
    convertido.loc[tem_virgula] = (
        convertido.loc[tem_virgula]
        .str.replace(".", "", regex=False)
        .str.replace(",", ".", regex=False)
    )
    convertido.loc[~tem_virgula] = convertido.loc[~tem_virgula].str.replace(
        r"\s+", "", regex=True
    )
    convertido.loc[nulos] = pd.NA
    return pd.to_numeric(convertido, errors="coerce")


def normalizar_texto(serie: pd.Series) -> pd.Series:
    """Normaliza texto: maiúsculas, sem acentos e espaços duplicados."""
    return (
        serie.astype("string")
        .fillna("")
        .str.upper()
        .str.normalize("NFKD")
        .str.encode("ascii", errors="ignore")
        .str.decode("utf-8")
        .str.replace(r"[^A-Z0-9 ]+", " ", regex=True)
        .str.replace(r"\s+", " ", regex=True)
        .str.strip()
    )


def dividir_seguro(
    numerador: pd.Series | np.ndarray | float,
    denominador: pd.Series | np.ndarray | float,
    exigir_denominador_positivo: bool = True,
) -> pd.Series:
    """Divide sem gerar erro de divisão por zero ou infinito."""
    num = pd.Series(numerador) if not isinstance(numerador, pd.Series) else numerador
    den = pd.Series(denominador, index=num.index) if not isinstance(denominador, pd.Series) else denominador
    valido = den.notna() & (den > 0 if exigir_denominador_positivo else den.ne(0))
    resultado = pd.Series(np.nan, index=num.index, dtype="float64")
    resultado.loc[valido] = num.loc[valido] / den.loc[valido]
    return resultado.replace([np.inf, -np.inf], np.nan)


def renomear_colunas_existentes(df: pd.DataFrame, mapa_antigo_novo: Mapping[str, str]) -> pd.DataFrame:
    """Renomeia apenas colunas realmente presentes no DataFrame."""
    mapa = {antigo: novo for antigo, novo in mapa_antigo_novo.items() if antigo in df.columns}
    return df.rename(columns=mapa)


def garantir_colunas(df: pd.DataFrame, colunas: Iterable[str], valor=np.nan) -> pd.DataFrame:
    """Garante a existência das colunas especificadas no DataFrame."""
    df = df.copy()
    for coluna in colunas:
        if coluna not in df.columns:
            df[coluna] = valor
    return df


def ler_aba_excel_flex(caminho_arquivo: Path, abas_prioritarias: list[str]) -> pd.DataFrame:
    """Lê a primeira aba disponível entre as opções informadas."""
    excel_file = pd.ExcelFile(caminho_arquivo, engine="openpyxl")
    abas_existentes = excel_file.sheet_names
    for aba in abas_prioritarias:
        if aba in abas_existentes:
            return pd.read_excel(excel_file, sheet_name=aba)
    return pd.read_excel(excel_file, sheet_name=0)


MESES_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


class ConfigReferencia:
    """Estrutura com as variáveis de mês de referência e janelas temporais."""

    def __init__(
        self,
        mes_referencia: pd.Timestamp,
        periodo_checagem_inicio: str = "2024-01",
        ano_filtro_inicio: int = 2024,
        meses_consecutivos_minimos: int = 12,
    ):
        self.mes_referencia: pd.Timestamp = mes_referencia.normalize()
        self.mes_referencia_str: str = self.mes_referencia.strftime("%Y_%m")
        self.mes_referencia_aba: str = self.mes_referencia.strftime("%Y_%m")
        self.mes_referencia_rotulo: str = self.mes_referencia.strftime("%m/%Y")
        self.mes_referencia_extenso: str = (
            f"{MESES_PT[self.mes_referencia.month - 1]} de {self.mes_referencia.year}"
        )
        self.periodo_checagem_inicio: str = periodo_checagem_inicio
        self.periodo_checagem_fim: str = self.mes_referencia.strftime("%Y-%m")
        self.periodo_resumo_fim: pd.Period = self.mes_referencia.to_period("M")
        self.periodo_resumo_inicio: pd.Period = self.periodo_resumo_fim - 11
        self.ano_filtro_inicio: int = ano_filtro_inicio
        self.meses_consecutivos_minimos: int = int(meses_consecutivos_minimos)

    def __repr__(self) -> str:
        return (
            f"ConfigReferencia(mes_referencia={self.mes_referencia_str}, "
            f"extenso='{self.mes_referencia_extenso}')"
        )


def carregar_config_referencia(raiz: Path | str | None = None) -> ConfigReferencia:
    """Carrega as configurações a partir de scripts/config/config.yaml."""
    raiz_path = detectar_raiz_projeto(raiz)
    arquivo_config = raiz_path / "scripts" / "config" / "config.yaml"
    if not arquivo_config.exists():
        arquivo_config = raiz_path / "SCRIPTS" / "CONFIG" / "config.yaml"

    dados_ref = {}
    if arquivo_config.exists():
        try:
            import yaml
            with open(arquivo_config, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
                dados_ref = cfg.get("referencia", {})
        except Exception as e:
            warnings.warn(f"Erro ao ler {arquivo_config}: {e}. Usando defaults.")

    data_str = str(dados_ref.get("mes_referencia", "2026-08-01"))
    mes = pd.to_datetime(data_str, errors="coerce")
    if pd.isna(mes):
        mes = pd.Timestamp("2026-08-01")

    return ConfigReferencia(
        mes_referencia=mes,
        periodo_checagem_inicio=str(dados_ref.get("periodo_checagem_inicio", "2024-01")),
        ano_filtro_inicio=int(dados_ref.get("ano_filtro_inicio", 2024)),
        meses_consecutivos_minimos=dados_ref.get("meses_consecutivos_minimos", 12),
    )


def carregar_env(raiz: Path | str | None = None) -> dict[str, str]:
    """Carrega variáveis de ambiente de scripts/config/.env."""
    raiz_path = detectar_raiz_projeto(raiz)
    env_file = raiz_path / "scripts" / "config" / ".env"
    if not env_file.exists():
        env_file = raiz_path / "SCRIPTS" / "CONFIG" / ".env"
    env_vars = {}
    if env_file.exists():
        try:
            from dotenv import dotenv_values
            env_vars = dict(dotenv_values(env_file))
        except ImportError:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        env_vars[k.strip()] = v.strip()
    if env_vars:
        import os
        os.environ.update(env_vars)
    return env_vars


def obter_cliente_supabase(raiz: Path | str | None = None):
    """
    Retorna a instância do cliente Supabase configurada a partir de scripts/config/.env.
    ATENÇÃO: Usar exclusivamente para operações de CONSULTA / LEITURA (Read-Only).
    """
    from supabase import create_client
    env_vars = carregar_env(raiz)
    url = env_vars.get("SUPABASE_URL")
    key = env_vars.get("SUPABASE_SERVICE_KEY") or env_vars.get("SUPABASE_KEY") or env_vars.get("SUPABASE_ANON_KEY")
    if not url or not key:
        raise ValueError(
            "Credenciais do Supabase não encontradas. Verifique SUPABASE_URL e SUPABASE_SERVICE_KEY em scripts/config/.env"
        )
    return create_client(url, key)


def consultar_tabela_supabase(
    tabela: str,
    colunas: str = "*",
    filtros: dict | None = None,
    filtros_in: dict[str, list] | None = None,
    raiz: Path | str | None = None,
    limite: int | None = None,
) -> pd.DataFrame:
    """
    Executa uma consulta SELECT de leitura em uma tabela/visão do Supabase e retorna um pandas.DataFrame.
    Suporta paginação automática transparente para trazer todos os registros (superando o limite de 1000 da API).
    Esta função cumpre a regra estrita do projeto: APENAS LEITURA (READ-ONLY).
    """
    client = obter_cliente_supabase(raiz)
    
    todos_registros = []
    chunk_size = 1000
    offset = 0
    
    while True:
        query = client.table(tabela).select(colunas)
        if filtros:
            for col, val in filtros.items():
                query = query.eq(col, val)
        if filtros_in:
            for col, vals in filtros_in.items():
                query = query.in_(col, vals)
                
        limite_fim = offset + chunk_size - 1
        if limite is not None and limite_fim >= limite:
            limite_fim = limite - 1
            
        resposta = query.range(offset, limite_fim).execute()
        dados = resposta.data or []
        if not dados:
            break
            
        todos_registros.extend(dados)
        
        if len(dados) < chunk_size or (limite is not None and len(todos_registros) >= limite):
            break
            
        offset += chunk_size
        
    return pd.DataFrame(todos_registros)


def consultar_view_azure_postgres(
    view: str = "vw_dim_property",
    schema: str | None = None,
    raiz: Path | str | None = None,
) -> pd.DataFrame:
    """
    Consulta uma view/tabela no banco de dados Azure PostgreSQL (ex: analytics_mart.vw_dim_property)
    usando as credenciais definidas em scripts/config/.env.
    """
    import os
    import psycopg2
    
    env_vars = carregar_env(raiz)
    pg_host = env_vars.get("PG_HOST") or os.getenv("PG_HOST")
    pg_port = env_vars.get("PG_PORT") or os.getenv("PG_PORT") or 5432
    pg_database = env_vars.get("PG_DATABASE") or os.getenv("PG_DATABASE") or "postgres"
    pg_user = env_vars.get("PG_USER") or os.getenv("PG_USER")
    pg_password = env_vars.get("PG_PASSWORD") or os.getenv("PG_PASSWORD")
    pg_schema = schema or env_vars.get("PG_SCHEMA") or os.getenv("PG_SCHEMA") or "analytics_mart"

    if not pg_host or not pg_user or not pg_password:
        raise ValueError(
            "Credenciais do Postgres Azure ausentes. Verifique PG_HOST, PG_USER e PG_PASSWORD em scripts/config/.env"
        )

    conn = psycopg2.connect(
        host=pg_host,
        port=int(pg_port),
        dbname=pg_database,
        user=pg_user,
        password=pg_password,
        sslmode="require"
    )

    try:
        query = f"SELECT * FROM {pg_schema}.{view};"
        df = pd.read_sql_query(query, conn)
        return df
    finally:
        conn.close()



