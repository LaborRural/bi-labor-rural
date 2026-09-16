import os
import re
import sys
import time
from datetime import datetime, date
from pathlib import Path
from typing import Any, Dict, List, Set
from zoneinfo import ZoneInfo
import numpy as np
import pandas as pd
import yaml

FUSO_SP = ZoneInfo("America/Sao_Paulo")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

caminho_atual = Path(__file__).resolve()
for candidato in [caminho_atual, *caminho_atual.parents]:
    if (candidato / "scripts").is_dir() and ((candidato / "db").is_dir() or (candidato / "dashboard").is_dir()):
        raiz_projeto = candidato
        break
    if (candidato / "SCRIPTS").is_dir() and ((candidato / "DB").is_dir() or (candidato / "DASHBOARD").is_dir()):
        raiz_projeto = candidato
        break
else:
    raiz_projeto = caminho_atual.parents[2]

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
    from functions.function import (
        carregar_config_referencia,
        carregar_env,
        obter_cliente_supabase,
        consultar_tabela_supabase,
    )
    from functions.metadata_tracker import obter_metadados_planilhas
except ImportError:
    from FUNCTIONS.function import (
        carregar_config_referencia,
        carregar_env,
        obter_cliente_supabase,
        consultar_tabela_supabase,
    )
    from FUNCTIONS.metadata_tracker import obter_metadados_planilhas


def extrair_consultor_individual(consultor_str: str, grupo_str: str = "") -> str:
    """Extrai o consultor individual responsável a partir do grupo ou do campo de consultor."""
    texto = grupo_str if (isinstance(grupo_str, str) and grupo_str.strip()) else consultor_str
    if not isinstance(texto, str) or not texto.strip():
        return "NÃO ATRIBUÍDO"
        
    texto_upper = texto.upper().strip()
    if "CELIO ROBERTO OLIVEIRA" in texto_upper or "SUELY DE JESUS OLIVEIRA" in texto_upper:
        return "LAC CONSULTORIA"
        
    limpo = re.sub(r"\(.*?\)", "", texto).strip()
    if limpo:
        partes = [p.strip().upper() for p in limpo.split("/") if p.strip()]
        if partes:
            return partes[0]
        return limpo.upper()
    return "NÃO ATRIBUÍDO"


