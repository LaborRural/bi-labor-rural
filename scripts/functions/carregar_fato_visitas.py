"""
Módulo: carregar_fato_visitas.py
Responsável por extrair visitas e vínculos brutos do Supabase, aplicar regras de negócio,
manter o consultor original de campo, preservar nome do produtor e propriedade,
higienizar tipos/nulos e carregar a tabela sq_fato_visitas.
"""

import os
import sys
import math
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client

ALLOWED_COLS_FATO_VISITAS = [
    'codigo_lr',
    'nome_consultor',
    'mes_referencia',
    'nome_produtor',
    'nome_propriedade',
    'projeto',
    'codigo_agroindustria',
    'id_atendimento',
    'data_visita',
    'data_processamento',
    'id_farm',
    'valor_pago_produtor',
    'valor_pago_agroindustria',
    'meses_ativos_vinculo',
    'id_composto',
    'tipo_visita'
]

def obter_cliente_supabase(raiz_projeto: Optional[Path] = None) -> Client:
    """Inicializa o cliente Supabase com credenciais das variáveis de ambiente."""
    if raiz_projeto is None:
        raiz_projeto = Path(__file__).resolve().parent.parent.parent

    for env_file in [
        raiz_projeto / 'scripts' / 'config' / '.env',
        raiz_projeto / 'dashboard' / '.env.local',
        raiz_projeto / 'SCRIPTS' / 'CONFIG' / '.env',
        raiz_projeto / 'DASHBOARD' / '.env.local'
    ]:
        if env_file.is_file():
            load_dotenv(env_file)

    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_SERVICE_KEY') or os.getenv('SUPABASE_KEY')

    if not supabase_url or not supabase_key:
        raise ValueError("❌ Credenciais do Supabase não encontradas no arquivo .env!")

    return create_client(supabase_url, supabase_key)


def buscar_todos_registros(supabase: Client, tabela: str, select_cols: str = "*", filtros: Optional[list] = None) -> pd.DataFrame:
    """Busca todos os registros de uma tabela do Supabase paginando com .range()."""
    todos_registros = []
    chunk_size = 1000
    offset = 0

    while True:
        query = supabase.table(tabela).select(select_cols).range(offset, offset + chunk_size - 1)
        if filtros:
            for op, col, val in filtros:
                if op == 'gte':
                    query = query.gte(col, val)
                elif op == 'lte':
                    query = query.lte(col, val)
                elif op == 'eq':
                    query = query.eq(col, val)

        res = query.execute()
        if not res.data:
            break

        todos_registros.extend(res.data)
        if len(res.data) < chunk_size:
            break
        offset += chunk_size

    return pd.DataFrame(todos_registros)


def ler_excel_seguro(caminho_excel, **kwargs):
    """Lê um arquivo Excel com suporte a arquivos abertos no Excel (evita PermissionError/Errno 13 no Windows)."""
    caminho = Path(caminho_excel)
    try:
        return pd.read_excel(caminho, **kwargs)
    except (PermissionError, OSError):
        try:
            import msvcrt, ctypes, tempfile
            from ctypes import wintypes

            GENERIC_READ = 0x80000000
            FILE_SHARE_READ = 0x00000001
            FILE_SHARE_WRITE = 0x00000002
            FILE_SHARE_DELETE = 0x00000004
            OPEN_EXISTING = 3
            FILE_ATTRIBUTE_NORMAL = 0x80

            kernel32 = ctypes.windll.kernel32
            CreateFileW = kernel32.CreateFileW
            CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            CreateFileW.restype = wintypes.HANDLE

            tmp_dir = tempfile.gettempdir()
            tmp_path = Path(tmp_dir) / f"temp_{caminho.name}"

            h = CreateFileW(str(caminho), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None)
            if h != -1 and h != 0xFFFFFFFFFFFFFFFF:
                fd = msvcrt.open_osfhandle(h, os.O_RDONLY)
                with open(fd, 'rb', closefd=True) as f_in:
                    with open(tmp_path, 'wb') as f_out:
                        f_out.write(f_in.read())
                df = pd.read_excel(tmp_path, **kwargs)
                try:
                    tmp_path.unlink()
                except Exception:
                    pass
                return df
        except Exception:
            pass
        raise


