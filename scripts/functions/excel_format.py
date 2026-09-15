from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import numpy as np
import pandas as pd
from numbers import Number

from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter


def aplicar_formatacao_excel(
    workbook,
    fonte: str = "Aptos",
    tamanho_fonte: int = 11,
    altura_linha: int = 20,
    largura_maxima: int = 60,
    zoom_planilha: int = 85,
    max_linhas_amostra: int = 100,
) -> None:
    """Formata todas as planilhas de um workbook do openpyxl de forma otimizada."""

    fonte_padrao = Font(
        name=fonte,
        size=tamanho_fonte,
    )

    fonte_cabecalho = Font(
        name=fonte,
        size=tamanho_fonte,
        bold=True,
    )

    align_center = Alignment(vertical="center", horizontal="center")
    align_right = Alignment(vertical="center", horizontal="right")
    align_left = Alignment(vertical="center", horizontal="left")

    for worksheet in workbook.worksheets:
        # Configurações de visualização
        worksheet.sheet_view.showGridLines = False
        worksheet.sheet_view.zoomScale = zoom_planilha

        # Congelar cabeçalho
        worksheet.freeze_panes = "A2"

        # Aplicar filtro
        if worksheet.max_row and worksheet.max_column:
            worksheet.auto_filter.ref = worksheet.dimensions

        # Altura padrão das linhas de dados (evita iterar row_dimensions para todas as linhas)
        worksheet.sheet_format.defaultRowHeight = altura_linha
        worksheet.sheet_format.customHeight = True

        # Formatar cabeçalho (linha 1)
        if worksheet.max_row and worksheet.max_row >= 1:
            worksheet.row_dimensions[1].height = altura_linha + 5
            total_cols_atual = worksheet.max_column or 0
            for col_idx in range(1, total_cols_atual + 1):
                cell = worksheet.cell(row=1, column=col_idx)
                cell.font = fonte_cabecalho
                cell.alignment = align_center

        # Formatar células de dados em 1 única passagem sem reinstanciar Alignment
        if worksheet.max_row and worksheet.max_row >= 2:
            for row in worksheet.iter_rows(min_row=2):
                for cell in row:
                    val = cell.value
                    if isinstance(val, Number) and not isinstance(val, bool):
                        cell.font = fonte_padrao
                        cell.alignment = align_right
                    else:
                        cell.font = fonte_padrao
                        cell.alignment = align_left

        # Ajustar largura das colunas usando amostragem das primeiras N linhas
        total_rows = worksheet.max_row or 0
        total_cols = worksheet.max_column or 0
        linhas_amostra = range(1, min(total_rows + 1, max_linhas_amostra + 1))

        for col_idx in range(1, total_cols + 1):
            letra = get_column_letter(col_idx)
            maior = 0
            for r in linhas_amostra:
                val = worksheet.cell(row=r, column=col_idx).value
                if val is not None:
                    maior = max(maior, len(str(val)))

            worksheet.column_dimensions[letra].width = max(
                10,
                min(maior + 4, largura_maxima),
            )
            
def exportar_xlsx_formatado(
    df: pd.DataFrame,
    caminho_saida: str | Path,
    nome_aba: str = "planilha",
) -> Path:
    """Exporta um DataFrame em XLSX com formatação padrão."""
    return exportar_varias_abas_xlsx({nome_aba: df}, caminho_saida)


