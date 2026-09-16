# -*- coding: utf-8 -*-
"""
Script Oficial de Execucao da Pipeline ETL (BI Labor Rural)
Executa o notebook ETL_BI_LR.ipynb salvando diretamente no arquivo original
(Regra 5 do AGENTS.md: nunca criar duplicatas com sufixo _executado.ipynb).
"""
from __future__ import annotations

import sys
import asyncio
import warnings

if sys.platform == 'win32':
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass
warnings.filterwarnings('ignore', category=RuntimeWarning, module='zmq')

# pyrefly: ignore [missing-attribute]
sys.stdout.reconfigure(encoding='utf-8')
import time
from datetime import datetime
from pathlib import Path

# Localizar raiz do projeto
caminho_atual = Path(__file__).resolve().parent
raiz_projeto = caminho_atual.parent if caminho_atual.name.lower() == "scripts" else caminho_atual

for p in [
    raiz_projeto,
    raiz_projeto / "scripts",
    raiz_projeto / "scripts" / "functions",
    raiz_projeto / "SCRIPTS",
    raiz_projeto / "SCRIPTS" / "FUNCTIONS",
]:
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import nbformat
from nbconvert.preprocessors import ExecutePreprocessor


def executar_notebook(caminho_notebook: Path) -> bool:
    print("=" * 70)
    print(f"🚀 INICIANDO EXECUÇÃO DO NOTEBOOK: {caminho_notebook.name}")
    print(f"⏰ Início: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    print("=" * 70)

    inicio = time.time()

    try:
        with open(caminho_notebook, "r", encoding="utf-8") as f:
            nb = nbformat.read(f, as_version=4)

        ep = ExecutePreprocessor(timeout=1800, kernel_name="python3")
        ep.preprocess(nb, {"metadata": {"path": str(caminho_notebook.parent)}})

        # Salvar diretamente no arquivo original (Regra 5)
        with open(caminho_notebook, "w", encoding="utf-8") as f:
            nbformat.write(nb, f)

        duracao = time.time() - inicio
        print("=" * 70)
        print(f"✅ NOTEBOOK EXECUTADO COM SUCESSO: {caminho_notebook.name}")
        print(f"⏱️ Tempo total: {duracao:.2f} segundos")
        print(f"⏰ Conclusão: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
        print("=" * 70)
        return True

    except Exception as e:
        duracao = time.time() - inicio
        print("=" * 70)
        print(f"❌ ERRO NA EXECUÇÃO DO NOTEBOOK: {str(e)}")
        print(f"⏱️ Tempo até a falha: {duracao:.2f} segundos")
        print("=" * 70)
        return False


def main():
    # 1. Sincronização Pré-ETL das Tabelas de Consistência (Mensal e Anual)
    try:
        try:
            from functions.atualizar_detalhamento_consistencia import executar_sincronizacao_consistencia
        except ImportError:
            from FUNCTIONS.atualizar_detalhamento_consistencia import executar_sincronizacao_consistencia
        print("\n📥 [PRÉ-ETL] Sincronizando relatórios mais recentes de consistência (Elabore)...")
        sucesso_consistencia = executar_sincronizacao_consistencia(raiz_projeto)
        if not sucesso_consistencia:
            print("⚠️ Aviso: Sincronização de consistência retornou avisos ou falhou, prosseguindo com dados existentes.")
    except Exception as e_cons:
        print(f"⚠️ Aviso ao sincronizar consistência pré-ETL: {e_cons}")
    
    # 2. Execução do Notebook Principal
    notebook_path = raiz_projeto / "scripts" / "ETL_BI_LR.ipynb"
    if not notebook_path.exists():
        notebook_path = raiz_projeto / "SCRIPTS" / "ETL_BI_LR.ipynb"
    if not notebook_path.exists():
        print(f"❌ Arquivo não encontrado: {notebook_path}")
        sys.exit(1)

    sucesso = executar_notebook(notebook_path)
    
    # 3. Pós-ETL: Reconciliação de Movimentação, Ativos e Sanitização das Tabelas Fato
    if sucesso:
        try:
            try:
                from functions.reconciliar_movimentacao_e_ativos import executar_reconciliacao
            except ImportError:
                from FUNCTIONS.reconciliar_movimentacao_e_ativos import executar_reconciliacao
            print("\n🔄 [PÓS-ETL] Executando reconciliação final de movimentações e ativos...")
            executar_reconciliacao()
        except Exception as e_rec:
            print(f"⚠️ Aviso na reconciliação: {e_rec}")

        try:
            from sanitizar_tabelas_fato_supabase import executar_sanitizacao_completa
            print("\n🧹 [PÓS-ETL] Sanitizando tabelas fato no Supabase...")
            executar_sanitizacao_completa(modo_execucao="aplicar")
        except Exception as e_san:
            print(f"⚠️ Aviso na sanitização: {e_san}")

        print("\n🎉 Pipeline ETL finalizada com sucesso!")
        sys.exit(0)
    else:
        print("\n💥 Falha na execução da pipeline ETL.")
        sys.exit(1)


if __name__ == "__main__":
    main()
