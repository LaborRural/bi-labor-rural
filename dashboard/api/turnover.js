const {
  getSupabaseClient,
  fetchAll,
  fetchWithCache,
  monthLabel,
  sanitizeConsultorList,
  isTestData,
  ehCadeiaLeite,
  isValidoLeite,
  mapAgroindustria
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

    const nowLocal = new Date();
    const nowUtc3 = new Date(nowLocal.getTime() - (nowLocal.getTimezoneOffset() * 60000));
    const maxAllowedMonth = nowUtc3.toISOString().slice(0, 7) + '-01';

    const [movimentacoesBrutas, produtoresBrutos, inativacoesFallback, vinculosFallback] = await Promise.all([
      fetchWithCache('TURNOVER_FATO_MOVIMENTACAO', () =>
        fetchAll(() => supabase
          .from('sq_fato_movimentacao')
          .select('codigo_lr, nome_produtor, nome_consultor, numero_atendimento, data_movimentacao, movimentacao, motivo_inativacao, outro_motivo')
          .order('data_movimentacao', { ascending: false })
          .order('codigo_lr', { ascending: true })).catch(() => [])
      ),
      getProdutoresAtivos(supabase, fetchAll, null, maxAllowedMonth),
      fetchWithCache('RAW_INATIVACOES_PRODUTOR', () =>
        fetchAll(() => supabase
          .from('sq_raw_inativacoes_produtor')
          .select('id_atendimento, codigo_lr, nome_produtor, nome_propriedade, projeto, grupo_ponto_atendimento')).catch(() => [])
      ),
      fetchWithCache('RAW_VINCULOS_META', () =>
        fetchAll(() => supabase
          .from('sq_raw_vinculos')
          .select('codigo_lr, nome_produtor, nome_propriedade, projeto, unidade_atendimento')).catch(() => [])
      )
    ]);

    const fallbackMetaMap = new Map();
    (vinculosFallback || []).forEach(v => {
      if (v.codigo_lr && !fallbackMetaMap.has(v.codigo_lr)) {
        fallbackMetaMap.set(v.codigo_lr, { nome_produtor: v.nome_produtor, projeto: v.projeto, unidade_atendimento: v.unidade_atendimento });
      }
    });
    (inativacoesFallback || []).forEach(i => {
      const meta = {
        nome_produtor: i.nome_produtor,
        projeto: i.projeto,
        unidade_atendimento: i.grupo_ponto_atendimento
      };
      if (i.codigo_lr) {
        const prev = fallbackMetaMap.get(i.codigo_lr) || {};
        fallbackMetaMap.set(i.codigo_lr, {
          nome_produtor: i.nome_produtor || prev.nome_produtor,
          projeto: i.projeto || prev.projeto,
          unidade_atendimento: i.unidade_atendimento || prev.unidade_atendimento
        });
      }
      if (i.id_atendimento) {
        fallbackMetaMap.set(`INAT_${i.id_atendimento}`, meta);
        fallbackMetaMap.set(String(i.id_atendimento), meta);
      }
    });

    const produtores = (produtoresBrutos || []).filter(p => isValidoLeite(p.nome_consultor, p.projeto)).filter(rowMatches);

    const produtoresMap = new Map();
    (produtores || []).forEach((produtor) => {
      if (produtor.codigo_lr && !produtoresMap.has(produtor.codigo_lr)) produtoresMap.set(produtor.codigo_lr, produtor);
    });

    const movimentacoes = (movimentacoesBrutas || []).filter(m => {
      const p = produtoresMap.get(m.codigo_lr) || fallbackMetaMap.get(m.codigo_lr);
      return rowMatches({ ...m, projeto: p?.projeto, unidade_atendimento: p?.unidade_atendimento, nome_produtor: p?.nome_produtor });
    });

    const requestedMonth = String(req.query?.month || '').slice(0, 10);
    const isAllMonths = !/^\d{4}-\d{2}-\d{2}$/.test(requestedMonth);
    const refMonth = isAllMonths ? null : requestedMonth;
    const produtoresFiltrados = refMonth
      ? produtores.filter(p => p.data_referencia === refMonth)
      : (produtores || []);

    const movimentacoesFiltradas = (movimentacoes || []).filter(m => !isTestData(m.nome_consultor, null));

    const totalAtivos = new Set(produtoresFiltrados.map(p => p.codigo_lr).filter(Boolean)).size || produtoresFiltrados.length;
    const totalConsultores = new Set(
      produtoresFiltrados.flatMap(p => sanitizeConsultorList(p.nome_consultor)).filter(Boolean)
    ).size;

    const currentMonthKey = refMonth ? String(refMonth).slice(0, 7) : null;
    const movimentacoesDoMes = currentMonthKey
      ? (movimentacoesFiltradas || []).filter(m => String(m.data_movimentacao || '').slice(0, 7) === currentMonthKey)
      : (movimentacoesFiltradas || []);

    let entradas = 0;
    let saidas = 0;
    const motivosMap = {};
    const tabelaMov = [];

    movimentacoesDoMes.forEach(m => {
      const isSaida = String(m.movimentacao || '').toLowerCase().includes('sa');
      const tipo = isSaida ? 'SAÍDA' : 'ENTRADA';
      if (tipo === 'ENTRADA') {
        entradas++;
      } else {
        saidas++;
        const mot = m.motivo_inativacao || m.outro_motivo || 'Outro Motivo';
        motivosMap[mot] = (motivosMap[mot] || 0) + 1;
      }
    });

    (movimentacoesDoMes || []).forEach(m => {
      const isSaida = String(m.movimentacao || '').toLowerCase().includes('sa');
      const tipo = isSaida ? 'SAÍDA' : 'ENTRADA';
      const produtorAtivo = produtoresMap.get(m.codigo_lr);
      const movementMonthKey = String(m.data_movimentacao || '').slice(0, 7);
      const metaFallback = fallbackMetaMap.get(m.codigo_lr);
      const nomeFinal = m.nome_produtor || produtorAtivo?.nome_produtor || metaFallback?.nome_produtor;
      const produtorNome = nomeFinal || (String(m.codigo_lr).includes('_CONSULTOR') ? 'CONTA DE SUPERVISÃO' : m.codigo_lr || 'PRODUTOR');
      
      const consultoresSanitizados = sanitizeConsultorList(m.nome_consultor);
      const consultorSanitizado = consultoresSanitizados[0] || 'NÃO ATRIBUÍDO';
      const atendFormatado = m.numero_atendimento ? String(m.numero_atendimento).replace(/\.0+$/, '').trim() : '—';
      
      tabelaMov.push({
        numero_atendimento: m.numero_atendimento || null,
        atendimento: atendFormatado,
        produtor: produtorNome,
        consultor: consultorSanitizado,
        grupo: consultorSanitizado,
        agroindustria: mapAgroindustria(produtorAtivo?.projeto || metaFallback?.projeto),
        regiao: getRegiao(m.codigo_lr, produtorAtivo?.unidade_atendimento || metaFallback?.unidade_atendimento, produtorAtivo?.projeto || metaFallback?.projeto),
        projeto: produtorAtivo?.projeto || metaFallback?.projeto || 'NÃO INFORMADO',
        status: tipo === 'SAÍDA' ? 'INATIVO' : 'ATIVO',
        mes_referencia: /^\d{4}-\d{2}$/.test(movementMonthKey) ? `${movementMonthKey}-01` : refMonth,
        tipo,
        data: m.data_movimentacao ? new Date(`${String(m.data_movimentacao).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '-',
        motivo: m.motivo_inativacao || m.outro_motivo || (tipo === 'ENTRADA' ? 'Novo Cadastro' : 'Desligamento')
      });
    });

    const saldo = entradas - saidas;
    const taxaChurn = ((saidas / (totalAtivos || 1)) * 100).toFixed(1);

    const referencias = [...new Set((produtores || []).map(p => p.data_referencia).filter(Boolean))]
      .filter(ref => !refMonth || ref <= refMonth)
      .sort();
    const movimentosPorMes = new Map();
    (movimentacoes || []).forEach(m => {
      const key = String(m.data_movimentacao || '').slice(0, 7);
      if (!key) return;
      if (!movimentosPorMes.has(key)) movimentosPorMes.set(key, { entradas: 0, saidas: 0 });
      const item = movimentosPorMes.get(key);
      if (String(m.movimentacao || '').toLowerCase().includes('sa')) item.saidas += 1;
      else item.entradas += 1;
    });
    const historicoMovimentacao = {
      labels: referencias.map(monthLabel),
      entradas: referencias.map(ref => movimentosPorMes.get(String(ref).slice(0, 7))?.entradas || 0),
      saidas: referencias.map(ref => movimentosPorMes.get(String(ref).slice(0, 7))?.saidas || 0),
      porcentagens: referencias.map(ref => {
        const item = movimentosPorMes.get(String(ref).slice(0, 7)) || { entradas: 0, saidas: 0 };
        const total = item.entradas + item.saidas;
        return total > 0 ? Number(((item.saidas / total) * 100).toFixed(1)) : 0;
      })
    };

    const carteiraPorMes = new Map();
    (produtores || []).forEach(p => {
      if (!p.data_referencia) return;
      if (!carteiraPorMes.has(p.data_referencia)) carteiraPorMes.set(p.data_referencia, new Set());
      if (p.codigo_lr) carteiraPorMes.get(p.data_referencia).add(p.codigo_lr);
    });

    const topMotivos = Object.entries(motivosMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      refMonth,
      kpis: {
        entradas_mes: entradas,
        saidas_mes: saidas,
        saldo: saldo,
        taxa_churn: taxaChurn,
        produtores_ativos: totalAtivos,
        consultores_ativos: totalConsultores
      },
      historicoMovimentacao,
      historicoCarteira: {
        labels: referencias.map(monthLabel),
        values: referencias.map(ref => carteiraPorMes.get(ref)?.size || 0)
      },
      motivosInativacao: {
        labels: topMotivos.map(m => m[0]),
        values: topMotivos.map(m => m[1])
      },
      tabelaMovimentacao: tabelaMov
    });
  } catch (error) {
    console.error('Erro em /api/turnover:', error);
    return res.status(500).json({ error: error.message });
  }
};