def exportar_varias_abas_xlsx(
    abas: Mapping[str, pd.DataFrame],
    caminho_saida: str | Path,
    fonte: str = "Aptos",
    tamanho_fonte: int = 11,
    tamanho_fonte_cabecalho: int = 11,
    altura_linha: int = 20,
    altura_cabecalho: int = 38,
    max_linhas_amostra: int = 100,
) -> Path:
    """Exporta várias tabelas para um único XLSX formatado com alta performance (xlsxwriter)."""
    caminho_saida = Path(caminho_saida)
    caminho_saida.parent.mkdir(parents=True, exist_ok=True)

    try:
        with pd.ExcelWriter(caminho_saida, engine="xlsxwriter") as writer:
            workbook = writer.book

            fmt_cabecalho = workbook.add_format({
                'bold': True,
                'font_name': fonte,
                'font_size': tamanho_fonte_cabecalho,
                'align': 'center',
                'valign': 'vcenter',
                'border': 0,
                'bg_color': '#247B72',
                'font_color': '#FFFFFF',
            })
            fmt_num = workbook.add_format({
                'font_name': fonte,
                'font_size': tamanho_fonte,
                'align': 'right',
                'valign': 'vcenter',
                'border': 0,
            })
            fmt_text = workbook.add_format({
                'font_name': fonte,
                'font_size': tamanho_fonte,
                'align': 'left',
                'valign': 'vcenter',
                'border': 0,
            })
            fmt_date = workbook.add_format({
                'font_name': fonte,
                'font_size': tamanho_fonte,
                'align': 'center',
                'valign': 'vcenter',
                'border': 0,
                'num_format': 'dd/mm/yyyy',
            })

            for nome_aba, df in abas.items():
                nome_seguro = str(nome_aba)[:31]
                df.to_excel(writer, index=False, sheet_name=nome_seguro)

                worksheet = writer.sheets[nome_seguro]
                worksheet.freeze_panes(1, 0)
                worksheet.hide_gridlines(2)
                worksheet.set_zoom(85)
                worksheet.set_default_row(altura_linha)

                max_row, max_col = df.shape
                if max_row > 0 and max_col > 0:
                    worksheet.autofilter(0, 0, max_row, max_col - 1)

                # Cabeçalho: altura customizada de 38 (sem aplicar formato na linha inteira para não colorir colunas infinitas)
                worksheet.set_row(0, altura_cabecalho)

                # Escrever cabeçalhos manualmente para garantir que o formato é aplicado apenas nas colunas com dados
                for col_idx, col_name in enumerate(df.columns):
                    worksheet.write(0, col_idx, col_name, fmt_cabecalho)

                amostra = df.head(max_linhas_amostra)
                for col_idx, col_name in enumerate(df.columns):
                    dtype = df[col_name].dtype
                    is_num = pd.api.types.is_numeric_dtype(dtype) and not pd.api.types.is_bool_dtype(dtype)
                    is_date = pd.api.types.is_datetime64_any_dtype(dtype)

                    if is_date:
                        col_fmt = fmt_date
                    elif is_num:
                        col_fmt = fmt_num
                    else:
                        col_fmt = fmt_text

                    max_len = max(
                        len(str(col_name)),
                        amostra[col_name].astype(str).str.len().max() if not amostra.empty else 0
                    )
                    largura = max(12 if is_date else 10, min(max_len + 4, 60))
                    worksheet.set_column(col_idx, col_idx, largura, col_fmt)
    except Exception:
        # Fallback para openpyxl caso xlsxwriter falhe por qualquer razão
        with pd.ExcelWriter(caminho_saida, engine="openpyxl") as writer:
            for nome_aba, df in abas.items():
                nome_seguro = str(nome_aba)[:31]
                df.to_excel(writer, index=False, sheet_name=nome_seguro)
            aplicar_formatacao_excel(writer.book, fonte=fonte, max_linhas_amostra=max_linhas_amostra)

    try:
        aplicar_estilo_listrado_xlsx(
            caminho_arquivo=caminho_saida,
            cor_cabecalho="#247B72",
            cor_texto_cabecalho="#FFFFFF",
            cor_linha_alternada="#F2F2F2",
            cor_linha_base="#FFFFFF",
            primeira_linha_cinza=True,
        )
    except Exception:
        pass

    return caminho_saida

