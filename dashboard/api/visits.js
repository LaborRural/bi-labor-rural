const {
  getSupabaseClient,
  fetchAll,
  fetchWithCache,
  sanitizeConsultorList,
  isTestData,
  ehCadeiaLeite,
  isValidoLeite,
  mapAgroindustria,
  isTipoVisitaDescartado,
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
    
    const nowLocal = new Date();
    const nowUtc3 = new Date(nowLocal.getTime() - (nowLocal.getTimezoneOffset() * 60000));
    const maxAllowedMonth = nowUtc3.toISOString().slice(0, 7) + '-01';

    const requestedMonth = String(req.query?.month || '').slice(0, 10);
    const isAllMonths = !/^\d{4}-\d{2}-\d{2}$/.test(requestedMonth);
    const refMonth = isAllMonths ? null : requestedMonth;

    const { getRegiaoMap, getDimRegioesMap, sanitizeRegiao, getProdutoresAtivos } = require('./azurePostgres');
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

    const produtoresBrutos = await getProdutoresAtivos(supabase, fetchAll, refMonth, maxAllowedMonth);

    let visitasBrutas = await fetchWithCache(`VISITS_FATO_VISITAS_${refMonth || 'ALL'}`, () =>
      fetchAll(() => {
        let q = supabase
          .from('sq_fato_visitas')
          .select('codigo_lr, nome_consultor, nome_produtor, projeto, mes_referencia, id_atendimento, tipo_visita')
          .neq('tipo_visita', 'EFICIENCIA ALIMENTAR');
        if (refMonth) q = q.eq('mes_referencia', refMonth);
        return q.order('codigo_lr', { ascending: true });
      }).catch(() => [])
    );

    if ((!visitasBrutas || visitasBrutas.length === 0) && refMonth) {
      const [anoRef, mesRef] = refMonth.split('-');
      const ultimoDiaMes = new Date(Number(anoRef), Number(mesRef), 0).getDate();
      const dtInicio = `${refMonth}`;
      const dtFim = `${anoRef}-${mesRef}-${String(ultimoDiaMes).padStart(2, '0')}`;
      const visitasFallback = await fetchWithCache(`VISITS_FALLBACK_${dtInicio}_${dtFim}`, () =>
        fetchAll(() => supabase
          .from('sq_raw_visitas')
          .select('id_atendimento, codigo_lr, nome_consultor, nome_produtor, data_visita, tipo_visita')
          .neq('tipo_visita', 'EFICIENCIA ALIMENTAR')
          .gte('data_visita', dtInicio)
          .lte('data_visita', dtFim)
          .order('data_visita', { ascending: false })).catch(() => [])
      );
      if (visitasFallback && visitasFallback.length > 0) {
        visitasBrutas = visitasFallback.map(v => ({
          ...v,
          projeto: 'Leite',
          mes_referencia: refMonth
        }));
      }
    }

    visitasBrutas = deduplicateAndFilterVisits(visitasBrutas);


    const produtoresFiltrados = (produtoresBrutos || []).filter(p => isValidoLeite(p.nome_consultor, p.projeto)).filter(rowMatches);
    const visitasFiltradas = (visitasBrutas || []).filter(v => isValidoLeite(v.nome_consultor, v.projeto, v.codigo_lr, null, v.tipo_visita)).filter(rowMatches);

    const totalAtivos = produtoresFiltrados.length;
    const totalVisitas = visitasFiltradas.length;

    // Agrupamento por consultor com sanitização de nomes (removendo não-consultores de campo)
    const consultoresMap = {};
    produtoresFiltrados.forEach(p => {
      const consultores = sanitizeConsultorList(p.nome_consultor);
      consultores.forEach(sanitizedC => {
        const c = sanitizedC || 'NÃO ATRIBUÍDO';
        if (isTestData(c, p.projeto)) return;
        if (!consultoresMap[c]) {
          consultoresMap[c] = {
            consultor: c,
            totalFarms: 0,
            farmCodes: new Set(),
            visitedFarms: new Set(),
            visitasCount: 0,
            industries: new Set(),
            projects: new Set(),
            regions: new Set()
          };
        }
        consultoresMap[c].totalFarms++;
        if (p.codigo_lr) consultoresMap[c].farmCodes.add(String(p.codigo_lr).trim().toUpperCase());
        if (p.projeto) {
          consultoresMap[c].projects.add(p.projeto);
          consultoresMap[c].industries.add(mapAgroindustria(p.projeto));
        }
        const reg = getRegiao(p.codigo_lr, p.unidade_atendimento, p.projeto);
        if (reg && reg !== 'NÃO INFORMADA') consultoresMap[c].regions.add(reg);
      });
    });

    visitasFiltradas.forEach(v => {
      const consultores = sanitizeConsultorList(v.nome_consultor);
      consultores.forEach(sanitizedC => {
        const c = sanitizedC || 'NÃO ATRIBUÍDO';
        if (!consultoresMap[c]) {
          consultoresMap[c] = {
            consultor: c,
            totalFarms: 0,
            farmCodes: new Set(),
            visitedFarms: new Set(),
            visitasCount: 0,
            industries: new Set(),
            projects: new Set(),
            regions: new Set()
          };
        }
        consultoresMap[c].visitasCount++;
        if (v.codigo_lr) consultoresMap[c].visitedFarms.add(String(v.codigo_lr).trim().toUpperCase());
      });
    });

    const consultoresList = Object.values(consultoresMap).map(c => {
      // 1. Fazendas da carteira do consultor que receberam visita
      let visitedInPortfolio = 0;
      if (c.farmCodes.size > 0) {
        c.visitedFarms.forEach(cod => {
          if (c.farmCodes.has(cod)) visitedInPortfolio++;
        });
      } else {
        visitedInPortfolio = c.visitedFarms.size;
      }

      // 2. Base da carteira: se tem carteira cadastrada usa totalFarms, senão usa visitedFarms
      const total = c.totalFarms > 0 ? c.totalFarms : (c.visitedFarms.size || 1);

      // 3. Cobertura da carteira estritamente limitada a 100%
      const cob = Math.min(100.0, (visitedInPortfolio / total) * 100).toFixed(1);

      return {
        consultor: c.consultor,
        total_fazendas: total,
        fazendas_visitadas: visitedInPortfolio,
        total_visitas: c.visitasCount,
        perc_cobertura: Number(cob),
        agroindustrias: [...c.industries],
        regioes: [...c.regions],
        projetos: [...(c.projects || [])],
        status: 'ATIVO',
        mes_referencia: refMonth
      };
    }).sort((a, b) => b.perc_cobertura - a.perc_cobertura || b.total_visitas - a.total_visitas);

    const topConsultores = consultoresList;
    const totalConsultoresAtivos = consultoresList.length;
    const mediaVisitasConsultor = (totalVisitas / (totalConsultoresAtivos || 1)).toFixed(1);

    // Contagem de produtores visitados que pertencem à carteira ativa (mesma lógica de overview.js)
    const setCodigosAtivos = new Set(produtoresFiltrados.map(p => p.codigo_lr).filter(Boolean));
    const codigosVisitadosNoPortfolio = new Set(
      visitasFiltradas
        .map(v => v.codigo_lr)
        .filter(c => c && (setCodigosAtivos.size === 0 || setCodigosAtivos.has(c)))
    );
    const visitadosUnicos = codigosVisitadosNoPortfolio.size;
    const fazendasNaoVisitadas = Math.max(0, totalAtivos - visitadosUnicos);
    const percCoberturaGeral = totalAtivos > 0 ? Math.min(100.0, (visitadosUnicos / totalAtivos) * 100).toFixed(1) : '0.0';

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      refMonth,
      kpis: {
        perc_cobertura_geral: percCoberturaGeral,
        total_visitas: totalVisitas,
        media_visitas_consultor: mediaVisitasConsultor,
        fazendas_nao_visitadas: fazendasNaoVisitadas
      },
      rankingConsultores: {
        labels: topConsultores.map(c => c.consultor),
        coberturas: topConsultores.map(c => c.perc_cobertura),
        visitas: topConsultores.map(c => c.total_visitas)
      },
      tabelaConsultores: consultoresList
    });
  } catch (error) {
    console.error('Erro em /api/visits:', error);
    return res.status(500).json({ error: error.message });
  }
};
