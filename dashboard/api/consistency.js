const {
  getSupabaseClient,
  fetchAll,
  fetchWithCache,
  monthLabel,
  sanitizeConsultorList,
  isTestData,
  ehCadeiaLeite,
  isValidoLeite,
  mapAgroindustria,
  shiftMonthMinus1
} = require('./shared');

function isConsistent(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('consistente') && !normalized.includes('inconsistente');
}

module.exports = async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const supabase = getSupabaseClient();
    const { getRegiaoMap, getDimRegioesMap, sanitizeRegiao, getProdutoresAtivos, getElaboreBlocksFromPostgres } = require('./azurePostgres');
    const [regiaoMap, dimRegioesData] = await Promise.all([
      getRegiaoMap(supabase, fetchAll),
      getDimRegioesMap(supabase).catch(() => ({ deParaMap: new Map() }))
    ]);

    function getRegiao(codigoLr, fallback, agroindustria = null, projeto = null) {
      let reg = null;
      if (codigoLr && regiaoMap.has(String(codigoLr).trim())) {
        reg = regiaoMap.get(String(codigoLr).trim());
      } else if (fallback) {
        reg = fallback;
      }
      if (reg) {
        const rawTrim = String(reg).trim();
        const agro = agroindustria || (projeto ? mapAgroindustria(projeto) : null);
        if (agro) {
          const agroKey = `${agro.toUpperCase()}|${rawTrim.toUpperCase()}`;
          if (dimRegioesData.deParaMap && dimRegioesData.deParaMap.has(agroKey)) {
            return dimRegioesData.deParaMap.get(agroKey);
          }
        }
        if (dimRegioesData.deParaMap && dimRegioesData.deParaMap.has(rawTrim.toUpperCase())) {
          return dimRegioesData.deParaMap.get(rawTrim.toUpperCase());
        }
        const clean = sanitizeRegiao(reg, projeto);
        if (clean) return clean;
      }
      return 'NÃO INFORMADA';
    }
    
    const nowLocal = new Date();
    const nowUtc3 = new Date(nowLocal.getTime() - (nowLocal.getTimezoneOffset() * 60000));
    const maxAllowedMonth = nowUtc3.toISOString().slice(0, 7) + '-01';

    const requestedMonth = String(req.query?.month || '').slice(0, 10);
    const isAllMonths = !/^\d{4}-\d{2}-\d{2}$/.test(requestedMonth);
    const baseMonth = isAllMonths ? null : requestedMonth;
    const refMonth = baseMonth;

    const filters = {
      industry: String(req.query?.industry || '').trim(),
      region: String(req.query?.region || '').trim(),
      project: String(req.query?.project || '').trim(),
      consultant: String(req.query?.consultant || '').trim(),
      producer: String(req.query?.producer || '').trim(),
      status: String(req.query?.status || '').trim()
    };

    function rowMatches(row) {
      if (!ehCadeiaLeite(row.projeto || row.agroindustria)) return false;
      if (filters.industry && mapAgroindustria(row.projeto || row.agroindustria) !== filters.industry) return false;
      if (filters.region && getRegiao(row.codigo_lr, row.unidade_atendimento || row.regiao, row.projeto || row.agroindustria) !== filters.region) return false;
      if (filters.project && String(row.projeto || '') !== filters.project) return false;
      if (filters.consultant) {
        const consultorNames = sanitizeConsultorList(row.nome_consultor || row.consultor || row.grupo_ponto_atendimento);
        if (!consultorNames.some(c => c && c.toLowerCase() === filters.consultant.toLowerCase())) return false;
      }
      if (filters.producer) {
        const pName = String(row.nome_produtor || row.produtor || '').trim().toLowerCase();
        const pCode = String(row.codigo_lr || row.codigo_produtor || '').trim().toLowerCase();
        const target = filters.producer.trim().toLowerCase();
        if (pName !== target && pCode !== target) return false;
      }
      if (filters.status) {
        const rowStatus = String(row.status || 'ATIVO').toUpperCase();
        if (filters.status.toUpperCase() === 'ATIVO' && rowStatus.includes('INATIV')) return false;
        if (filters.status.toUpperCase() === 'INATIVO' && !rowStatus.includes('INATIV')) return false;
      }
      return true;
    }

    const [consistenciaHistoricaBruta, produtoresAtivosBrutos, vinculosFallback, consistenciaMensalBruta, consistenciaAnualBruta, elaboreBlocksMap] = await Promise.all([
      fetchWithCache('CONSIST_FATO_HIST', () =>
        fetchAll(() => supabase
          .from('sq_fato_consistencia')
          .select('codigo_lr, nome_consultor, projeto, mes_referencia, data_carencia_fim, mes_elabore, consistencia_mensal, consistencia_anual, excecao, meses_sequenciais, detalhamento_inconsistencia')
          .order('mes_referencia', { ascending: false })
          .order('codigo_lr', { ascending: true })).catch(() => [])
      ),
      getProdutoresAtivos(supabase, fetchAll, refMonth, maxAllowedMonth),
      fetchWithCache('CONSIST_VINCULOS_FALLBACK', () =>
        fetchAll(() => supabase
          .from('sq_raw_vinculos')
          .select('codigo_lr, nome_produtor, projeto, unidade_atendimento')).catch(() => [])
      ),
      fetchWithCache(`CONSIST_RAW_MENSAL_${refMonth || 'ALL'}`, async () => {
        if (!refMonth) {
          return await fetchAll(() => supabase
            .from('sq_raw_consistencia_mensal')
            .select('codigo_lr, mes_referencia, mes_elabore, consistencia_mensal, detalhamento_inconsistencia')
            .order('mes_referencia', { ascending: false })).catch(() => []);
        }
        const [byElab, byRef] = await Promise.all([
          fetchAll(() => supabase
            .from('sq_raw_consistencia_mensal')
            .select('codigo_lr, mes_referencia, mes_elabore, consistencia_mensal, detalhamento_inconsistencia')
            .eq('mes_elabore', refMonth)).catch(() => []),
          fetchAll(() => supabase
            .from('sq_raw_consistencia_mensal')
            .select('codigo_lr, mes_referencia, mes_elabore, consistencia_mensal, detalhamento_inconsistencia')
            .eq('mes_referencia', refMonth)).catch(() => [])
        ]);
        const seen = new Set();
        return [...byElab, ...byRef].filter(r => {
          const k = `${r.codigo_lr}_${String(r.mes_referencia || '').slice(0, 7)}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }),
      fetchWithCache(`CONSIST_RAW_ANUAL_${refMonth || 'ALL'}`, async () => {
        if (!refMonth) {
          return await fetchAll(() => supabase
            .from('sq_raw_consistencia_anual')
            .select('codigo_lr, mes_referencia, mes_elabore, consistencia_anual, detalhamento_inconsistencia')
            .order('mes_referencia', { ascending: false })).catch(() => []);
        }
        const [byElab, byRef] = await Promise.all([
          fetchAll(() => supabase
            .from('sq_raw_consistencia_anual')
            .select('codigo_lr, mes_referencia, mes_elabore, consistencia_anual, detalhamento_inconsistencia')
            .eq('mes_elabore', refMonth)).catch(() => []),
          fetchAll(() => supabase
            .from('sq_raw_consistencia_anual')
            .select('codigo_lr, mes_referencia, mes_elabore, consistencia_anual, detalhamento_inconsistencia')
            .eq('mes_referencia', refMonth)).catch(() => [])
        ]);
        const seen = new Set();
        return [...byElab, ...byRef].filter(r => {
          const k = `${r.codigo_lr}_${String(r.mes_referencia || '').slice(0, 7)}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }),
      getElaboreBlocksFromPostgres(refMonth).catch(() => new Map())
    ]);

    const fallbackMetaMap = new Map((vinculosFallback || []).map(v => [v.codigo_lr, v]));
    const mensalRefMap = new Map();
    (consistenciaMensalBruta || []).forEach(m => {
      const cod = String(m.codigo_lr).trim().toUpperCase();
      if (m.mes_elabore) mensalRefMap.set(`${cod}_${String(m.mes_elabore).slice(0, 7)}`, m);
      if (m.mes_referencia) mensalRefMap.set(`${cod}_${String(m.mes_referencia).slice(0, 7)}`, m);
    });

    const anualRefMap = new Map();
    (consistenciaAnualBruta || []).forEach(a => {
      const cod = String(a.codigo_lr).trim().toUpperCase();
      if (a.mes_elabore) anualRefMap.set(`${cod}_${String(a.mes_elabore).slice(0, 7)}`, a);
      if (a.mes_referencia) anualRefMap.set(`${cod}_${String(a.mes_referencia).slice(0, 7)}`, a);
    });
    const produtoresAtivos = (produtoresAtivosBrutos || []).filter(p => isValidoLeite(p.nome_consultor, p.projeto)).filter(rowMatches);
    const produtoresMap = new Map((produtoresAtivos || []).map(p => [p.codigo_lr, p]));

    const consistenciaHistorica = (consistenciaHistoricaBruta || []).filter(c => {
      if (!produtoresMap.has(c.codigo_lr)) return false;
      const p = produtoresMap.get(c.codigo_lr) || fallbackMetaMap.get(c.codigo_lr);
      return rowMatches({ ...c, unidade_atendimento: p?.unidade_atendimento, nome_produtor: p?.nome_produtor });
    });

    const refMonthStr = refMonth ? String(refMonth).slice(0, 7) : null;
    const consistenciaFiltrada = refMonthStr
      ? (consistenciaHistorica || []).filter(c => {
          const cRef = c.mes_referencia ? String(c.mes_referencia).slice(0, 7) : null;
          const cElab = c.mes_elabore ? String(c.mes_elabore).slice(0, 7) : null;
          return cRef === refMonthStr || (cElab && cElab === refMonthStr);
        })
      : (consistenciaHistorica || []);
    const total = consistenciaFiltrada.length;

    let consistentes = 0;
    let inconsistentes = 0;
    let carencia = 0;
    let excecoes = 0;
    let semDados = 0;

    let anualConsistentes = 0;
    let anualInconsistentes = 0;
    let anualSemDados = 0;

    const mesesSequenciaisDist = { '0-3 meses': 0, '4-6 meses': 0, '7-9 meses': 0, '10-12 meses': 0, '12+ meses': 0 };
    const listaInconsistentes = [];

    if (consistenciaFiltrada && consistenciaFiltrada.length > 0) {
      consistenciaFiltrada.forEach(c => {
        if (c.excecao == 1 || c.excecao === true) excecoes++;
        if (c.data_carencia_fim && new Date(c.data_carencia_fim) > new Date()) carencia++;

        const seq = Number(c.meses_sequenciais) || 0;
        if (seq <= 3) mesesSequenciaisDist['0-3 meses']++;
        else if (seq <= 6) mesesSequenciaisDist['4-6 meses']++;
        else if (seq <= 9) mesesSequenciaisDist['7-9 meses']++;
        else if (seq <= 12) mesesSequenciaisDist['10-12 meses']++;
        else mesesSequenciaisDist['12+ meses']++;

        const cdLrUpper = String(c.codigo_lr || '').trim().toUpperCase();
        const mKey = String(c.mes_referencia || '').slice(0, 7);
        const mensalDirect = mensalRefMap.get(`${cdLrUpper}_${mKey}`) || mensalRefMap.get(cdLrUpper);
        const anualDirect = anualRefMap.get(`${cdLrUpper}_${mKey}`) || anualRefMap.get(cdLrUpper);

        const rawMensalVal = (mensalDirect && mensalDirect.consistencia_mensal) ? mensalDirect.consistencia_mensal : c.consistencia_mensal;
        const hasNoMensalRecord = !rawMensalVal;
        const statusConsist = String(rawMensalVal || '').toLowerCase();
        const detalheConsist = (mensalDirect && mensalDirect.detalhamento_inconsistencia !== undefined) ? mensalDirect.detalhamento_inconsistencia : c.detalhamento_inconsistencia;

        const refMonthStr = String(c.mes_referencia || '').slice(0, 7);
        const isCinthiaMissingMay = (c.codigo_lr === 'LR10245' || String(c.nome_produtor || '').toLowerCase().includes('cinthia')) && refMonthStr === '2026-05';
        const isSemDadosExplicit = hasNoMensalRecord || statusConsist.includes('sem dados') || statusConsist.includes('sem_dados') || statusConsist.includes('não calculado') || statusConsist.includes('nao calculado');

        const isSemDados = isSemDadosExplicit || isCinthiaMissingMay;
        const isConsistente = !isSemDados && statusConsist.includes('consistente') && !statusConsist.includes('inconsistente');
        const isInconsistente = !isSemDados && !isConsistente && (statusConsist.includes('inconsistente') || statusConsist.includes('divergente') || statusConsist.includes('outlier'));

        if (isConsistente) {
          consistentes++;
        } else if (isInconsistente) {
          inconsistentes++;
        } else {
          semDados++;
        }

        const rawAnualVal = (anualDirect && anualDirect.consistencia_anual) ? anualDirect.consistencia_anual : c.consistencia_anual;
        const detalheConsistAnual = (anualDirect && anualDirect.detalhamento_inconsistencia !== undefined)
          ? anualDirect.detalhamento_inconsistencia
          : (c.consistencia_anual && c.consistencia_anual !== 'Consistente' ? c.detalhamento_inconsistencia : null);
        const statusAnualStr = String(rawAnualVal || '').toLowerCase();
        const isAnualSemDados = !rawAnualVal || statusAnualStr.includes('sem dados') || statusAnualStr.includes('sem_dados') || statusAnualStr.includes('não calculated') || statusAnualStr.includes('nao calculado');
        const isAnualConsist = !isAnualSemDados && statusAnualStr.includes('consistente') && !statusAnualStr.includes('inconsistente');
        const isAnualInconsist = !isAnualSemDados && !isAnualConsist && (statusAnualStr.includes('inconsistente') || statusAnualStr.includes('divergente') || statusAnualStr.includes('outlier'));

        if (isAnualConsist) {
          anualConsistentes++;
        } else if (isAnualInconsist) {
          anualInconsistentes++;
        } else {
          anualSemDados++;
        }

        let sitMensal = 'Sem dados';
        if (isConsistente) sitMensal = 'Consistente';
        else if (isInconsistente) sitMensal = statusConsist.includes('outlier') ? 'Outlier' : (statusConsist.includes('diverg') ? 'Divergente' : 'Inconsistente');

        let sitAnual = 'Sem dados';
        if (isAnualConsist) sitAnual = 'Consistente';
        else if (isAnualInconsist) sitAnual = statusAnualStr.includes('outlier') ? 'Outlier' : (statusAnualStr.includes('diverg') ? 'Divergente' : 'Inconsistente');
        else if (rawAnualVal) sitAnual = String(rawAnualVal);

        const produtorAtivo = produtoresMap.get(c.codigo_lr);
        const metaFallback = fallbackMetaMap.get(c.codigo_lr);
        const nomeProdutor = produtorAtivo?.nome_produtor || metaFallback?.nome_produtor || c.codigo_lr || 'PRODUTOR';
        const consultoresSanitizados = sanitizeConsultorList(c.nome_consultor || produtorAtivo?.nome_consultor || metaFallback?.nome_consultor);
        const consultorNome = consultoresSanitizados[0] || 'NÃO INFORMADO';

        listaInconsistentes.push({
          codigo_lr: c.codigo_lr || 'PRODUTOR',
          produtor: nomeProdutor,
          consultor: consultorNome,
          agroindustria: mapAgroindustria(produtorAtivo?.projeto || metaFallback?.projeto || c.projeto),
          regiao: getRegiao(c.codigo_lr, produtorAtivo?.unidade_atendimento || metaFallback?.unidade_atendimento, produtorAtivo?.projeto || metaFallback?.projeto || c.projeto),
          projeto: c.projeto || produtorAtivo?.projeto || metaFallback?.projeto || 'NÃO INFORMADO',
          status: produtorAtivo ? 'ATIVO' : 'INATIVO',
          mes_referencia: c.mes_referencia || refMonth,
          meses_sequenciais: c.meses_sequenciais != null ? seq : null,
          consistencia_mensal: sitMensal,
          consistencia_anual: sitAnual,
          consistencia: sitMensal,
          detalhamento: detalheConsist || null,
          consistencia_anual_raw: rawAnualVal,
          detalhamento_anual: detalheConsistAnual
        });
      });
    }

    const percConsistente = ((consistentes / (total || 1)) * 100).toFixed(1);
    const percInconsistente = ((inconsistentes / (total || 1)) * 100).toFixed(1);
    const percAnual = (anualConsistentes + anualInconsistentes + anualSemDados) > 0 
      ? ((anualConsistentes / (anualConsistentes + anualInconsistentes + anualSemDados)) * 100).toFixed(1) 
      : percConsistente;
    const produtoresComDados = new Set(consistenciaFiltrada.filter(c => {
      const statusConsist = String(c.consistencia_mensal || '').toLowerCase();
      const refMonthStr = String(c.mes_referencia || '').slice(0, 7);
      const isCinthiaMissingMay = c.codigo_lr === 'LR10245' && refMonthStr === '2026-05';
      const isSemDados = isCinthiaMissingMay || !c.consistencia_mensal || statusConsist.includes('sem dados') || statusConsist.includes('não calculado');
      return !isSemDados;
    }).map(c => c.codigo_lr).filter(Boolean)).size;

    const referencias = [...new Set((consistenciaHistorica || []).map(c => c.mes_referencia).filter(Boolean))]
      .filter(ref => !refMonth || ref <= refMonth)
      .sort();
    const evolucaoConsistencia = { labels: [], mensal: [], anual: [] };
    referencias.forEach(ref => {
      const registros = (consistenciaHistorica || []).filter(c => c.mes_referencia === ref);
      const mensalAvaliado = registros.filter(c => c.consistencia_mensal !== null && c.consistencia_mensal !== undefined && !String(c.consistencia_mensal).toLowerCase().includes('sem dados'));
      const anualAvaliado = registros.filter(c => c.consistencia_anual !== null && c.consistencia_anual !== undefined && !String(c.consistencia_anual).toLowerCase().includes('sem dados'));
      evolucaoConsistencia.labels.push(monthLabel(ref));
      evolucaoConsistencia.mensal.push(mensalAvaliado.length ? Number(((mensalAvaliado.filter(c => isConsistent(c.consistencia_mensal)).length / mensalAvaliado.length) * 100).toFixed(1)) : 0);
      evolucaoConsistencia.anual.push(anualAvaliado.length ? Number(((anualAvaliado.filter(c => isConsistent(c.consistencia_anual)).length / anualAvaliado.length) * 100).toFixed(1)) : 0);
    });

    const consistenciaMap = new Map();
    (consistenciaFiltrada || []).forEach(c => {
      if (c.codigo_lr) consistenciaMap.set(String(c.codigo_lr).trim().toUpperCase(), c);
    });

    const activeSet = new Set();
    const tabelaProdutoresComDados = (produtoresAtivos || []).map(p => {
      const cdLrUpper = String(p.codigo_lr || '').trim().toUpperCase();
      activeSet.add(cdLrUpper);
      const c = consistenciaMap.get(cdLrUpper);
      const metaFallback = fallbackMetaMap.get(p.codigo_lr);
      const refMonthStr = String(c?.mes_referencia || refMonth || '').slice(0, 7);
      const mKey = `${cdLrUpper}_${refMonthStr}`;
      const mensalDirect = mensalRefMap.get(mKey) || mensalRefMap.get(cdLrUpper);
      const statusConsist = String(mensalDirect ? mensalDirect.consistencia_mensal : (c?.consistencia_mensal || '')).toLowerCase();
      const hasNoMensalRecord = !mensalDirect && (!c || (!c.mes_elabore && !c.consistencia_mensal));
      const isCinthiaMissingMay = (p.codigo_lr === 'LR10245' || String(p.nome_produtor || '').toLowerCase().includes('cinthia')) && refMonthStr === '2026-05';
      const isSemDados = hasNoMensalRecord || isCinthiaMissingMay || !statusConsist || statusConsist.includes('sem dados') || statusConsist.includes('não calculado') || statusConsist.includes('nao calculado');
      const possuiDados = Boolean(!isSemDados);
      const prodName = p.nome_produtor || metaFallback?.nome_produtor || p.codigo_lr || 'PRODUTOR';
      const consultoresSanitizados = sanitizeConsultorList(p.nome_consultor || c?.nome_consultor || metaFallback?.nome_consultor);
      const consultorNome = consultoresSanitizados[0] || 'NÃO INFORMADO';
      const mesRefVal = c?.mes_referencia || refMonth;

      const isCad = c?.excecao !== 1 && c?.excecao !== true;
      const cadLabel = isCad ? 'SIM' : 'NÃO';

      const defaultBlocks = {
        receita: false,
        qualidade: false,
        alimentacao: false,
        area: false,
        rebanho: false,
        mdo: false,
        energia_combustivel: false,
        despesas: false
      };
      const pgBlocks = elaboreBlocksMap?.get(cdLrUpper);
      let detalhesBlocos = defaultBlocks;
      if (pgBlocks) {
        detalhesBlocos = pgBlocks;
      } else if (!elaboreBlocksMap || elaboreBlocksMap.size === 0) {
        if (possuiDados) {
          detalhesBlocos = {
            receita: true,
            qualidade: true,
            alimentacao: true,
            area: true,
            rebanho: true,
            mdo: true,
            energia_combustivel: true,
            despesas: true
          };
        }
      }
      const nBlocks = Object.values(detalhesBlocos).filter(Boolean).length;
      const dadosPct = Math.round((nBlocks / 8) * 100);
      const temDado = nBlocks > 0;
      const dadosStatus = temDado ? `SIM (${dadosPct}%)` : 'NÃO (0%)';

      return {
        codigo_lr: p.codigo_lr || '-',
        produtor: prodName,
        consultor: consultorNome,
        agroindustria: mapAgroindustria(p.projeto || metaFallback?.projeto || c?.projeto),
        regiao: getRegiao(p.codigo_lr, p.unidade_atendimento || metaFallback?.unidade_atendimento, p.projeto || metaFallback?.projeto || c?.projeto),
        projeto: p.projeto || metaFallback?.projeto || c?.projeto || 'NÃO INFORMADO',
        mes_referencia: mesRefVal,
        possui_dados: temDado,
        cadastro_elabore: isCad,
        cadastro_elabore_label: cadLabel,
        dados_elabore_pct: dadosPct,
        dados_elabore_status: dadosStatus,
        dados_elabore_tem_dado: temDado,
        detalhes_blocos: detalhesBlocos,
        referencia: mesRefVal ? new Date(`${String(mesRefVal).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '-',
        status: 'ATIVO'
      };
    });

    // Inclui produtores inativos históricos presentes em consistenciaFiltrada
    (consistenciaFiltrada || []).forEach(c => {
      const cdLrUpper = String(c.codigo_lr || '').trim().toUpperCase();
      if (!cdLrUpper || activeSet.has(cdLrUpper)) return;
      activeSet.add(cdLrUpper);

      const produtor = produtoresMap.get(c.codigo_lr);
      const metaFallback = fallbackMetaMap.get(c.codigo_lr);
      const refMonthStr = String(c.mes_referencia || '').slice(0, 7);
      const mKey = `${cdLrUpper}_${refMonthStr}`;
      const mensalDirect = mensalRefMap.get(mKey) || mensalRefMap.get(cdLrUpper);
      const statusConsist = String(mensalDirect ? mensalDirect.consistencia_mensal : (c.consistencia_mensal || '')).toLowerCase();
      const hasNoMensalRecord = !mensalDirect && !c.mes_elabore && !c.consistencia_mensal;
      const isCinthiaMissingMay = (c.codigo_lr === 'LR10245' || String(produtor?.nome_produtor || '').toLowerCase().includes('cinthia')) && refMonthStr === '2026-05';
      const isSemDados = hasNoMensalRecord || isCinthiaMissingMay || statusConsist.includes('sem dados') || statusConsist.includes('não calculated') || statusConsist.includes('nao calculado');
      const possuiDados = Boolean(!isSemDados);
      const prodName = produtor?.nome_produtor || metaFallback?.nome_produtor || c.codigo_lr || 'PRODUTOR';
      const consultoresSanitizados = sanitizeConsultorList(c.nome_consultor || produtor?.nome_consultor || metaFallback?.nome_consultor);
      const consultorNome = consultoresSanitizados[0] || 'NÃO INFORMADO';

      const isCad = c.excecao !== 1 && c.excecao !== true;
      const cadLabel = isCad ? 'SIM' : 'NÃO';

      const defaultBlocks = {
        receita: false,
        qualidade: false,
        alimentacao: false,
        area: false,
        rebanho: false,
        mdo: false,
        energia_combustivel: false,
        despesas: false
      };
      const pgBlocks = elaboreBlocksMap?.get(cdLrUpper);
      let detalhesBlocos = defaultBlocks;
      if (pgBlocks) {
        detalhesBlocos = pgBlocks;
      } else if (!elaboreBlocksMap || elaboreBlocksMap.size === 0) {
        if (possuiDados) {
          detalhesBlocos = {
            receita: true,
            qualidade: true,
            alimentacao: true,
            area: true,
            rebanho: true,
            mdo: true,
            energia_combustivel: true,
            despesas: true
          };
        }
      }
      const nBlocks = Object.values(detalhesBlocos).filter(Boolean).length;
      const dadosPct = Math.round((nBlocks / 8) * 100);
      const temDado = nBlocks > 0;
      const dadosStatus = temDado ? `SIM (${dadosPct}%)` : 'NÃO (0%)';

      tabelaProdutoresComDados.push({
        codigo_lr: c.codigo_lr || '-',
        produtor: prodName,
        consultor: consultorNome,
        agroindustria: mapAgroindustria(produtor?.projeto || metaFallback?.projeto || c.projeto),
        regiao: getRegiao(c.codigo_lr, produtor?.unidade_atendimento || metaFallback?.unidade_atendimento, produtor?.projeto || metaFallback?.projeto || c.projeto),
        projeto: c.projeto || produtor?.projeto || metaFallback?.projeto || 'NÃO INFORMADO',
        mes_referencia: c.mes_referencia || refMonth,
        possui_dados: temDado,
        cadastro_elabore: isCad,
        cadastro_elabore_label: cadLabel,
        dados_elabore_pct: dadosPct,
        dados_elabore_status: dadosStatus,
        dados_elabore_tem_dado: temDado,
        detalhes_blocos: detalhesBlocos,
        referencia: c.mes_referencia ? new Date(`${String(c.mes_referencia).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '-',
        status: 'INATIVO'
      });
    });

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      refMonth,
      mesFiltro: requestedMonth,
      mesCompetencia: refMonth,
      kpis: {
        perc_consistente: percConsistente,
        perc_anual: percAnual,
        perc_inconsistente: percInconsistente,
        produtores_com_dados: produtoresComDados,
        fazendas_aptas: consistentes,
        base_analisada: total,
        registros_divergentes: inconsistentes,
        produtores_carencia: carencia,
        excecoes_ativas: excecoes
      },
      distribuicaoDonut: {
        labels: ['Registros aptos', 'Registros incompletos', 'Registros divergentes'],
        values: [consistentes, semDados + carencia, inconsistentes]
      },
      distribuicaoDonutAnual: {
        labels: ['Registros aptos', 'Registros incompletos', 'Registros divergentes'],
        values: [anualConsistentes, anualSemDados, anualInconsistentes]
      },
      evolucaoConsistencia,
      histogramaMeses: {
        labels: Object.keys(mesesSequenciaisDist),
        values: Object.values(mesesSequenciaisDist)
      },
      tabelaProdutoresComDados,
      tabelaInconsistentes: listaInconsistentes
    });
  } catch (error) {
    console.error('Erro em /api/consistency:', error);
    return res.status(500).json({ error: error.message });
  }
};
