const { Client } = require('pg');

// ─── Utilitários de Tratamento e Sanitização de Regiões ─────────────────────

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

  // Tratar sufixos como " - 0460", " - 1217", " - 2155", " - 9655", " - 1215", " - 9264", " - 9188"
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

  // Fallback: Title Case com preservação de siglas
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

  // 1. Excluir valores de teste ou genéricos
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

  // 2. Se for contexto Nestlé ou se contiver códigos da Nestlé, padronizar nas 4 regiões
  if (isNestleContext(context) || /\b(1215|9188|1217|9655|9264)\b/.test(upper)) {
    const nestleReg = mapRegiaoNestle(str);
    if (nestleReg) return nestleReg;
  }

  if (upper === 'BATALHA/AL' || upper.startsWith('BATALHA/')) {
    return 'Alagoas';
  }

  // 3. Se for composto por '/', tratar cada parte
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

// ─── Consulta ao Banco de Dados ─────────────────────────────────────────────

const { fetchWithCache, sanitizeConsultorList, isNonFieldConsultant, extractCleanProject, mapAgroindustria } = require('./shared');

/**
 * Consulta a tabela canônica sq_dim_regiao do Supabase.
 * Fornece o catálogo oficial e de-para de regiões por agroindústria.
 */
async function getDimRegioesMap(supabase) {
  return fetchWithCache('SUPABASE_DIM_REGIAO_CANONICAL', async () => {
    const deParaMap = new Map();
    const regioesPorAgro = new Map();
    const todasSet = new Set();

    try {
      const { data, error } = await supabase
        .from('sq_dim_regiao')
        .select('nome_regiao, nome_regiao_formatada, agroindustria, uf, status')
        .eq('status', 'Ativo');

      if (!error && data) {
        data.forEach(r => {
          const raw = String(r.nome_regiao || '').trim();
          const formatada = String(r.nome_regiao_formatada || raw).trim();
          const agro = String(r.agroindustria || '').trim();

          if (formatada) {
            todasSet.add(formatada);
            if (agro) {
              if (!regioesPorAgro.has(agro)) regioesPorAgro.set(agro, new Set());
              regioesPorAgro.get(agro).add(formatada);

              // Chave composta com maior prioridade: agro|regiao
              deParaMap.set(`${agro.toUpperCase()}|${raw.toUpperCase()}`, formatada);
            }
            // Chave simples para fallback se agroindústria não bater
            if (!deParaMap.has(raw.toUpperCase())) {
              deParaMap.set(raw.toUpperCase(), formatada);
            }
          }
        });
      }
    } catch (e) {
      console.warn('⚠️ Erro ao consultar sq_dim_regiao no Supabase:', e.message);
    }

    return {
      deParaMap,
      regioesPorAgro,
      todasRegioesFormatadas: Array.from(todasSet).sort((a, b) => a.localeCompare(b, 'pt-BR'))
    };
  }, 10 * 60 * 1000);
}

async function getRegiaoMap(supabase, fetchAll) {
  return fetchWithCache('GLOBAL_REGIAO_MAP', async () => {
    const regiaoMap = new Map();
    const dimRegioes = await getDimRegioesMap(supabase).catch(() => ({ deParaMap: new Map() }));

    function resolveCanonical(raw, agro) {
      if (!raw) return null;
      const rawTrim = String(raw).trim();
      if (agro) {
        const agroKey = `${String(agro).trim().toUpperCase()}|${rawTrim.toUpperCase()}`;
        if (dimRegioes.deParaMap && dimRegioes.deParaMap.has(agroKey)) {
          return dimRegioes.deParaMap.get(agroKey);
        }
      }
      if (dimRegioes.deParaMap && dimRegioes.deParaMap.has(rawTrim.toUpperCase())) {
        return dimRegioes.deParaMap.get(rawTrim.toUpperCase());
      }
      return sanitizeRegiao(raw, agro);
    }

    if (process.env.PG_HOST && process.env.PG_USER && process.env.PG_PASSWORD) {
      try {
        const client = new Client({
          host: process.env.PG_HOST,
          port: Number(process.env.PG_PORT || 5432),
          database: process.env.PG_DATABASE || 'postgres',
          user: process.env.PG_USER,
          password: process.env.PG_PASSWORD,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 3000
        });
        await client.connect();
        const schema = process.env.PG_SCHEMA || 'analytics_mart';
        const res = await client.query(`SELECT labor_rural_code, dairy_region, agroindustry_name FROM ${schema}.vw_dim_property WHERE dairy_region IS NOT NULL AND labor_rural_code IS NOT NULL AND property_status = 'active_approved';`);
        (res.rows || []).forEach(r => {
          if (r.labor_rural_code && r.dairy_region) {
            const cleanRegiao = resolveCanonical(r.dairy_region, r.agroindustry_name);
            if (cleanRegiao) {
              regiaoMap.set(String(r.labor_rural_code).trim(), cleanRegiao);
            }
          }
        });
        await client.end();
        if (regiaoMap.size > 0) return regiaoMap;
      } catch (err) {
        console.warn('⚠️ Erro ao consultar Azure PostgreSQL (vw_dim_property), recorrendo ao Supabase:', err.message);
      }
    }

    // Fallback no Supabase se o Postgres não estiver disponível:
    // Consulta a dimensão canônica sq_dim_fazendas_ativas (que contém codigo_produtor e regiao)
    try {
      const fazendasDB = await fetchAll(() =>
        supabase
          .from('sq_dim_fazendas_ativas')
          .select('codigo_produtor, regiao, agroindustria')
          .not('regiao', 'is', null)
      );
      (fazendasDB || []).forEach(f => {
        const cod = f.codigo_produtor;
        const reg = f.regiao;
        if (cod && reg) {
          const cleanRegiao = resolveCanonical(reg, f.agroindustria);
          if (cleanRegiao) {
            regiaoMap.set(String(cod).trim(), cleanRegiao);
            regiaoMap.set(String(cod).trim().toUpperCase(), cleanRegiao);
          }
        }
      });
    } catch (errSupabase) {
      console.warn('⚠️ Erro no fallback Supabase sq_dim_fazendas_ativas:', errSupabase.message);
    }

    return regiaoMap;
  }, 10 * 60 * 1000);
}