def aplicar_estilo_listrado_xlsx(
    caminho_arquivo: str | Path,
    fonte: str = "Aptos",
    tamanho_fonte: int = 11,
    tamanho_fonte_cabecalho: int = 11,
    altura_linha: int = 20,
    altura_cabecalho: int = 38,
    cor_cabecalho: str = "#247B72",
    cor_texto_cabecalho: str = "#FFFFFF",
    cor_linha_alternada: str = "#F2F2F2",
    cor_linha_base: str = "#FFFFFF",
    primeira_linha_cinza: bool = True,
) -> Path:
    """
    Aplica formatação visual em todas as abas de um arquivo XLSX.

    Formatação:
    - fonte Aptos tamanho 10 nos dados e 10 no cabeçalho;
    - altura padrão das linhas = 20; altura do cabeçalho = 38;
    - alinhamento vertical no meio (vcenter);
    - cabeçalho verde (#247B72), texto branco e negrito, sem bordas;
    - linhas alternadas entre cinza e branco;
    - linhas de grade ocultas na tela e na impressão.
    """

    from openpyxl import load_workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    caminho_arquivo = Path(caminho_arquivo)

    if not caminho_arquivo.exists():
        raise FileNotFoundError(
            f"Arquivo Excel não encontrado: {caminho_arquivo}"
        )

    if caminho_arquivo.suffix.lower() != ".xlsx":
        raise ValueError(
            "A função aceita somente arquivos com extensão .xlsx."
        )

    if tamanho_fonte <= 0:
        raise ValueError(
            "O tamanho da fonte precisa ser maior que zero."
        )

    def normalizar_cor(cor: str) -> str:
        """Converte #RRGGBB ou RRGGBB para o formato ARGB."""
        cor_normalizada = (
            str(cor)
            .strip()
            .replace("#", "")
            .upper()
        )

        if len(cor_normalizada) == 6:
            return f"FF{cor_normalizada}"

        if len(cor_normalizada) == 8:
            return cor_normalizada

        raise ValueError(
            f"Cor inválida: {cor!r}. Utilize o formato '#RRGGBB'."
        )

    preenchimento_cabecalho = PatternFill(
        fill_type="solid",
        fgColor=normalizar_cor(cor_cabecalho),
    )

    preenchimento_linha_alternada = PatternFill(
        fill_type="solid",
        fgColor=normalizar_cor(cor_linha_alternada),
    )

    preenchimento_linha_base = PatternFill(
        fill_type="solid",
        fgColor=normalizar_cor(cor_linha_base),
    )

    cor_fonte_cabecalho = normalizar_cor(cor_texto_cabecalho)

    fonte_cabecalho_padrao = Font(
        name=fonte,
        size=tamanho_fonte_cabecalho,
        bold=True,
        color=cor_fonte_cabecalho,
    )

    fonte_dados_padrao = Font(
        name=fonte,
        size=tamanho_fonte,
        bold=False,
    )

    sem_borda = Border(
        left=Side(style=None),
        right=Side(style=None),
        top=Side(style=None),
        bottom=Side(style=None),
    )

    align_cabecalho = Alignment(vertical="center", horizontal="center")
    align_dados_esquerda = Alignment(vertical="center", horizontal="left")
    align_dados_direita = Alignment(vertical="center", horizontal="right")

    workbook = load_workbook(caminho_arquivo)

    for worksheet in workbook.worksheets:
        total_linhas = worksheet.max_row or 0
        total_colunas_bruto = worksheet.max_column or 0

        if total_linhas < 1 or total_colunas_bruto < 1:
            continue

        # Identificar apenas as colunas reais que possuem cabeçalho/dados na linha 1
        colunas_cabecalho = [
            c for c in range(1, total_colunas_bruto + 1)
            if worksheet.cell(row=1, column=c).value is not None
        ]
        total_colunas = max(colunas_cabecalho) if colunas_cabecalho else total_colunas_bruto

        # Ocultar linhas de grade.
        worksheet.sheet_view.showGridLines = False
        worksheet.print_options.gridLines = False

        # Altura padrão para TODAS as linhas de dados.
        worksheet.sheet_format.defaultRowHeight = altura_linha
        worksheet.sheet_format.customHeight = True

        # Altura explícita para a linha do cabeçalho (38).
        worksheet.row_dimensions[1].height = altura_cabecalho

        # ----------------------------------------------------------------------
        # Cabeçalho (Linha 1) - aplicar apenas até total_colunas
        # ----------------------------------------------------------------------
        for col_idx in range(1, total_colunas + 1):
            celula = worksheet.cell(row=1, column=col_idx)
            celula.fill = preenchimento_cabecalho
            celula.font = fonte_cabecalho_padrao
            celula.border = sem_borda
            celula.alignment = align_cabecalho

        # ----------------------------------------------------------------------
        # Linhas de dados (Linha 2 em diante)
        # ----------------------------------------------------------------------
        numero_linha_dados = 0

        for linha in worksheet.iter_rows(
            min_row=2,
            max_row=total_linhas,
            min_col=1,
            max_col=total_colunas,
        ):
            if all(celula.value is None for celula in linha):
                continue

            numero_linha_dados += 1
            usar_cinza = (numero_linha_dados % 2 == 1) if primeira_linha_cinza else (numero_linha_dados % 2 == 0)
            preenchimento = preenchimento_linha_alternada if usar_cinza else preenchimento_linha_base

            for celula in linha:
                celula.fill = preenchimento
                celula.font = fonte_dados_padrao
                if isinstance(celula.value, (datetime, date)):
                    celula.number_format = 'dd/mm/yyyy'
                    celula.alignment = align_cabecalho

    workbook.save(caminho_arquivo)
    return caminho_arquivo