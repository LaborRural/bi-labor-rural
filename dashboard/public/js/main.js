/**
 * Controlador da interface e integração somente leitura com as APIs do dashboard.
 */
document.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const carousel = new DashboardCarousel({ slideDuration: 30000 });
  const charts = new DashboardCharts();
  const state = {
    overview: null,
    visits: null,
    turnover: null,
    consistency: null,
    rankingDimension: 'producer',
    hasUserChangedMonth: false,
    chartHorizons: {
      coverage: 6,
      turnover: 6,
      portfolio: 6,
      consistency: 6
    }
  };

  function sliceTimeSeries(seriesObj, monthsCount) {
    if (!seriesObj || !seriesObj.labels || !seriesObj.labels.length) return seriesObj;
    if (!monthsCount || monthsCount <= 0 || monthsCount >= seriesObj.labels.length) return seriesObj;
    const startIdx = Math.max(0, seriesObj.labels.length - monthsCount);
    const sliced = {};
    for (const [k, v] of Object.entries(seriesObj)) {
      if (Array.isArray(v)) {
        sliced[k] = v.slice(startIdx);
      } else {
        sliced[k] = v;
      }
    }
    return sliced;
  }
  const projectOptions = [
    { value: 'ALVOAR ASSIST', label: 'Alvoar Assist' },
    { value: 'ALVOAR ECO', label: 'Alvoar Eco' },
    { value: 'ATEG_CCPR', label: 'Ateg_Ccpr' },
    { value: 'LPA', label: 'Lpa' },
    { value: 'REGENERA', label: 'Regenera' },
    { value: 'SEMEAR', label: 'Semear' }
  ];

  const emptyState = {
    overview: {
      refMonth: null,
      kpis: {},
      evolucaoMensal: { labels: [], fazendasAtivas: [], fazendasVisitadas: [], percCobertura: [] },
      evolucaoVisitas: { labels: [], values: [] },
      rankingProdutores: { labels: [], values: [] },
      filterOptions: { agroindustrias: [], regioes: [], projetos: projectOptions.map((p) => p.value), status: ['ATIVO', 'INATIVO'], meses: [] },
      tabelas: { movimentacao: [], sem_visita: [], visitados: [] }
    },
    visits: {
      kpis: {},
      rankingConsultores: { labels: [], coberturas: [], visitas: [] },
      tabelaConsultores: []
    },
    turnover: {
      kpis: {},
      historicoMovimentacao: { labels: [], entradas: [], saidas: [] },
      historicoCarteira: { labels: [], values: [] },
      tabelaMovimentacao: []
    },
    consistency: {
      kpis: {},
      evolucaoConsistencia: { labels: [], mensal: [], anual: [] },
      distribuicaoDonut: { labels: ['Registros aptos', 'Registros incompletos', 'Registros divergentes'], values: [0, 0, 0] },
      distribuicaoDonutAnual: { labels: ['Registros aptos', 'Registros incompletos', 'Registros divergentes'], values: [0, 0, 0] },
      tabelaProdutoresComDados: [],
      tabelaInconsistentes: []
    }
  };

  const el = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '—').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('pt-BR') : '—';
  const percent = (value) => value === null || value === undefined || value === '' ? '—' : `${String(value).replace('.', ',')}%`;
  const date = (value) => {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('pt-BR');
  };

  function isStatusInconsistente(statusStr) {
    if (!statusStr) return false;
    const normalized = String(statusStr)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
    if (normalized.includes('SEM DADOS') || normalized.includes('NAO CALCULADO') || normalized.includes('PENDENTE')) {
      return false;
    }
    return normalized.includes('INCONSIST') || normalized.includes('DIVERG') || normalized.includes('OUTLIER');
  }

  function isStatusConsistente(statusStr) {
    if (!statusStr) return false;
    const normalized = String(statusStr)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
    return normalized.includes('CONSIST') && !normalized.includes('INCONSIST');
  }

  function updateValue(id, value) {
    const node = el(id);
    if (!node) return;
    const text = String(value ?? '—');
    if (node.textContent !== text) {
      node.textContent = text;
      node.classList.remove('pulse-update');
      void node.offsetWidth;
      node.classList.add('pulse-update');
    }
  }

  function setTheme(theme, persist = true) {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    const isDark = root.dataset.theme === 'dark';
    const labelText = `Ativar modo ${isDark ? 'claro' : 'escuro'}`;
    themeToggle?.setAttribute('aria-pressed', String(isDark));
    themeToggle?.setAttribute('aria-label', labelText);
    themeToggle?.setAttribute('title', labelText);
    const themeIcon = themeToggle?.querySelector('.theme-icon');
    if (themeIcon) themeIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
    const label = themeToggle?.querySelector('.theme-toggle-label');
    if (label) label.textContent = `Modo ${isDark ? 'claro' : 'escuro'}`;
    if (themeMeta) themeMeta.content = isDark ? '#060E0D' : '#ffffff';
    if (persist) {
      try { localStorage.setItem('lr-dashboard-theme', root.dataset.theme); } catch (_) { /* preferência opcional */ }
    }
    charts.applyTheme();
  }

  setTheme(root.dataset.theme, false);
  themeToggle?.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

  async function getJson(url) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error(`${url} indisponível.`, error);
      return null;
    }
  }

  function renderOverview(data) {
    if (!data) return;
    const kpi = data.kpis || {};
    const totalActive = Number(kpi.produtores_ativos) || 0;
    const totalVisited = Number(kpi.produtores_visitados) || Math.max(0, totalActive - Number(state.visits?.kpis?.fazendas_nao_visitadas || 0));
    updateValue('kpiVisitsTotal', number(kpi.total_visitas));
    updateValue('kpiVisitsActive', number(kpi.produtores_ativos));
    updateValue('kpiVisitsVisited', number(totalVisited));
    updateValue('kpiVisitsCoverage', percent(kpi.perc_visitados));
    updateValue('kpiVisitsPerProducer', String(kpi.visitas_por_produtor || '—').replace('.', ','));
    updateValue('kpiVisitsMissing', number(Math.max(0, totalActive - totalVisited)));

    updateValue('kpiTurnActive', number(kpi.produtores_ativos));
    updateValue('kpiDataProducers', number(kpi.produtores_com_dados));
    updateValue('kpiDataEligible', number(state.consistency?.kpis?.fazendas_aptas || kpi.produtores_com_dados));

    const coverageData = sliceTimeSeries(data.evolucaoMensal || emptyState.overview.evolucaoMensal, state.chartHorizons.coverage);
    charts.renderCoverage('chartVisitsCoverage', coverageData);
    renderSelectedRanking();
  }

  function renderSelectedRanking() {
    const isConsultant = state.rankingDimension === 'consultant';
    const producerRanking = state.overview?.rankingProdutores || emptyState.overview.rankingProdutores;
    const consultantSource = state.visits?.rankingConsultores || emptyState.visits.rankingConsultores;
    let rawRanking = isConsultant
      ? { labels: consultantSource.labels || [], values: consultantSource.visitas || [] }
      : { labels: producerRanking.labels || [], values: producerRanking.values || [] };

    // Ordenação estrita do MAIOR para o MENOR valor
    const paired = (rawRanking.labels || []).map((label, idx) => ({
      label,
      value: Number(rawRanking.values?.[idx]) || 0
    })).filter((item) => item.value > 0);
    paired.sort((a, b) => b.value - a.value);

    // Limita aos Top 30 para manter o Canvas em alta performance (60fps) e evitar travamento da GPU do navegador
    const maxRankingItems = isConsultant ? 40 : 30;
    const topPaired = paired.slice(0, maxRankingItems);

    const ranking = {
      labels: topPaired.map((item) => item.label),
      values: topPaired.map((item) => item.value)
    };

    const viewport = el('rankingChartViewport');
    const inner = el('rankingChartInner');
    if (viewport && inner) {
      const availableHeight = Math.max(viewport.clientHeight || 0, 170);
      const computedHeight = Math.min(Math.max(availableHeight, ranking.labels.length * 28 + 8), 900);
      inner.style.height = `${computedHeight}px`;
      viewport.scrollTop = 0;
    }
    charts.renderRanking('chartVisitsRanking', ranking);
    if (el('rankingSubtitle')) el('rankingSubtitle').textContent = `Ranking por ${isConsultant ? 'consultor' : 'produtor'} (Top ${topPaired.length})`;
    document.querySelectorAll('[data-ranking]').forEach((button) => {
      const active = button.dataset.ranking === state.rankingDimension;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderVisits(data) {
    if (!data) return;
    const kpi = data.kpis || {};
    updateValue('kpiVisitsCoverage', percent(kpi.perc_cobertura_geral || state.overview?.kpis?.perc_visitados));
    updateValue('kpiVisitsTotal', number(kpi.total_visitas || state.overview?.kpis?.total_visitas));
    updateValue('kpiVisitsMissing', number(kpi.fazendas_nao_visitadas));
    updateValue('kpiTurnConsultants', number(data.tabelaConsultores?.length || state.overview?.kpis?.consultores_ativos));
  }

  function renderTurnover(data) {
    if (!data) return;
    const kpi = data.kpis || {};
    updateValue('kpiTurnEntradas', number(kpi.entradas_mes));
    updateValue('kpiTurnSaidas', number(kpi.saidas_mes));
    updateValue('kpiTurnSaldo', Number(kpi.saldo) >= 0 ? `+${number(kpi.saldo)}` : number(kpi.saldo));
    updateValue('kpiTurnChurn', percent(kpi.taxa_churn));
    const turnoverData = sliceTimeSeries(data.historicoMovimentacao || emptyState.turnover.historicoMovimentacao, state.chartHorizons.turnover);
    charts.renderTurnover('chartTurnoverHistory', turnoverData);
    const portfolioData = sliceTimeSeries(data.historicoCarteira || emptyState.turnover.historicoCarteira, state.chartHorizons.portfolio);
    charts.renderPortfolio('chartPortfolioHistory', portfolioData);
  }

  function renderConsistency(data) {
    if (!data) return;
    const kpi = data.kpis || {};
    const values = data.distribuicaoDonut?.values || [];
    const base = Number(kpi.base_analisada) || values.reduce((sum, item) => sum + Number(item || 0), 0);
    const divergences = Number(kpi.registros_divergentes) || Number(values[1] || 0);
    updateValue('kpiDataProducers', number(kpi.produtores_com_dados || state.overview?.kpis?.produtores_com_dados));
    updateValue('kpiDataEligible', number(kpi.fazendas_aptas || kpi.produtores_com_dados || state.overview?.kpis?.produtores_com_dados));
    updateValue('kpiDataMonthly', percent(kpi.perc_consistente));
    updateValue('kpiDataAnnual', percent(kpi.perc_anual));
    updateValue('kpiDataDivergent', number(divergences));
    updateValue('kpiDataBase', number(base));
    const consistencyData = sliceTimeSeries(data.evolucaoConsistencia || emptyState.consistency.evolucaoConsistencia, state.chartHorizons.consistency);
    charts.renderConsistencyHistory('chartConsistencyHistory', consistencyData);
    charts.renderQuality('chartDataQualityMonthly', data.distribuicaoDonut || emptyState.consistency.distribuicaoDonut);
    charts.renderQuality('chartDataQualityAnnual', data.distribuicaoDonutAnual || emptyState.consistency.distribuicaoDonutAnual);
  }

  function currentFilter() {
    return {
      industry: el('filterIndustry')?.value || '',
      region: el('filterRegion')?.value || '',
      project: el('filterProject')?.value || '',
      status: '',
      consultant: el('filterConsultant')?.value || '',
      producer: el('filterProducer')?.value || '',
      month: el('filterMonth')?.value || ''
    };
  }

  function dimensionMatches(rowValue, filterValue) {
    if (!filterValue) return true;
    if (rowValue === null || rowValue === undefined || rowValue === '' || rowValue === 'Todos') return true;
    const expected = String(filterValue).toLocaleLowerCase('pt-BR');
    const values = Array.isArray(rowValue) ? rowValue : [rowValue];
    return values.some((value) => String(value).toLocaleLowerCase('pt-BR') === expected);
  }

  function normalizeStatus(value) {
    const normalized = String(value || '').trim().toLocaleUpperCase('pt-BR');
    if (normalized.startsWith('INATIV')) return 'INATIVO';
    if (normalized.startsWith('ATIV')) return 'ATIVO';
    return normalized;
  }

  function fixMojibake(str) {
    if (!str) return '';
    return String(str)
      .replace(/Ã§/g, 'ç')
      .replace(/Ã‡/g, 'Ç')
      .replace(/Ã¡/g, 'á')
      .replace(/Ã /g, 'Á')
      .replace(/Ã¢/g, 'â')
      .replace(/Ã‚/g, 'Â')
      .replace(/Ã£/g, 'ã')
      .replace(/Ãƒ/g, 'Ã')
      .replace(/Ã©/g, 'é')
      .replace(/Ã‰/g, 'É')
      .replace(/Ãª/g, 'ê')
      .replace(/ÃŠ/g, 'Ê')
      .replace(/Ã­/g, 'í')
      .replace(/Ã /g, 'Í')
      .replace(/Ã³/g, 'ó')
      .replace(/Ã“/g, 'Ó')
      .replace(/Ã´/g, 'ô')
      .replace(/Ã”/g, 'Ô')
      .replace(/Ãµ/g, 'õ')
      .replace(/Ã•/g, 'Õ')
      .replace(/Ãº/g, 'ú')
      .replace(/Ãš/g, 'Ú');
  }

  const KNOWN_ACRONYMS = new Set(['AL', 'MG', 'SP', 'GO', 'CE', 'BA', 'SE', 'PE', 'RJ', 'PR', 'SC', 'RS', 'ES', 'MT', 'MS', 'RO', 'AC', 'AM', 'PA', 'MA', 'PI', 'RN', 'PB', 'TO', 'DF']);
  const LOWERCASE_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

  const UF_TO_CANONICAL_REGION = {
    'BA': 'Bahia',
    'CE': 'Ceará',
    'AL': 'Alagoas',
    'SE': 'Sergipe',
    'PE': 'Pernambuco',
    'MT': 'Campinápolis',
    'GO': 'Goiânia',
    'SP': 'Araçatuba'
  };

  function formatSingleRegionName(raw) {
    const str = fixMojibake(raw).trim();
    if (!str) return null;

    const explicitMap = {
      'ba': 'Bahia',
      'ce': 'Ceará',
      'al': 'Alagoas',
      'se': 'Sergipe',
      'pe': 'Pernambuco',
      'mt': 'Campinápolis',
      'go': 'Goiânia',
      'sp': 'Araçatuba',
      'alagoas': 'Alagoas',
      'aracatuba': 'Araçatuba',
      'bahia': 'Bahia',
      'batalha/al': 'Alagoas',
      'batalha': 'Alagoas',
      'ceara': 'Ceará',
      'goiania': 'Goiânia',
      'ibia': 'Ibiá',
      'independente': 'Independente',
      'itambacuri': 'Itambacuri',
      'ituiutaba': 'Ituiutaba',
      'minas gerais': 'Minas Gerais',
      'montes claros': 'Montes Claros',
      'patos de minas': 'Patos de Minas',
      'pedra do forte': 'Bahia',
      'pernambuco': 'Pernambuco',
      'ponte nova': 'Ponte Nova',
      'quixeramobim': 'Ceará',
      'sergipe': 'Sergipe',
      'sertao norte': 'Sertão Norte',
      'sul de minas': 'Sul de Minas',
      'triangulo mineiro': 'Triângulo Mineiro'
    };

    const suffixMatch = str.match(/\s*-\s*(\d+)\s*$/);
    let base = str;
    let suffix = '';
    if (suffixMatch) {
      base = str.substring(0, suffixMatch.index).trim();
      suffix = ` - ${suffixMatch[1]}`;
    }

    const baseKey = base.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (explicitMap[baseKey]) {
      return explicitMap[baseKey] + suffix;
    }

    const baseUpper = base.toUpperCase().trim();
    if (UF_TO_CANONICAL_REGION[baseUpper]) {
      return UF_TO_CANONICAL_REGION[baseUpper] + suffix;
    }

    const words = base.split(/\s+/);
    const formattedWords = words.map((w, idx) => {
      const wUpper = w.toUpperCase();
      if (UF_TO_CANONICAL_REGION[wUpper]) return UF_TO_CANONICAL_REGION[wUpper];
      if (KNOWN_ACRONYMS.has(wUpper)) return wUpper;
      const wLower = w.toLowerCase();
      if (idx > 0 && LOWERCASE_WORDS.has(wLower)) return wLower;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });

    return formattedWords.join(' ') + suffix;
  }

  function mapRegiaoNestle(str) {
    if (!str) return null;
    const normalized = str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (normalized === 'go' || normalized.includes('goiania') || normalized.includes('9655') || normalized.includes('goias')) {
      return 'Goiânia';
    }
    if (normalized === 'mg' || normalized.includes('patos') || normalized.includes('ibia') || normalized.includes('9188') || normalized.includes('1215')) {
      return 'Patos de Minas e Ibiá';
    }
    if (normalized.includes('ituiutaba') || normalized.includes('1217') || normalized.includes('triangulo')) {
      return 'Ituiutaba';
    }
    if (normalized.includes('montes claros') || normalized.includes('9264') || normalized.includes('sertao norte')) {
      return 'Montes Claros';
    }
    if (normalized.includes('aracatuba') || normalized.includes('0460') || normalized === 'sp') {
      return 'Araçatuba';
    }
    return null;
  }

    function isNestleContext(context) {
      if (!context) return false;
      const upper = String(context).toUpperCase();
      return upper.includes('NESTLE') || upper.includes('NESTLÉ') || upper.includes('REGENERA');
    }

    function sanitizeRegiao(rawRegion, context = null) {
      if (!rawRegion) return null;
      const str = fixMojibake(String(rawRegion).trim());
      if (!str) return null;

      const upper = str.toUpperCase().trim();
      if (
        upper === '1' ||
        upper === '0' ||
        upper === 'TESTE' ||
        upper === 'TEST' ||
        upper === 'LABOR RURAL' ||
        upper === 'UNIDADE GENERICA' ||
        upper === 'NÃO INFORMADA' ||
        upper === 'NAO INFORMADA' ||
        /^\d+$/.test(upper)
      ) {
        return null;
      }

      if (isNestleContext(context) || /\b(1215|9188|1217|9655|9264)\b/.test(upper)) {
        const nestleReg = mapRegiaoNestle(str);
        if (nestleReg) return nestleReg;
      }

      if (upper === 'BATALHA/AL' || upper.startsWith('BATALHA/')) {
        return 'Alagoas';
      }

      if (str.includes('/')) {
        const parts = str.split('/').map(p => p.trim()).filter(Boolean);
        const cleanParts = parts.map(part => formatSingleRegionName(part)).filter(Boolean);
        if (cleanParts.length === 0) return null;

        // Deduplicate (ex: Alagoas/Alagoas -> Alagoas)
        const uniqueParts = [...new Set(cleanParts)];
        if (uniqueParts.length === 1) return uniqueParts[0];

        // Ordenar alfabeticamente para estados compostos (ex: Sergipe/Bahia -> Bahia/Sergipe)
        uniqueParts.sort((a, b) => a.localeCompare(b, 'pt-BR'));
        return uniqueParts.join('/');
      }

      return formatSingleRegionName(str);
    }

  const LAC_CONSULTORIA_RAW = new Set([
    'CELIO ROBERTO OLIVEIRA (REGENERA)',
    'SUELY DE JESUS OLIVEIRA (REGENERA)',
    'CELIO ROBERTO OLIVEIRA',
    'SUELY DE JESUS OLIVEIRA'
  ]);

  const NON_FIELD_CONSULTANTS = new Set([
    'TALITA FONTES',
    'TALITA FONTES (ALVOAR ECO)',
    'TALITA FONTES (LABOR RURAL)',
    'CONSULTOR LABOR RURAL (GENERICO)',
    'CONSULTOR GENERICO',
    'USUARIO TESTE (PRODUCAO)',
    'USUARIO TESTE',
    'CONTA DE SUPERVISÃO',
    'CONTA DE SUPERVISAO',
    'LABOR RURAL (GERAL)',
    'SUPERVISAO',
    'SUPERVISÃO',
    'SUPERVISAO AGRICULTURA',
    'SUPERVISAO PECUARIA',
    'SUPERVISÃO AGRICULTURA',
    'SUPERVISÃO PECUÁRIA',
    'COORDENACAO',
    'COORDENAÇÃO'
  ]);

  function isNonFieldConsultant(name) {
    if (!name) return true;
    const upper = String(name).trim().toUpperCase();
    if (NON_FIELD_CONSULTANTS.has(upper)) return true;
    if (upper.startsWith('TALITA FONTES')) return true;
    if (upper.includes('_CONSULTOR') || upper.includes('CONSULTOR_') || upper === 'CONTA DE SUPERVISÃO') return true;
    if (upper.includes('SUPERVISAO') || upper.includes('SUPERVISÃO')) return true;
    if (upper.includes('COORDENACAO') || upper.includes('COORDENAÇÃO')) return true;
    return false;
  }

  function sanitizeConsultorList(rawName) {
    if (!rawName) return [];
    return String(rawName)
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((part) => {
        const upper = part.toUpperCase();
        if (LAC_CONSULTORIA_RAW.has(upper)) return 'LAC CONSULTORIA';
        return part.replace(/\s*\([^)]+\)\s*$/, '').trim() || part;
      })
      .filter((name) => !isNonFieldConsultant(name));
  }

  function matches(row, filter, ignoreMonth = false) {
    const codUpper = String(row.codigo_lr || row.codigo_produtor || '').toUpperCase();
    if (codUpper.includes('_CONSULTOR') || codUpper.includes('CONSULTOR_')) return false;

    const rawConsultant = String(row.consultor || row.nome_consultor || '');
    if (isNonFieldConsultant(rawConsultant)) return false;

    const consultores = sanitizeConsultorList(rawConsultant).map((c) => c.toLocaleLowerCase('pt-BR'));
    const filterConsult = (filter.consultant || '').toLocaleLowerCase('pt-BR');
    const consultantMatch = !filterConsult ||
      consultores.includes(filterConsult) ||
      rawConsultant.toLocaleLowerCase('pt-BR').includes(filterConsult);

    const producer = String(row.produtor || row.nome_produtor || row.propriedade || '').trim().toLocaleLowerCase('pt-BR');
    const producerCode = String(row.codigo_lr || row.codigo_produtor || '').trim().toLocaleLowerCase('pt-BR');
    const filterProd = (filter.producer || '').trim().toLocaleLowerCase('pt-BR');
    const producerMatch = !filterProd || producer === filterProd || producerCode === filterProd;

    const rowRegion = sanitizeRegiao(row.regiao || row.regioes);
    const filterRegion = sanitizeRegiao(filter.region);
    const rowMonth = String(row.mes_referencia || row.data_referencia || '').slice(0, 10);
    const monthMatch = ignoreMonth || !filter.month || !rowMonth || dimensionMatches(rowMonth, filter.month);

    const rawAgroVal = row.agroindustria || row.agroindustrias || row.projeto || row.projetos;
    const rowAgro = Array.isArray(rawAgroVal) ? rawAgroVal.map(mapAgroindustria) : mapAgroindustria(rawAgroVal);

    return consultantMatch &&
      producerMatch &&
      dimensionMatches(rowAgro, filter.industry) &&
      (!filterRegion || rowRegion === filterRegion) &&
      dimensionMatches(row.projeto || row.projetos, filter.project) &&
      (!filter.status || normalizeStatus(row.status) === normalizeStatus(filter.status)) &&
      monthMatch;
  }

  // Estado de ordenação para cada tabela do dashboard
  const tableSort = {
    tbodySemVisita: { colKey: null, dir: 'asc' },
    tbodyVisitados: { colKey: null, dir: 'asc' },
    tbodyTurnover: { colKey: null, dir: 'asc' },
    tbodyConsultants: { colKey: null, dir: 'asc' },
    tbodyDataProducers: { colKey: 'possui_dados', dir: 'asc' },
    tbodyInconsistencies: { colKey: null, dir: 'asc' }
  };

  // Estado de paginação para cada tabela do dashboard
  const tablePagination = {
    tableSemVisita: { page: 1, pageSize: 25 },
    tableVisitados: { page: 1, pageSize: 25 },
    tableTurnover: { page: 1, pageSize: 25 },
    tableConsultants: { page: 1, pageSize: 25 },
    tableDataProducers: { page: 1, pageSize: 25 },
    tableInconsistencies: { page: 1, pageSize: 25 }
  };

  function getPaginatedSlice(tableId, rows) {
    if (!tablePagination[tableId]) {
      tablePagination[tableId] = { page: 1, pageSize: 25 };
    }
    const conf = tablePagination[tableId];
    const total = rows.length;
    if (total === 0) {
      conf.page = 1;
      return [];
    }

    if (conf.pageSize === 0) {
      // 0 = Exibir todos os registros
      conf.page = 1;
      return rows;
    }

    const totalPages = Math.max(1, Math.ceil(total / conf.pageSize));
    if (conf.page > totalPages) conf.page = totalPages;
    if (conf.page < 1) conf.page = 1;

    const start = (conf.page - 1) * conf.pageSize;
    const end = start + conf.pageSize;
    return rows.slice(start, end);
  }

  function getPaginationPagesList(currentPage, totalPages) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages = [];
    if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i);
      pages.push('...');
      pages.push(totalPages);
    } else if (currentPage >= totalPages - 3) {
      pages.push(1);
      pages.push('...');
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push('...');
      pages.push(currentPage - 1);
      pages.push(currentPage);
      pages.push(currentPage + 1);
      pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  }

  function renderTablePagination(paginationId, tableId, totalRows) {
    const container = el(paginationId);
    if (!container) return;
    if (!tablePagination[tableId]) {
      tablePagination[tableId] = { page: 1, pageSize: 25 };
    }
    const conf = tablePagination[tableId];
    const pageSize = conf.pageSize;

    if (totalRows === 0) {
      container.innerHTML = `
        <div class="pagination-info"><span>0 registros</span></div>
      `;
      return;
    }

    const isAll = pageSize === 0;
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = isAll ? 1 : Math.min(Math.max(1, conf.page), totalPages);
    conf.page = currentPage;

    const startIdx = isAll ? 0 : (currentPage - 1) * pageSize;
    const endIdx = isAll ? totalRows : Math.min(startIdx + pageSize, totalRows);

    const rangeText = isAll
      ? `Exibindo todos os <strong>${totalRows.toLocaleString('pt-BR')}</strong> registros`
      : `Exibindo <strong>${(startIdx + 1).toLocaleString('pt-BR')}–${endIdx.toLocaleString('pt-BR')}</strong> de <strong>${totalRows.toLocaleString('pt-BR')}</strong> registros`;

    const pageButtons = isAll || totalPages <= 1 ? '' : getPaginationPagesList(currentPage, totalPages).map((p) => {
      if (p === '...') {
        return `<span class="pagination-ellipsis">…</span>`;
      }
      const isActive = p === currentPage;
      return `<button type="button" class="pagination-btn ${isActive ? 'active' : ''}" data-table="${escapeHtml(tableId)}" data-page="${p}" ${isActive ? 'aria-current="page"' : ''} title="Página ${p}">${p}</button>`;
    }).join('');

    container.innerHTML = `
      <div class="pagination-info">
        <span>${rangeText}</span>
      </div>
      <div class="pagination-controls">
        <div class="pagination-size-wrap">
          <label for="pageSize_${escapeHtml(tableId)}">Exibir:</label>
          <select id="pageSize_${escapeHtml(tableId)}" class="pagination-size-select" data-table="${escapeHtml(tableId)}" aria-label="Registros por página">
            <option value="10" ${pageSize === 10 ? 'selected' : ''}>10</option>
            <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
            <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
            <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
            <option value="0" ${pageSize === 0 ? 'selected' : ''}>Todos</option>
          </select>
        </div>
        ${totalPages > 1 ? `
        <div class="pagination-nav" aria-label="Navegação de páginas">
          <button type="button" class="pagination-btn" data-table="${escapeHtml(tableId)}" data-page="1" ${currentPage <= 1 ? 'disabled' : ''} title="Primeira página" aria-label="Primeira página">«</button>
          <button type="button" class="pagination-btn" data-table="${escapeHtml(tableId)}" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} title="Página anterior" aria-label="Página anterior">‹</button>
          ${pageButtons}
          <button type="button" class="pagination-btn" data-table="${escapeHtml(tableId)}" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} title="Próxima página" aria-label="Próxima página">›</button>
          <button type="button" class="pagination-btn" data-table="${escapeHtml(tableId)}" data-page="${totalPages}" ${currentPage >= totalPages ? 'disabled' : ''} title="Última página" aria-label="Última página">»</button>
        </div>
        ` : ''}
      </div>
    `;
  }

  function setupTablePagination() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.pagination-btn[data-page]');
      if (!btn || btn.disabled) return;
      const tableId = btn.dataset.table;
      const targetPage = Number(btn.dataset.page);
      if (!tableId || Number.isNaN(targetPage)) return;

      if (tablePagination[tableId]) {
        tablePagination[tableId].page = targetPage;
        renderTables();
        const table = el(tableId);
        const scroll = table?.closest('.table-scroll');
        if (scroll) scroll.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    document.addEventListener('change', (e) => {
      const select = e.target.closest('.pagination-size-select');
      if (!select) return;
      const tableId = select.dataset.table;
      const newSize = Number(select.value);
      if (!tableId || Number.isNaN(newSize)) return;

      if (tablePagination[tableId]) {
        tablePagination[tableId].pageSize = newSize;
        tablePagination[tableId].page = 1;
        renderTables();
        const table = el(tableId);
        const scroll = table?.closest('.table-scroll');
        if (scroll) scroll.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  let loadingTimeout = null;

  function showLoading(message = 'Atualizando dashboard com filtros...') {
    const overlay = el('loadingOverlay');
    if (!overlay) return;
    const textEl = overlay.querySelector('.loading-text');
    if (textEl) textEl.textContent = message;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function hideLoading(delay = 0) {
    clearTimeout(loadingTimeout);
    if (delay <= 0) {
      const overlay = el('loadingOverlay');
      if (overlay) {
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden', 'true');
      }
      return;
    }
    loadingTimeout = setTimeout(() => {
      const overlay = el('loadingOverlay');
      if (!overlay) return;
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
    }, delay);
  }

  function parseSortValue(value) {
    if (value === null || value === undefined || value === '' || value === '—') return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value;
    const str = String(value).trim();
    if (/^-?\d+([.,]\d+)?%?$/.test(str)) {
      return parseFloat(str.replace('%', '').replace(/\./g, '').replace(',', '.'));
    }
    const brDateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str);
    if (brDateMatch) {
      return new Date(`${brDateMatch[3]}-${brDateMatch[2]}-${brDateMatch[1]}`).getTime();
    }
    return str.toLocaleLowerCase('pt-BR');
  }

  function sortRows(rows, sortConfig, keyGetter) {
    if (!sortConfig || !sortConfig.colKey) return rows;
    const { colKey, dir } = sortConfig;
    return [...rows].sort((a, b) => {
      const valA = parseSortValue(keyGetter(a, colKey));
      const valB = parseSortValue(keyGetter(b, colKey));
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1;
      if (valB === null) return -1;
      let res = 0;
      if (typeof valA === 'number' && typeof valB === 'number') {
        res = valA - valB;
      } else {
        res = String(valA).localeCompare(String(valB), 'pt-BR');
      }
      return dir === 'asc' ? res : -res;
    });
  }

  function rowsOrEmpty(rows, columns, mapper) {
    if (!rows || !rows.length) {
      return `<tr><td colspan="${columns}" class="empty-cell">Nenhum registro para os filtros selecionados.</td></tr>`;
    }
    return rows.map(mapper).join('');
  }

  function updateCount(id, rows) {
    const node = el(id);
    if (!node) return;
    node.textContent = `${rows.length} registros`;
  }

  function updateTableHeadIcons(tbodyId, activeColKey, dir) {
    const tbody = el(tbodyId);
    if (!tbody) return;
    const table = tbody.closest('table');
    if (!table) return;
    table.querySelectorAll('th').forEach((th) => {
      const key = th.dataset.sortKey;
      th.classList.remove('sort-asc', 'sort-desc');
      if (key && key === activeColKey) {
        th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });
  }

  let isTableResizing = false;
  let tableResizeEndTime = 0;

  function setupTableSorting() {
    const MAPPINGS = {
      tbodySemVisita: ['codigo_lr', 'consultor', 'produtor', 'data_associacao', 'data_visita_mes_anterior', 'data_ultima_visita', 'dias_sem_visita', 'status'],
      tbodyVisitados: ['codigo_lr', 'consultor', 'produtor', 'atendimento', 'data_visita', 'elabore_ok'],
      tbodyTurnover: ['atendimento', 'produtor', 'tipo', 'data', 'grupo', 'motivo'],
      tbodyConsultants: ['consultor', 'total_fazendas', 'fazendas_visitadas', 'total_visitas', 'perc_cobertura', 'status'],
      tbodyDataProducers: ['codigo_lr', 'produtor', 'consultor', 'possui_dados', 'referencia', 'status'],
      tbodyInconsistencies: ['codigo_lr', 'produtor', 'consultor', 'meses_sequenciais', 'consistencia_mensal', 'consistencia_anual', 'acao']
    };

    Object.entries(MAPPINGS).forEach(([tbodyId, colKeys]) => {
      const tbody = el(tbodyId);
      if (!tbody) return;
      const table = tbody.closest('table');
      if (!table) return;
      const ths = table.querySelectorAll('thead tr:first-child th');
      ths.forEach((th, idx) => {
        const key = colKeys[idx];
        if (!key || key === 'acao') return;
        th.dataset.sortKey = key;
        th.classList.add('sortable');
        th.title = `Clique para ordenar por ${th.textContent.trim()}`;
        th.addEventListener('click', (e) => {
          // Bloqueia ordenação se o usuário estiver redimensionando colunas, clicando no botão info ou se acabou de soltar a divisória
          if (e.target.closest('.col-resizer') || e.target.closest('.kpi-info-btn') || isTableResizing || (Date.now() - tableResizeEndTime < 350)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          const current = tableSort[tbodyId] || { colKey: null, dir: 'asc' };
          if (current.colKey === key) {
            current.dir = current.dir === 'asc' ? 'desc' : 'asc';
          } else {
            current.colKey = key;
            current.dir = 'asc';
          }
          tableSort[tbodyId] = current;
          showLoading('Ordenando dados...');
          setTimeout(() => {
            renderTables();
            hideLoading(150);
          }, 60);
        });
      });
    });
  }

  function setupColumnResizers() {
    document.querySelectorAll('.data-table').forEach((table) => {
      const ths = table.querySelectorAll('thead tr:first-child th');
      const tableScroll = table.closest('.table-scroll');

      ths.forEach((th, idx) => {
        if (th.querySelector('.col-resizer')) return;

        const resizer = document.createElement('span');
        resizer.className = 'col-resizer';
        resizer.title = 'Arraste para redimensionar a coluna ou dê um duplo clique para auto-ajustar';
        th.appendChild(resizer);

        // Previne que cliques isolados na alça disparem ordenação
        resizer.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
        });

        let startX = 0;
        let startWidth = 0;
        let rafId = null;

        const initExplicitWidths = () => {
          if (!table.dataset.hasExplicitWidths) {
            ths.forEach((colTh) => {
              const currentW = Math.round(colTh.getBoundingClientRect().width);
              colTh.style.width = `${currentW}px`;
              colTh.style.minWidth = `${currentW}px`;
            });
            table.dataset.hasExplicitWidths = 'true';
            table.style.width = 'max-content';
            table.style.minWidth = '100%';
            if (tableScroll) tableScroll.style.overflowX = 'auto';
          }
        };

        const onMouseMove = (e) => {
          const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
          const diff = clientX - startX;
          const newWidth = Math.max(50, startWidth + diff);

          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
            th.style.width = `${newWidth}px`;
            th.style.minWidth = `${newWidth}px`;
          });
        };

        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          document.removeEventListener('touchmove', onMouseMove);
          document.removeEventListener('touchend', onMouseUp);
          document.body.classList.remove('table-resizing');
          resizer.classList.remove('is-active');

          isTableResizing = false;
          tableResizeEndTime = Date.now();
        };

        const startResize = (clientX) => {
          isTableResizing = true;
          initExplicitWidths();

          startX = clientX;
          startWidth = th.offsetWidth;
          resizer.classList.add('is-active');
          document.body.classList.add('table-resizing');

          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp, { once: false });
        };

        resizer.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          startResize(e.clientX);
        });

        resizer.addEventListener('touchstart', (e) => {
          e.stopPropagation();
          startResize(e.touches[0].clientX);
          document.addEventListener('touchmove', onMouseMove, { passive: false });
          document.addEventListener('touchend', onMouseUp, { once: false });
        }, { passive: false });

        resizer.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          e.preventDefault();
          isTableResizing = true;
          initExplicitWidths();

          const tableRows = table.querySelectorAll('tbody tr');
          let maxWidth = th.textContent.trim().length * 8.5 + 24;

          const ruler = document.createElement('span');
          ruler.style.visibility = 'hidden';
          ruler.style.position = 'absolute';
          ruler.style.whiteSpace = 'nowrap';
          ruler.style.font = '600 11px "Open Sans", sans-serif';
          document.body.appendChild(ruler);

          tableRows.forEach((tr) => {
            const cell = tr.children[idx];
            if (cell) {
              ruler.textContent = cell.textContent.trim();
              const w = ruler.offsetWidth + 22;
              if (w > maxWidth) maxWidth = w;
            }
          });

          document.body.removeChild(ruler);
          const optimalWidth = Math.min(520, Math.max(65, Math.ceil(maxWidth)));

          th.style.width = `${optimalWidth}px`;
          th.style.minWidth = `${optimalWidth}px`;

          isTableResizing = false;
          tableResizeEndTime = Date.now();
        });
      });
    });
  }

  const tableColFilters = {
    tableSemVisita: {},
    tableVisitados: {},
    tableTurnover: {},
    tableConsultants: {},
    tableDataProducers: {},
    tableInconsistencies: {}
  };

  function applyColumnFilters(rows, tableId) {
    const filters = tableColFilters[tableId];
    if (!filters || Object.keys(filters).length === 0) return rows;

    return rows.filter((row) => {
      for (const [colKey, rawVal] of Object.entries(filters)) {
        if (!rawVal) continue;
        const searchVal = String(rawVal).toLowerCase().trim();
        if (!searchVal) continue;

        let rowVal = '';
        if (colKey === 'dias_sem_visita') {
          rowVal = String(row.dias_sem_visita ?? '');
        } else if (colKey === 'status') {
          if (row.status && row.status !== 'ATIVO') {
            rowVal = String(row.status);
          } else if (row.dias_sem_visita !== undefined) {
            const hasDays = row.dias_sem_visita !== null && row.dias_sem_visita !== undefined && row.dias_sem_visita !== '';
            const days = hasDays ? Number(row.dias_sem_visita) : null;
            rowVal = !hasDays ? 'sem visita no período' :
                     days >= 60 ? 'sem visita > 60 dias' :
                     days >= 45 ? 'sem visita > 45 dias' :
                     days >= 30 ? 'sem visita > 30 dias' :
                     days > 0 ? `sem visita (${days}d)` :
                     'vínculo recente';
          } else {
            rowVal = String(row.status || 'ativo');
          }
        } else if (colKey === 'elabore') {
          rowVal = row.elabore_ok === false ? 'não nao' : 'sim';
        } else if (colKey === 'possui_dados') {
          rowVal = row.possui_dados === false ? 'não nao' : 'sim';
        } else if (colKey === 'data_associacao' || colKey === 'data_vinculo') {
          rowVal = String(row.data_associacao || row.data_vinculacao || row.data_referencia || '');
        } else if (colKey === 'data_visita_mes_anterior') {
          rowVal = String(row.data_visita_mes_anterior || '');
        } else if (colKey === 'data_ultima_visita') {
          rowVal = String(row.data_ultima_visita || '');
        } else if (colKey === 'grupo') {
          rowVal = String(row.grupo || row.consultor || '');
        } else if (colKey === 'tipo') {
          rowVal = String(row.tipo || row.movimentacao || '');
        } else if (colKey === 'referencia') {
          rowVal = String(row.referencia || row.mes_referencia || '');
        } else if (colKey === 'atendimento') {
          rowVal = String(row.atendimento || row.numero_atendimento || '');
        } else if (colKey === 'perc_cobertura') {
          rowVal = String(row.perc_cobertura ?? '') + '%';
        } else {
          rowVal = String(row[colKey] ?? '');
        }

        if (!rowVal.toLowerCase().includes(searchVal)) {
          return false;
        }
      }
      return true;
    });
  }

  function setupColumnFilters() {
    document.querySelectorAll('.table-col-filter').forEach((input) => {
      input.addEventListener('input', (e) => {
        const tableId = e.target.dataset.table;
        const col = e.target.dataset.col;
        if (!tableId || !col) return;
        if (!tableColFilters[tableId]) tableColFilters[tableId] = {};
        tableColFilters[tableId][col] = e.target.value;
        if (tablePagination[tableId]) tablePagination[tableId].page = 1;
        renderTables();
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => e.stopPropagation());
    });
  }

  function renderTables() {
    const filter = currentFilter();
    const overview = state.overview || emptyState.overview;
    const visits = state.visits || emptyState.visits;
    const turnover = state.turnover || emptyState.turnover;
    const consistency = state.consistency || emptyState.consistency;

    // Tabela 1: Sem Visita
    let withoutVisit = (overview.tabelas?.sem_visita || []).filter((row) => matches(row, filter, true));
    withoutVisit = applyColumnFilters(withoutVisit, 'tableSemVisita');
    updateCount('countWithoutVisit', withoutVisit);
    withoutVisit = sortRows(withoutVisit, tableSort.tbodySemVisita, (row, key) => row[key] ?? row.data_associacao ?? row.data_referencia);
    updateTableHeadIcons('tbodySemVisita', tableSort.tbodySemVisita.colKey, tableSort.tbodySemVisita.dir);
    const pWithoutVisit = getPaginatedSlice('tableSemVisita', withoutVisit);
    if (el('tbodySemVisita')) el('tbodySemVisita').innerHTML = rowsOrEmpty(pWithoutVisit, 8, (row) => {
      const hasDays = row.dias_sem_visita !== null && row.dias_sem_visita !== undefined && row.dias_sem_visita !== '';
      const days = hasDays ? Number(row.dias_sem_visita) : null;
      
      let status = row.status && row.status !== 'ATIVO' ? row.status : '';
      let badgeClass = row.status_class || '';

      if (!status) {
        const isGrave = hasDays && days >= 60;
        const isZero = hasDays && days <= 0;
        status = !hasDays ? 'Sem visita no período' :
                 isGrave ? 'Sem visita > 60 dias' :
                 days >= 45 ? 'Sem visita > 45 dias' :
                 days >= 30 ? 'Sem visita > 30 dias' :
                 days > 0 ? `Sem visita (${days}d)` :
                 'Vínculo Recente';
        badgeClass = isGrave ? 'badge-danger' : (isZero ? 'badge-positive' : 'badge-warning');
      }

      if (!badgeClass) {
        if (status === 'Inativação Pendente' || status === 'Nunca visitado' || status.includes('> 60')) {
          badgeClass = 'badge-danger';
        } else if (status.includes('Recente')) {
          badgeClass = 'badge-positive';
        } else {
          badgeClass = 'badge-warning';
        }
      }

      const rowClass = badgeClass === 'badge-danger' ? 'table-row-grave' : (badgeClass === 'badge-positive' ? '' : 'table-row-pending');
      const dtAssoc = row.data_associacao || row.data_vinculacao || row.data_referencia || '—';
      const dtVisitaMesAnterior = row.data_visita_mes_anterior || '—';
      const dtUltimaVisita = row.data_ultima_visita || '—';
      return `<tr class="${rowClass}"><td class="col-center"><strong>${escapeHtml(row.codigo_lr || '—')}</strong></td><td class="col-left" title="${escapeHtml(row.consultor || '—')}">${escapeHtml(row.consultor || '—')}</td><td class="col-left" title="${escapeHtml(row.produtor || '—')}">${escapeHtml(row.produtor || '—')}</td><td class="col-center" title="${escapeHtml(dtAssoc)}">${escapeHtml(dtAssoc)}</td><td class="col-center" title="${escapeHtml(dtVisitaMesAnterior)}">${escapeHtml(dtVisitaMesAnterior)}</td><td class="col-center" title="${escapeHtml(dtUltimaVisita)}">${escapeHtml(dtUltimaVisita)}</td><td class="col-center font-tabular">${hasDays ? days : '—'}</td><td class="col-center"><span class="badge ${badgeClass}" title="${escapeHtml(status)}">${escapeHtml(status)}</span></td></tr>`;
    });
    renderTablePagination('paginationSemVisita', 'tableSemVisita', withoutVisit.length);

    // Tabela 2: Visitados
    let visited = (overview.tabelas?.visitados || []).filter((row) => matches(row, filter, true));
    visited = applyColumnFilters(visited, 'tableVisitados');
    updateCount('countVisited', visited);
    visited = sortRows(visited, tableSort.tbodyVisitados, (row, key) => row[key]);
    updateTableHeadIcons('tbodyVisitados', tableSort.tbodyVisitados.colKey, tableSort.tbodyVisitados.dir);
    const pVisited = getPaginatedSlice('tableVisitados', visited);
    if (el('tbodyVisitados')) el('tbodyVisitados').innerHTML = rowsOrEmpty(pVisited, 8, (row) => {
      const isCad = row.cadastro_elabore !== false && row.cadastro_elabore !== 'NÃO' && String(row.cadastro_elabore_label || '').toUpperCase() !== 'NÃO' && Boolean(row.cadastro_elabore);
      const cadBadge = isCad
        ? '<span class="badge badge-positive">SIM</span>'
        : '<span class="badge badge-neutral">NÃO</span>';
      
      const statusDados = row.dados_elabore_status || (row.elabore_ok ? 'SIM (100%)' : 'NÃO (0%)');
      const hasData = row.dados_elabore_tem_dado || row.elabore_ok;
      const pct = row.dados_elabore_pct ?? (hasData ? 100 : 0);

      let dataBadgeClass = 'badge-neutral';
      if (pct >= 80) {
        dataBadgeClass = 'badge-positive';
      } else if (pct > 0) {
        dataBadgeClass = 'badge-warning';
      } else {
        dataBadgeClass = isCad ? 'badge-danger' : 'badge-neutral';
      }

      const dataBadge = `<span class="badge ${dataBadgeClass}">${escapeHtml(statusDados)}</span>`;

      return `<tr>
        <td class="col-center"><strong>${escapeHtml(row.codigo_lr || '—')}</strong></td>
        <td class="col-left" title="${escapeHtml(row.consultor || '—')}">${escapeHtml(row.consultor || '—')}</td>
        <td class="col-left" title="${escapeHtml(row.produtor || '—')}">${escapeHtml(row.produtor || '—')}</td>
        <td class="col-center" title="${escapeHtml(row.atendimento || '—')}">${escapeHtml(row.atendimento || '—')}</td>
        <td class="col-center">${escapeHtml(row.data_visita || '—')}</td>
        <td class="col-center">${cadBadge}</td>
        <td class="col-center">${dataBadge}</td>
        <td class="col-center"><button class="btn-elabore-detail" type="button" data-lr="${escapeHtml(row.codigo_lr || '')}">Ver detalhes ›</button></td>
      </tr>`;
    });
    renderTablePagination('paginationVisitados', 'tableVisitados', visited.length);

    // Tabela 3: Turnover / Movimentação
    let movements = (turnover.tabelaMovimentacao || []).filter((row) => matches(row, filter, true));
    movements = applyColumnFilters(movements, 'tableTurnover');
    updateCount('countTurnover', movements);
    movements = sortRows(movements, tableSort.tbodyTurnover, (row, key) => key === 'grupo' ? (row.grupo || row.consultor) : row[key]);
    updateTableHeadIcons('tbodyTurnover', tableSort.tbodyTurnover.colKey, tableSort.tbodyTurnover.dir);
    const pMovements = getPaginatedSlice('tableTurnover', movements);
    if (el('tbodyTurnover')) el('tbodyTurnover').innerHTML = rowsOrEmpty(pMovements, 6, (row) => {
      const isSaida = row.tipo === 'SAÍDA';
      const grp = row.grupo || row.consultor || '—';
      const numAtend = row.atendimento || row.numero_atendimento || '—';
      return `<tr class="${isSaida ? 'table-row-grave' : ''}"><td class="col-center font-tabular"><strong>${escapeHtml(String(numAtend))}</strong></td><td class="col-left" title="${escapeHtml(row.produtor || '—')}"><strong>${escapeHtml(row.produtor || '—')}</strong></td><td class="col-center"><span class="badge ${isSaida ? 'badge-danger' : 'badge-positive'}">${escapeHtml(row.tipo)}</span></td><td class="col-center">${escapeHtml(row.data || '—')}</td><td class="col-left" title="${escapeHtml(grp)}">${escapeHtml(grp)}</td><td class="col-left" title="${escapeHtml(row.motivo || '—')}">${escapeHtml(row.motivo || '—')}</td></tr>`;
    });
    renderTablePagination('paginationTurnover', 'tableTurnover', movements.length);

    // Tabela 4: Consultores
    let consultants = (visits.tabelaConsultores || []).filter((row) => matches(row, filter, true));
    consultants = applyColumnFilters(consultants, 'tableConsultants');
    updateCount('countConsultants', consultants);
    consultants = sortRows(consultants, tableSort.tbodyConsultants, (row, key) => row[key]);
    updateTableHeadIcons('tbodyConsultants', tableSort.tbodyConsultants.colKey, tableSort.tbodyConsultants.dir);
    const pConsultants = getPaginatedSlice('tableConsultants', consultants);
    if (el('tbodyConsultants')) el('tbodyConsultants').innerHTML = rowsOrEmpty(pConsultants, 6, (row) => `<tr><td class="col-left" title="${escapeHtml(row.consultor || '—')}"><strong>${escapeHtml(row.consultor || '—')}</strong></td><td class="col-center font-tabular">${number(row.total_fazendas)}</td><td class="col-center font-tabular">${number(row.fazendas_visitadas)}</td><td class="col-center font-tabular">${number(row.total_visitas)}</td><td class="col-center font-tabular">${percent(row.perc_cobertura)}</td><td class="col-center"><span class="badge badge-positive">ATIVO</span></td></tr>`);
    renderTablePagination('paginationConsultants', 'tableConsultants', consultants.length);

    // Tabela 5: Produtores com Dados
    let withData = (consistency.tabelaProdutoresComDados || []).filter((row) => matches(row, filter, true));
    withData = applyColumnFilters(withData, 'tableDataProducers');
    updateCount('countDataProducers', withData);
    withData = sortRows(withData, tableSort.tbodyDataProducers, (row, key) => key === 'produtor' ? (row.produtor || row.codigo_lr) : row[key]);
    updateTableHeadIcons('tbodyDataProducers', tableSort.tbodyDataProducers.colKey, tableSort.tbodyDataProducers.dir);
    const pWithData = getPaginatedSlice('tableDataProducers', withData);
    if (el('tbodyDataProducers')) el('tbodyDataProducers').innerHTML = rowsOrEmpty(pWithData, 6, (row) => {
      const noData = row.possui_dados === false;
      const prodName = row.produtor || row.codigo_lr || '—';
      return `<tr class="${noData ? 'table-row-grave' : ''}"><td class="col-center"><strong>${escapeHtml(row.codigo_lr || '—')}</strong></td><td class="col-left" title="${escapeHtml(prodName)}">${escapeHtml(prodName)}</td><td class="col-left" title="${escapeHtml(row.consultor || '—')}">${escapeHtml(row.consultor || '—')}</td><td class="col-center"><span class="badge ${noData ? 'badge-danger' : 'badge-positive'}">${noData ? 'NÃO' : 'SIM'}</span></td><td class="col-center">${escapeHtml(row.referencia || '—')}</td><td class="col-center"><span class="badge ${String(row.status).toUpperCase() === 'INATIVO' ? 'badge-danger' : 'badge-positive'}">${escapeHtml(row.status || 'ATIVO')}</span></td></tr>`;
    });
    renderTablePagination('paginationDataProducers', 'tableDataProducers', withData.length);

    // Tabela 6: Inconsistências
    let inconsistencies = (consistency.tabelaInconsistentes || []).filter((row) => matches(row, filter, true));
    inconsistencies = applyColumnFilters(inconsistencies, 'tableInconsistencies');
    updateCount('countInconsistencies', inconsistencies);
    inconsistencies = sortRows(inconsistencies, tableSort.tbodyInconsistencies, (row, key) => key === 'produtor' ? (row.produtor || row.codigo_lr) : row[key]);
    updateTableHeadIcons('tbodyInconsistencies', tableSort.tbodyInconsistencies.colKey, tableSort.tbodyInconsistencies.dir);
    const pInconsistencies = getPaginatedSlice('tableInconsistencies', inconsistencies);
    if (el('tbodyInconsistencies')) el('tbodyInconsistencies').innerHTML = rowsOrEmpty(pInconsistencies, 7, (row, idx) => {
      const isGraveMensal = isStatusInconsistente(row.consistencia_mensal || row.consistencia);
      const isGraveAnual = isStatusInconsistente(row.consistencia_anual);
      const isGrave = isGraveMensal || isGraveAnual;
      const rowClass = isGrave ? 'table-row-grave' : 'table-row-pending';

      const getBadgeClass = (val) => {
        const str = String(val || '').toLowerCase();
        if (str.includes('consistente') && !str.includes('inconsistente')) return 'badge-positive';
        if (str.includes('inconsistente') || str.includes('divergente') || str.includes('outlier')) return 'badge-danger';
        return 'badge-warning';
      };

      const badgeClassMensal = getBadgeClass(row.consistencia_mensal || row.consistencia);
      const badgeClassAnual = getBadgeClass(row.consistencia_anual);
      const prodName = row.produtor || row.codigo_lr || '—';

      return `<tr class="${rowClass}"><td class="col-center"><strong>${escapeHtml(row.codigo_lr || '—')}</strong></td><td class="col-left" title="${escapeHtml(prodName)}"><strong>${escapeHtml(prodName)}</strong></td><td class="col-left" title="${escapeHtml(row.consultor || '—')}">${escapeHtml(row.consultor || '—')}</td><td class="col-center font-tabular">${number(row.meses_sequenciais)}</td><td class="col-center"><span class="badge ${badgeClassMensal}" title="${escapeHtml(row.consistencia_mensal || 'SEM DADOS')}">${escapeHtml(row.consistencia_mensal || 'SEM DADOS')}</span></td><td class="col-center"><span class="badge ${badgeClassAnual}" title="${escapeHtml(row.consistencia_anual || 'SEM DADOS')}">${escapeHtml(row.consistencia_anual || 'SEM DADOS')}</span></td><td class="col-center"><button class="link-button btn-view-details" type="button" onclick="window.openInconsistencyDetail('${escapeHtml(row.codigo_lr || row.produtor)}')">Ver detalhes ›</button></td></tr>`;
    });
    renderTablePagination('paginationInconsistencies', 'tableInconsistencies', inconsistencies.length);
  }

  // ─── LÓGICA DE FILTRAGEM MULTIDIRECIONAL ESTILO POWER BI ──────────────

  function ehCadeiaLeite(projeto) {
    if (!projeto) return true;
    const p = String(projeto).trim().toUpperCase();
    const TERMOS_NAO_LEITE = [
      'MAIS GRAOS', 'MAIS GRÃOS', 'GRAOS', 'GRÃOS',
      'MIMC', 'M&E', 'CAFE&GESTAO', 'CAFE & GESTAO', 'CAFÉ & GESTÃO',
      'CAFÉ', 'CAFE', 'CACAU', 'CARGILL', 'NCP', 'OFI', 'PV CARGILL',
      'AGRICULTURA'
    ];
    for (const termo of TERMOS_NAO_LEITE) {
      if (p.includes(termo)) return false;
    }
    return true;
  }

  const PROJECT_LABEL_MAP = {
    'ALVOAR ASSIST': 'Alvoar Assist',
    'ALVOAR ECO': 'Alvoar Eco',
    'ATEG_CCPR': 'Ateg_Ccpr',
    'LPA': 'Lpa',
    'REGENERA': 'Regenera',
    'SEMEAR': 'Semear'
  };

  function formatProjectLabel(projectCode) {
    if (!projectCode) return '';
    const code = String(projectCode).trim().toUpperCase();
    if (PROJECT_LABEL_MAP[code]) return PROJECT_LABEL_MAP[code];
    return String(projectCode)
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function mapAgroindustria(projeto) {
    if (!projeto) return 'NÃO INFORMADA';
    const p = String(projeto).trim().toUpperCase();
    if (p === 'LEITE' || p === 'GERAL' || p === 'NÃO INFORMADA' || p === 'NAO INFORMADA') return 'NÃO INFORMADA';
    if (p.includes('ALVOAR')) return 'Alvoar';
    if (p.includes('CCPR')) return 'CCPR';
    if (p.includes('LPA') || p.includes('PORTO ALEGRE')) return 'Laticínios Porto Alegre (LPA)';
    if (p.includes('REGENERA') || p.includes('NESTLE') || p.includes('NESTLÉ')) return 'Nestlé';
    if (p.includes('SEMEAR') || p.includes('DANONE')) return 'Danone';
    if (p.includes('COPRIL')) return 'Copril';
    if (p.includes('CAMPILEITE')) return 'CAMPILEITE';
    if (p.includes('QUILLAYES')) return 'Quillayes';
    if (p.includes('PIRACANJUBA')) return 'Piracanjuba';
    if (p.includes('INDEPENDENTE')) return 'Independente';
    return String(projeto).trim();
  }

  function extractMasterRows(overview, visits, turnover, consistency) {
    const o = overview || emptyState.overview;
    const v = visits || emptyState.visits;
    const t = turnover || emptyState.turnover;
    const c = consistency || emptyState.consistency;

    const rows = [];
    const seen = new Set();

    function addRow(r, defaultStatus = 'ATIVO') {
      if (!r) return;
      if (!ehCadeiaLeite(r.projeto || r.agroindustria)) return;
      const consultores = sanitizeConsultorList(r.consultor || r.nome_consultor);
      const produtor = String(r.produtor || r.nome_produtor || '').trim();
      const codigoLr = String(r.codigo_lr || '').trim();
      const agro = mapAgroindustria(r.agroindustria || r.projeto);
      const reg = sanitizeRegiao(r.regiao || r.unidade_atendimento, r.projeto || r.agroindustria);
      const proj = String(r.projeto || '').trim();
      const stat = normalizeStatus(r.status || defaultStatus);
      const mes = String(r.mes_referencia || r.data_referencia || '').slice(0, 10);

      if (produtor.includes('_CONSULTOR') || produtor === 'CONTA DE SUPERVISÃO') return;

      if (consultores.length === 0) {
        const key = `${agro}|${reg}|${proj}|${stat}||${produtor}|${codigoLr}|${mes}`;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push({
            agroindustria: agro || '',
            regiao: reg || '',
            projeto: proj || '',
            status: stat || 'ATIVO',
            consultor: '',
            produtor: produtor || '',
            codigo_lr: codigoLr || '',
            mes_referencia: mes || ''
          });
        }
      } else {
        consultores.forEach((consult) => {
          const cleanConsult = String(consult || '').trim();
          if (!cleanConsult) return;
          const key = `${agro}|${reg}|${proj}|${stat}|${cleanConsult}|${produtor}|${codigoLr}|${mes}`;
          if (!seen.has(key)) {
            seen.add(key);
            rows.push({
              agroindustria: agro || '',
              regiao: reg || '',
              projeto: proj || '',
              status: stat || 'ATIVO',
              consultor: cleanConsult || '',
              produtor: produtor || '',
              codigo_lr: codigoLr || '',
              mes_referencia: mes || ''
            });
          }
        });
      }
    }

    // 0. Base Mestre Direta da sq_dim_fazendas_ativas
    if (o.dim_fazendas && Array.isArray(o.dim_fazendas)) {
      o.dim_fazendas.forEach((r) => addRow(r, r.status || 'ATIVO'));
    }

    // 1. Tabela de consultores ativos da carteira oficial do mês
    (v.tabelaConsultores || []).forEach((tc) => {
      const consult = tc.consultor;
      const agros = tc.agroindustrias && tc.agroindustrias.length ? tc.agroindustrias : [mapAgroindustria(tc.projeto)];
      const projs = tc.projetos && tc.projetos.length ? tc.projetos : [tc.projeto];
      const regs = tc.regioes && tc.regioes.length ? tc.regioes : [tc.regiao];
      agros.forEach((agro) => {
        projs.forEach((proj) => {
          regs.forEach((reg) => {
            addRow({
              consultor: consult,
              agroindustria: agro,
              projeto: proj,
              regiao: reg,
              status: 'ATIVO',
              mes_referencia: tc.mes_referencia
            }, 'ATIVO');
          });
        });
      });
    });

    (o.tabelas?.sem_visita || []).forEach((r) => addRow(r, 'ATIVO'));
    (o.tabelas?.visitados || []).forEach((r) => addRow(r, 'ATIVO'));
    (c.tabelaProdutoresComDados || []).forEach((r) => addRow(r, r.status || 'ATIVO'));
    (c.tabelaInconsistentes || []).forEach((r) => addRow(r, r.status || 'ATIVO'));
    (t.tabelaMovimentacao || []).forEach((r) => addRow(r, r.status || (r.tipo === 'SAÍDA' ? 'INATIVO' : 'ATIVO')));

    return rows;
  }

  function syncCustomSelectDisplay(selectId) {
    const select = el(selectId);
    if (!select) return;
    const control = select.closest('.filter-control');
    if (!control) return;
    const displayValue = control.querySelector('.select-display-value');
    if (!displayValue) return;
    const selectedOpt = select.options[select.selectedIndex];
    displayValue.textContent = selectedOpt ? selectedOpt.text : (select.value || '');
  }

  function populateMonthSelect(values) {
    const select = el('filterMonth');
    if (!select) return;
    const current = select.value;
    const now = new Date();
    const currentCalendarMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const maxAllowedMonth = currentCalendarMonth;
    const unique = [...new Set((values || []).filter(Boolean).map((v) => String(v).slice(0, 10)).filter((v) => v <= maxAllowedMonth))].sort().reverse();
    const options = unique.map((value) => {
      const parsed = new Date(`${value}T12:00:00`);
      const label = Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (letter) => letter.toUpperCase());
      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    }).join('');
    select.innerHTML = `<option value="">Todos</option>${options}`;
    if (state.hasUserChangedMonth) {
      if (unique.includes(current) || current === '') select.value = current;
    } else {
      // Padrão ao carregar o dashboard: selecionar o mês atual (ou o mês mais recente disponível <= mês atual), não TODOS
      if (unique.length > 0) {
        select.value = unique.includes(currentCalendarMonth) ? currentCalendarMonth : unique[0];
      }
    }
    syncCustomSelectDisplay('filterMonth');
  }

  function updateAllCrossFilters() {
    const current = currentFilter();
    const rows = state.masterRows || [];
    if (!rows.length) return;

    const curInd = current.industry;
    const curReg = current.region;
    const curProj = current.project;
    const curStat = current.status;
    const curCons = (current.consultant || '').toLowerCase();
    const curProd = (current.producer || '').toLowerCase();
    const curMonth = current.month ? String(current.month).slice(0, 7) : '';

    function matchesActiveExcept(row, fieldKey) {
      if (!ehCadeiaLeite(row.projeto || row.agroindustria)) return false;
      if (fieldKey !== 'month' && curMonth && row.mes_referencia && String(row.mes_referencia).slice(0, 7) !== curMonth) return false;
      if (fieldKey !== 'industry' && curInd && row.agroindustria !== curInd) return false;
      if (fieldKey !== 'region' && curReg && row.regiao !== curReg) return false;
      if (fieldKey !== 'project' && curProj && row.projeto !== curProj) return false;
      if (fieldKey !== 'status' && curStat && row.status !== curStat) return false;
      if (fieldKey !== 'consultant' && curCons && (row.consultor || '').toLowerCase() !== curCons) return false;
      if (fieldKey !== 'producer' && curProd && (row.produtor || '').toLowerCase() !== curProd) return false;
      return true;
    }

    // 1. Agroindústria
    const indSelect = el('filterIndustry');
    if (indSelect) {
      const prevVal = indSelect.value;
      const validRows = rows.filter((r) => matchesActiveExcept(r, 'industry'));
      const oficiais = state.overview?.filterOptions?.agroindustrias;
      let available = [...new Set(validRows.map((r) => r.agroindustria).filter(Boolean).filter(ehCadeiaLeite))];
      if (oficiais && Array.isArray(oficiais) && oficiais.length > 0) {
        available = available.filter((ind) => oficiais.includes(ind));
      }
      available.sort((a, b) => a.localeCompare(b, 'pt-BR'));
      indSelect.innerHTML = `<option value="">Todas</option>${available.map((ind) => `<option value="${escapeHtml(ind)}">${escapeHtml(ind)}</option>`).join('')}`;
      if (available.includes(prevVal)) indSelect.value = prevVal;
      else indSelect.value = '';
      syncCustomSelectDisplay('filterIndustry');
    }

    // 2. Região
    const regSelect = el('filterRegion');
    if (regSelect) {
      const prevVal = regSelect.value;
      const validRows = rows.filter((r) => matchesActiveExcept(r, 'region'));
      const available = [...new Set(validRows.map((r) => r.regiao).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      regSelect.innerHTML = `<option value="">Todas</option>${available.map((reg) => `<option value="${escapeHtml(reg)}">${escapeHtml(reg)}</option>`).join('')}`;
      if (available.includes(prevVal)) regSelect.value = prevVal;
      else regSelect.value = '';
      syncCustomSelectDisplay('filterRegion');
    }

    // 3. Projeto
    const projSelect = el('filterProject');
    if (projSelect) {
      const prevVal = projSelect.value;
      const validRows = rows.filter((r) => matchesActiveExcept(r, 'project'));
      const availableProjects = [...new Set(validRows.map((r) => r.projeto).filter(Boolean).filter(ehCadeiaLeite))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      projSelect.innerHTML = `<option value="">Todos</option>${availableProjects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(formatProjectLabel(p))}</option>`).join('')}`;
      if (availableProjects.includes(prevVal)) projSelect.value = prevVal;
      else projSelect.value = '';
      syncCustomSelectDisplay('filterProject');
    }

    // 4. Consultor
    const consultSelect = el('filterConsultant');
    if (consultSelect) {
      const prevVal = consultSelect.value;
      const validRows = rows.filter((r) => matchesActiveExcept(r, 'consultant'));
      const available = [...new Set(validRows.map((r) => r.consultor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      consultSelect.innerHTML = `<option value="">Todos</option>${available.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}`;
      if (available.includes(prevVal)) consultSelect.value = prevVal;
      else consultSelect.value = '';
      syncCustomSelectDisplay('filterConsultant');
    }

    // 6. Produtor
    const prodSelect = el('filterProducer');
    if (prodSelect) {
      const prevVal = prodSelect.value;
      const validRows = rows.filter((r) => matchesActiveExcept(r, 'producer'));
      const available = [...new Set(
        validRows.map((r) => r.produtor)
          .filter((p) => p && !String(p).includes('_CONSULTOR') && p !== 'CONTA DE SUPERVISÃO')
      )].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      prodSelect.innerHTML = `<option value="">Todos</option>${available.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}`;
      if (available.includes(prevVal)) prodSelect.value = prevVal;
      else prodSelect.value = '';
      syncCustomSelectDisplay('filterProducer');
    }
  }

  function getTableDataForExport(tableId) {
    const filter = currentFilter();
    const overview = state.overview || emptyState.overview;
    const visits = state.visits || emptyState.visits;
    const turnover = state.turnover || emptyState.turnover;
    const consistency = state.consistency || emptyState.consistency;

    if (tableId === 'tableSemVisita') {
      let data = (overview.tabelas?.sem_visita || []).filter((row) => matches(row, filter, true));
      data = applyColumnFilters(data, 'tableSemVisita');
      return {
        headers: ['Consultor(a)', 'ID (Código LR)', 'Produtor(a)', 'Propriedade', 'Agroindústria', 'Região', 'Projeto', 'Data Associação', 'Última Visita', 'Dias s/ Visita', 'Status'],
        rows: data.map((r) => [
          r.consultor || '—',
          r.codigo_lr || '—',
          r.produtor || '—',
          r.propriedade || '—',
          r.agroindustria || '—',
          r.regiao || '—',
          r.projeto || '—',
          r.data_associacao || r.data_vinculacao || '—',
          r.data_ultima_visita || '—',
          r.dias_sem_visita !== null && r.dias_sem_visita !== undefined ? r.dias_sem_visita : '—',
          r.status && r.status !== 'ATIVO' ? r.status : (r.dias_sem_visita >= 60 ? 'Sem visita > 60 dias' : (r.dias_sem_visita >= 45 ? 'Sem visita > 45 dias' : (r.dias_sem_visita >= 30 ? 'Sem visita > 30 dias' : 'Sem visita no período')))
        ])
      };
    }

    if (tableId === 'tableVisitados') {
      let data = (overview.tabelas?.visitados || []).filter((row) => matches(row, filter, true));
      data = applyColumnFilters(data, 'tableVisitados');
      return {
        headers: ['Consultor(a)', 'ID (Código LR)', 'Produtor(a)', 'Nº Atendimento', 'Data Visita', 'Mês Referência', 'Projeto', 'Agroindústria', 'Região', 'Elabore'],
        rows: data.map((r) => [
          r.consultor || '—',
          r.codigo_lr || '—',
          r.produtor || '—',
          r.atendimento || '—',
          r.data_visita || '—',
          r.mes_referencia || '—',
          r.projeto || '—',
          r.agroindustria || '—',
          r.regiao || '—',
          r.elabore_ok === false ? 'NÃO' : 'SIM'
        ])
      };
    }

    if (tableId === 'tableTurnover') {
      let data = (turnover.tabelaMovimentacao || []).filter((row) => matches(row, filter, true));
      data = applyColumnFilters(data, 'tableTurnover');
      return {
        headers: ['Nº Atendimento', 'Produtor(a)', 'Movimentação', 'Data', 'Consultor / Grupo', 'Motivo da Inativação'],
        rows: data.map((r) => [
          r.atendimento || r.numero_atendimento || '—',
          r.produtor || '—',
          r.tipo || (String(r.movimentacao).toLowerCase().includes('sa') ? 'SAÍDA' : 'ENTRADA'),
          r.data || '—',
          r.grupo || r.consultor || '—',
          r.motivo || '—'
        ])
      };
    }

    if (tableId === 'tableConsultants') {
      let data = (visits.tabelaConsultores || []).filter((row) => matches(row, filter, true));
      data = applyColumnFilters(data, 'tableConsultants');
      return {
        headers: ['Consultor(a)', 'Total Fazendas', 'Fazendas Visitadas', 'Total Visitas', '% Cobertura', 'Status'],
        rows: data.map((r) => [
          r.consultor || '—',
          r.total_fazendas ?? 0,
          r.fazendas_visitadas ?? 0,
          r.total_visitas ?? 0,
          percent(r.perc_cobertura),
          'ATIVO'
        ])
      };
    }

    if (tableId === 'tableDataProducers') {
      let data = (consistency.tabelaProdutoresComDados || []).filter((row) => matches(row, filter, true));
      data = applyColumnFilters(data, 'tableDataProducers');
      return {
        headers: ['ID (Código LR)', 'Produtor(a)', 'Consultor(a)', 'Possui Dados', 'Última Referência', 'Status Cadastral'],
        rows: data.map((r) => [
          r.codigo_lr || '—',
          r.produtor || r.codigo_lr || '—',
          r.consultor || '—',
          r.possui_dados ? 'SIM' : 'NÃO',
          r.referencia || '—',
          r.status || 'ATIVO'
        ])
      };
    }

    return null;
  }

  function exportTableToCsv(tableId, defaultFilename) {
    const exportData = getTableDataForExport(tableId);
    if (!exportData || !exportData.rows.length) {
      alert('Nenhum dado disponível para exportação com os filtros atuais.');
      return;
    }

    const csvLines = [exportData.headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(';')];
    exportData.rows.forEach((rowVals) => {
      csvLines.push(rowVals.map((v) => `"${String(v ?? '—').trim().replace(/\r?\n/g, ' | ').replace(/"/g, '""')}"`).join(';'));
    });

    const bom = '\uFEFF';
    const blob = new Blob([bom + csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const d = new Date();
    const dateStr = `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    link.href = url;
    link.download = `${dateStr}_${defaultFilename || 'export'}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportInconsistenciesToCsv() {
    const filter = currentFilter();
    let inconsistencies = (state.consistency?.tabelaInconsistentes || []).filter((row) => matches(row, filter));
    if (!inconsistencies.length) {
      alert('Nenhum dado disponível para exportação com os filtros atuais.');
      return;
    }
    inconsistencies = sortRows(inconsistencies, tableSort.tbodyInconsistencies, (row, key) => key === 'produtor' ? (row.produtor || row.codigo_lr) : row[key]);

    const headers = [
      'ID (Código LR)',
      'Produtor(a)',
      'Consultor(a)',
      'Projeto',
      'Agroindústria',
      'Região',
      'Mês Referência',
      'Meses Consecutivos',
      'Situação Mensal',
      'Situação Anual',
      'Detalhamento Mensal',
      'Detalhamento Anual'
    ];

    const csvLines = [headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(';')];

    inconsistencies.forEach((row) => {
      const prodName = row.produtor || row.codigo_lr || '—';
      const detMensal = row.detalhamento || 'Nenhum detalhamento registrado na base mensal.';
      const detAnual = row.detalhamento_anual || 'Nenhum detalhamento registrado na base anual.';
      const values = [
        row.codigo_lr || '—',
        prodName,
        row.consultor || '—',
        row.projeto || '—',
        row.agroindustria || '—',
        row.regiao || '—',
        row.mes_referencia || '—',
        row.meses_sequenciais ?? '0',
        row.consistencia_mensal || 'SEM DADOS',
        row.consistencia_anual || 'SEM DADOS',
        detMensal,
        detAnual
      ];
      csvLines.push(values.map((v) => `"${String(v).trim().replace(/\r?\n/g, ' | ').replace(/"/g, '""')}"`).join(';'));
    });

    const bom = '\uFEFF';
    const blob = new Blob([bom + csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const d = new Date();
    const dateStr = `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    link.href = url;
    link.download = `${dateStr}_inconsistencias_identificadas.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function setupExportButtons() {
    el('btnExportSemVisita')?.addEventListener('click', () => exportTableToCsv('tableSemVisita', 'produtores_sem_visita'));
    el('btnExportVisitados')?.addEventListener('click', () => exportTableToCsv('tableVisitados', 'produtores_visitados'));
    el('btnExportTurnover')?.addEventListener('click', () => exportTableToCsv('tableTurnover', 'movimentacao_produtores'));
    el('btnExportConsultants')?.addEventListener('click', () => exportTableToCsv('tableConsultants', 'consultores_ativos'));
    el('btnExportDataProducers')?.addEventListener('click', () => exportTableToCsv('tableDataProducers', 'produtores_com_dados'));
    el('btnExportInconsistencies')?.addEventListener('click', exportInconsistenciesToCsv);
  }

  function updateTimestamp() {
    const now = new Date();
    if (el('lastUpdateDate')) el('lastUpdateDate').textContent = `${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }

  async function fetchMonthMasterData() {
    let selectedMonth = el('filterMonth')?.value || '';
    if (!selectedMonth && !state.hasUserChangedMonth) {
      const now = new Date();
      selectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const select = el('filterMonth');
      if (select) select.value = selectedMonth;
    }

    const query = selectedMonth ? `?month=${encodeURIComponent(selectedMonth)}` : '';
    const [overview, visits, turnover, consistency] = await Promise.all([
      getJson(`/api/overview${query}`),
      getJson(`/api/visits${query}`),
      getJson(`/api/turnover${query}`),
      getJson(`/api/consistency${query}`)
    ]);

    state.masterOverview = overview;
    state.masterVisits = visits;
    state.masterTurnover = turnover;
    state.masterConsistency = consistency;
    state.masterRows = extractMasterRows(overview, visits, turnover, consistency);

    if (overview?.filterOptions?.meses) {
      if (!state.allAvailableMonths || state.allAvailableMonths.length === 0) {
        state.allAvailableMonths = overview.filterOptions.meses;
      } else {
        state.allAvailableMonths = [...new Set([...state.allAvailableMonths, ...overview.filterOptions.meses])];
      }
      populateMonthSelect(state.allAvailableMonths);
    }
  }

  let debounceFilterTimer = null;

  async function loadAllData(isFilterChange = false) {
    showLoading(isFilterChange ? 'Atualizando dashboard com filtros...' : 'Carregando dados...');

    try {
      if (!state.masterRows || state.masterRows.length === 0) {
        await fetchMonthMasterData();
        updateAllCrossFilters();
      }

      const filter = currentFilter();
      const params = new URLSearchParams();
      if (filter.month) params.set('month', filter.month);
      if (filter.industry) params.set('industry', filter.industry);
      if (filter.region) params.set('region', filter.region);
      if (filter.project) params.set('project', filter.project);
      if (filter.consultant) params.set('consultant', filter.consultant);
      if (filter.status) params.set('status', filter.status);
      if (filter.producer) params.set('producer', filter.producer);

      const query = params.toString() ? `?${params.toString()}` : '';
      const [overview, visits, turnover, consistency] = await Promise.all([
        getJson(`/api/overview${query}`),
        getJson(`/api/visits${query}`),
        getJson(`/api/turnover${query}`),
        getJson(`/api/consistency${query}`)
      ]);
      state.overview = overview;
      state.visits = visits;
      state.turnover = turnover;
      state.consistency = consistency;
      renderVisits(visits);
      renderConsistency(consistency);
      renderOverview(overview);
      renderTurnover(turnover);
      renderTables();
      updateTimestamp();
    } finally {
      hideLoading(0);
    }
  }

  function handleFilterSelectionChange() {
    updateAllCrossFilters();
    Object.keys(tablePagination).forEach((k) => { tablePagination[k].page = 1; });
    clearTimeout(debounceFilterTimer);
    debounceFilterTimer = setTimeout(() => {
      loadAllData(true);
    }, 50);
  }

  function closeAllPopups() {
    document.querySelectorAll('.custom-select-popup').forEach((p) => p.classList.remove('open'));
    document.querySelectorAll('.filter-control').forEach((fc) => {
      fc.classList.remove('active-popup');
      fc.setAttribute('aria-expanded', 'false');
    });
  }

  function normalizeText(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function setupCustomSelectDropdowns() {
    const filterControls = document.querySelectorAll('.filter-control');
    
    filterControls.forEach((control) => {
      const select = control.querySelector('select');
      if (!select) return;

      if (!control.hasAttribute('tabindex')) {
        control.setAttribute('tabindex', '0');
        control.setAttribute('role', 'combobox');
        control.setAttribute('aria-expanded', 'false');
        control.setAttribute('aria-haspopup', 'listbox');
      }

      let displayValue = control.querySelector('.select-display-value');
      if (!displayValue) {
        displayValue = document.createElement('div');
        displayValue.className = 'select-display-value';
        control.appendChild(displayValue);
      }

      function syncDisplayValue() {
        const selectedOpt = select.options[select.selectedIndex];
        displayValue.textContent = selectedOpt ? selectedOpt.text : (select.value || '');
      }

      syncDisplayValue();

      let popup = control.querySelector('.custom-select-popup');
      if (!popup) {
        popup = document.createElement('div');
        popup.className = 'custom-select-popup';
        control.appendChild(popup);
      }

      select.onchange = syncDisplayValue;

      if (control.dataset.customSelectInitialized === 'true') {
        return;
      }
      control.dataset.customSelectInitialized = 'true';

      let highlightedIndex = 0;

      function highlightOption(index, scroll = true) {
        const optionsList = popup.querySelector('.custom-select-options-list');
        if (!optionsList) return;
        const optEls = optionsList.querySelectorAll('.custom-select-option');
        if (optEls.length === 0) return;

        if (index < 0) index = 0;
        if (index >= optEls.length) index = optEls.length - 1;
        highlightedIndex = index;

        optEls.forEach((el, idx) => {
          if (idx === highlightedIndex) {
            el.classList.add('highlighted');
            if (scroll) {
              el.scrollIntoView({ block: 'nearest' });
            }
          } else {
            el.classList.remove('highlighted');
          }
        });
      }

      function selectOptionByValue(val) {
        select.value = val;
        syncDisplayValue();
        closeAllPopups();
        showLoading('Atualizando dashboard com filtros...');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        control.focus();
      }

      function updatePopupOptions(searchQuery = '') {
        const options = Array.from(select.options);
        const queryNorm = normalizeText(searchQuery);

        const currentFilteredOptions = options.filter(opt => {
          if (!queryNorm) return true;
          return normalizeText(opt.text).includes(queryNorm);
        });

        let searchWrap = popup.querySelector('.custom-select-search-wrap');
        let optionsList = popup.querySelector('.custom-select-options-list');

        if (!searchWrap || !optionsList) {
          popup.innerHTML = `
            <div class="custom-select-search-wrap">
              <input type="text" class="custom-select-search-input" placeholder="Pesquisar..." aria-label="Pesquisar opção">
            </div>
            <div class="custom-select-options-list"></div>
          `;
          searchWrap = popup.querySelector('.custom-select-search-wrap');
          optionsList = popup.querySelector('.custom-select-options-list');

          const inputEl = searchWrap.querySelector('.custom-select-search-input');
          inputEl.addEventListener('click', (e) => e.stopPropagation());
          inputEl.addEventListener('mousedown', (e) => e.stopPropagation());
          
          inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            const key = e.key;
            const isDown = key === 'ArrowDown' || key === 'Down' || e.keyCode === 40;
            const isUp = key === 'ArrowUp' || key === 'Up' || e.keyCode === 38;
            const isEnter = key === 'Enter' || e.keyCode === 13;
            const isEsc = key === 'Escape' || key === 'Esc' || e.keyCode === 27;
            const isTab = key === 'Tab' || e.keyCode === 9;

            if (isDown) {
              e.preventDefault();
              highlightOption(highlightedIndex + 1, true);
            } else if (isUp) {
              e.preventDefault();
              highlightOption(highlightedIndex - 1, true);
            } else if (isEnter) {
              e.preventDefault();
              const optsList = popup.querySelector('.custom-select-options-list');
              const optEls = optsList ? optsList.querySelectorAll('.custom-select-option') : [];
              if (optEls.length > 0) {
                const targetIdx = Math.max(0, Math.min(highlightedIndex, optEls.length - 1));
                const targetEl = optEls[targetIdx];
                if (targetEl && targetEl.dataset.value !== undefined) {
                  selectOptionByValue(targetEl.dataset.value);
                }
              }
            } else if (isEsc) {
              e.preventDefault();
              closeAllPopups();
              control.focus();
            } else if (isTab) {
              closeAllPopups();
            }
          });

          inputEl.addEventListener('input', (e) => {
            updatePopupOptions(e.target.value);
          });
        }

        if (currentFilteredOptions.length === 0) {
          optionsList.innerHTML = `<div class="custom-select-no-results">Nenhum resultado encontrado</div>`;
          highlightedIndex = -1;
        } else {
          const selectedIdx = currentFilteredOptions.findIndex(opt => opt.value === select.value);
          highlightedIndex = selectedIdx >= 0 ? selectedIdx : 0;

          optionsList.innerHTML = currentFilteredOptions.map((opt, idx) => {
            const isSelected = opt.value === select.value;
            const isHighlighted = idx === highlightedIndex;
            return `<div class="custom-select-option ${isSelected ? 'selected' : ''} ${isHighlighted ? 'highlighted' : ''}" data-value="${escapeHtml(opt.value)}" data-index="${idx}">
              <span>${escapeHtml(opt.text)}</span>
              ${isSelected ? '<span style="font-size:10px;">✓</span>' : ''}
            </div>`;
          }).join('');

          highlightOption(highlightedIndex, true);
        }

        optionsList.querySelectorAll('.custom-select-option').forEach((optEl, idx) => {
          optEl.addEventListener('mouseenter', () => {
            highlightOption(idx, false);
          });

          optEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const val = optEl.dataset.value;
            selectOptionByValue(val);
          });
        });
      }

      function togglePopup(e) {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        const isOpen = popup.classList.contains('open');
        closeAllPopups();
        if (!isOpen) {
          updatePopupOptions('');
          popup.classList.add('open');
          control.classList.add('active-popup');
          control.setAttribute('aria-expanded', 'true');
          const searchInput = popup.querySelector('.custom-select-search-input');
          if (searchInput) {
            searchInput.value = '';
            setTimeout(() => searchInput.focus(), 60);
          }
        }
      }

      control.addEventListener('click', (e) => {
        if (e.target.closest('.custom-select-popup')) return;
        togglePopup(e);
      });

      control.addEventListener('keydown', (e) => {
        if (e.target.closest('.custom-select-popup')) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          togglePopup(e);
        }
      });
    });

    if (!window._customSelectDocumentListenerAttached) {
      window._customSelectDocumentListenerAttached = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.filter-control')) {
          closeAllPopups();
        }
      });
    }
  }

  const mobileFilterToggle = el('mobileFilterToggle');
  const filterShell = el('filterShell');
  if (mobileFilterToggle && filterShell) {
    mobileFilterToggle.addEventListener('click', () => {
      const isExpanded = filterShell.classList.toggle('is-expanded');
      mobileFilterToggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.renderAllCharts && state.renderedData) {
        window.renderAllCharts(state.renderedData);
      }
    }, 250);
  });

  // Eventos de filtros com suporte a filtragem cruzada multidirecional estilo Power BI
  ['filterIndustry', 'filterRegion', 'filterProject', 'filterConsultant', 'filterProducer']
    .forEach((id) => el(id)?.addEventListener('change', handleFilterSelectionChange));
  el('filterMonth')?.addEventListener('change', async () => {
    state.hasUserChangedMonth = true;
    showLoading('Atualizando dashboard com filtros...');
    state.masterRows = null;
    await fetchMonthMasterData();
    updateAllCrossFilters();
    await loadAllData(true);
  });
  document.querySelectorAll('[data-ranking]').forEach((button) => button.addEventListener('click', () => {
    state.rankingDimension = button.dataset.ranking;
    renderSelectedRanking();
  }));

  function setupDetailsModal() {
    const detailsModal = el('detailsModal');
    const modalBody = el('modalBody');
    const modalCancelBtn = el('modalCancelBtn');

    function openDetailsModal(item) {
      if (!item || !detailsModal || !modalBody) return;

      const statusMensalStr = String(item.consistencia_mensal || item.consistencia || 'Consistente');
      const isMensalInconsistente = isStatusInconsistente(statusMensalStr);
      const isMensalConsistente = isStatusConsistente(statusMensalStr);
      const isMensalSemDados = statusMensalStr.toLowerCase().includes('sem dados') || statusMensalStr.toLowerCase().includes('não calculado');

      const badgeClassMensal = isMensalInconsistente ? 'badge-danger' : (isMensalConsistente ? 'badge-positive' : 'badge-warning');
      const highlightBoxClassMensal = isMensalInconsistente ? 'field-box--danger' : (isMensalSemDados ? 'field-box--warning' : '');

      const statusAnualStr = String(item.consistencia_anual || 'Não calculado');
      const isAnualInconsistente = isStatusInconsistente(statusAnualStr);
      const isAnualConsistente = isStatusConsistente(statusAnualStr);
      const isAnualSemDados = statusAnualStr.toLowerCase().includes('sem dados') || statusAnualStr.toLowerCase().includes('não calculado');

      const badgeClassAnual = isAnualInconsistente ? 'badge-danger' : (isAnualConsistente ? 'badge-positive' : 'badge-warning');
      const highlightBoxClassAnual = isAnualInconsistente ? 'field-box--danger' : (isAnualSemDados ? 'field-box--warning' : '');

      const statusBadge = String(item.status || 'ATIVO').toUpperCase() === 'INATIVO' ? 'badge-danger' : 'badge-positive';

      const refMonthText = item.mes_referencia ? String(item.mes_referencia).slice(0, 7).split('-').reverse().join('/') : '--/----';
      const refMonthEl = el('modalRefMonthText');
      if (refMonthEl) refMonthEl.textContent = refMonthText;

      const mensalDetailText = isMensalConsistente
        ? 'Registros mensais conformes e validados (sem inconsistências apuradas).'
        : (item.detalhamento || 'Nenhum detalhamento registrado na base de auditoria mensal.');

      const anualDetailText = isAnualConsistente
        ? 'Fechamento anual em conformidade (sem inconsistências apuradas).'
        : (item.detalhamento_anual || 'Nenhum detalhamento registrado na base de auditoria anual.');

      modalBody.innerHTML = `
        <fieldset class="modal-fieldset">
          <legend class="modal-legend">Informações do Produtor e Vínculo</legend>
          <div class="detail-grid">
            <div class="detail-field">
              <label class="field-label">Código LR</label>
              <div class="field-box">${escapeHtml(item.codigo_lr || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Produtor(a)</label>
              <div class="field-box field-box--bold">${escapeHtml(item.produtor || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Consultor(a) Técnico(a)</label>
              <div class="field-box">${escapeHtml(item.consultor || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Agroindústria</label>
              <div class="field-box">${escapeHtml(item.agroindustria || item.projeto || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Região Leiteira</label>
              <div class="field-box">${escapeHtml(item.regiao || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Projeto / Programa</label>
              <div class="field-box">${escapeHtml(item.projeto || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Status Cadastral</label>
              <div class="field-box"><span class="badge ${statusBadge}">${escapeHtml(item.status || 'ATIVO')}</span></div>
            </div>
          </div>
        </fieldset>

        <fieldset class="modal-fieldset">
          <legend class="modal-legend">Consistência Mensal</legend>
          <div class="detail-grid">
            <div class="detail-field">
              <label class="field-label">Mês Referência</label>
              <div class="field-box">${escapeHtml(item.mes_referencia || '—')}</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Meses Consecutivos</label>
              <div class="field-box">${number(item.meses_sequenciais)} mês(es)</div>
            </div>
            <div class="detail-field">
              <label class="field-label">Classificação Mensal</label>
              <div class="field-box"><span class="badge ${badgeClassMensal}">${escapeHtml(statusMensalStr)}</span></div>
            </div>
            <div class="detail-field field-full">
              <label class="field-label">Detalhamento da Consistência Mensal</label>
              <div class="field-box ${highlightBoxClassMensal}">${escapeHtml(mensalDetailText)}</div>
            </div>
          </div>
        </fieldset>

        <fieldset class="modal-fieldset">
          <legend class="modal-legend">Consistência Anual</legend>
          <div class="detail-grid">
            <div class="detail-field">
              <label class="field-label">Classificação Anual</label>
              <div class="field-box"><span class="badge ${badgeClassAnual}">${escapeHtml(statusAnualStr)}</span></div>
            </div>
            <div class="detail-field field-full">
              <label class="field-label">Detalhamento da Consistência Anual</label>
              <div class="field-box ${highlightBoxClassAnual}">${escapeHtml(anualDetailText)}</div>
            </div>
          </div>
        </fieldset>
      `;

      detailsModal.classList.add('active');
      detailsModal.setAttribute('aria-hidden', 'false');
    }

    function closeDetailsModal() {
      if (!detailsModal) return;
      detailsModal.classList.remove('active');
      detailsModal.setAttribute('aria-hidden', 'true');
    }

    modalCloseBtn?.addEventListener('click', closeDetailsModal);
    modalOkBtn?.addEventListener('click', closeDetailsModal);
    modalCancelBtn?.addEventListener('click', closeDetailsModal);
    detailsModal?.addEventListener('click', (e) => {
      if (e.target === detailsModal) closeDetailsModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && detailsModal?.classList.contains('active')) {
        closeDetailsModal();
      }
    });

    window.openInconsistencyDetail = function(codigoLr) {
      if (!codigoLr) return;
      const targetCode = String(codigoLr).trim().toLowerCase();
      const list = (state.consistency?.tabelaInconsistentes || []);
      const selectedItem = list.find(r => String(r.codigo_lr || '').trim().toLowerCase() === targetCode)
                        || list.find(r => String(r.produtor || '').trim().toLowerCase() === targetCode);
      if (selectedItem) {
        openDetailsModal(selectedItem);
      }
    };

    el('tbodyInconsistencies')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-view-details');
      if (!btn) return;
      const idx = Number(btn.dataset.idx);
      const filter = getFilterState();
      let inconsistencies = (state.consistency?.tabelaInconsistentes || []).filter((row) => matches(row, filter));
      inconsistencies = sortRows(inconsistencies, tableSort.tbodyInconsistencies, (row, key) => key === 'produtor' ? (row.produtor || row.codigo_lr) : row[key]);
      const selectedItem = inconsistencies[idx];
      if (selectedItem) openDetailsModal(selectedItem);
    });
  }

  function shiftMonthMinus1(monthStr) {
    if (!monthStr) return null;
    const d = new Date(`${String(monthStr).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  function getActiveReferenceMonthDisplay(isElabore = false) {
    const select = el('filterMonth');
    let monthValue = (select && select.value) ? select.value : (state.overview?.refMonth || state.visits?.refMonth || '2026-08-01');

    if (isElabore && monthValue) {
      const shifted = shiftMonthMinus1(monthValue);
      if (shifted) monthValue = shifted;
    }

    if (monthValue) {
      const parsed = new Date(`${String(monthValue).slice(0, 10)}T12:00:00`);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
      }
      return String(monthValue).slice(0, 7);
    }
    return isElabore ? 'Julho de 2026' : 'Agosto de 2026';
  }

  function setupKpiInfoPopovers() {
    const popover = el('kpiInfoPopover');
    const popoverTitle = el('kpiPopoverTitle');
    const popoverBody = el('kpiPopoverBody');
    const popoverRefBox = el('kpiPopoverRefBox');
    const popoverRefLabel = el('kpiPopoverRefLabel');
    const popoverRefVal = el('kpiPopoverRefVal');
    if (!popover || !popoverTitle || !popoverBody) return;

    let activeBtn = null;

    function showPopover(btn) {
      const title = btn.dataset.infoTitle || 'Informação do Indicador';
      const body = btn.dataset.infoBody || '';
      const isElabore = btn.dataset.infoRefType === 'mes_elabore' || title.toLowerCase().includes('elabore');
      const refMonthDisplay = btn.dataset.infoRef || getActiveReferenceMonthDisplay(isElabore);

      popoverTitle.textContent = title;
      popoverBody.textContent = body;

      if (popoverRefBox && popoverRefVal) {
        if (refMonthDisplay) {
          if (popoverRefLabel) {
            popoverRefLabel.textContent = 'Mês de referência:';
          }
          popoverRefVal.textContent = refMonthDisplay;
          popoverRefBox.style.display = 'flex';
        } else {
          popoverRefBox.style.display = 'none';
        }
      }

      const rect = btn.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      popover.style.display = 'block';
      const popoverHeight = popover.offsetHeight || 110;
      const popoverWidth = popover.offsetWidth || 270;

      let top = rect.top + scrollY - popoverHeight - 8;
      let left = rect.left + scrollX + (rect.width / 2) - (popoverWidth / 2);

      if (rect.top - popoverHeight < 10) {
        top = rect.bottom + scrollY + 8;
      }
      if (left < 10) left = 10;
      if (left + popoverWidth > window.innerWidth - 10) {
        left = window.innerWidth - popoverWidth - 10;
      }

      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
      popover.classList.add('active');
      popover.setAttribute('aria-hidden', 'false');
      activeBtn = btn;
    }

    function hidePopover() {
      popover.classList.remove('active');
      popover.setAttribute('aria-hidden', 'true');
      activeBtn = null;
    }

    document.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('.kpi-info-btn');
      if (btn && activeBtn !== btn) {
        showPopover(btn);
      }
    });

    document.addEventListener('mouseout', (e) => {
      const btn = e.target.closest('.kpi-info-btn');
      if (btn && activeBtn === btn) {
        const related = e.relatedTarget;
        if (!popover.contains(related) && (!related || !related.closest('.kpi-info-btn'))) {
          hidePopover();
        }
      }
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.kpi-info-btn');
      if (btn) {
        e.stopPropagation();
        if (activeBtn === btn) {
          hidePopover();
        } else {
          showPopover(btn);
        }
        return;
      }
      if (activeBtn && !popover.contains(e.target)) {
        hidePopover();
      }
    });

    window.addEventListener('scroll', hidePopover, { passive: true });
  }

  function setupProvenanceModal() {
    const modalOverlay = el('modalProvenanceOverlay');
    const btnProvenance = el('btnProvenance');
    const closeBtn = el('provCloseBtn');
    const okBtn = el('provOkBtn');
    const groupsContainer = el('provGroupsContainer');
    const totalBadge = el('provTotalFilesBadge');
    const summaryDir = el('provSummaryDir');
    const summaryInspection = el('provSummaryInspection');

    function openModal() {
      modalOverlay.classList.add('active');
      modalOverlay.setAttribute('aria-hidden', 'false');
      renderProvenanceData();
    }

    function closeModal() {
      modalOverlay.classList.remove('active');
      modalOverlay.setAttribute('aria-hidden', 'true');
    }

    btnProvenance?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    okBtn?.addEventListener('click', closeModal);
    modalOverlay?.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalOverlay?.classList.contains('active')) {
        closeModal();
      }
    });

    async function renderProvenanceData() {
      let data = state.overview?.dataProvenance;
      if (!data) {
        data = await getJson('/data/fontes_metadados.json');
      }
      if (!data || !data.arquivos || data.arquivos.length === 0) {
        if (groupsContainer) {
          groupsContainer.innerHTML = '<div class="provenance-loading-state">Nenhum metadado de planilha disponível no momento.</div>';
        }
        return;
      }

      if (totalBadge) totalBadge.textContent = String(data.total_arquivos || data.arquivos.length);
      if (summaryDir) summaryDir.textContent = data.diretorio_origem ? '.../' + data.diretorio_origem.split(/[\\/]/).pop() : 'BD_SMARTQUESTION';
      
      const summaryEtl = el('provSummaryEtl');
      if (summaryEtl) {
        if (data.ultima_execucao_etl_formatada) {
          summaryEtl.textContent = data.ultima_execucao_etl_formatada;
        } else {
          const etlTime = data.timestamp_etl || data.timestamp_inspecao;
          if (etlTime) {
            const d = new Date(etlTime);
            summaryEtl.textContent = `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
          }
        }
      }

      if (summaryInspection) {
        if (data.ultima_leitura_planilhas_formatada) {
          summaryInspection.textContent = data.ultima_leitura_planilhas_formatada;
        } else if (data.timestamp_inspecao) {
          const d = new Date(data.timestamp_inspecao);
          summaryInspection.textContent = `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        }
      }

      const summaryRecentFile = el('provSummaryRecentFile');
      if (summaryRecentFile) {
        if (data.arquivo_mais_recente_nome) {
          const dataFmt = data.arquivo_mais_recente_data ? ` (${data.arquivo_mais_recente_data})` : '';
          summaryRecentFile.textContent = `${data.arquivo_mais_recente_nome}${dataFmt}`;
          summaryRecentFile.setAttribute('title', `Última modificação detectada: ${data.arquivo_mais_recente_nome}`);
        } else {
          summaryRecentFile.textContent = '--';
        }
      }

      // Preencher dados de Consistência Mensal
      const mensalUpdate = el('provMensalUpdate');
      const mensalRecords = el('provMensalRecords');
      const mensalStatus = el('provMensalStatus');
      if (data.consistencia_mensal) {
        if (mensalUpdate) mensalUpdate.textContent = data.consistencia_mensal.ultima_atualizacao_formatada || '--';
        if (mensalRecords) {
          const count = data.consistencia_mensal.total_registros;
          mensalRecords.textContent = count !== null && count !== undefined ? `${Number(count).toLocaleString('pt-BR')} registros` : '--';
        }
        if (mensalStatus && data.consistencia_mensal.status) mensalStatus.textContent = data.consistencia_mensal.status;
      }

      // Preencher dados de Consistência Anual
      const anualUpdate = el('provAnualUpdate');
      const anualRecords = el('provAnualRecords');
      const anualStatus = el('provAnualStatus');
      if (data.consistencia_anual) {
        if (anualUpdate) anualUpdate.textContent = data.consistencia_anual.ultima_atualizacao_formatada || '--';
        if (anualRecords) {
          const count = data.consistencia_anual.total_registros;
          anualRecords.textContent = count !== null && count !== undefined ? `${Number(count).toLocaleString('pt-BR')} registros` : '--';
        }
        if (anualStatus && data.consistencia_anual.status) anualStatus.textContent = data.consistencia_anual.status;
      }

      // Agrupar arquivos por categoria
      const groups = {};
      data.arquivos.forEach(file => {
        const cat = file.categoria || 'Outros Relatórios';
        if (!groups[cat]) {
          groups[cat] = {
            categoria: cat,
            icone: file.icone || 'description',
            descricao: file.descricao || '',
            files: []
          };
        }
        groups[cat].files.push(file);
      });

      let html = '';
      Object.values(groups).forEach(grp => {
        html += `
          <div class="prov-category-card">
            <div class="prov-category-header">
              <div class="prov-category-title-box">
                <span class="material-symbols-rounded prov-cat-icon" aria-hidden="true">${escapeHtml(grp.icone)}</span>
                <span class="prov-category-title">${escapeHtml(grp.categoria)}</span>
              </div>
              <span class="prov-category-count">${grp.files.length} ${grp.files.length === 1 ? 'arquivo' : 'arquivos'}</span>
            </div>
            <div class="prov-file-list">
        `;

        grp.files.forEach(f => {
          const recText = f.total_registros !== null && f.total_registros !== undefined
            ? `${Number(f.total_registros).toLocaleString('pt-BR')} registros`
            : 'Planilha bruta';
          html += `
            <div class="prov-file-item">
              <div class="prov-file-name-col">
                <span class="prov-file-name">${escapeHtml(f.nome)}</span>
                <span class="prov-file-desc">${escapeHtml(f.descricao)}</span>
              </div>
              <div class="prov-file-date">
                <span class="prov-date-label">Exportação SmartQuestion</span>
                <span class="prov-date-val">${escapeHtml(f.data_modificacao_formatada || f.data_modificacao)}</span>
              </div>
              <div>
                <span class="prov-badge-size">${escapeHtml(f.tamanho_formatado)}</span>
              </div>
              <div>
                <span class="prov-badge-records">${escapeHtml(recText)}</span>
              </div>
            </div>
          `;
        });

        html += `
            </div>
          </div>
        `;
      });

      if (groupsContainer) groupsContainer.innerHTML = html;
    }
  }

  function setupChartHorizonControls() {
    document.querySelectorAll('.chart-horizon-control button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const container = btn.closest('.chart-horizon-control');
        if (!container) return;
        const horizonKey = container.dataset.chartHorizon;
        const months = Number(btn.dataset.months) || 0;

        container.querySelectorAll('button').forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');

        if (horizonKey && state.chartHorizons) {
          state.chartHorizons[horizonKey] = months;
        }

        if (horizonKey === 'coverage' && state.overview) {
          const coverageData = sliceTimeSeries(state.overview.evolucaoMensal || emptyState.overview.evolucaoMensal, months);
          charts.renderCoverage('chartVisitsCoverage', coverageData);
        } else if (horizonKey === 'turnover' && state.turnover) {
          const turnoverData = sliceTimeSeries(state.turnover.historicoMovimentacao || emptyState.turnover.historicoMovimentacao, months);
          charts.renderTurnover('chartTurnoverHistory', turnoverData);
        } else if (horizonKey === 'portfolio' && state.turnover) {
          const portfolioData = sliceTimeSeries(state.turnover.historicoCarteira || emptyState.turnover.historicoCarteira, months);
          charts.renderPortfolio('chartPortfolioHistory', portfolioData);
        } else if (horizonKey === 'consistency' && state.consistency) {
          const consistencyData = sliceTimeSeries(state.consistency.evolucaoConsistencia || emptyState.consistency.evolucaoConsistencia, months);
          charts.renderConsistencyHistory('chartConsistencyHistory', consistencyData);
        }
      });
    });
  }

  function setupPanelFullscreen() {
    let activeFullscreenPanel = null;
    const fsBackdrop = el('panelFsBackdrop');

    function openPanelFullscreen(panel) {
      if (!panel) return;
      if (activeFullscreenPanel && activeFullscreenPanel !== panel) {
        closePanelFullscreen();
      }

      // 1. Criar marcador de posição no local original do DOM
      const placeholder = document.createElement('div');
      placeholder.className = 'panel-fs-placeholder';
      placeholder.style.display = 'none';
      panel.parentNode.insertBefore(placeholder, panel);
      panel._fsPlaceholder = placeholder;

      // 2. Mover o painel diretamente para document.body (escapa do transform do carrossel)
      document.body.appendChild(panel);

      panel.classList.add('is-fullscreen');
      if (fsBackdrop) {
        fsBackdrop.removeAttribute('hidden');
      }

      // 3. Adicionar botão explícito de fechar na parte superior
      let closeBtn = panel.querySelector('.panel-fullscreen-close-btn');
      if (!closeBtn) {
        closeBtn = document.createElement('button');
        closeBtn.className = 'panel-fullscreen-close-btn';
        closeBtn.type = 'button';
        closeBtn.title = 'Fechar tela cheia (Esc)';
        closeBtn.setAttribute('aria-label', 'Fechar tela cheia');
        closeBtn.innerHTML = '<span class="material-symbols-rounded">close</span><span>Fechar</span>';
        closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          closePanelFullscreen();
        });
        panel.appendChild(closeBtn);
      }

      const fsBtn = panel.querySelector('.btn-panel-fs');
      if (fsBtn) {
        fsBtn.setAttribute('title', 'Sair da tela cheia (Esc)');
        fsBtn.setAttribute('aria-label', 'Sair do modo tela cheia');
        const icon = fsBtn.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = 'fullscreen_exit';
      }

      // Pausa carrossel durante a inspeção em tela cheia (S-01)
      carousel?.pauseForModal?.(true);

      activeFullscreenPanel = panel;

      // Redimensionar gráficos instantaneamente
      setTimeout(() => {
        panel.querySelectorAll('canvas').forEach((canvas) => {
          const chartInstance = charts.instances[canvas.id];
          if (chartInstance && typeof chartInstance.resize === 'function') {
            chartInstance.resize();
            if (typeof chartInstance.update === 'function') {
              chartInstance.update('none');
            }
          }
        });
      }, 60);
    }

    function closePanelFullscreen() {
      if (!activeFullscreenPanel) return;
      const panel = activeFullscreenPanel;

      // Remover botão de fechar criado dinamicamente
      const closeBtn = panel.querySelector('.panel-fullscreen-close-btn');
      if (closeBtn) {
        closeBtn.remove();
      }

      panel.classList.remove('is-fullscreen');

      if (fsBackdrop) {
        fsBackdrop.setAttribute('hidden', '');
      }

      const fsBtn = panel.querySelector('.btn-panel-fs');
      if (fsBtn) {
        fsBtn.setAttribute('title', 'Tela cheia');
        fsBtn.setAttribute('aria-label', 'Expandir painel para tela cheia');
        const icon = fsBtn.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = 'fullscreen';
      }

      // Devolver o painel para a sua posição original no slide
      if (panel._fsPlaceholder && panel._fsPlaceholder.parentNode) {
        panel._fsPlaceholder.parentNode.insertBefore(panel, panel._fsPlaceholder);
        panel._fsPlaceholder.remove();
        delete panel._fsPlaceholder;
      }

      // Retoma o carrossel se não estiver pausado pelo usuário
      carousel?.pauseForModal?.(false);

      activeFullscreenPanel = null;

      // Restaurar dimensões dos gráficos
      setTimeout(() => {
        panel.querySelectorAll('canvas').forEach((canvas) => {
          const chartInstance = charts.instances[canvas.id];
          if (chartInstance && typeof chartInstance.resize === 'function') {
            chartInstance.resize();
            if (typeof chartInstance.update === 'function') {
              chartInstance.update('none');
            }
          }
        });
      }, 60);
    }

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-panel-fs');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const panel = btn.closest('.panel-card');
        if (!panel) return;
        if (panel.classList.contains('is-fullscreen')) {
          closePanelFullscreen();
        } else {
          openPanelFullscreen(panel);
        }
        return;
      }

      if (e.target === fsBackdrop) {
        closePanelFullscreen();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && activeFullscreenPanel) {
        const detailsModal = el('detailsModal');
        const provModal = el('provenanceModal');
        if (detailsModal?.classList.contains('active') || provModal?.classList.contains('active')) {
          return;
        }
        e.preventDefault();
        closePanelFullscreen();
      }
    });

    window.openPanelFullscreen = openPanelFullscreen;
    window.closePanelFullscreen = closePanelFullscreen;
  }

  setupTableSorting();
  setupTablePagination();
  setupColumnResizers();
  setupColumnFilters();
  setupCustomSelectDropdowns();
  setupDetailsModal();
  setupKpiInfoPopovers();
  setupProvenanceModal();

  function abrirModalDetalhesElabore(codigoLr) {
    if (!state.overview || !state.overview.tabelas || !state.overview.tabelas.visitados) return;
    const row = state.overview.tabelas.visitados.find(v => String(v.codigo_lr).trim().toUpperCase() === String(codigoLr).trim().toUpperCase());
    if (!row) return;

    const overlay = el('modalElaboreOverlay');
    const modalBody = el('modalElaboreBody');
    const refMonthEl = el('modalElaboreRefMonthText');
    if (!overlay || !modalBody) return;

    const anoMes = row.mes_referencia ? String(row.mes_referencia).slice(0, 7) : '—';
    const refMonthText = row.mes_referencia ? String(row.mes_referencia).slice(0, 7).split('-').reverse().join('/') : '--/----';
    if (refMonthEl) refMonthEl.textContent = refMonthText;

    const b = row.detalhes_blocos || {
      receita: row.elabore_ok,
      qualidade: row.elabore_ok,
      alimentacao: row.elabore_ok,
      area: row.elabore_ok,
      rebanho: row.elabore_ok,
      mdo: row.elabore_ok,
      energia: row.elabore_ok,
      despesas: row.elabore_ok
    };

    const temDado = row.dados_elabore_tem_dado || row.elabore_ok;
    const statusBadge = String(row.status || 'ATIVO').toUpperCase() === 'INATIVO' ? 'badge-danger' : 'badge-positive';

    const blocosConfig = [
      { nome: 'Disponibilidade de Dados (Geral)', ok: temDado, desc: 'Relatório e lançamentos analíticos disponíveis no Elabore' },
      { nome: 'Possui Receita', ok: b.receita, desc: 'Presença de lançamentos de faturamento bruto e produção de leite' },
      { nome: 'Possui Qualidade', ok: b.qualidade, desc: 'Parâmetros físico-químicos e microbiológicos (CCS, CBT, Gordura, Proteína)' },
      { nome: 'Possui Alimentação', ok: b.alimentacao, desc: 'Lançamentos de despesas com volumoso, ração e concentrados' },
      { nome: 'Possui Área', ok: b.area, desc: 'Informações de hectares e área destinada à atividade leiteira' },
      { nome: 'Possui Rebanho', ok: b.rebanho, desc: 'Inventário de vacas em lactação, vacas secas e novilhas' },
      { nome: 'Possui Mão de Obra (MDO)', ok: b.mdo, desc: 'Despesas e contingente de trabalhadores familiares e contratados' },
      { nome: 'Possui Energia e Combustível', ok: b.energia, desc: 'Lançamentos de energia elétrica, diesel e combustíveis operacionais' },
      { nome: 'Possui Outras Despesas', ok: b.despesas, desc: 'Despesas operacionais diversas, medicamentos, fretes e manutenção' }
    ];

    const blocosRowsHtml = blocosConfig.map(c => `
      <tr>
        <td class="col-left"><strong>${escapeHtml(c.nome)}</strong></td>
        <td class="col-center">
          <span class="badge ${c.ok ? 'badge-positive' : 'badge-danger'}">
            ${c.ok ? 'SIM' : 'NÃO'}
          </span>
        </td>
        <td class="col-left" style="color:var(--muted); font-size:11px;">${escapeHtml(c.desc)}</td>
      </tr>
    `).join('');

    modalBody.innerHTML = `
      <fieldset class="modal-fieldset">
        <legend class="modal-legend">Informações do Produtor e Vínculo</legend>
        <div class="detail-grid">
          <div class="detail-field">
            <label class="field-label">Código LR</label>
            <div class="field-box">${escapeHtml(row.codigo_lr || '—')}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Produtor(a)</label>
            <div class="field-box field-box--bold">${escapeHtml(row.produtor || '—')}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Consultor(a) Técnico(a)</label>
            <div class="field-box">${escapeHtml(row.consultor || '—')}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Agroindústria</label>
            <div class="field-box">${escapeHtml(row.agroindustria || row.projeto || '—')}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Propriedade / Região</label>
            <div class="field-box">${escapeHtml(row.propriedade || row.regiao || 'FAZENDA')}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Projeto / Programa</label>
            <div class="field-box">${escapeHtml(row.projeto || '—')}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Ano-Mês Referência</label>
            <div class="field-box">${escapeHtml(anoMes)}</div>
          </div>
          <div class="detail-field">
            <label class="field-label">Status Cadastral</label>
            <div class="field-box"><span class="badge ${statusBadge}">${escapeHtml(row.status || 'ATIVO')}</span></div>
          </div>
        </div>
      </fieldset>

      <fieldset class="modal-fieldset">
        <legend class="modal-legend">Detalhamento dos Lançamentos por Bloco (Elabore)</legend>
        <div class="table-scroll" style="max-height: 280px;">
          <table class="data-table data-table--modal">
            <thead>
              <tr>
                <th class="col-left" style="width: 35%;">Bloco / Módulo Analítico</th>
                <th class="col-center" style="width: 15%;">Status</th>
                <th class="col-left" style="width: 50%;">Descrição do Lançamento</th>
              </tr>
            </thead>
            <tbody>
              ${blocosRowsHtml}
            </tbody>
          </table>
        </div>
      </fieldset>
    `;

    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-elabore-detail');
    if (btn) {
      e.preventDefault();
      const lr = btn.dataset.lr;
      if (lr) abrirModalDetalhesElabore(lr);
    }
  });

  function fecharModalElabore() {
    const overlay = el('modalElaboreOverlay');
    if (overlay) {
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  el('btnCloseElaboreModal')?.addEventListener('click', fecharModalElabore);
  el('btnOkElaboreModal')?.addEventListener('click', fecharModalElabore);
  el('modalElaboreOverlay')?.addEventListener('click', (e) => {
    if (e.target === el('modalElaboreOverlay')) {
      fecharModalElabore();
    }
  });
  setupExportButtons();
  setupChartHorizonControls();
  setupPanelFullscreen();

  let chartResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(() => {
      if (charts && charts.instances) {
        Object.values(charts.instances).forEach((instance) => {
          if (instance && typeof instance.resize === 'function') {
            instance.resize();
          }
        });
      }
    }, 100);
  });

  loadAllData();
  setInterval(loadAllData, 300000);

  window.dashboard = { carousel, charts, state, reload: loadAllData };
});