// ─── Consulta Unificada e Resiliente de Produtores Ativos ───────────────────

async function getProdutoresAtivos(supabase, fetchAll, refMonth = null, maxAllowedMonth = null) {
  const cacheKey = `PRODUTORES_ATIVOS_${refMonth || 'ALL'}_${maxAllowedMonth || 'ALL'}`;
  return fetchWithCache(cacheKey, async () => {
    // 1. Tenta sq_dim_fazendas_ativas ou sq_fato_fazendas_ativas
    for (const tbl of ['sq_dim_fazendas_ativas', 'sq_fato_fazendas_ativas']) {
      try {
        const rows = await fetchAll(() => {
          let q = supabase
            .from(tbl)
            .select('codigo_produtor, nome_produtor, nome_propriedade, grupo_ponto_atendimento, nome_grupo_ponto_atendimento, projeto, agroindustria, regiao, unidade_atendimento, mes_referencia, tipo_ponto_atendimento, status')
            .eq('tipo_ponto_atendimento', 'LEITE');
          if (refMonth) q = q.eq('mes_referencia', refMonth);
          else if (maxAllowedMonth) q = q.lte('mes_referencia', maxAllowedMonth);
          return q.order('mes_referencia', { ascending: false }).order('codigo_produtor', { ascending: true });
        });
        if (rows && rows.length > 0) {
          // Enriquecer com mapa de grupos completos da LISTA_GERAL (sq_raw_fazendas_grupo ou sq_raw_fazendas)
          const gruposMap = new Map();
          try {
            for (const rawTbl of ['sq_raw_fazendas_grupo', 'sq_raw_fazendas']) {
              const rawRows = await fetchAll(() => supabase
                .from(rawTbl)
                .select('codigo_produtor, grupo_ponto_atendimento, nome_grupo_ponto_atendimento')
                .not('grupo_ponto_atendimento', 'is', null)
              ).catch(() => []);
              if (rawRows && rawRows.length > 0) {
                rawRows.forEach(rg => {
                  const c = String(rg.codigo_produtor || '').trim().toUpperCase();
                  const grp = rg.nome_grupo_ponto_atendimento || rg.grupo_ponto_atendimento || '';
                  if (c && grp) {
                    const existing = gruposMap.get(c);
                    if (!existing || (grp.includes('/') && !existing.includes('/')) || grp.length > existing.length) {
                      gruposMap.set(c, grp);
                    }
                  }
                });
                break;
              }
            }
          } catch (eGrupos) {
            // fallback gracioso se raw não estiver disponível
          }

          return rows
            .filter(r => {
              const cod = String(r.codigo_produtor || '').toUpperCase();
              if (cod.includes('_CONSULTOR') || cod.includes('CONSULTOR_')) return false;
              const rawGrupo = (r.nome_grupo_ponto_atendimento || r.grupo_ponto_atendimento || '').toUpperCase();
              if (rawGrupo.includes('SUPERVISAO') || rawGrupo.includes('SUPERVISÃO') || rawGrupo.includes('AGRICULTURA')) {
                // se o grupo é supervisão/agricultura e o produtor é conta de consultor, descarta
                if (!cod.startsWith('LR')) return false;
              }
              return true;
            })
            .map(r => {
              const codUpper = String(r.codigo_produtor || '').trim().toUpperCase();
              const grupoRawOriginal = r.nome_grupo_ponto_atendimento || r.grupo_ponto_atendimento || '';
              const grupoCompleto = gruposMap.get(codUpper);
              // Priorizar grupo com múltiplos consultores ('/') ou mais completo
              const rawGrupo = (grupoCompleto && (grupoCompleto.includes('/') || grupoCompleto.length > grupoRawOriginal.length))
                ? grupoCompleto
                : grupoRawOriginal;
              const cleanProj = r.projeto || extractCleanProject(rawGrupo, r.tipo_ponto_atendimento);
              const consultores = sanitizeConsultorList(rawGrupo);
              const consultor = consultores.length > 0
                ? consultores.join(' / ')
                : (isNonFieldConsultant(rawGrupo) ? 'NÃO ATRIBUÍDO' : rawGrupo.replace(/\s*\([^)]+\)\s*$/, '').trim());
              return {
                codigo_lr: r.codigo_produtor,
                nome_produtor: r.nome_produtor,
                nome_propriedade: r.nome_propriedade,
                nome_consultor: consultor,
                projeto: cleanProj || null,
                agroindustria: mapAgroindustria(r.agroindustria || cleanProj),
                regiao: r.regiao || null,
                unidade_atendimento: r.unidade_atendimento,
                data_referencia: r.mes_referencia,
                status: r.status
              };
            });
        }
      } catch (e) {
        // ignora e tenta próxima fonte
      }
    }

    // 2. Fallback para sq_raw_fazendas_grupo_ativas ou sq_raw_fazendas
    try {
      const rows = await fetchAll(() => {
        let q = supabase
          .from('sq_raw_fazendas')
          .select('codigo_produtor, nome_produtor, nome_propriedade, grupo_ponto_atendimento, projeto, unidade_atendimento, tipo_ponto_atendimento, status')
          .eq('status', 'Ativo')
          .ilike('tipo_ponto_atendimento', '%LEITE%');
        return q.order('codigo_produtor', { ascending: true });
      });
      if (rows && rows.length > 0) {
        return rows
          .filter(r => {
            const cod = String(r.codigo_produtor || '').toUpperCase();
            if (cod.includes('_CONSULTOR') || cod.includes('CONSULTOR_')) return false;
            return true;
          })
          .map(r => {
            const rawGrupo = r.grupo_ponto_atendimento || '';
            const cleanProj = r.projeto || extractCleanProject(rawGrupo, r.tipo_ponto_atendimento);
            const consultores = sanitizeConsultorList(rawGrupo);
            const consultor = consultores.length > 0
              ? consultores.join(' / ')
              : (isNonFieldConsultant(rawGrupo) ? 'NÃO ATRIBUÍDO' : rawGrupo.replace(/\s*\([^)]+\)\s*$/, '').trim());
            return {
              codigo_lr: r.codigo_produtor,
              nome_produtor: r.nome_produtor,
              nome_propriedade: r.nome_propriedade,
              nome_consultor: consultor,
              projeto: cleanProj || null,
              agroindustria: mapAgroindustria(cleanProj),
              unidade_atendimento: r.unidade_atendimento,
              data_referencia: refMonth,
              status: r.status
            };
          });
      }
    } catch (e) {
      // ignora e tenta fallback
    }

    // 3. Fallback para sq_raw_vinculos
    try {
      const rows = await fetchAll(() => {
        let q = supabase
          .from('sq_raw_vinculos')
          .select('codigo_lr, nome_produtor, nome_propriedade, consultor_grupo_atendimento, grupo_atendimento, projeto, unidade_atendimento, data_associacao, vinculo_ativo');
        if (refMonth) q = q.lte('data_associacao', refMonth);
        return q.order('data_associacao', { ascending: false });
      });
      return (rows || [])
        .filter(r => {
          const cod = String(r.codigo_lr || '').toUpperCase();
          if (cod.includes('_CONSULTOR') || cod.includes('CONSULTOR_')) return false;
          const cons = String(r.consultor_grupo_atendimento || r.grupo_atendimento || '').toUpperCase();
          if (cons.includes('SUPERVISAO') || cons.includes('SUPERVISÃO') || cons.includes('AGRICULTURA')) {
            if (!cod.startsWith('LR')) return false;
          }
          return true;
        })
        .map(r => {
          const rawGrupo = r.consultor_grupo_atendimento || r.grupo_atendimento || '';
          const consultores = sanitizeConsultorList(rawGrupo);
          const consultor = consultores.length > 0
            ? consultores.join(' / ')
            : (isNonFieldConsultant(rawGrupo) ? 'NÃO ATRIBUÍDO' : rawGrupo);
          return {
            codigo_lr: r.codigo_lr,
            nome_produtor: r.nome_produtor,
            nome_propriedade: r.nome_propriedade,
            nome_consultor: consultor,
            projeto: r.projeto,
            agroindustria: mapAgroindustria(r.projeto),
            unidade_atendimento: r.unidade_atendimento,
            data_referencia: refMonth || (r.data_associacao ? r.data_associacao.slice(0, 7) + '-01' : null),
            status: r.vinculo_ativo ? 'ATIVO' : 'INATIVO'
          };
        });
    } catch (e) {
      return [];
    }
  }, 5 * 60 * 1000);
}

module.exports = { getRegiaoMap, getDimRegioesMap, sanitizeRegiao, fixMojibake, getProdutoresAtivos };