def executar_reconciliacao(reindex_completo: bool = False):
    print("=================================================================")
    print("   INICIANDO RECONCILIAÇÃO DE VÍNCULOS, INATIVAÇÕES E ATIVOS     ")
    print("=================================================================")

    config = carregar_config_referencia(raiz_projeto)
    supabase = obter_cliente_supabase(raiz_projeto)
    
    cfg_file = raiz_projeto / "scripts" / "config" / "config.yaml"
    if not cfg_file.exists():
        cfg_file = raiz_projeto / "SCRIPTS" / "CONFIG" / "config.yaml"
    with open(cfg_file, "r", encoding="utf-8") as f:
        cfg_raw = yaml.safe_load(f)
        
    bd_path = Path(cfg_raw.get("caminhos", {}).get("bd_smartquestion", ""))
    
    # 1. Atualizar Metadados de Proveniência
    print("\n📦 1. Atualizando metadados de proveniência das planilhas...")
    metadados = obter_metadados_planilhas(raiz_projeto)
    print(f"   -> {metadados['total_arquivos']} arquivos rastreados com sucesso.")

    # 2. Consultar Status Atual dos Consultores (Desduplicando por ultimaAtualizacao)
    print("\n👤 2. Verificando status dos consultores (BD_STATUS_USUARIO_SQ.xlsx)...")
    arquivo_status_consultores = bd_path / "BD_STATUS_USUARIO_SQ.xlsx"
    consultores_inativos: Set[str] = set()
    
    if arquivo_status_consultores.exists():
        try:
            df_status_raw = pd.read_excel(arquivo_status_consultores, header=None)
            h_idx = 0
            for r in range(min(10, len(df_status_raw))):
                vals = [str(x).strip().lower() for x in df_status_raw.iloc[r].dropna().tolist()]
                if "nome" in vals and "ativo" in vals:
                    h_idx = r
                    break
            df_status = pd.read_excel(arquivo_status_consultores, header=h_idx)
            if "ultimaAtualizacao" in df_status.columns and "Nome" in df_status.columns:
                df_status_sorted = df_status.sort_values(
                    by="ultimaAtualizacao", ascending=False
                ).drop_duplicates(subset=["Nome"], keep="first")
                
                consultores_inativos = set(
                    df_status_sorted[df_status_sorted["Ativo"].astype(str).str.strip().str.lower().isin(["não", "nao", "false", "0"])]["Nome"]
                    .astype(str)
                    .str.strip()
                    .str.upper()
                )
                print(f"   -> {len(df_status_sorted)} consultores únicos avaliados.")
                print(f"   -> {len(consultores_inativos)} consultores inativos identificados.")
                
                # Checar Amanda Roriz
                amanda_status = df_status_sorted[
                    df_status_sorted["Nome"].str.contains("AMANDA RORIZ", case=False, na=False)
                ]
                if not amanda_status.empty:
                    print(f"   -> Amanda Roriz status confirmado: {amanda_status['Ativo'].values[0]} (Data: {amanda_status['ultimaAtualizacao'].values[0]})")
        except Exception as e:
            print(f"   ⚠️ Aviso ao ler BD_STATUS_USUARIO_SQ.xlsx: {e}")

    # 3. Processar Inativações Recentes para sq_raw_inativacoes_produtor
    print("\n🚫 3. Processando solicitações de inativação (sq_raw_inativacoes_produtor)...")
    
    # Verificar se há inativações recentes na pasta para sincronizar no Supabase
    try:
        arquivos_inat = list(bd_path.glob("*_LISTA_INATIVACAO.xlsx")) + list((bd_path / "BACKUPS").glob("*_LISTA_INATIVACAO.xlsx"))
        if arquivos_inat:
            for arq_inat in arquivos_inat:
                if arq_inat.exists():
                    df_raw_i = pd.read_excel(arq_inat, header=None)
                    h_i = 0
                    for r in range(min(5, len(df_raw_i))):
                        vals = [str(x).strip().lower() for x in df_raw_i.iloc[r].dropna().tolist()]
                        if any("atendimento" in v for v in vals):
                            h_i = r
                            break
                    df_i = pd.read_excel(arq_inat, header=h_i).dropna(how="all", axis=1).dropna(how="all", axis=0)
                    col_id_i = [c for c in df_i.columns if "atendimento" in str(c).lower()]
                    if col_id_i:
                        df_i["id_atendimento"] = pd.to_numeric(df_i[col_id_i[0]], errors="coerce")
                        df_i = df_i.dropna(subset=["id_atendimento"])
                        df_i["id_atendimento"] = df_i["id_atendimento"].astype(int)
                        
                        mapa_cols = {
                            "Consultor(a):": "nome_consultor",
                            "Projeto": "projeto",
                            "Código do(a) produtor(a):": "codigo_lr",
                            "Produtor(a):": "nome_produtor",
                            "Propriedade:": "nome_propriedade",
                            "Grupo Ponto Atendimento": "grupo_ponto_atendimento",
                            "Data da solicitação:": "data_solicitacao",
                            "Data da inativação:": "data_inativacao",
                            "Motivo da inativação:": "motivo_inativacao",
                            "Se outro, qual motivo?": "outro_motivo",
                            "Status": "produtor_ativo",
                        }
                        df_prep_i = df_i.rename(columns={k: v for k, v in mapa_cols.items() if k in df_i.columns})
                        df_prep_i["data_processamento"] = datetime.now(FUSO_SP).isoformat()
                        
                        # Converter datas
                        if "data_solicitacao" in df_prep_i.columns:
                            df_prep_i["data_solicitacao"] = pd.to_datetime(df_prep_i["data_solicitacao"], errors="coerce").dt.strftime("%Y-%m-%d %H:%M:%S")
                        if "data_inativacao" in df_prep_i.columns:
                            df_prep_i["data_inativacao"] = pd.to_datetime(df_prep_i["data_inativacao"], errors="coerce").dt.strftime("%Y-%m-%d")
                            
                        cols_finais = ["id_atendimento", "nome_consultor", "projeto", "codigo_lr", "nome_produtor", "nome_propriedade", "grupo_ponto_atendimento", "data_solicitacao", "data_inativacao", "motivo_inativacao", "outro_motivo", "produtor_ativo", "data_processamento"]
                        cols_presentes = [c for c in cols_finais if c in df_prep_i.columns]
                        registros_i = df_prep_i[cols_presentes].replace({np.nan: None}).to_dict(orient="records")
                        if registros_i:
                            supabase.table("sq_raw_inativacoes_produtor").upsert(registros_i, on_conflict="id_atendimento").execute()
    except Exception as e_inat:
        print(f"   ⚠️ Aviso ao sincronizar inativações recentes: {e_inat}")

    # Buscar inativações já consolidadas no Supabase com paginação transparente (P-09)
    df_inats_existentes = consultar_tabela_supabase("sq_raw_inativacoes_produtor", "*", raiz=raiz_projeto)
    print(f"   -> Total de inativações existentes no banco: {len(df_inats_existentes)}")

    # 4. Construir Movimentações Consolidadas (sq_fato_movimentacao)
    print("\n🔄 4. Consolidando tabela fato de movimentação (sq_fato_movimentacao)...")
    
    PROJETOS_OFICIAIS = ['ALVOAR ASSIST', 'ALVOAR ECO', 'ATEG_CCPR', 'LPA', 'REGENERA', 'SEMEAR']

    movimentacoes_lista = []

    # 4.1 Entradas Pré-2026 (a partir de sq_raw_vinculos com paginação transparente P-09)
    cols_vinc = "codigo_lr, consultor_grupo_atendimento, grupo_atendimento, data_associacao, projeto, nome_produtor, nome_propriedade, vinculo_ativo, unidade_atendimento, cidade_produtor, estado_produtor, codigo_agroindustria, codigo_fazenda"
    df_vinc_db = consultar_tabela_supabase("sq_raw_vinculos", cols_vinc, filtros_in={"projeto": PROJETOS_OFICIAIS}, raiz=raiz_projeto)
    
    if not df_vinc_db.empty:
        for _, row in df_vinc_db.iterrows():
            cod = str(row.get("codigo_lr") or "").strip()
            if not cod or cod.lower() == "nan":
                continue
            cons = extrair_consultor_individual(row.get("consultor_grupo_atendimento"), row.get("grupo_atendimento"))
            proj = str(row.get("projeto") or "").strip().upper()
            if proj not in PROJETOS_OFICIAIS:
                continue
            if "MATEUS CARNIELLI" in cons and proj and "ALVOAR ECO" in proj:
                continue
            dt_assoc = row.get("data_associacao")
            if dt_assoc:
                try:
                    dt_mov = pd.to_datetime(dt_assoc).strftime("%Y-%m-01")
                except Exception:
                    dt_mov = "2024-01-01"
            else:
                dt_mov = "2024-01-01"
                
            # Somente incluir se for ANTES de 2026 (2026 em diante vem da lista de cadastro oficial)
            if dt_mov < "2026-01-01":
                nome_prod_vinc = str(row.get("nome_produtor") or "").strip()
                id_comp = f"{cod}_{cons}_{dt_mov}_Entrada"
                movimentacoes_lista.append({
                    "id_composto": id_comp,
                    "codigo_lr": cod,
                    "nome_consultor": cons,
                    "nome_produtor": nome_prod_vinc if (nome_prod_vinc and nome_prod_vinc.lower() != "nan") else None,
                    "numero_atendimento": None,
                    "data_movimentacao": dt_mov,
                    "movimentacao": "Entrada",
                    "motivo_inativacao": None,
                    "outro_motivo": None,
                    "data_processamento": datetime.now(FUSO_SP).isoformat(),
                })

    # Mapeamento dimensional para validação da cadeia produtiva com paginação transparente (P-09)
    df_all_vinc = consultar_tabela_supabase("sq_raw_vinculos", "codigo_lr, projeto, tipo_ponto_atendimento, nome_produtor", raiz=raiz_projeto)
    mapa_lr_tipo: Dict[str, str] = {}
    mapa_lr_proj: Dict[str, str] = {}
    mapa_lr_nome: Dict[str, str] = {}
    for _, v in df_all_vinc.iterrows():
        c_lr = str(v.get("codigo_lr") or "").strip()
        if c_lr:
            mapa_lr_tipo[c_lr] = str(v.get("tipo_ponto_atendimento") or "").strip().upper()
            mapa_lr_proj[c_lr] = str(v.get("projeto") or "").strip().upper()
            mapa_lr_nome[c_lr] = str(v.get("nome_produtor") or "").strip()

    def eh_cadeia_leite(projeto_str: str, codigo_lr: str = "") -> bool:
        proj_upper = (projeto_str or "").strip().upper()
        # 1. Se o projeto contém termos de outras cadeias (Cacau, Grãos, Café)
        for p_out in ['MAIS GRÃOS', 'MAIS GRAOS', 'MIMC', 'M&E', 'CAFE&GESTAO', 'CAFE & GESTAO', 'CARGILL', 'NCP', 'OFI', 'PV CARGILL']:
            if p_out in proj_upper:
                return False
        # 2. Se o projeto é reconhecido de Leite
        for p_lei in ['REGENERA', 'ALVOAR', 'SEMEAR', 'CCPR', 'ATEG_CCPR', 'LPA', 'CFT', 'CAMPILEITE', 'COPRIL', 'EDUCAMPO', 'QUILLAYES', 'NESTLE']:
            if p_lei in proj_upper:
                return True
        # 3. Cruzamento com código LR em sq_raw_vinculos
        if codigo_lr in mapa_lr_tipo:
            t = mapa_lr_tipo[codigo_lr]
            if "CACAU" in t or "CAFE" in t or "GRAOS" in t:
                return False
            if "LEITE" in t:
                return True
        if codigo_lr in mapa_lr_proj:
            p = mapa_lr_proj[codigo_lr]
            if any(p_out in p for p_out in ['MIMC', 'M&E', 'GRAOS', 'CAFE', 'CARGILL', 'NCP', 'OFI']):
                return False
            if any(p_lei in p for p_lei in ['REGENERA', 'ALVOAR', 'SEMEAR', 'CCPR', 'LPA', 'CFT', 'CAMPILEITE', 'COPRIL', 'EDUCAMPO', 'QUILLAYES', 'NESTLE']):
                return True
        return False

    # 4.2 Entradas de 2026 em diante (a partir de *_LISTA_CADASTRO.xlsx - Filtrado apenas LEITE)
    arquivos_cad = list(bd_path.glob("*_LISTA_CADASTRO.xlsx")) + list((bd_path / "BACKUPS").glob("*_LISTA_CADASTRO.xlsx"))
    if arquivos_cad:
        for arq_cad in arquivos_cad:
            if not arq_cad.exists():
                continue
            try:
                df_raw_c = pd.read_excel(arq_cad, header=None)
                h_c = 0
                for r in range(min(5, len(df_raw_c))):
                    vals = [str(x).strip().lower() for x in df_raw_c.iloc[r].dropna().tolist()]
                    if any("atendimento" in v for v in vals):
                        h_c = r
                        break
                df_c = pd.read_excel(arq_cad, header=h_c).dropna(how="all", axis=1).dropna(how="all", axis=0)
                col_id_c = [c for c in df_c.columns if "atendimento" in str(c).lower()][0]
                col_cons_c = [c for c in df_c.columns if "consultor" in str(c).lower()][0]
                col_dt_c = [c for c in df_c.columns if "solicita" in str(c).lower()][0]
                col_cod_c = [c for c in df_c.columns if "código" in str(c).lower() or "codigo" in str(c).lower()][0]
                col_tipo_c = [c for c in df_c.columns if "tipo de cadastro" in str(c).lower()]
                col_cadeia_c = [c for c in df_c.columns if "cadeia" in str(c).lower()]
                col_proj_c = [c for c in df_c.columns if "projeto" in str(c).lower()]
                col_prod_c = [c for c in df_c.columns if ("produtor" in str(c).lower() and "novo" not in str(c).lower() and "código" not in str(c).lower() and "consultor" not in str(c).lower())]
                col_novo_prod_c = [c for c in df_c.columns if "novo(a) produtor(a)" in str(c).lower() and "nome" in str(c).lower()]
                
                for _, row in df_c.iterrows():
                    id_atend = str(row[col_id_c]).strip().replace(".0", "")
                    if not id_atend or id_atend.lower() == "nan":
                        continue
                    dt_solic = pd.to_datetime(row[col_dt_c], errors="coerce")
                    if pd.isna(dt_solic):
                        continue
                    dt_mov = dt_solic.strftime("%Y-%m-01")
                    if dt_mov < "2026-01-01":
                        continue
                    
                    # Filtro exclusivo de LEITE
                    if col_cadeia_c:
                        cadeia_val = str(row.get(col_cadeia_c[0]) or "").strip().lower()
                        if cadeia_val and not ("leite" in cadeia_val):
                            continue
                    elif col_proj_c:
                        if not eh_cadeia_leite(str(row.get(col_proj_c[0]) or ""), str(row.get(col_cod_c) or "")):
                            continue

                    cod_raw = str(row.get(col_cod_c) or "").strip().replace(".0", "")
                    cod = cod_raw if (cod_raw and cod_raw.lower() != "nan") else f"CAD_{id_atend}"
                    cons = extrair_consultor_individual(str(row[col_cons_c]))
                    tipo_cad = str(row[col_tipo_c[0]]) if col_tipo_c and pd.notna(row.get(col_tipo_c[0])) else "Inclusão de propriedade"
                    
                    # Nome do produtor direto do Excel (ou titular novo em caso de troca)
                    nome_prod_cad = ""
                    if col_novo_prod_c and pd.notna(row.get(col_novo_prod_c[0])) and str(row.get(col_novo_prod_c[0])).strip():
                        nome_prod_cad = str(row.get(col_novo_prod_c[0])).strip()
                    elif col_prod_c and pd.notna(row.get(col_prod_c[0])):
                        nome_prod_cad = str(row.get(col_prod_c[0])).strip()
                    if not nome_prod_cad and cod in mapa_lr_nome:
                        nome_prod_cad = mapa_lr_nome[cod]

                    id_atend_num = int(id_atend) if str(id_atend).isdigit() else id_atend
                    id_comp = f"CAD_{id_atend}_{dt_mov}_Entrada"
                    movimentacoes_lista.append({
                        "id_composto": id_comp,
                        "codigo_lr": cod,
                        "nome_consultor": cons,
                        "nome_produtor": nome_prod_cad if (nome_prod_cad and nome_prod_cad.lower() != "nan") else None,
                        "numero_atendimento": id_atend_num,
                        "data_movimentacao": dt_mov,
                        "movimentacao": "Entrada",
                        "motivo_inativacao": None,
                        "outro_motivo": tipo_cad,
                        "data_processamento": datetime.now(FUSO_SP).isoformat(),
                    })
            except Exception as e_cad:
                print(f"   ⚠️ Aviso ao processar {arq_cad.name}: {e_cad}")

    # 4.3 Saídas (Histórico Pré-2026 preservado + 2026 em diante por Data da Solicitação - Filtrado LEITE)
    codigos_oficiais_set = set(df_vinc_db["codigo_lr"].dropna().unique()) if not df_vinc_db.empty else set()
    
    if not df_inats_existentes.empty:
        for _, row in df_inats_existentes.iterrows():
            id_atend = str(row.get("id_atendimento") or "").strip().replace(".0", "")
            cod_raw = str(row.get("codigo_lr") or "").strip()
            cod = cod_raw if (cod_raw and cod_raw.lower() != "nan") else f"INAT_{id_atend}"
            cons = extrair_consultor_individual(row.get("nome_consultor"), row.get("grupo_ponto_atendimento"))
            proj_inat = str(row.get("projeto") or "").strip()
            nome_prod_inat = str(row.get("nome_produtor") or "").strip()
            if not nome_prod_inat and cod in mapa_lr_nome:
                nome_prod_inat = mapa_lr_nome[cod]
            
            dt_solic = row.get("data_solicitacao")
            dt_inat = row.get("data_inativacao")
            
            # Priorizar a Data da Inativação (quando o produtor efetivamente saiu) sobre a Data da Solicitação
            dt_inat_p = pd.to_datetime(dt_inat, errors="coerce")
            dt_solic_p = pd.to_datetime(dt_solic, errors="coerce")
            dt_efetiva = dt_inat_p if pd.notna(dt_inat_p) else dt_solic_p

            if pd.notna(dt_efetiva):
                if dt_efetiva >= pd.Timestamp("2026-01-01"):
                    if not eh_cadeia_leite(proj_inat, cod_raw):
                        continue
                dt_mov = dt_efetiva.strftime("%Y-%m-01")
                id_comp = f"INAT_{id_atend}_{dt_mov}_Saída" if id_atend else f"{cod}_{cons}_{dt_mov}_Saída"
            else:
                dt_mov = config.mes_referencia.strftime("%Y-%m-01")
                id_comp = f"{cod}_{cons}_{dt_mov}_Saída"
                
            motivo = row.get("motivo_inativacao")
            outro = row.get("outro_motivo")
            id_atend_num = int(id_atend) if str(id_atend).isdigit() else (id_atend if id_atend else None)
            
            movimentacoes_lista.append({
                "id_composto": id_comp,
                "codigo_lr": cod,
                "nome_consultor": cons,
                "nome_produtor": nome_prod_inat if (nome_prod_inat and nome_prod_inat.lower() != "nan") else None,
                "numero_atendimento": id_atend_num,
                "data_movimentacao": dt_mov,
                "movimentacao": "Saída",
                "motivo_inativacao": motivo,
                "outro_motivo": outro,
                "data_processamento": datetime.now(FUSO_SP).isoformat(),
            })
            
    df_mov_final = pd.DataFrame(movimentacoes_lista).drop_duplicates(subset=["id_composto"], keep="last")
    print(f"   -> Total de movimentações consolidadas: {len(df_mov_final)} (Entradas: {len(df_mov_final[df_mov_final['movimentacao'] == 'Entrada'])}, Saídas: {len(df_mov_final[df_mov_final['movimentacao'] == 'Saída'])})")
    
    # 4.4 Limpar rigorosamente registros de 2026 em diante no Supabase antes de reinserir
    try:
        res_2026_db = supabase.table("sq_fato_movimentacao").select("id_composto").gte("data_movimentacao", "2026-01-01").execute()
        ids_2026_db = [r["id_composto"] for r in (res_2026_db.data or [])]
        if ids_2026_db:
            print(f"   🧹 Limpando {len(ids_2026_db)} registros antigos de 2026 em diante no Supabase...")
            LOTE_DEL = 100
            for d_idx in range(0, len(ids_2026_db), LOTE_DEL):
                lote_ids = ids_2026_db[d_idx : d_idx + LOTE_DEL]
                supabase.table("sq_fato_movimentacao").delete().in_("id_composto", lote_ids).execute()
    except Exception as e_clean:
        print(f"   ⚠️ Aviso ao limpar registros de 2026: {e_clean}")

    # Upsert em lotes em sq_fato_movimentacao
    print("\n💾 5. Gravando movimentações consolidadas em sq_fato_movimentacao no Supabase...")
    registros_mov = df_mov_final.replace({np.nan: None}).to_dict(orient="records")
    LOTE = 500
    sucesso_mov = 0
    for i in range(0, len(registros_mov), LOTE):
        lote = registros_mov[i : i + LOTE]
        try:
            supabase.table("sq_fato_movimentacao").upsert(lote, on_conflict="id_composto").execute()
            sucesso_mov += len(lote)
        except Exception as e:
            print(f"   ❌ Erro ao enviar lote {i // LOTE + 1}: {e}")
        time.sleep(0.2)
    print(f"   ✅ {sucesso_mov} registros de movimentação atualizados no Supabase.")

    # 6. Reconciliar Tabelas de Fazendas:
    #    6.1 sq_raw_fazendas (e sq_raw_fazendas_grupo se existir): Espelho COMPLETO da LISTA_GERAL (todas as cadeias, ativos e inativos)
    #    6.2 sq_raw_fazendas_grupo_ativas (se existir): Espelho das ATIVAS (todas as cadeias, apenas status=Ativo)
    #    6.3 sq_fato_fazendas_ativas: Fato Analítica de LEITE com histórico mensal desde 2026-01-01 reconstruído

    tabela_raw = cfg_raw.get("supabase", {}).get("tabelas", {}).get("fazendas_raw", "sq_raw_fazendas")
    tabela_grupo_raw = cfg_raw.get("supabase", {}).get("tabelas", {}).get("fazendas_grupo_raw", "sq_raw_fazendas_grupo")
    tabela_grupo_ativas_raw = cfg_raw.get("supabase", {}).get("tabelas", {}).get("fazendas_grupo_ativas_raw", "sq_raw_fazendas_grupo_ativas")
    tabela_ativos = cfg_raw.get("supabase", {}).get("tabelas", {}).get("fazendas_ativas_dim", cfg_raw.get("supabase", {}).get("tabelas", {}).get("fazendas_ativas_fato", "sq_dim_fazendas_ativas"))

    print(f"\n🌱 6. Processando espelhos e base ativa mensal de fazendas...")

    # Identificar todas as inativações com data e código
    inativacoes_por_codigo: Dict[str, str] = {}
    if not df_inats_existentes.empty:
        for _, row in df_inats_existentes.iterrows():
            c = str(row.get("codigo_lr") or "").strip()
            dt_solic = row.get("data_solicitacao")
            dt_inat = row.get("data_inativacao")

            dt_inat_p = pd.to_datetime(dt_inat, errors="coerce")
            dt_solic_p = pd.to_datetime(dt_solic, errors="coerce")
            dt_efetiva = dt_inat_p if pd.notna(dt_inat_p) else dt_solic_p
            dt_str = dt_efetiva.strftime("%Y-%m-01") if pd.notna(dt_efetiva) else None

            if c and dt_str:
                if c not in inativacoes_por_codigo or dt_str < inativacoes_por_codigo[c]:
                    inativacoes_por_codigo[c] = dt_str

    print(f"   -> Mapeados {len(inativacoes_por_codigo)} produtores com inativação confirmada.")

    # Identificar cadastros novos de 2026
    cadastros_por_codigo: Dict[str, str] = {}
    if not df_mov_final.empty:
        df_ents_2026 = df_mov_final[
            (df_mov_final["movimentacao"] == "Entrada") & 
            (pd.to_datetime(df_mov_final["data_movimentacao"], errors="coerce") >= pd.Timestamp("2026-01-01"))
        ]
        for _, row in df_ents_2026.iterrows():
            c = str(row.get("codigo_lr") or "").strip()
            dt_ent = pd.to_datetime(row.get("data_movimentacao"), errors="coerce")
            if c and pd.notna(dt_ent):
                dt_str = dt_ent.strftime("%Y-%m-01")
                if c not in cadastros_por_codigo or dt_str < cadastros_por_codigo[c]:
                    cadastros_por_codigo[c] = dt_str

    print(f"   -> Mapeados {len(cadastros_por_codigo)} produtores com novo cadastro em 2026.")

    UF_MAP = {
        'MINAS GERAIS': 'MG', 'BAHIA': 'BA', 'GOIAS': 'GO', 'GOIÁS': 'GO',
        'SAO PAULO': 'SP', 'SÃO PAULO': 'SP', 'ESPIRITO SANTO': 'ES', 'ESPÍRITO SANTO': 'ES',
        'MATO GROSSO': 'MT', 'MATO GROSSO DO SUL': 'MS', 'PARANA': 'PR', 'PARANÁ': 'PR',
        'RIO DE JANEIRO': 'RJ', 'RONDÔNIA': 'RO', 'RONDONIA': 'RO', 'TOCANTINS': 'TO'
    }

    def limpar_uf(val):
        if not val or pd.isna(val):
            return None
        s = str(val).strip().upper()
        if len(s) == 2:
            return s
        return UF_MAP.get(s, s[:2] if len(s) >= 2 else None)

    # Leitura e parsing da LISTA_GERAL_RELATORIO_DE_GRUPO.xlsx
    arquivo_grupo = bd_path / "LISTA_GERAL_RELATORIO_DE_GRUPO.xlsx"
    if not arquivo_grupo.exists():
        print(f"   ❌ Arquivo não encontrado: {arquivo_grupo}")
        return

    print(f"   📖 Lendo base de status de grupos: {arquivo_grupo.name}...")
    df_g_raw = pd.read_excel(arquivo_grupo)

    status_cols = [c for c in df_g_raw.columns if 'status' in str(c).lower() and (df_g_raw[c].dtype == bool or str(c).strip() == 'Status ')]
    status_col_name = status_cols[0] if status_cols else 'Status '

    tipo_cols = [c for c in df_g_raw.columns if 'tipo ponto' in str(c).lower()]
    tipo_col_name = tipo_cols[0] if tipo_cols else 'Tipo ponto atendimento'

    cod_cols = [c for c in df_g_raw.columns if 'código' in str(c).lower() or 'codigo' in str(c).lower()]
    cod_col_name = cod_cols[0] if cod_cols else 'Código'

    nome_cols = [c for c in df_g_raw.columns if str(c).strip() == 'Nome']
    nome_col_name = nome_cols[0] if nome_cols else 'Nome'

    prop_cols = [c for c in df_g_raw.columns if 'propriedade' in str(c).lower()]
    prop_col_name = prop_cols[0] if prop_cols else 'Nome da propriedade'

    cid_cols = [c for c in df_g_raw.columns if 'cidade' in str(c).lower()]
    cid_col_name = cid_cols[0] if cid_cols else 'Cidade'

    uf_cols = [c for c in df_g_raw.columns if 'estado' in str(c).lower()]
    uf_col_name = uf_cols[0] if uf_cols else 'Estado'

    unid_cols = [c for c in df_g_raw.columns if 'unidade atendimento' in str(c).lower()]
    unid_col_name = unid_cols[0] if unid_cols else 'Unidade atendimento'

    grupo_cols = [c for c in df_g_raw.columns if 'grupo ponto' in str(c).lower()]
    grupo_col_name = grupo_cols[0] if grupo_cols else 'Grupo ponto atendimento'

    agro_cols = [c for c in df_g_raw.columns if 'agroindústria' in str(c).lower() or 'agroindustria' in str(c).lower()]
    agro_col_name = agro_cols[0] if agro_cols else 'Código Agroindústria - Campo personalizado'

    faz_cols = [c for c in df_g_raw.columns if 'fazenda - campo' in str(c).lower()]
    faz_col_name = faz_cols[0] if faz_cols else 'Código Fazenda - Campo personalizado'

    cfg_ref = carregar_config_referencia(raiz_projeto)
    mes_ref_dt = cfg_ref.mes_referencia
    mes_ref_str = mes_ref_dt.strftime("%Y-%m-01")
    proximo_mes_str = (mes_ref_dt + pd.DateOffset(months=1)).strftime("%Y-%m-01")

    # Montar DataFrame padronizado completo
    lista_todos = []
    agora_iso = datetime.now(FUSO_SP).isoformat()

    def extrair_projeto_especifico(texto):
        if not texto or str(texto).strip().lower() in ["nan", "none", "não atribuído", "nao atribuido"]:
            return None
        matches = re.findall(r'\((.*?)\)', str(texto))
        if not matches:
            return None
        projs = []
        for m in matches:
            p = m.strip().upper()
            # Se contiver 'CFT', desconsidera (é modalidade operacional, não projeto)
            if "CFT" in p:
                continue
            if p and p not in projs:
                projs.append(p)
        if not projs:
            return None
        projs.sort()
        return " / ".join(projs)

    def extrair_nome_grupo_limpo(texto):
        if not texto or str(texto).strip().lower() in ["nan", "none", "não atribuído", "nao atribuido"]:
            return None
        partes = [p.strip() for p in str(texto).split("/") if p.strip()]
        partes_sem_cft = [p for p in partes if "CFT" not in p.upper()]
        if not partes_sem_cft:
            return None
        # Remove qualquer conteúdo entre parênteses e espaços extras para ficar apenas o nome limpo sem parênteses
        partes_limpas = [re.sub(r'\s*\(.*?\)', '', p).strip() for p in partes_sem_cft]
        partes_limpas = [p for p in partes_limpas if p]
        if not partes_limpas:
            return None
        return " / ".join(partes_limpas)

    # Mapeamento oficial de Projeto -> Agroindústria e mapa de regiões
    MAP_PROJETO_AGRO = {
        "REGENERA": "Nestlé",
        "ALVOAR ECO": "Alvoar",
        "ALVOAR ASSIST": "Alvoar",
        "ALVOAR ECO / MAIS GRAOS": "Alvoar",
        "COPRIL": "Copril",
        "SEMEAR": "Danone",
        "CAMPILEITE": "CAMPILEITE",
        "ATEG_CCPR": "CCPR",
        "LPA": "Laticínios Porto Alegre"
    }

    regiao_map = {}
    try:
        res_reg = supabase.table("sq_dim_fazendas_ativas").select("codigo_produtor, regiao").not_.is_("regiao", "null").limit(5000).execute()
        for r_reg in (res_reg.data or []):
            c_lr = str(r_reg.get("codigo_produtor") or "").strip().upper()
            reg_val = r_reg.get("regiao")
            if c_lr and reg_val and str(reg_val).strip().lower() not in ["none", "nan", "teste"]:
                regiao_map[c_lr] = str(reg_val).strip()
    except Exception:
        pass

    # Carregar sq_dim_regiao do Supabase para ter o de-para sempre atualizado dinamicamente
    dim_regiao_cache = {}
    try:
        res_dim = supabase.table("sq_dim_regiao").select("nome_regiao, nome_regiao_formatada, agroindustria").eq("status", "Ativo").execute()
        for r_dim in (res_dim.data or []):
            raw_n = str(r_dim.get("nome_regiao") or "").strip().upper()
            fmt_n = str(r_dim.get("nome_regiao_formatada") or "").strip()
            agro_n = str(r_dim.get("agroindustria") or "").strip().upper()
            if raw_n and fmt_n:
                if agro_n:
                    dim_regiao_cache[f"{agro_n}|{raw_n}"] = fmt_n
                if raw_n not in dim_regiao_cache:
                    dim_regiao_cache[raw_n] = fmt_n
    except Exception:
        pass

    UF_TO_NOME = {
        "BA": "Bahia",
        "CE": "Ceará",
        "AL": "Alagoas",
        "SE": "Sergipe",
        "PE": "Pernambuco",
        "MT": "Campinápolis",
        "GO": "Goiânia",
        "SP": "Araçatuba",
        "MG": "Minas Gerais"
    }

    def formatar_regiao(agro, reg_raw, estado_val):
        target = reg_raw
        if not target or str(target).strip().lower() in ["none", "nan", "teste", "labor rural", "unidade generica"]:
            target = estado_val
        if not target or str(target).strip().lower() in ["none", "nan", "teste", "labor rural", "unidade generica"]:
            return "NÃO INFORMADA"

        t_str = str(target).strip()
        t_upper = t_str.upper()
        agro_upper = str(agro or "").strip().upper()

        # 1. Consulta ao cache dinâmico da sq_dim_regiao
        if agro_upper and f"{agro_upper}|{t_upper}" in dim_regiao_cache:
            return dim_regiao_cache[f"{agro_upper}|{t_upper}"]
        if t_upper in dim_regiao_cache:
            return dim_regiao_cache[t_upper]

        # 2. Regras específicas por agroindústria
        if agro == "Nestlé":
            if t_str in ["Patos de Minas - 9188", "Ibiá - 1215", "9188", "1215", "MG"]:
                return "Patos de Minas e Ibiá"
            if "9655" in t_str or "Goiânia" in t_str or "Goiania" in t_str or t_upper == "GO":
                return "Goiânia"
            if "1217" in t_str or "Ituiutaba" in t_str or "TRIANGULO" in t_upper:
                return "Ituiutaba"
            if "9264" in t_str or "Montes Claros" in t_str:
                return "Montes Claros"
            if "0460" in t_str or "Araçatuba" in t_str or t_upper == "SP":
                return "Araçatuba"
        elif agro == "CAMPILEITE":
            if t_upper in ["MT", "CAMPINAPOLIS", "CAMPINÁPOLIS"]:
                return "Campinápolis"
        elif agro == "Copril":
            if t_upper in ["MG", "ITAMBACURI"]:
                return "Itambacuri"
        elif agro == "Danone":
            if t_upper in ["MG", "MINAS GERAIS", "SUL DE MINAS"]:
                return "Sul de Minas"
        elif agro in ["LPA", "Laticínios Porto Alegre"]:
            if t_upper in ["MG", "PONTE NOVA"]:
                return "Ponte Nova"
        elif agro == "CCPR":
            if t_upper in ["GO", "DF", "GOIANIA", "GOIÂNIA"]:
                return "Goiânia"

        # 3. Fallback de UFs e siglas
        if t_upper in UF_TO_NOME:
            return UF_TO_NOME[t_upper]

        return t_str

    for _, r in df_g_raw.iterrows():
        c = str(r.get(cod_col_name) or "").strip()
        if not c or c.lower() == "nan":
            continue

        nome_p_raw = str(r.get(nome_col_name) or "PRODUTOR").strip()
        tem_inativo_flag = ("_INATIVO" in c.upper()) or ("(INATIVO)" in nome_p_raw.upper()) or ("_INATIVO" in nome_p_raw.upper())

        st_val = r.get(status_col_name)
        is_ativo = (st_val == True) or (str(st_val).strip().lower() in ["ativo", "true", "sim", "1"])
        if tem_inativo_flag:
            is_ativo = False

        status_str = "Ativo" if is_ativo else "Inativo"

        tipo_str = str(r.get(tipo_col_name) or "LEITE").strip().upper()
        if not tipo_str or tipo_str.lower() == "nan":
            tipo_str = "LEITE"

        g_raw = r.get(grupo_col_name) if grupo_col_name in r else None
        cons_extraido = None
        proj_extraido = None
        if pd.notna(g_raw) and str(g_raw).strip() and str(g_raw).strip().lower() != "nan":
            g_str = str(g_raw).strip()
            m_proj = re.search(r'\((.*?)\)', g_str)
            proj_extraido = m_proj.group(1).strip().upper() if m_proj else None
            cons_extraido = re.sub(r'\(.*?\)', '', g_str).strip()

        nome_c = cons_extraido or "NÃO ATRIBUÍDO"
        unid = str(r.get(unid_col_name) or "LABOR RURAL").strip()[:100]
        cid = str(r.get(cid_col_name) or "").strip()[:100] or None
        uf = limpar_uf(r.get(uf_col_name))
        
        cod_agro = str(r.get(agro_col_name) or "").strip()[:50] or None
        if cod_agro and cod_agro.lower() == "nan":
            cod_agro = None
        cod_faz = str(r.get(faz_col_name) or "").strip()[:50] or None
        if cod_faz and cod_faz.lower() == "nan":
            cod_faz = None

        grupo_final = str(g_raw).strip()[:250] if (pd.notna(g_raw) and str(g_raw).strip() and str(g_raw).strip().lower() != "nan") else str(nome_c).strip()[:250]
        proj_final = extrair_projeto_especifico(grupo_final)
        nome_grupo_limpo = extrair_nome_grupo_limpo(grupo_final)
        agro_calc = MAP_PROJETO_AGRO.get(proj_final)
        reg_calc = formatar_regiao(agro_calc, regiao_map.get(c.upper()), uf)

        id_raw = f"{c[:50]}_{mes_ref_str.replace('-', '_')}"
        lista_todos.append({
            "id": id_raw,
            "codigo_produtor": c[:50],
            "nome_produtor": nome_p_raw[:250],
            "nome_propriedade": str(r.get(prop_col_name) or "FAZENDA").strip()[:250],
            "estado": uf or "NÃO INFORMADO",
            "cidade": cid or "NÃO INFORMADA",
            "tipo_ponto_atendimento": tipo_str,
            "unidade_atendimento": unid,
            "grupo_ponto_atendimento": grupo_final,
            "nome_grupo_ponto_atendimento": nome_grupo_limpo,
            "projeto": proj_final,
            "agroindustria": agro_calc,
            "regiao": reg_calc,
            "codigo_agroindustria": cod_agro,
            "codigo_fazenda": cod_faz,
            "status": status_str,
            "mes_referencia": mes_ref_str,
            "data_processamento": agora_iso
        })

    df_todos = pd.DataFrame(lista_todos).drop_duplicates(subset=["id"])
    df_ativas_todas = df_todos[df_todos["status"] == "Ativo"].copy()
    df_leite_todos = df_todos[df_todos["tipo_ponto_atendimento"].str.contains("LEITE", na=False)].copy()

    # Mapeamento de grupos completos da LISTA_GERAL (para garantir co-consultores em sq_dim_fazendas_ativas)
    mapa_grupos_lista_geral = {}
    for item_g in lista_todos:
        c_prod = str(item_g.get("codigo_produtor") or "").strip().upper()
        grp_comp = item_g.get("grupo_ponto_atendimento")
        grp_limp = item_g.get("nome_grupo_ponto_atendimento")
        if c_prod and grp_comp:
            mapa_grupos_lista_geral[c_prod] = (grp_comp, grp_limp)

    print(f"   -> {len(df_todos)} fazendas consolidadas no espelho completo ({len(mapa_grupos_lista_geral)} mapeadas com grupo).")
    
    # ─── 6.1 Enviar Espelho Completo para sq_raw_fazendas_grupo ────────────
    print(f"\n📤 6.1 Gravando espelho completo da LISTA_GERAL em {tabela_raw}...")
    
    tabela_destino_raw = tabela_raw
    try:
        supabase.table(tabela_destino_raw).select("id").limit(1).execute()
    except Exception:
        if tabela_destino_raw != "sq_raw_fazendas":
            print(f"   ℹ️ {tabela_destino_raw} não disponível no schema cache. Usando sq_raw_fazendas...")
            tabela_destino_raw = "sq_raw_fazendas"

    try:
        # Expurgar snapshot do mês de referência atual para atualizar com dados mais recentes
        supabase.table(tabela_destino_raw).delete().eq("mes_referencia", mes_ref_str).execute()
    except Exception as e_del_raw:
        print(f"   ℹ️ Aviso ao expurgar mês atual de {tabela_destino_raw}: {e_del_raw}")

    recs_todos = df_todos.to_dict(orient="records")
    LOTE = 500
    sucesso_raw = 0
    erros_raw = 0

    for i in range(0, len(recs_todos), LOTE):
        lote = recs_todos[i : i + LOTE]
        try:
            supabase.table(tabela_destino_raw).upsert(lote, on_conflict="id").execute()
            sucesso_raw += len(lote)
        except Exception as e_raw:
            try:
                supabase.table(tabela_destino_raw).upsert(lote).execute()
                sucesso_raw += len(lote)
            except Exception as e_raw2:
                erros_raw += len(lote)
                print(f"     ❌ Erro ao enviar lote {i // LOTE + 1} para {tabela_destino_raw}: {e_raw2}")
        time.sleep(0.05)
    print(f"   ✅ {sucesso_raw} registros gravados em {tabela_destino_raw} (falhas: {erros_raw}).")

    # Tenta também sq_raw_fazendas_grupo se configurada com nome distinto e disponível
    if tabela_grupo_raw != tabela_destino_raw:
        try:
            for i in range(0, len(recs_todos), LOTE):
                supabase.table(tabela_grupo_raw).upsert(recs_todos[i : i + LOTE], on_conflict="id").execute()
            print(f"   ✅ Registros espelhados em {tabela_grupo_raw}.")
        except Exception as e_espelho:
            print(f"   ℹ️ Aviso ao espelhar em {tabela_grupo_raw}: {e_espelho}")

    # ─── 6.2 Enviar Ativas de Todas as Cadeias para sq_raw_fazendas_grupo_ativas ─
    print(f"\n📤 6.2 Gravando fazendas ativas (todas as cadeias) da LISTA_GERAL em {tabela_grupo_ativas_raw}...")

    # ─── 6.3 Reconstruindo histórico de FAZENDAS ATIVAS (todas as cadeias) ─────
    # Janela temporal deslizante: reprocessa mês anterior (fechamento), mês atual e próximo mês
    mes_ref_dt = pd.to_datetime(mes_ref_str)
    mes_anterior_str = (mes_ref_dt - pd.DateOffset(months=1)).strftime("%Y-%m-01")
    proximo_mes_str = (mes_ref_dt + pd.DateOffset(months=1)).strftime("%Y-%m-01")

    # Se reindex_completo for True no chamador, recalcula todos os meses a partir de 2026-01-01
    if reindex_completo:
        inicio_2026 = pd.Timestamp("2026-01-01")
        meses_reconciliacao = [m.strftime("%Y-%m-01") for m in pd.date_range(start=inicio_2026, end=pd.to_datetime(proximo_mes_str), freq="MS")]
    else:
        meses_reconciliacao = [mes_anterior_str, mes_ref_str, proximo_mes_str]

    print(f"\n📊 6.3 Reconstruindo FAZENDAS ATIVAS (todas as cadeias) em {tabela_ativos} para a janela ({meses_reconciliacao[0]} a {meses_reconciliacao[-1]})...")

    # Buscar base completa de vínculos no Supabase para isolar da LISTA_GERAL
    res_vinculos_dim = supabase.table("sq_raw_vinculos").select(
        "codigo_lr, consultor_grupo_atendimento, grupo_atendimento, data_associacao, projeto, "
        "nome_produtor, nome_propriedade, vinculo_ativo, unidade_atendimento, cidade_produtor, "
        "estado_produtor, codigo_agroindustria, codigo_fazenda, tipo_ponto_atendimento"
    ).execute()
    df_vinculos_base = pd.DataFrame(res_vinculos_dim.data) if res_vinculos_dim.data else pd.DataFrame()

    def normalizar_cadeia(tipo_val, proj_val):
        t = str(tipo_val or "").strip().upper()
        p = str(proj_val or "").strip().upper()
        if "LEITE" in t or any(x in p for x in ["REGENERA", "ALVOAR", "SEMEAR", "CCPR", "LPA", "COPRIL", "CAMPILEITE", "DANONE", "CFT"]):
            return "LEITE"
        if "CACAU" in t or any(x in p for x in ["CACAU", "OFI", "MIMC", "CARGILL"]):
            return "CACAU"
        if "CAFE" in t or "CAFÉ" in t or "CAFE" in p:
            return "CAFE"
        if "GRAOS" in t or "GRÃOS" in t or "GRAOS" in p:
            return "MAIS GRAOS"
        if t and t not in ["NONE", "NAN", ""]:
            return t
        return "OUTROS"

    if not df_vinculos_base.empty:
        print(f"   -> {len(df_vinculos_base)} vínculos carregados de sq_raw_vinculos ({df_vinculos_base['codigo_lr'].nunique()} produtores únicos).")
    else:
        print("   ⚠️ Nenhum vínculo encontrado em sq_raw_vinculos.")

    # ── FONTE DE VERDADE: Ler BD_BI_VINCULOS_COMPLETO.xlsx para saber quem está ATIVO oficialmente ──
    # O campo vinculo_ativo em sq_raw_vinculos pode estar obsoleto (ETL antigo não deletou registros).
    # Produtores inativados e removidos da planilha mestre devem ser excluídos de sq_dim_fazendas_ativas.
    codigos_ativos_excel: set = set()
    try:
        arq_vinc_excel = bd_path / "BD_BI_VINCULOS_COMPLETO.xlsx"
        if arq_vinc_excel.exists():
            try:
                from functions.carregar_fato_visitas import ler_excel_seguro
            except ImportError:
                from carregar_fato_visitas import ler_excel_seguro
            df_vinc_ex = ler_excel_seguro(arq_vinc_excel)
            if "Ativo" in df_vinc_ex.columns and "Código LR" in df_vinc_ex.columns:
                m_at_ex = df_vinc_ex["Ativo"].astype(str).str.strip().str.lower().isin(["true", "sim", "ativo", "1"])
                codigos_ativos_excel = set(df_vinc_ex[m_at_ex]["Código LR"].dropna().astype(str).str.strip().str.upper())
                print(f"   -> {len(codigos_ativos_excel)} vínculos ativos confirmados em BD_BI_VINCULOS_COMPLETO.xlsx (fonte de verdade).")
    except Exception as e_vinc_ex2:
        print(f"   ℹ️ Aviso ao ler BD_BI_VINCULOS_COMPLETO.xlsx para dim_fazendas_ativas: {e_vinc_ex2}")

    # ── VÍNCULOS E GRUPOS UNIFICADOS: Combinar LISTA_GERAL (df_todos) + sq_raw_vinculos (df_vinculos_base)
    vinc_dict = {}
    if not df_vinculos_base.empty:
        for _, r_v in df_vinculos_base.iterrows():
            c_v = str(r_v.get("codigo_lr") or "").strip().upper()
            if c_v:
                vinc_dict[c_v] = r_v.to_dict()

    candidatos_list = []
    # 1. Fazendas ativas da LISTA_GERAL_RELATORIO_DE_GRUPO (fonte primária e oficial)
    for _, r_g in df_todos.iterrows():
        c_prod = str(r_g.get("codigo_produtor") or "").strip()
        if not c_prod or c_prod.lower() == "nan":
            continue
        st_g = str(r_g.get("status") or "").strip().lower()
        if st_g != "ativo":
            continue
        v_info = vinc_dict.get(c_prod.upper(), {})
        candidatos_list.append({
            "codigo_lr": c_prod,
            "nome_produtor": r_g.get("nome_produtor") or v_info.get("nome_produtor"),
            "nome_propriedade": r_g.get("nome_propriedade") or v_info.get("nome_propriedade"),
            "estado_produtor": r_g.get("estado") or v_info.get("estado_produtor"),
            "cidade_produtor": r_g.get("cidade") or v_info.get("cidade_produtor"),
            "tipo_ponto_atendimento": r_g.get("tipo_ponto_atendimento") or v_info.get("tipo_ponto_atendimento"),
            "unidade_atendimento": r_g.get("unidade_atendimento") or v_info.get("unidade_atendimento"),
            "grupo_atendimento": r_g.get("grupo_ponto_atendimento") or v_info.get("grupo_atendimento"),
            "consultor_grupo_atendimento": r_g.get("nome_grupo_ponto_atendimento") or v_info.get("consultor_grupo_atendimento"),
            "projeto": r_g.get("projeto") or v_info.get("projeto"),
            "codigo_agroindustria": r_g.get("codigo_agroindustria") or v_info.get("codigo_agroindustria"),
            "codigo_fazenda": r_g.get("codigo_fazenda") or v_info.get("codigo_fazenda"),
            "data_associacao": v_info.get("data_associacao"),
            "vinculo_ativo": True
        })

    # 2. Fazendas adicionais de sq_raw_vinculos que não constem na LISTA_GERAL
    codigos_g_set = {str(item.get("codigo_lr") or "").strip().upper() for item in candidatos_list}
    if not df_vinculos_base.empty:
        for _, r_v in df_vinculos_base.iterrows():
            c_v = str(r_v.get("codigo_lr") or "").strip()
            if c_v and c_v.upper() not in codigos_g_set:
                candidatos_list.append({
                    "codigo_lr": c_v,
                    "nome_produtor": r_v.get("nome_produtor"),
                    "nome_propriedade": r_v.get("nome_propriedade"),
                    "estado_produtor": r_v.get("estado_produtor"),
                    "cidade_produtor": r_v.get("cidade_produtor"),
                    "tipo_ponto_atendimento": r_v.get("tipo_ponto_atendimento"),
                    "unidade_atendimento": r_v.get("unidade_atendimento"),
                    "grupo_atendimento": r_v.get("grupo_atendimento"),
                    "consultor_grupo_atendimento": r_v.get("consultor_grupo_atendimento"),
                    "projeto": r_v.get("projeto"),
                    "codigo_agroindustria": r_v.get("codigo_agroindustria"),
                    "codigo_fazenda": r_v.get("codigo_fazenda"),
                    "data_associacao": r_v.get("data_associacao"),
                    "vinculo_ativo": r_v.get("vinculo_ativo")
                })

    df_base_candidatos = pd.DataFrame(candidatos_list).drop_duplicates(subset=["codigo_lr"])
    print(f"   -> {len(df_base_candidatos)} produtores ativas mapeados como candidatos a sq_dim_fazendas_ativas.")

    for ref_m in meses_reconciliacao:
        novos_ativos_m = []

        for _, r in df_base_candidatos.iterrows():
            c = str(r.get("codigo_lr") or "").strip()
            nome_p = str(r.get("nome_produtor") or "").strip()

            if not c or c.lower() == "nan":
                continue

            # 0. Se possui flag _INATIVO no código ou nome, NUNCA entra na dim de ativos
            if ("_INATIVO" in c.upper()) or ("(INATIVO)" in nome_p.upper()) or ("_INATIVO" in nome_p.upper()):
                continue

            # Priorizar grupo completo da LISTA_GERAL_RELATORIO_DE_GRUPO (contém todos os co-consultores)
            grupo_val = str(r.get("grupo_atendimento") or "")
            grp_lg, grp_limp_lg = mapa_grupos_lista_geral.get(c.upper(), (None, None))
            grupo_efetivo = grp_lg if grp_lg else grupo_val
            nome_grupo_efetivo = grp_limp_lg if grp_limp_lg else extrair_nome_grupo_limpo(grupo_efetivo)

            # 0.1 Se o grupo contém CFT, NÃO sobe para a dimensão analítica
            proj_val = str(r.get("projeto") or "")
            if "CFT" in grupo_efetivo.upper() or "CFT" in proj_val.upper():
                continue

            # 0.2 Status do Consultor: Se todos os consultores do grupo estiverem inativos
            cons_resp = extrair_consultor_individual(r.get("consultor_grupo_atendimento"), grupo_efetivo)
            consultores_do_grupo = [p.strip().upper() for p in re.sub(r"\(.*?\)", "", grupo_efetivo).split("/") if p.strip()]
            if consultores_do_grupo and all(cg in consultores_inativos for cg in consultores_do_grupo):
                continue
            elif not consultores_do_grupo and cons_resp in consultores_inativos:
                continue

            # 1. Se a data de associação for posterior ao mês avaliado, ainda não existia
            dt_assoc = r.get("data_associacao")
            dt_assoc_p = pd.to_datetime(dt_assoc, errors="coerce")

            if pd.notna(dt_assoc_p) and dt_assoc_p.strftime("%Y-%m-01") > ref_m:
                continue

            # 2. REGRA PRINCIPAL: Usar BD_BI_VINCULOS_COMPLETO.xlsx como fonte de verdade.
            # Se o produtor TEM inativação registrada E NÃO está ativo na planilha oficial
            # -> está inativo neste mês (se a inativação já ocorreu).
            # Se está ativo na planilha oficial (ex: LR06033), o status ATIVO prevalece.
            is_ativo_excel = c.upper() in codigos_ativos_excel
            if not is_ativo_excel and c in inativacoes_por_codigo and inativacoes_por_codigo[c] <= ref_m:
                continue

            # 3. Se vinculo_ativo é False no Supabase e o produtor já estava inativo
            v_ativo = r.get("vinculo_ativo")
            if v_ativo is False and c in inativacoes_por_codigo:
                continue

            # 4. Se o produtor foi cadastrado como novo em data > ref_m: ainda não havia entrado
            if c in cadastros_por_codigo and cadastros_por_codigo[c] > ref_m:
                continue

            # Tratamentos dimensionais de projeto, cadeia, agroindústria e região
            proj_final = proj_val.strip().upper() if proj_val else None
            cadeia_calc = normalizar_cadeia(r.get("tipo_ponto_atendimento"), proj_final)
            agro_calc = MAP_PROJETO_AGRO.get(proj_final) or (proj_final if proj_final in ["OFI", "PV CARGILL", "NCP", "MIMC", "CAFE & GESTAO", "COPRIL", "CAMPILEITE"] else None)
            uf_val = limpar_uf(r.get("estado_produtor"))
            reg_calc = formatar_regiao(agro_calc, regiao_map.get(c.upper()), uf_val)
            nome_prop = str(r.get("nome_propriedade") or "FAZENDA").strip()[:250]
            cid_val = str(r.get("cidade_produtor") or "").strip()[:100] or "NÃO INFORMADA"
            unid_val = str(r.get("unidade_atendimento") or "LABOR RURAL").strip()[:100]
            id_ativo = f"{c}_{ref_m.replace('-', '_')}"
            novos_ativos_m.append({
                "id": id_ativo,
                "codigo_produtor": c[:50],
                "nome_produtor": nome_p[:250] if nome_p else "PRODUTOR",
                "nome_propriedade": nome_prop,
                "estado": uf_val or "NÃO INFORMADO",
                "cidade": cid_val,
                "tipo_ponto_atendimento": cadeia_calc,
                "unidade_atendimento": unid_val,
                "grupo_ponto_atendimento": str(grupo_efetivo)[:250] if grupo_efetivo else cons_resp,
                "nome_grupo_ponto_atendimento": str(nome_grupo_efetivo)[:250] if nome_grupo_efetivo else None,
                "projeto": proj_final,
                "agroindustria": agro_calc,
                "regiao": reg_calc,
                "codigo_agroindustria": r.get("codigo_agroindustria"),
                "codigo_fazenda": r.get("codigo_fazenda"),
                "status": "Ativo",
                "mes_referencia": ref_m,
                "data_processamento": agora_iso
            })

        df_novos_ativos = pd.DataFrame(novos_ativos_m).drop_duplicates(subset=["id"])
        print(f"   Mês {ref_m}: {len(df_novos_ativos)} fazendas ativas consolidadas.")

        # Limpar apenas os registros do mês específico que estamos atualizando antes de inserir os novos
        try:
            supabase.table(tabela_ativos).delete().eq("mes_referencia", ref_m).execute()
        except Exception as e_del_m:
            print(f"   ℹ️ Aviso ao limpar {ref_m} em {tabela_ativos}: {e_del_m}")

        registros_ativos = df_novos_ativos.to_dict(orient="records")
        sucesso_ativos = 0
        erros_ativos = 0
        for i in range(0, len(registros_ativos), LOTE):
            lote_at = registros_ativos[i : i + LOTE]
            try:
                supabase.table(tabela_ativos).upsert(lote_at, on_conflict="id").execute()
                sucesso_ativos += len(lote_at)
            except Exception as e:
                try:
                    supabase.table(tabela_ativos).upsert(lote_at).execute()
                    sucesso_ativos += len(lote_at)
                except Exception as e2:
                    erros_ativos += len(lote_at)
                    print(f"     ❌ Erro ao enviar lote de ativos {i // LOTE + 1}: {e2}")
            time.sleep(0.05)

        print(f"   ✅ {sucesso_ativos} produtores ativos atualizados para {ref_m} em {tabela_ativos} (falhas: {erros_ativos}).")

    print("\n=================================================================")
    print("   RECONCILIAÇÃO CONCLUÍDA COM SUCESSO!                          ")
    print("=================================================================")


if __name__ == "__main__":
    executar_reconciliacao()