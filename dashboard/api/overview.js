const {
  getSupabaseClient,
  fetchAll,
  fetchWithCache,
  monthLabel,
  formatDate,
  normalizeName,
  sanitizeConsultorList,
  isNonFieldConsultant,
  isTestData,
  ehCadeiaLeite,
  isValidoLeite,
  mapAgroindustria,
  shiftMonthMinus1,
  expandRows,
  deduplicateAndFilterVisits
} = require('./shared');


module.exports = async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const supabase = getSupabaseClient();
    const { getRegiaoMap, getDimRegioesMap, sanitizeRegiao, getProdutoresAtivos } = require('./azurePostgres');

    // 1. Metadados e Tabelas Dimensão com Cache
    const [agrosDB, consultoresDB, regiaoMap, dimRegioesData] = await Promise.all([
      fetchWithCache('DIM_AGROINDUSTRIA_CANONICAL', async () => {
        try {
          const { data } = await supabase
            .from('sq_dim_agroindustria')
            .select('*')
            .eq('status', 'Ativo')
            .eq('excluido', 0);
          return data || [];
        } catch (_) {
          return [];
        }
      }),
      fetchWithCache('DIM_CONSULTOR', () =>
        fetchAll(() => supabase.from('sq_dim_consultor').select('nome_consultor, formacao_consultor, nomeConsultor, formacaoConsultor')).catch(() => [])
      ),
      getRegiaoMap(supabase, fetchAll).catch(() => new Map()),
      getDimRegioesMap(supabase).catch(() => ({ deParaMap: new Map(), regioesPorAgro: new Map(), todasRegioesFormatadas: [] }))
    ]);

    const agroindustriasOficiais = (agrosDB || [])
      .map(a => {
        const raw = a.nome_agroindustria;
        const formatada = a.nome_agroindustria_formatada;
        if (formatada) return formatada;
        if (raw === 'Laticínios Porto Alegre' || String(raw).toUpperCase().includes('PORTO ALEGRE')) {
          return 'Laticínios Porto Alegre (LPA)';
        }
        return mapAgroindustria(raw);
      })
      .filter(Boolean)
      .filter(ehCadeiaLeite);

    if (!agroindustriasOficiais.includes('NÃO INFORMADA')) {
      agroindustriasOficiais.push('NÃO INFORMADA');
    }

    const profissaoMap = new Map();
    (consultoresDB || []).forEach(c => {
      const nome = c.nome_consultor || c.nomeConsultor;
      const formacao = c.formacao_consultor || c.formacaoConsultor;
      if (nome && formacao) {
        profissaoMap.set(normalizeName(nome), String(formacao).trim());
      }
    });

    function getRegiao(codigoLr, fallback, agroindustria = null, projeto = null) {
      const agro = agroindustria || mapAgroindustria(projeto);
      let rawReg = null;
      if (codigoLr && regiaoMap.has(String(codigoLr).trim())) {
        rawReg = regiaoMap.get(String(codigoLr).trim());
      } else if (fallback) {
        rawReg = fallback;
      }

      if (rawReg) {
        const rawTrim = String(rawReg).trim();
        // 1. Prioridade absoluta: de-para oficial de sq_dim_regiao combinando com agroindústria
        if (agro) {
          const agroKey = `${agro.toUpperCase()}|${rawTrim.toUpperCase()}`;
          if (dimRegioesData.deParaMap && dimRegioesData.deParaMap.has(agroKey)) {
            return dimRegioesData.deParaMap.get(agroKey);
          }
        }
        // 2. Chave simples de sq_dim_regiao
        if (dimRegioesData.deParaMap && dimRegioesData.deParaMap.has(rawTrim.toUpperCase())) {
          return dimRegioesData.deParaMap.get(rawTrim.toUpperCase());
        }
        // 3. Sanitização padrão de fallback
        const clean = sanitizeRegiao(rawReg, projeto);
        if (clean) return clean;
      }
      return 'NÃO INFORMADA';
    }

    // 2. Mês de referência (Mês Atual no fuso horário do Brasil)
    const nowLocal = new Date();
    const nowUtc3 = new Date(nowLocal.getTime() - (nowLocal.getTimezoneOffset() * 60000));
    const maxAllowedMonth = nowUtc3.toISOString().slice(0, 7) + '-01';

    const requestedMonth = String(req.query?.month || '').slice(0, 10);
    const isAllMonths = !/^\d{4}-\d{2}-\d{2}$/.test(requestedMonth);

    const visitasMonth = isAllMonths ? null : requestedMonth;
    const consistencyMonth = visitasMonth;
    const refMonth = visitasMonth;

    // 3. Consultar produtores ativos
    const produtoresListRaw = await getProdutoresAtivos(supabase, fetchAll, visitasMonth, maxAllowedMonth);
    const produtoresConsistenciaRaw = produtoresListRaw;
    const produtoresList = (produtoresListRaw || []).filter(p => isValidoLeite(p.nome_consultor, p.projeto, p.codigo_lr, p.tipo_ponto_atendimento));
    const produtoresConsistencia = (produtoresConsistenciaRaw || []).filter(p => isValidoLeite(p.nome_consultor, p.projeto, p.codigo_lr, p.tipo_ponto_atendimento));

    // 4. Consultar visitas do mês selecionado com Cache
    const visitasListRaw = await fetchWithCache(`FATO_VISITAS_${visitasMonth || 'ALL'}`, async () => {
      try {
        let q = supabase
          .from('sq_fato_visitas')
          .select('id, codigo_lr, nome_consultor, nome_produtor, nome_propriedade, data_visita, id_atendimento, projeto, mes_referencia, tipo_visita, valor_pago_produtor, valor_pago_agroindustria')
          .neq('tipo_visita', 'EFICIENCIA ALIMENTAR');
        if (visitasMonth) q = q.eq('mes_referencia', visitasMonth);
        return await fetchAll(() => q.order('data_visita', { ascending: false }));
      } catch (e) {
        let q = supabase
          .from('sq_fato_visitas')
          .select('id, codigo_lr, nome_consultor, nome_produtor, nome_propriedade, data_visita, id_atendimento, projeto, mes_referencia, tipo_visita')
          .neq('tipo_visita', 'EFICIENCIA ALIMENTAR');
        if (visitasMonth) q = q.eq('mes_referencia', visitasMonth);
        return await fetchAll(() => q.order('data_visita', { ascending: false })).catch(() => []);
      }
    });

    let visitasList = (visitasListRaw || []).filter(v => isValidoLeite(v.nome_consultor, v.projeto, v.codigo_lr, null, v.tipo_visita));

    if (visitasList.length === 0 && visitasMonth) {
      const [anoRef, mesRef] = visitasMonth.split('-');
      const ultimoDiaMes = new Date(Number(anoRef), Number(mesRef), 0).getDate();
      const dtInicio = `${visitasMonth}`;
      const dtFim = `${anoRef}-${mesRef}-${String(ultimoDiaMes).padStart(2, '0')}`;
      const visitasFallback = await fetchWithCache(`RAW_VISITAS_FALLBACK_${dtInicio}_${dtFim}`, () =>
        fetchAll(() => supabase
          .from('sq_raw_visitas')
          .select('id_atendimento, codigo_lr, nome_consultor, nome_produtor, data_visita, tipo_visita, valor_pago_produtor, valor_pago_agroindustria')
          .neq('tipo_visita', 'EFICIENCIA ALIMENTAR')
          .gte('data_visita', dtInicio)
          .lte('data_visita', dtFim)
          .order('data_visita', { ascending: false })).catch(() => [])
      );
      if (visitasFallback && visitasFallback.length > 0) {
        visitasList = visitasFallback.map(v => ({
          ...v,
          nome_propriedade: 'PROPRIEDADE',
          projeto: 'Leite',
          mes_referencia: visitasMonth
        })).filter(v => isValidoLeite(v.nome_consultor, v.projeto, v.codigo_lr, null, v.tipo_visita));
      }
    }

    // Deduplicação por id_atendimento e remoção de registros inválidos/administrativos (inclusive EFICIENCIA ALIMENTAR)
    visitasList = deduplicateAndFilterVisits(visitasList);

    // 5. Histórico completo com cache
    const [visitasHistoricasRaw, produtoresHistoricosRaw, vinculosSQRaw] = await Promise.all([
      fetchWithCache('HIST_FATO_VISITAS', () =>
        fetchAll(() => supabase
          .from('sq_fato_visitas')
          .select('codigo_lr, nome_consultor, nome_produtor, projeto, mes_referencia, data_visita, id_atendimento, tipo_visita')
          .neq('tipo_visita', 'EFICIENCIA ALIMENTAR')
          .order('mes_referencia', { ascending: false })
          .order('codigo_lr', { ascending: true })).catch(() => [])
      ),
      getProdutoresAtivos(supabase, fetchAll, null, maxAllowedMonth),
      fetchWithCache('RAW_VINCULOS_ALL', () =>
        fetchAll(() => supabase
          .from('sq_raw_vinculos')
          .select('codigo_lr, data_associacao, consultor_grupo_atendimento, grupo_atendimento, projeto, unidade_atendimento, vinculo_ativo')
          .order('data_associacao', { ascending: true })).catch(() => [])
      )
    ]);

    const visitasHistoricas = deduplicateAndFilterVisits((visitasHistoricasRaw || []).filter(v => isValidoLeite(v.nome_consultor, v.projeto, v.codigo_lr, null, v.tipo_visita)));

    const produtoresHistoricos = (produtoresHistoricosRaw || []).filter(p => isValidoLeite(p.nome_consultor, p.projeto, p.codigo_lr, p.tipo_ponto_atendimento));

    // Filtros selecionados no frontend
    const filters = {
      industry: String(req.query?.industry || '').trim(),
      region: String(req.query?.region || '').trim(),
      project: String(req.query?.project || '').trim(),
      consultant: String(req.query?.consultant || '').trim(),
      producer: String(req.query?.producer || '').trim(),
      status: String(req.query?.status || '').trim()
    };

    function rowMatches(row) {
      const codUpper = String(row.codigo_lr || row.codigo_produtor || '').toUpperCase();
      if (codUpper.includes('_CONSULTOR') || codUpper.includes('CONSULTOR_')) return false;
      const consUpper = String(row.nome_consultor || row.consultor || row.grupo_ponto_atendimento || '').toUpperCase();
      if (consUpper.includes('SUPERVISAO') || consUpper.includes('SUPERVISÃO') || consUpper.includes('AGRICULTURA')) {
        if (!codUpper.startsWith('LR')) return false;
      }
      if (isNonFieldConsultant(row.nome_consultor || row.consultor)) return false;
      if (!ehCadeiaLeite(row.projeto || row.agroindustria)) return false;
      const rowAgro = row.agroindustria || mapAgroindustria(row.projeto);
      if (filters.industry && rowAgro !== filters.industry) return false;
      if (filters.region && getRegiao(row.codigo_lr, row.unidade_atendimento || row.regiao, rowAgro, row.projeto) !== filters.region) return false;
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

    const produtoresFiltrados = produtoresList.filter(rowMatches);
    const produtoresConsistenciaFiltrados = produtoresConsistencia.filter(rowMatches);
    const visitasFiltradas = visitasList.filter(rowMatches);
    const produtoresHistFiltrados = (produtoresHistoricos || []).filter(rowMatches);
    const visitasHistFiltradas = (visitasHistoricas || []).filter(rowMatches);

    // 6. Consultar movimentação, inativações e consistência com cache
    const [movimentacoes, consistenciaList, elaboreMensalList, inativacoesList] = await Promise.all([
      fetchWithCache('FATO_MOVIMENTACAO', () =>
        fetchAll(() => supabase
          .from('sq_fato_movimentacao')
          .select('codigo_lr, nome_consultor, data_movimentacao, movimentacao, motivo_inativacao, outro_motivo')
          .order('data_movimentacao', { ascending: false })).catch(() => [])
      ),
      fetchWithCache(`FATO_CONSISTENCIA_${visitasMonth || 'ALL'}`, async () => {
        if (!visitasMonth) {
          return await fetchAll(() => supabase
            .from('sq_fato_consistencia')
            .select('codigo_lr, consistencia_mensal, consistencia_anual, mes_elabore, mes_referencia')
            .order('mes_referencia', { ascending: false })
            .order('codigo_lr', { ascending: true })).catch(() => []);
        }
        // mes_elabore e mes_referencia são timestamptz — .or() com string falha; usar dois .eq() separados
        const [byElab, byRef] = await Promise.all([
          fetchAll(() => supabase
            .from('sq_fato_consistencia')
            .select('codigo_lr, consistencia_mensal, consistencia_anual, mes_elabore, mes_referencia')
            .eq('mes_elabore', visitasMonth)).catch(() => []),
          fetchAll(() => supabase
            .from('sq_fato_consistencia')
            .select('codigo_lr, consistencia_mensal, consistencia_anual, mes_elabore, mes_referencia')
            .eq('mes_referencia', visitasMonth)).catch(() => [])
        ]);
        const seen = new Set();
        return [...byElab, ...byRef].filter(r => {
          const k = `${r.codigo_lr}_${String(r.mes_referencia || '').slice(0, 7)}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }),
      fetchWithCache(`RAW_CONSISTENCIA_MENSAL_${visitasMonth || 'ALL'}`, async () => {
        if (!visitasMonth) {
          return await fetchAll(() => supabase
            .from('sq_raw_consistencia_mensal')
            .select('codigo_lr, mes_elabore, consistencia_mensal, mes_referencia')
            .order('mes_referencia', { ascending: false })).catch(() => []);
        }
        const [byElab, byRef] = await Promise.all([
          fetchAll(() => supabase
            .from('sq_raw_consistencia_mensal')
            .select('codigo_lr, mes_elabore, consistencia_mensal, mes_referencia')
            .eq('mes_elabore', visitasMonth)).catch(() => []),
          fetchAll(() => supabase
            .from('sq_raw_consistencia_mensal')
            .select('codigo_lr, mes_elabore, consistencia_mensal, mes_referencia')
            .eq('mes_referencia', visitasMonth)).catch(() => [])
        ]);
        const seen = new Set();
        return [...byElab, ...byRef].filter(r => {
          const k = `${r.codigo_lr}_${String(r.mes_referencia || '').slice(0, 7)}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }),
      fetchWithCache('RAW_INATIVACOES_PRODUTOR_OVERVIEW', () =>
        fetchAll(() => supabase
          .from('sq_raw_inativacoes_produtor')
          .select('codigo_lr')).catch(() => [])
      )
    ]);

    const inativacoesSet = new Set();
    (inativacoesList || []).forEach(i => {
      if (i.codigo_lr) inativacoesSet.add(String(i.codigo_lr).trim().toUpperCase());
    });
    (movimentacoes || []).forEach(m => {
      const isSaida = String(m.movimentacao || '').toLowerCase().includes('sa') || Boolean(m.motivo_inativacao);
      if (isSaida && m.codigo_lr) inativacoesSet.add(String(m.codigo_lr).trim().toUpperCase());
    });

    const fonteElabore = (elaboreMensalList && elaboreMensalList.length > 0) ? elaboreMensalList : (consistenciaList || []);

    const elaboreMensalMap = new Map();
    fonteElabore.forEach(item => {
      const cod = String(item.codigo_lr).trim().toUpperCase();
      if (item.mes_elabore) {
        elaboreMensalMap.set(`${cod}_${String(item.mes_elabore).slice(0, 7)}`, item);
      }
      if (item.mes_referencia) {
        elaboreMensalMap.set(`${cod}_${String(item.mes_referencia).slice(0, 7)}`, item);
      }
    });

    const elaboreSet = new Set(
      fonteElabore
        .filter(item => item.mes_elabore || (item.consistencia_mensal && !String(item.consistencia_mensal).toLowerCase().includes('sem dados')))
        .map(item => String(item.codigo_lr).trim().toUpperCase())
    );

    const produtoresMap = new Map((produtoresFiltrados || []).map(p => [p.codigo_lr, p]));
    const produtoresConsistenciaMap = new Map((produtoresConsistenciaFiltrados || []).map(p => [p.codigo_lr, p]));
    const consistenciaFiltrada = (consistenciaList || []).filter(c => {
      const p = produtoresConsistenciaMap.get(c.codigo_lr);
      return rowMatches({ ...c, unidade_atendimento: p?.unidade_atendimento, nome_produtor: p?.nome_produtor });
    });

    // KPIs
    const setCodigosAtivos = new Set(produtoresFiltrados.map(p => p.codigo_lr).filter(Boolean));
    const totalAtivos = setCodigosAtivos.size || produtoresFiltrados.length;
    const totalVisitas = visitasFiltradas.length;
    const consultoresAtivos = new Set(
      produtoresFiltrados.flatMap(p => sanitizeConsultorList(p.nome_consultor)).filter(Boolean)
    ).size;

    // Apenas contar produtores visitados que pertencem à carteira ativa do filtro
    const codigosVisitados = new Set(
      visitasFiltradas
        .map(v => v.codigo_lr)
        .filter(c => c && (setCodigosAtivos.size === 0 || setCodigosAtivos.has(c)))
    );
    const totalVisitadosUnicos = codigosVisitados.size;

    const percVisitados = totalAtivos > 0 ? Math.min(100.0, (totalVisitadosUnicos / totalAtivos) * 100).toFixed(1) : '0.0';
    const visitasPorProdutor = totalAtivos > 0 ? (totalVisitas / totalAtivos).toFixed(1) : '0.0';

    let consistentesCount = 0;
    let avaliadosCount = 0;
    let comDadosCount = 0;

    consistenciaFiltrada.forEach(c => {
      const cdLrUpper = String(c.codigo_lr || '').trim().toUpperCase();
      const monthKey = String(c.mes_referencia || '').slice(0, 7);
      const mensalItem = elaboreMensalMap.get(`${cdLrUpper}_${monthKey}`) || c;
      const status = String(mensalItem.consistencia_mensal || c.consistencia_mensal || '').toLowerCase();
      if (status && !status.includes('sem dados') && !status.includes('não calculado')) {
        comDadosCount++;
        avaliadosCount++;
        if (status.includes('consistente') && !status.includes('inconsistente')) {
          consistentesCount++;
        }
      }
    });

    const percConsistente = avaliadosCount > 0 
      ? ((consistentesCount / avaliadosCount) * 100).toFixed(1)
      : '0.0';

    function gerarMesesHistoricos(inicioStr, fimStr) {
      const meses = [];
      const [anoInicio, mesInicio] = inicioStr.split('-').map(Number);
      const [anoFim, mesFim] = fimStr.split('-').map(Number);
      let curAno = anoInicio;
      let curMes = mesInicio;
      while (curAno < anoFim || (curAno === anoFim && curMes <= mesFim)) {
        const strMes = `${curAno}-${String(curMes).padStart(2, '0')}-01`;
        meses.push(strMes);
        curMes++;
        if (curMes > 12) {
          curMes = 1;
          curAno++;
        }
      }
      return meses;
    }

    const mesesComDados = [...new Set([
      ...(produtoresHistoricos || []).map(p => p.data_referencia),
      ...(visitasHistoricas || []).map(v => v.mes_referencia)
    ].filter(Boolean))].sort();

    const primeiroMesReal = mesesComDados.length > 0 ? mesesComDados[0] : '2026-01-01';
    const mesesHistoricosPadrao = gerarMesesHistoricos(primeiroMesReal, maxAllowedMonth);
    const todosMesesDisponiveis = [...new Set([
      ...mesesHistoricosPadrao,
      ...mesesComDados,
      maxAllowedMonth
    ].filter(Boolean))]
      .filter(m => m <= maxAllowedMonth)
      .sort();

    const MINIMO_MES_HISTORICO = '2026-01-01';
    const referencias = todosMesesDisponiveis.filter(ref => ref >= MINIMO_MES_HISTORICO && (!visitasMonth || ref <= visitasMonth));
    const visitasPorMes = new Map();
    const ativosPorMes = new Map();
    (visitasHistFiltradas || []).forEach(v => {
      if (!v.mes_referencia) return;
      if (!visitasPorMes.has(v.mes_referencia)) visitasPorMes.set(v.mes_referencia, { total: 0, produtores: new Set() });
      const item = visitasPorMes.get(v.mes_referencia);
      item.total += 1;
      if (v.codigo_lr) item.produtores.add(v.codigo_lr);
    });
    (produtoresHistFiltrados || []).forEach(p => {
      if (!p.data_referencia) return;
      if (!ativosPorMes.has(p.data_referencia)) ativosPorMes.set(p.data_referencia, new Set());
      if (p.codigo_lr) ativosPorMes.get(p.data_referencia).add(p.codigo_lr);
    });

    const fazendasVisitadasNoPortfolio = referencias.map(ref => {
      const setAtivos = ativosPorMes.get(ref);
      const setVisitados = visitasPorMes.get(ref)?.produtores;
      if (!setVisitados || setVisitados.size === 0) return 0;
      if (!setAtivos || setAtivos.size === 0) return setVisitados.size;
      let count = 0;
      for (const cod of setVisitados) {
        if (setAtivos.has(cod)) count++;
      }
      return count;
    });

    const evolucaoMensal = {
      labels: referencias.map(monthLabel),
      fazendasAtivas: referencias.map(ref => ativosPorMes.get(ref)?.size || 0),
      fazendasVisitadas: fazendasVisitadasNoPortfolio,
      percCobertura: referencias.map((ref, idx) => {
        const ativos = ativosPorMes.get(ref)?.size || 0;
        const visitadosNoPort = fazendasVisitadasNoPortfolio[idx] || 0;
        if (ativos === 0) return 0;
        const ratio = (visitadosNoPort / ativos) * 100;
        return Number(Math.min(100.0, Math.max(0, ratio)).toFixed(1));
      })
    };

    const evolucaoVisitas = {
      labels: referencias.map(monthLabel),
      values: referencias.map(ref => visitasPorMes.get(ref)?.total || 0)
    };

    const rankingMap = new Map();
    visitasFiltradas.forEach(v => {
      const nome = v.nome_produtor || v.codigo_lr || 'Produtor não identificado';
      rankingMap.set(nome, (rankingMap.get(nome) || 0) + 1);
    });
    const ranking = [...rankingMap.entries()].sort((a, b) => b[1] - a[1]);

    const hoje = new Date();
    let dataCorte = hoje;
    if (visitasMonth) {
      const parts = String(visitasMonth).slice(0, 10).split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        const lastDayOfMonth = new Date(year, month, 0, 23, 59, 59);
        if (lastDayOfMonth < hoje) {
          dataCorte = lastDayOfMonth;
        }
      }
    }

    const prevMonthStr = shiftMonthMinus1(visitasMonth || maxAllowedMonth);
    const prevMonthPrefix = prevMonthStr ? prevMonthStr.slice(0, 7) : null;

    const ultimaVisitaMap = new Map();
    const visitaMesAnteriorMap = new Map();
    (visitasHistoricas || []).forEach(v => {
      if (!v.codigo_lr || !v.data_visita) return;
      const cod = String(v.codigo_lr).trim().toUpperCase();
      const d = new Date(v.data_visita);
      if (Number.isNaN(d.getTime())) return;

      // 1. Mapear visita do mês anterior
      if (prevMonthPrefix) {
        const vMonth = String(v.mes_referencia || v.data_visita).slice(0, 7);
        if (vMonth === prevMonthPrefix) {
          const prevMA = visitaMesAnteriorMap.get(cod);
          if (!prevMA || d > prevMA) {
            visitaMesAnteriorMap.set(cod, d);
          }
        }
      }

      // 2. Mapear última visita considerando apenas visitas ocorridas ATÉ a data de corte (<= dataCorte)
      if (d <= dataCorte) {
        const prev = ultimaVisitaMap.get(cod);
        if (!prev || d > prev) {
          ultimaVisitaMap.set(cod, d);
        }
      }
    });

    const dataAssociacaoMap = new Map();
    (vinculosSQRaw || []).forEach(v => {
      if (!v.codigo_lr || !v.data_associacao) return;
      const cod = String(v.codigo_lr).trim().toUpperCase();
      const d = new Date(v.data_associacao);
      if (Number.isNaN(d.getTime())) return;
      const prev = dataAssociacaoMap.get(cod);
      if (!prev || d < prev) {
        dataAssociacaoMap.set(cod, d);
      }
    });

    // Tabela: Produtores sem visita — expande somente consultores válidos de campo
    const semVisita = expandRows(
      produtoresFiltrados.filter(p => !codigosVisitados.has(p.codigo_lr))
    ).filter(p => p.nome_consultor && p.nome_consultor !== 'NÃO ATRIBUÍDO' && !isNonFieldConsultant(p.nome_consultor))
     .map(p => {
        let diasSemVisita = null;
        const codNorm = String(p.codigo_lr || '').trim().toUpperCase();
        const dataUltimaVisita = codNorm ? ultimaVisitaMap.get(codNorm) : null;
        const dataAssoc = codNorm ? dataAssociacaoMap.get(codNorm) : null;

        if (dataUltimaVisita) {
          const diffMs = dataCorte.getTime() - dataUltimaVisita.getTime();
          diasSemVisita = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        } else if (dataAssoc) {
          const diffMs = dataCorte.getTime() - dataAssoc.getTime();
          diasSemVisita = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        } else if (p.data_referencia) {
          const dataVinc = new Date(`${String(p.data_referencia).slice(0, 10)}T12:00:00`);
          if (!Number.isNaN(dataVinc.getTime())) {
            const diffMs = dataCorte.getTime() - dataVinc.getTime();
            diasSemVisita = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
          }
        }

        const dataExibicao = dataAssoc
          ? formatDate(dataAssoc.toISOString().slice(0, 10))
          : formatDate(p.data_referencia);

        const dataUltimaVisitaExibicao = dataUltimaVisita
          ? formatDate(dataUltimaVisita.toISOString().slice(0, 10))
          : '—';

        const dataVisitaMesAnterior = codNorm ? visitaMesAnteriorMap.get(codNorm) : null;
        const dataVisitaMesAnteriorExibicao = dataVisitaMesAnterior
          ? formatDate(dataVisitaMesAnterior.toISOString().slice(0, 10))
          : '—';

        const agro = mapAgroindustria(p.projeto);

        // Classificação do Status na tabela Produtores sem visita
        const temInativacao = inativacoesSet.has(codNorm);
        let statusSemVisita = 'Sem visita no período';
        let statusBadgeClass = 'badge-warning';

        if (temInativacao) {
          statusSemVisita = 'Inativação Pendente';
          statusBadgeClass = 'badge-danger';
        } else if (!dataUltimaVisita) {
          const diffAssocMs = dataAssoc ? (dataCorte.getTime() - dataAssoc.getTime()) : null;
          const diasAssoc = diffAssocMs !== null ? Math.max(0, Math.floor(diffAssocMs / (1000 * 60 * 60 * 24))) : null;
          if (diasAssoc !== null && diasAssoc <= 45) {
            statusSemVisita = 'Vínculo Recente';
            statusBadgeClass = 'badge-positive';
          } else {
            statusSemVisita = 'Nunca visitado';
            statusBadgeClass = 'badge-danger';
          }
        } else if (diasSemVisita !== null && diasSemVisita !== undefined) {
          if (diasSemVisita >= 60) {
            statusSemVisita = 'Sem visita > 60 dias';
            statusBadgeClass = 'badge-danger';
          } else if (diasSemVisita >= 45) {
            statusSemVisita = 'Sem visita > 45 dias';
            statusBadgeClass = 'badge-warning';
          } else if (diasSemVisita >= 30) {
            statusSemVisita = 'Sem visita > 30 dias';
            statusBadgeClass = 'badge-warning';
          } else if (diasSemVisita <= 0) {
            statusSemVisita = 'Vínculo Recente';
            statusBadgeClass = 'badge-positive';
          } else {
            statusSemVisita = `Sem visita (${diasSemVisita}d)`;
            statusBadgeClass = 'badge-warning';
          }
        }

        return {
          consultor: p.nome_consultor || 'NÃO ATRIBUÍDO',
          codigo_lr: p.codigo_lr || '-',
          produtor: p.nome_produtor || 'PRODUTOR SEM NOME',
          propriedade: p.nome_propriedade || '-',
          agroindustria: agro,
          regiao: getRegiao(p.codigo_lr, p.regiao || p.unidade_atendimento, agro, p.projeto),
          projeto: p.projeto || 'NÃO INFORMADO',
          status: statusSemVisita,
          status_class: statusBadgeClass,
          mes_referencia: visitasMonth,
          data_associacao: dataExibicao,
          data_vinculacao: dataExibicao,
          data_visita_mes_anterior: dataVisitaMesAnteriorExibicao,
          data_ultima_visita: dataUltimaVisitaExibicao,
          dias_sem_visita: diasSemVisita
        };
      });

    // Tabela: Produtores visitados
    const visitados = expandRows(visitasFiltradas)
      .map(v => {
        const produtorAtivo = produtoresMap.get(v.codigo_lr);
        const normConsultor = normalizeName(v.nome_consultor);
        const profissao = profissaoMap.get(normConsultor) || '-';

        let numAtendimento = '-';
        if (v.id_atendimento !== null && v.id_atendimento !== undefined && !Number.isNaN(Number(v.id_atendimento))) {
          numAtendimento = `AT-${Math.floor(Number(v.id_atendimento))}`;
        } else if (v.id) {
          numAtendimento = `VIS-${v.id}`;
        }

        const codLrNorm = String(v.codigo_lr || '').trim().toUpperCase();
        const monthKey = String(v.mes_referencia || refMonth || '').slice(0, 7);
        const elaboreObj = elaboreMensalMap.get(`${codLrNorm}_${monthKey}`);
        const hasElabore = elaboreObj ? Boolean(elaboreObj.mes_elabore) : elaboreSet.has(codLrNorm);
        const agro = mapAgroindustria(v.projeto || produtorAtivo?.projeto);

        return ({
          consultor: v.nome_consultor || 'CONSULTOR',
          codigo_lr: v.codigo_lr || '-',
          produtor: v.nome_produtor || 'PRODUTOR',
          agroindustria: agro,
          regiao: getRegiao(v.codigo_lr, produtorAtivo?.regiao || produtorAtivo?.unidade_atendimento, agro, v.projeto || produtorAtivo?.projeto),
          projeto: v.projeto || produtorAtivo?.projeto || 'NÃO INFORMADO',
          status: 'ATIVO',
          mes_referencia: v.mes_referencia || refMonth,
          profissao: profissao,
          atendimento: numAtendimento,
          data_visita: formatDate(v.data_visita || v.mes_referencia),
          elabore_ok: hasElabore,
          tipo_visita: v.tipo_visita || 'RELATÓRIO DE VISITA LABOR RURAL - LEITE',
          valor_pago_produtor: Number(v.valor_pago_produtor || 0),
          valor_pago_agroindustria: Number(v.valor_pago_agroindustria || 0)
        });
      });

    // Tabela: Movimentações
    const listaMovimentacao = (movimentacoes || []).map(m => ({
      produtor: m.codigo_lr || 'PRODUTOR',
      movimentacao: String(m.movimentacao || '').toLowerCase().includes('sa') ? 'SAÍDA' : 'ENTRADA',
      grupo: m.nome_consultor || 'GRUPO',
      motivo: m.motivo_inativacao || m.outro_motivo || 'NOVO VÍNCULO'
    }));

    let dataProvenance = null;
    try {
      const fs = require('fs');
      const path = require('path');
      const metaPath = path.join(__dirname, '..', 'public', 'data', 'fontes_metadados.json');
      if (fs.existsSync(metaPath)) {
        dataProvenance = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    } catch (e) {
      console.warn('Metadados de proveniência não carregados:', e.message);
    }

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      refMonth: visitasMonth,
      visitasMonth,
      consistencyMonth,
      dataProvenance,
      kpis: {
        total_visitas: totalVisitas,
        consultores_ativos: consultoresAtivos,
        produtores_ativos: totalAtivos,
        produtores_visitados: totalVisitadosUnicos,
        visitas_por_produtor: visitasPorProdutor,
        perc_visitados: percVisitados,
        produtores_com_dados: comDadosCount,
        perc_consistente: percConsistente,
        visitas_nao_realizadas: null
      },
      evolucaoMensal,
      evolucaoVisitas,
      rankingProdutores: {
        labels: ranking.map(item => item[0]),
        values: ranking.map(item => item[1])
      },
      filterOptions: {
        agroindustrias: agroindustriasOficiais.sort((a, b) => a.localeCompare(b, 'pt-BR')),
        regioes: (dimRegioesData.todasRegioesFormatadas && dimRegioesData.todasRegioesFormatadas.length > 0)
          ? dimRegioesData.todasRegioesFormatadas
          : [...new Set(produtoresList.map(p => getRegiao(p.codigo_lr, p.unidade_atendimento, p.agroindustria, p.projeto)))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR')),
        projetos: [...new Set([...produtoresList.map(p => p.projeto), ...visitasList.map(v => v.projeto)])].filter(Boolean).filter(ehCadeiaLeite).sort(),
        consultores: [...new Set(produtoresList.flatMap(p => sanitizeConsultorList(p.nome_consultor)))].filter(Boolean).sort(),
        status: ['ATIVO', 'INATIVO'],
        meses: todosMesesDisponiveis
      },
      dim_fazendas: (produtoresList || []).map(p => {
        const agro = p.agroindustria || mapAgroindustria(p.projeto);
        return {
          codigo_lr: p.codigo_lr,
          produtor: p.nome_produtor,
          propriedade: p.nome_propriedade,
          consultor: p.nome_consultor,
          projeto: p.projeto,
          agroindustria: agro,
          regiao: getRegiao(p.codigo_lr, p.regiao || p.unidade_atendimento, agro, p.projeto),
          mes_referencia: p.data_referencia,
          status: p.status || 'ATIVO'
        };
      }),
      tabelas: {
        movimentacao: listaMovimentacao,
        sem_visita: semVisita,
        visitados: visitados
      }
    });
  } catch (error) {
    console.error('Erro em /api/overview:', error);
    return res.status(500).json({ error: error.message });
  }
};