def executar_etl_fato_visitas(
    data_inicial: str = '2026-01-01',
    data_final: Optional[str] = None,
    raiz_projeto: Optional[Path] = None,
    tabela_fato: str = 'sq_fato_visitas',
    tabela_raw_visitas: str = 'sq_raw_visitas',
    tabela_raw_vinculos: str = 'sq_raw_vinculos'
) -> pd.DataFrame:
    """
    Executa o pipeline completo de extração, transformação e carga da sq_fato_visitas.
    """
    if data_final is None:
        data_final = datetime.now().strftime('%Y-%m-%d')

    print("==================================================================")
    print(f"🚀 INICIANDO PROCESSAMENTO DA TABELA FATO: {tabela_fato}")
    print(f"📅 Período de análise: {data_inicial} até {data_final}")
    print("==================================================================")

    supabase = obter_cliente_supabase(raiz_projeto)

    # 1. Extração de visitas brutas
    print(f"\n🔍 ETAPA 1: Importando visitas brutas de {tabela_raw_visitas}")
    filtros_visitas = [
        ('gte', 'data_visita', data_inicial),
        ('lte', 'data_visita', data_final)
    ]
    df_visitas = buscar_todos_registros(supabase, tabela_raw_visitas, filtros=filtros_visitas)
    print(f"   -> Total de visitas brutas extraídas: {len(df_visitas)}")

    if df_visitas.empty:
        print("⚠️ Nenhuma visita encontrada para o período especificado.")
        return pd.DataFrame()

    # Tipagem e padronização de visitas
    df_visitas['data_visita'] = pd.to_datetime(df_visitas['data_visita'], errors='coerce')
    df_visitas = df_visitas[df_visitas['data_visita'].notna()].copy()
    df_visitas['mes_ano'] = df_visitas['data_visita'].dt.strftime('%Y-%m')
    df_visitas['mes_referencia'] = df_visitas['data_visita'].dt.to_period('M').dt.to_timestamp()

    # Filtro estrito de visitas técnicas da cadeia de Leite (Whitelist aprovada sem CFT)
    if 'tipo_visita' in df_visitas.columns:
        linhas_antes = len(df_visitas)
        whitelist_leite = [
            'ALVOAR ASSIST', 'ALVOAR ASSIST - V2',
            'ALVOAR ECO', 'ALVOAR ECO - V2',
            'RELATORIO DE VISITA ATEG/CCPR_GOIAS', 'RELATORIO DE VISITA ATEG/CCPR_GOIAS - V2',
            'RELATÓRIO DE VISITA AUROKE',
            'RELATORIO DE VISITA CAMPILEITE+',
            'RELATÓRIO DE VISITA COPRIL', 'RELATÓRIO DE VISITA COPRIL - V2',
            'RELATÓRIO DE VISITA FLORA',
            'RELATÓRIO DE VISITA LABOR RURAL - LEITE',
            'RELATÓRIO DE VISITA LABOR RURAL (PADRÃO)',
            'RELATORIO DE VISITA LPA', 'RELATORIO DE VISITA LPA - V1', 'RELATORIO DE VISITA LPA - V2',
            'RELATÓRIO DE VISITA NATA',
            'RELATORIO DE VISITA REGENERA', 'RELATORIO DE VISITA REGENERA - V2',
            'RELATÓRIO DE VISITA SEMEAR - V2', 'RELATÓRIO DE VISITA SEMEAR - V3'
        ]

        def _remover_acentos_tipo(txt: str) -> str:
            import unicodedata
            return "".join(c for c in unicodedata.normalize("NFKD", str(txt)) if not unicodedata.combining(c)).strip().upper()

        whitelist_norm_set = {_remover_acentos_tipo(t) for t in whitelist_leite}
        df_visitas['tipo_clean_temp'] = df_visitas['tipo_visita'].apply(_remover_acentos_tipo)
        df_visitas = df_visitas[df_visitas['tipo_clean_temp'].isin(whitelist_norm_set)].copy()
        df_visitas.drop(columns=['tipo_clean_temp'], inplace=True, errors='ignore')

        # Exclusão estrita de projetos puramente CFT e grupos exclusivos de CFT
        grupos_cft_exclusivos = {
            "DAYANNE UCHOA VEIGA / DEBORA LIMA DE OLIVEIRA / MARIO BARBOSA ROSA FILHO / MATEUS CARNIELLI / TALITA FONTES / THAYNAN FERREIRA DE ARAUJO",
            "HUGO LOPES / MATEUS CARNIELLI / ROMARCIO PAULO DE OLIVEIRA / THAYNAN FERREIRA DE ARAUJO",
            "BRUNO ANTONIO FERRONI RODRIGUES / HUGO LOPES / MATEUS CARNIELLI / THAYNAN FERREIRA DE ARAUJO",
            "MATHEUS GOMIDES GONCALVES",
            "TALITA FONTES"
        }
        if 'projeto' in df_visitas.columns:
            m_cft_proj = df_visitas['projeto'].astype(str).str.upper().str.contains('CFT', na=False) & \
                        ~df_visitas['projeto'].astype(str).str.upper().str.contains('ALVOAR|CCPR|LPA|REGENERA|SEMEAR|COPRIL|CAMPILEITE|NESTLE|EDUCAMPO', regex=True, na=False)
            df_visitas = df_visitas[~m_cft_proj].copy()

        if 'nome_consultor' in df_visitas.columns:
            m_cft_grupo = df_visitas['nome_consultor'].astype(str).str.strip().str.upper().isin(grupos_cft_exclusivos)
            df_visitas = df_visitas[~m_cft_grupo].copy()

        print(f"   -> Filtradas {linhas_antes - len(df_visitas)} visitas (excluídos formulários CFT, administrativos, projetos/grupos CFT exclusivos e outras cadeias). Restaram {len(df_visitas)} visitas técnicas de Leite.")

    # 2. Extração de vínculos e inativações de produtores
    print(f"\n🔍 ETAPA 2: Importando vínculos ({tabela_raw_vinculos}) e inativações (sq_raw_inativacoes_produtor)")
    df_vinculos = buscar_todos_registros(supabase, tabela_raw_vinculos)
    print(f"   -> Total de vínculos importados: {len(df_vinculos)}")

    df_inativacoes = buscar_todos_registros(supabase, 'sq_raw_inativacoes_produtor', select_cols='codigo_lr')
    print(f"   -> Total de solicitações de inativação importadas: {len(df_inativacoes)}")

    codigos_vinculos_ativos = set()
    try:
        dir_bd_sq = (raiz_projeto / 'DB' / 'INPUT' / 'BD_SMARTQUESTION') if raiz_projeto else (Path(__file__).resolve().parent.parent.parent / 'DB' / 'INPUT' / 'BD_SMARTQUESTION')
        if not dir_bd_sq.exists():
            dir_bd_sq = Path(r'c:\Users\Guilherme\LABOR RURAL\Analytics - Departamento Analytics\POWER_BI\PROJETOS\BI_LABOR_RURAL\BD_SMARTQUESTION')
        arq_vinc_excel = dir_bd_sq / 'BD_BI_VINCULOS_COMPLETO.xlsx'
        if arq_vinc_excel.exists():
            df_vinc_excel = ler_excel_seguro(arq_vinc_excel)
            if 'Ativo' in df_vinc_excel.columns and 'Código LR' in df_vinc_excel.columns:
                m_at = df_vinc_excel['Ativo'].astype(str).str.strip().str.lower().isin(['true', 'sim', 'ativo', '1'])
                codigos_vinculos_ativos = set(df_vinc_excel[m_at]['Código LR'].dropna().astype(str).str.strip().str.upper())
                print(f"   -> Total de vínculos ativos na planilha oficial BD_BI_VINCULOS_COMPLETO.xlsx: {len(codigos_vinculos_ativos)}")
    except Exception as e_vinc_ex:
        print(f"   ℹ️ Aviso ao ler planilha oficial de vínculos: {e_vinc_ex}")

    if not codigos_vinculos_ativos and not df_vinculos.empty and 'vinculo_ativo' in df_vinculos.columns:
        m_ativos = df_vinculos['vinculo_ativo'].astype(str).str.strip().str.lower().isin(['true', 'sim', 'ativo', '1'])
        codigos_vinculos_ativos = set(df_vinculos[m_ativos]['codigo_lr'].dropna().astype(str).str.strip().str.upper())

    # Regra Ajustada: Produtores inativados sem vínculo ativo em BD_BI_VINCULOS_COMPLETO.xlsx têm inativação mantida.
    # Suas visitas durante o período ATIVO (ex: LR02481 em junho/26 antes da inativação em agosto/26) são preservadas.
    # Apenas visitas efetuadas APÓS a data da inativação (data_visita > data_inativacao) são descartadas.
    dict_dt_inativacao = {}
    if not df_inativacoes.empty and 'codigo_lr' in df_inativacoes.columns:
        df_inat_temp = df_inativacoes.copy()
        df_inat_temp['codigo_lr_clean'] = df_inat_temp['codigo_lr'].dropna().astype(str).str.strip().str.upper()
        cols_dt = [c for c in ['data_inativacao', 'data_solicitacao'] if c in df_inat_temp.columns]
        if cols_dt:
            df_inat_temp['dt_inat'] = pd.to_datetime(df_inat_temp[cols_dt[0]], errors='coerce')
            if len(cols_dt) > 1:
                df_inat_temp['dt_inat'] = df_inat_temp['dt_inat'].fillna(pd.to_datetime(df_inat_temp[cols_dt[1]], errors='coerce'))
            dict_dt_inativacao = df_inat_temp.groupby('codigo_lr_clean')['dt_inat'].max().to_dict()

    codigos_inativados = set(dict_dt_inativacao.keys())
    codigos_inativos_sem_vinculo = codigos_inativados - codigos_vinculos_ativos

    if codigos_inativos_sem_vinculo:
        linhas_antes_inat = len(df_visitas)
        df_visitas['codigo_lr_clean_temp'] = df_visitas['codigo_lr'].astype(str).str.strip().str.upper()
        
        def deve_manter_visita(row):
            cd = row['codigo_lr_clean_temp']
            if cd in codigos_inativos_sem_vinculo:
                dt_inat = dict_dt_inativacao.get(cd)
                dt_vis = row['data_visita']
                if pd.notna(dt_inat) and pd.notna(dt_vis) and dt_vis > dt_inat:
                    return False
            return True

        df_visitas = df_visitas[df_visitas.apply(deve_manter_visita, axis=1)].copy()
        df_visitas.drop(columns=['codigo_lr_clean_temp'], inplace=True, errors='ignore')
        print(f"   -> Filtradas {linhas_antes_inat - len(df_visitas)} visitas efetuadas APÓS a inativação de produtores sem vínculo ativo.")

    df_vinculos_dedup = pd.DataFrame()
    if not df_vinculos.empty:
        if 'consultor_grupo_atendimento' in df_vinculos.columns and 'nome_consultor' not in df_vinculos.columns:
            df_vinculos['nome_consultor'] = df_vinculos['consultor_grupo_atendimento']

        if 'data_associacao' in df_vinculos.columns:
            df_vinculos['data_referencia'] = pd.to_datetime(df_vinculos['data_associacao'], errors='coerce')
        elif 'data_processamento' in df_vinculos.columns:
            df_vinculos['data_referencia'] = pd.to_datetime(df_vinculos['data_processamento'], errors='coerce')
        else:
            df_vinculos['data_referencia'] = pd.Timestamp.now()

        # Deduplicar vínculos por codigo_lr pegando o vínculo mais recente
        df_vinculos_dedup = df_vinculos.sort_values(by=['data_referencia'], ascending=False).drop_duplicates(subset=['codigo_lr'], keep='first').copy()

        if 'meses_ativos_vinculo' not in df_vinculos_dedup.columns:
            df_vinculos_dedup['meses_ativos_vinculo'] = 1
        else:
            df_vinculos_dedup['meses_ativos_vinculo'] = pd.to_numeric(df_vinculos_dedup['meses_ativos_vinculo'], errors='coerce').fillna(1).astype('Int64')

        if 'codigo_fazenda' not in df_vinculos_dedup.columns:
            df_vinculos_dedup['codigo_fazenda'] = None

    # 3. Preparação das bases para o Merge Não Destrutivo
    print("\n🔄 ETAPA 3: Cruzamento (LEFT JOIN) mantendo dados originais da visita + metadados de vínculo")
    
    # Manter em df_visitas todas as colunas essenciais nativas da visita
    cols_visita_merge = [
        'id_atendimento', 'data_visita', 'mes_referencia', 'codigo_lr', 'nome_consultor',
        'nome_produtor', 'nome_propriedade', 'mes_ano', 'valor_pago_produtor', 'valor_pago_agroindustria'
    ]
    if 'tipo_visita' in df_visitas.columns:
        cols_visita_merge.append('tipo_visita')
    if 'id_farm' in df_visitas.columns:
        cols_visita_merge.append('id_farm')

    cols_visita_merge = [c for c in cols_visita_merge if c in df_visitas.columns]
    df_visitas_merge = df_visitas[cols_visita_merge].copy()

    # Normalizar códigos LR para cruzamento perfeito
    df_visitas_merge['codigo_lr'] = df_visitas_merge['codigo_lr'].astype(str).str.strip().str.replace('\xa0', '').str.upper()

    if not df_vinculos_dedup.empty:
        cols_vinculos_disponiveis = [
            c for c in [
                'codigo_lr', 'nome_consultor', 'unidade_atendimento', 'nome_produtor',
                'nome_propriedade', 'projeto', 'codigo_agroindustria',
                'codigo_fazenda', 'cidade_produtor', 'estado_produtor', 'meses_ativos_vinculo'
            ] if c in df_vinculos_dedup.columns
        ]

        df_base_vinculos = df_vinculos_dedup[cols_vinculos_disponiveis].copy()
        if 'nome_consultor' in df_base_vinculos.columns:
            df_base_vinculos.rename(columns={'nome_consultor': 'consultor_vinculado'}, inplace=True)
        df_base_vinculos['codigo_lr'] = df_base_vinculos['codigo_lr'].astype(str).str.strip().str.replace('\xa0', '').str.upper()

        f_visitas = pd.merge(
            df_visitas_merge,
            df_base_vinculos,
            on='codigo_lr',
            how='left',
            suffixes=('', '_vinculo')
        )
    else:
        f_visitas = df_visitas_merge.copy()

    # 4. Tratamento de campos, nomes de produtor/propriedade e constraints NOT NULL
    print("\n🛠️ ETAPA 4: Aplicando regras de integridade e preenchimento de nomes")
    f_visitas['mes_referencia'] = f_visitas['data_visita'].dt.to_period('M').dt.to_timestamp()

    # Preencher nome_produtor priorizando o da visita e complementando pelo vínculo se necessário
    if 'nome_produtor_vinculo' in f_visitas.columns:
        f_visitas['nome_produtor'] = f_visitas['nome_produtor'].combine_first(f_visitas['nome_produtor_vinculo'])
    f_visitas['nome_produtor'] = f_visitas['nome_produtor'].fillna('NÃO INFORMADO').astype(str).str.strip()
    f_visitas.loc[f_visitas['nome_produtor'] == '', 'nome_produtor'] = 'NÃO INFORMADO'

    # Preencher nome_propriedade priorizando o da visita e complementando pelo vínculo se necessário
    if 'nome_propriedade_vinculo' in f_visitas.columns:
        f_visitas['nome_propriedade'] = f_visitas['nome_propriedade'].combine_first(f_visitas['nome_propriedade_vinculo'])

    # Preencher projeto priorizando o do vínculo se existir
    if 'projeto_vinculo' in f_visitas.columns:
        f_visitas['projeto'] = f_visitas.get('projeto', pd.Series()).combine_first(f_visitas['projeto_vinculo'])
    if 'projeto' in f_visitas.columns:
        f_visitas['projeto'] = f_visitas['projeto'].fillna('GERAL').astype(str).str.strip()
        f_visitas.loc[f_visitas['projeto'] == '', 'projeto'] = 'GERAL'
    else:
        f_visitas['projeto'] = 'GERAL'

    if 'codigo_fazenda' in f_visitas.columns and 'id_farm' not in f_visitas.columns:
        f_visitas.rename(columns={'codigo_fazenda': 'id_farm'}, inplace=True)
    elif 'codigo_fazenda' in f_visitas.columns and 'id_farm' in f_visitas.columns:
        f_visitas['id_farm'] = f_visitas['id_farm'].combine_first(f_visitas['codigo_fazenda'])

    # Filtros padrão de exclusão da Labor Rural
    if 'unidade_atendimento' in f_visitas.columns:
        f_visitas = f_visitas[f_visitas['unidade_atendimento'] != 'UNIDADE GENERICA'].copy()
    if 'nome_consultor' in f_visitas.columns:
        f_visitas = f_visitas[f_visitas['nome_consultor'] != 'TALITA FONTES'].copy()

    f_visitas['id_atendimento'] = pd.to_numeric(f_visitas['id_atendimento'], errors='coerce').astype('Int64')
    f_visitas['data_processamento'] = datetime.now()

    # Formatar strings ISO para datas
    f_visitas['data_visita_str'] = f_visitas['data_visita'].apply(
        lambda x: x.isoformat(timespec='milliseconds') + 'Z' if pd.notna(x) else None
    )
    f_visitas['mes_referencia_str'] = f_visitas['mes_referencia'].apply(
        lambda x: x.isoformat(timespec='milliseconds') + 'Z' if pd.notna(x) else None
    )
    f_visitas['data_processamento_str'] = f_visitas['data_processamento'].apply(
        lambda x: x.isoformat(timespec='milliseconds') + 'Z' if pd.notna(x) else None
    )

    # 5. Cálculo do Hash SHA-256 (id_composto)
    print("\n🔑 ETAPA 5: Gerando chave única de deduplicação (id_composto)")
    hash_cols = ['codigo_lr', 'nome_consultor', 'mes_referencia_str', 'id_atendimento']
    df_hash = f_visitas[hash_cols].copy()
    df_hash['id_atendimento'] = df_hash['id_atendimento'].astype(str).replace({'<NA>': 'NULL_VAL'})
    df_hash['mes_referencia_str'] = df_hash['mes_referencia_str'].astype(str).replace({'None': 'NULL_VAL'})
    df_hash['codigo_lr'] = df_hash['codigo_lr'].astype(str).replace({'None': 'NULL_VAL', 'nan': 'NULL_VAL'})
    df_hash['nome_consultor'] = df_hash['nome_consultor'].astype(str).replace({'None': 'NULL_VAL', 'nan': 'NULL_VAL'})

    hash_input = df_hash.agg(''.join, axis=1)
    f_visitas['id_composto'] = hash_input.apply(lambda x: hashlib.sha256(x.encode()).hexdigest())

    total_bruto = len(f_visitas)
    f_visitas.drop_duplicates(subset=['id_composto'], keep='first', inplace=True)
    print(f"   -> Registros consolidados: {len(f_visitas)} (removidas {total_bruto - len(f_visitas)} duplicatas por id_composto).")

    # 6. Preparação estrita de colunas e limpeza de NaNs
    print("\n📦 ETAPA 6: Preparando payload e sanitizando NaNs para Supabase")
    df_to_upsert = f_visitas.copy()
    df_to_upsert = df_to_upsert.drop(columns=['data_visita', 'mes_referencia', 'data_processamento'], errors='ignore')
    df_to_upsert.rename(columns={
        'data_visita_str': 'data_visita',
        'mes_referencia_str': 'mes_referencia',
        'data_processamento_str': 'data_processamento'
    }, inplace=True)

    # Filtrar estritamente colunas do schema
    cols_finais = [c for c in ALLOWED_COLS_FATO_VISITAS if c in df_to_upsert.columns]
    df_to_upsert = df_to_upsert[cols_finais]

    records = df_to_upsert.to_dict(orient='records')
    records_limpos = []
    for row in records:
        cleaned_row = {}
        for k, v in row.items():
            if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) or pd.isna(v):
                cleaned_row[k] = None
            elif k in ['meses_ativos_vinculo', 'id_atendimento']:
                try:
                    cleaned_row[k] = int(float(v))
                except (ValueError, TypeError):
                    cleaned_row[k] = None
            elif k in ['valor_pago_produtor', 'valor_pago_agroindustria']:
                try:
                    cleaned_row[k] = float(v)
                except (ValueError, TypeError):
                    cleaned_row[k] = None
            else:
                cleaned_row[k] = v
        records_limpos.append(cleaned_row)

    # 7. Gravação idempotente no Supabase (UPSERT por id_composto)
    print(f"\n💾 ETAPA 7: Gravação por UPSERT no Supabase ({tabela_fato})...")

    chunk_size = 1000
    total_lotes = (len(records_limpos) + chunk_size - 1) // chunk_size
    total_inserido = 0

    for i in range(0, len(records_limpos), chunk_size):
        chunk = records_limpos[i:i + chunk_size]
        lote_num = i // chunk_size + 1
        try:
            resp = supabase.table(tabela_fato).upsert(chunk, on_conflict='id_composto').execute()
            linhas_lote = len(resp.data) if resp.data else len(chunk)
            total_inserido += linhas_lote
            print(f"   ✅ Lote {lote_num}/{total_lotes}: {linhas_lote} registros gravados com sucesso.")
        except Exception as e:
            print(f"   ❌ ERRO FATAL no lote {lote_num}/{total_lotes}: {e}")
            raise e

    print("==================================================================")
    print(f"🎉 CARGA DA TABELA {tabela_fato} FINALIZADA COM SUCESSO!")
    print(f"📊 Total de registros gravados: {total_inserido}")
    print("==================================================================")

    return f_visitas

if __name__ == "__main__":
    executar_etl_fato_visitas()
