/**
 * Módulo compartilhado para o backend do Dashboard:
 * - Cache em memória com TTL de 5 minutos para alta performance
 * - Sanitização de consultores, exclusão de supervisores/coordenadores não operacionais
 * - Mapeamento e validação de cadeias de leite e agroindústrias
 */

// Cache em memória no processo Node.js
const memoryCache = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutos

function getCached(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, ttlMs = DEFAULT_TTL_MS) {
  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs
  });
  if (memoryCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of memoryCache.entries()) {
      if (now > v.expiresAt) memoryCache.delete(k);
    }
  }
}

async function fetchWithCache(cacheKey, fetcherFn, ttlMs = DEFAULT_TTL_MS) {
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;
  const result = await fetcherFn();
  setCached(cacheKey, result, ttlMs);
  return result;
}

/** Nomes que devem ser substituídos por "LAC CONSULTORIA" */
const LAC_CONSULTORIA_RAW = new Set([
  'CELIO ROBERTO OLIVEIRA (REGENERA)',
  'SUELY DE JESUS OLIVEIRA (REGENERA)',
  'CELIO ROBERTO OLIVEIRA',
  'SUELY DE JESUS OLIVEIRA'
]);

/** Grupos exclusivos de CFT */
const GRUPOS_CFT_EXCLUSIVOS = new Set([
  'DAYANNE UCHOA VEIGA / DEBORA LIMA DE OLIVEIRA / MARIO BARBOSA ROSA FILHO / MATEUS CARNIELLI / TALITA FONTES / THAYNAN FERREIRA DE ARAUJO',
  'HUGO LOPES / MATEUS CARNIELLI / ROMARCIO PAULO DE OLIVEIRA / THAYNAN FERREIRA DE ARAUJO',
  'BRUNO ANTONIO FERRONI RODRIGUES / HUGO LOPES / MATEUS CARNIELLI / THAYNAN FERREIRA DE ARAUJO',
  'MATHEUS GOMIDES GONCALVES'
]);

/** Perfis de coordenação, supervisão ou contas genéricas que NÃO realizam visitas de campo */
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
  if (!name) return false;
  const upper = String(name).trim().toUpperCase();
  if (NON_FIELD_CONSULTANTS.has(upper)) return true;
  if (upper.startsWith('TALITA FONTES')) return true;
  if (upper.includes('_CONSULTOR') || upper.includes('CONSULTOR_') || upper === 'CONTA DE SUPERVISÃO') return true;
  if (upper.includes('SUPERVISAO') || upper.includes('SUPERVISÃO')) return true;
  if (upper.includes('COORDENACAO') || upper.includes('COORDENAÇÃO')) return true;
  return false;
}

/** Recebe o conteúdo bruto de grupo/consultor e retorna array de consultores saneados. */
function sanitizeConsultorList(rawName) {
  if (!rawName) return [];
  return String(rawName)
    .split('/')
    .map(p => p.trim())
    .filter(Boolean)
    .map(part => {
      const upper = part.toUpperCase();
      if (LAC_CONSULTORIA_RAW.has(upper)) return 'LAC CONSULTORIA';
      return part.replace(/\s*\([^)]+\)\s*$/, '').trim() || part;
    })
    .filter(name => !isNonFieldConsultant(name));
}

/** Retorna true para registros de teste (MATEUS CARNIELLI / ALVOAR ECO de teste). */
function isTestData(nome_consultor, projeto) {
  return String(nome_consultor || '').toUpperCase().includes('MATEUS CARNIELLI') &&
         String(projeto || '').toUpperCase().includes('ALVOAR ECO');
}

/** Verifica se um projeto pertence à cadeia de Leite */
function ehCadeiaLeite(projeto) {
  if (!projeto) return true;
  const p = String(projeto).trim().toUpperCase();
  // Se for projeto puramente CFT (ex: CFT DANONE 2026, CFT LPA 2026, QUILLAYES - CFT) sem projeto oficial de leite
  if (p.includes('CFT')) {
    const PROJETOS_OFICIAIS_LEITE = ['ALVOAR', 'CCPR', 'LPA', 'REGENERA', 'SEMEAR', 'COPRIL', 'CAMPILEITE', 'NESTLE', 'EDUCAMPO'];
    if (!PROJETOS_OFICIAIS_LEITE.some(proj => p.includes(proj))) {
      return false;
    }
  }
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

function isValidoLeite(nome_consultor, projeto, codigo_lr = null, tipo_ponto_atendimento = null, tipo_visita = null) {
  if (isTestData(nome_consultor, projeto)) return false;
  if (codigo_lr) {
    const codUpper = String(codigo_lr).toUpperCase();
    if (codUpper.includes('_CONSULTOR') || codUpper.includes('CONSULTOR_')) return false;
  }
  if (tipo_ponto_atendimento) {
    const tipoUpper = String(tipo_ponto_atendimento).toUpperCase();
    if (tipoUpper.includes('SUPERVISAO') || tipoUpper.includes('SUPERVISÃO')) return false;
  }
  if (tipo_visita && isTipoVisitaDescartado(tipo_visita)) return false;
  if (nome_consultor && isNonFieldConsultant(nome_consultor)) return false;
  if (!ehCadeiaLeite(projeto)) return false;
  return true;
}

const PROJETOS_OFICIAIS = [
  'ALVOAR ASSIST',
  'ALVOAR ECO',
  'ATEG_CCPR',
  'LPA',
  'REGENERA',
  'SEMEAR'
];

function extractCleanProject(str, fallback = '') {
  if (!str) return fallback || '';
  const upper = String(str).toUpperCase();
  for (const proj of PROJETOS_OFICIAIS) {
    if (upper.includes(proj)) return proj;
  }
  if (upper.includes('ALVOAR')) return 'ALVOAR ECO';
  if (upper.includes('NESTLE') || upper.includes('NESTLÉ')) return 'REGENERA';
  if (upper.includes('DANONE')) return 'SEMEAR';
  if (upper.includes('CCPR')) return 'ATEG_CCPR';
  if (upper.includes('PORTO ALEGRE')) return 'LPA';
  return fallback || String(str).replace(/\s*\([^)]+\)\s*$/, '').trim();
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
  return projeto;
}

function getSupabaseClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials missing in environment variables');
  }
  return createClient(url, key);
}

async function fetchAll(createQuery, pageSize = 1000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await createQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (data && data.length > 0) {
      rows.push(...data);
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function monthLabel(value) {
  if (!value) return '-';
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const month = parsed.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return `${month.charAt(0).toUpperCase()}${month.slice(1)}/${String(parsed.getFullYear()).slice(-2)}`;
}

function formatDate(value) {
  if (!value) return '-';
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('pt-BR');
}

function normalizeName(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function shiftMonthMinus1(monthStr) {
  if (!monthStr) return null;
  const d = new Date(`${String(monthStr).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function expandRows(rows) {
  const result = [];
  for (const row of (rows || [])) {
    const rawName = row.nome_consultor || row.consultor || row.grupo_ponto_atendimento;
    const codUpper = String(row.codigo_lr || row.codigo_produtor || '').toUpperCase();
    if (codUpper.includes('_CONSULTOR') || codUpper.includes('CONSULTOR_')) continue;
    if (rawName && isNonFieldConsultant(rawName)) continue;

    const consultores = sanitizeConsultorList(rawName);
    if (consultores.length === 0) {
      if (!isTestData(row.nome_consultor, row.projeto)) {
        result.push(row);
      }
    } else {
      for (const c of consultores) {
        if (!isTestData(c, row.projeto)) {
          result.push({ ...row, nome_consultor: c, consultor: c });
        }
      }
    }
  }
  return result;
}

function isTipoVisitaDescartado(tipo) {
  if (!tipo) return false;
  const s = String(tipo).toUpperCase();
  return s.includes('TERMO DE ADESAO') || 
         s.includes('TERMO DE ADESÃO') || 
         s.includes('INATIVAÇÃO') || 
         s.includes('INATIVACAO') || 
         s.includes('CADASTRO') || 
         s.includes('EXCLUSÃO') || 
         s.includes('EXCLUSAO') ||
         s.includes('EFICIENCIA ALIMENTAR') ||
         s.includes('EFICIÊNCIA ALIMENTAR');
}

const isTermoAdesao = isTipoVisitaDescartado;

function deduplicateAndFilterVisits(visitas) {
  if (!visitas || !Array.isArray(visitas)) return [];

  const semTermo = visitas.filter(v => !isTipoVisitaDescartado(v.tipo_visita));
  const mapAtendimento = new Map();
  const semIdAtendimento = [];

  semTermo.forEach(v => {
    const idAtend = (v.id_atendimento !== null && v.id_atendimento !== undefined && String(v.id_atendimento).trim() !== '')
      ? String(Math.floor(Number(v.id_atendimento)))
      : null;

    if (!idAtend || idAtend === '0' || idAtend === 'NaN') {
      semIdAtendimento.push(v);
    } else {
      if (!mapAtendimento.has(idAtend)) {
        mapAtendimento.set(idAtend, { ...v });
      } else {
        const exist = mapAtendimento.get(idAtend);
        const c1 = sanitizeConsultorList(exist.nome_consultor);
        const c2 = sanitizeConsultorList(v.nome_consultor);
        const mergedConsultants = [...new Set([...c1, ...c2])].join(' / ');
        if (mergedConsultants) {
          exist.nome_consultor = mergedConsultants;
        }
      }
    }
  });

  return [...mapAtendimento.values(), ...semIdAtendimento];
}

module.exports = {
  fetchWithCache,
  getCached,
  setCached,
  getSupabaseClient,
  fetchAll,
  monthLabel,
  formatDate,
  normalizeName,
  sanitizeConsultorList,
  isNonFieldConsultant,
  isTestData,
  ehCadeiaLeite,
  isValidoLeite,
  mapAgroindustria,
  extractCleanProject,
  shiftMonthMinus1,
  expandRows,
  isTermoAdesao,
  isTipoVisitaDescartado,
  deduplicateAndFilterVisits
};

