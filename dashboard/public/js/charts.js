/**
 * Fábrica de gráficos do dashboard Labor Rural.
 */
class DashboardCharts {
  constructor() {
    this.instances = {};
    Chart.defaults.font.family = 'Open Sans, Open Sans Fallback, Arial, sans-serif';
    Chart.defaults.font.size = 11.2;
    Chart.defaults.animation.duration = 420;
    Chart.defaults.responsive = true;
    Chart.defaults.maintainAspectRatio = false;
  }

  colors() {
    const styles = getComputedStyle(document.documentElement);
    const get = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      dark: get('--green-950', '#004d49'),
      green: get('--green-700', '#11775d'),
      medium: '#29927d',
      light: '#a9d1c5',
      mint: get('--green-400', '#4fc9b0'),
      danger: get('--danger', '#e23e3b'),
      warning: get('--warning', '#e28a10'),
      info: get('--info', '#2385c7'),
      ink: get('--ink', '#162640'),
      muted: get('--muted', '#65707c'),
      grid: get('--line-soft', '#e9edef'),
      surface: get('--surface', '#ffffff')
    };
  }

  destroy(id) {
    if (this.instances[id]) this.instances[id].destroy();
  }

  tooltip() {
    return {
      backgroundColor: 'rgba(0, 77, 73, 0.94)',
      titleColor: '#ffffff',
      bodyColor: '#ffffff',
      padding: 10,
      displayColors: true,
      cornerRadius: 7,
      titleFont: { size: 11.2, weight: '700' },
      bodyFont: { size: 11.2 }
    };
  }

  formatValue(value, suffix = '') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return `${value ?? '—'}${suffix}`;
    return `${numeric.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}${suffix}`;
  }

  valueLabels(formatter, options = {}) {
    const color = this.colors();
    return {
      id: 'dashboardValueLabels',
      afterDatasetsDraw: (chart) => {
        const context = chart.ctx;
        const isHorizontal = chart.options.indexAxis === 'y';
        const isDoughnut = chart.config.type === 'doughnut';
        const total = isDoughnut
          ? (chart.data.datasets[0]?.data || []).reduce((sum, value) => sum + Number(value || 0), 0)
          : 0;

        context.save();
        context.font = `700 ${options.fontSize || 11.2}px Open Sans, Arial, sans-serif`;
        context.textBaseline = 'middle';

        chart.data.datasets.forEach((dataset, datasetIndex) => {
          const metadata = chart.getDatasetMeta(datasetIndex);
          if (metadata.hidden) return;

          metadata.data.forEach((element, dataIndex) => {
            const rawValue = dataset.data[dataIndex];
            if (rawValue === null || rawValue === undefined || rawValue === '') return;
            const percentage = total > 0 ? (Number(rawValue) / total) * 100 : 0;
            if (isDoughnut && percentage < (options.minimumPercentage || 0)) return;

            const label = formatter(rawValue, { chart, dataset, datasetIndex, dataIndex, percentage });
            if (!label) return;

            let x = element.x;
            let y = element.y;
            let align = 'center';
            const requestedPosition = typeof options.position === 'function'
              ? options.position({ chart, dataset, datasetIndex, dataIndex, element })
              : options.position;
            const requestedColor = typeof options.color === 'function'
              ? options.color({ chart, dataset, datasetIndex, dataIndex, element })
              : options.color;
            let fill = requestedColor || color.ink;

            if (isDoughnut) {
              const angle = (element.startAngle + element.endAngle) / 2;
              const radius = (element.innerRadius + element.outerRadius) / 2;
              x = element.x + Math.cos(angle) * radius;
              y = element.y + Math.sin(angle) * radius;
              fill = '#ffffff';
            } else if (isHorizontal) {
              x += 7;
              align = 'left';
            } else if (requestedPosition === 'insideBase' && Number.isFinite(element.base)) {
              y = element.base - 11;
            } else {
              y -= dataset.type === 'line' || chart.config.type === 'line' ? 11 : 8;
            }

            context.textAlign = align;
            context.lineWidth = 3;
            context.strokeStyle = requestedPosition === 'insideBase'
              ? String(dataset.backgroundColor || color.dark)
              : (isDoughnut ? 'rgba(0, 77, 73, 0.38)' : color.surface);
            context.strokeText(label, x, y);
            context.fillStyle = fill;
            context.fillText(label, x, y);
          });
        });

        context.restore();
      }
    };
  }

  centerText(text, options = {}) {
    const color = this.colors();
    return {
      id: 'dashboardCenterText',
      afterDatasetsDraw: (chart) => {
        if (chart.config.type !== 'doughnut') return;
        const meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data || !meta.data[0]) return;
        const x = meta.data[0].x;
        const y = meta.data[0].y;
        const ctx = chart.ctx;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${options.fontSize || 12}px Open Sans, Arial, sans-serif`;
        ctx.fillStyle = options.color || color.ink;
        ctx.fillText(text, x, y);
        ctx.restore();
      }
    };
  }

  baseScales(extra = {}) {
    const color = this.colors();
    return {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: { color: color.muted, font: { size: 11.2, weight: '600' }, maxRotation: 0 }
      },
      y: {
        beginAtZero: true,
        grid: { color: color.grid },
        border: { display: false },
        ticks: { color: color.muted, font: { size: 11.2 } }
      },
      ...extra
    };
  }

  renderCoverage(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    this.instances[id] = new Chart(ctx, {
      plugins: [this.valueLabels(
        (value, context) => this.formatValue(value, context.datasetIndex === 2 ? '%' : ''),
        {
          position: ({ datasetIndex }) => datasetIndex < 2 ? 'insideBase' : 'above',
          color: ({ datasetIndex }) => datasetIndex === 0 ? '#ffffff' : color.dark
        }
      )],
      data: {
        labels: data.labels || [],
        datasets: [
          { type: 'bar', label: 'Fazendas ativas', data: data.fazendasAtivas || [], backgroundColor: color.dark, borderRadius: 2, barPercentage: 0.72, categoryPercentage: 0.72 },
          { type: 'bar', label: 'Fazendas visitadas', data: data.fazendasVisitadas || [], backgroundColor: color.light, borderRadius: 2, barPercentage: 0.72, categoryPercentage: 0.72 },
          { type: 'line', label: '% Visitadas', data: data.percCobertura || [], yAxisID: 'percentage', borderColor: color.dark, backgroundColor: color.dark, borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, tension: 0.28 }
        ]
      },
      options: {
        layout: { padding: { top: 17 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: this.tooltip() },
        scales: this.baseScales({
          percentage: {
            position: 'right', min: 0, max: 100,
            grid: { drawOnChartArea: false }, border: { display: false },
            ticks: { color: color.muted, font: { size: 11.2 }, callback: (value) => `${value}%` }
          }
        })
      }
    });
  }

  renderTurnover(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    const lineColor = '#4472c5'; // Azul clássico #4472c5
    const textColor = '#203864'; // Azul escuro legível

    const entradas = data.entradas || [];
    const saidas = data.saidas || [];
    const porcentagens = data.porcentagens || saidas.map((s, idx) => {
      const e = entradas[idx] || 0;
      const total = Number(e || 0) + Number(s || 0);
      return total > 0 ? Number(((s / total) * 100).toFixed(1)) : 0;
    });

    const turnoverCustomLabels = {
      id: 'turnoverCustomLabels',
      afterDatasetsDraw: (chart) => {
        const context = chart.ctx;
        context.save();

        chart.data.datasets.forEach((dataset, datasetIndex) => {
          const meta = chart.getDatasetMeta(datasetIndex);
          if (meta.hidden) return;

          meta.data.forEach((element, dataIndex) => {
            const rawValue = dataset.data[dataIndex];
            if (rawValue === null || rawValue === undefined) return;

            const x = element.x;

            if (datasetIndex === 0 || datasetIndex === 1) {
              // Barras (Entradas e Saídas): Rótulo na BASE INTERNA com texto branco
              const valNum = Number(rawValue);
              const label = String(valNum);

              context.font = '700 11px Open Sans, Arial, sans-serif';
              context.textAlign = 'center';
              context.textBaseline = 'middle';

              const baseY = element.base;
              const topY = element.y;
              const barHeight = Math.abs(baseY - topY);

              if (valNum > 0 && barHeight >= 14) {
                const y = baseY - 9;
                context.fillStyle = '#ffffff';
                context.fillText(label, x, y);
              } else if (valNum === 0) {
                const y = baseY - 8;
                context.fillStyle = color.muted;
                context.fillText(label, x, y);
              } else {
                const y = topY - 7;
                context.fillStyle = color.ink;
                context.fillText(label, x, y);
              }
            } else if (datasetIndex === 2) {
              // Linha (Inativações/total de pedidos): Texto em tom âmbar escuro com contorno branco e sem fundo
              const valNum = Number(rawValue);
              const label = `${valNum.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

              context.font = '700 11px Open Sans, Arial, sans-serif';
              context.textAlign = 'center';
              context.textBaseline = 'middle';

              const y = element.y - 12;

              // Contorno branco para máxima legibilidade sobre barras/linhas
              context.lineWidth = 3.5;
              context.strokeStyle = color.surface || '#ffffff';
              context.strokeText(label, x, y);

              // Texto em âmbar escuro
              context.fillStyle = textColor;
              context.fillText(label, x, y);
            }
          });
        });

        context.restore();
      }
    };

    this.instances[id] = new Chart(ctx, {
      data: {
        labels: data.labels || [],
        datasets: [
          {
            type: 'bar',
            label: 'Entradas',
            data: entradas,
            backgroundColor: color.green,
            borderRadius: 2,
            barPercentage: 0.72,
            categoryPercentage: 0.7,
            order: 2,
            yAxisID: 'y'
          },
          {
            type: 'bar',
            label: 'Saídas',
            data: saidas,
            backgroundColor: color.danger,
            borderRadius: 2,
            barPercentage: 0.72,
            categoryPercentage: 0.7,
            order: 3,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: 'Inativações/total de pedidos',
            data: porcentagens,
            borderColor: lineColor,
            backgroundColor: lineColor,
            borderWidth: 2.2,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: lineColor,
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.5,
            tension: 0.28,
            fill: false,
            order: 1,
            yAxisID: 'y1'
          }
        ]
      },
      plugins: [turnoverCustomLabels],
      options: {
        layout: { padding: { top: 25, right: 8 } },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              pointStyle: 'circle',
              font: { size: 10.5, weight: '600' },
              color: color.muted,
              padding: 10
            }
          },
          tooltip: {
            ...this.tooltip(),
            callbacks: {
              label: (item) => {
                if (item.datasetIndex === 2) {
                  return ` Inativações/total de pedidos: ${item.raw}%`;
                }
                return ` ${item.dataset.label}: ${item.raw}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: color.muted, font: { size: 11.2, weight: '600' } }
          },
          y: {
            type: 'linear',
            position: 'left',
            beginAtZero: true,
            grid: { color: color.grid },
            border: { display: false },
            ticks: { color: color.muted, font: { size: 11.2 }, precision: 0 }
          },
          y1: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            suggestedMax: 100,
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: color.muted,
              font: { size: 11.2 },
              callback: (val) => `${val}%`
            }
          }
        }
      }
    });
  }

  renderVisits(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    this.instances[id] = new Chart(ctx, {
      type: 'bar',
      plugins: [this.valueLabels((value) => this.formatValue(value))],
      data: { labels: data.labels || [], datasets: [{ label: 'Visitas', data: data.values || [], backgroundColor: color.green, borderRadius: 2, barPercentage: 0.68 }] },
      options: { layout: { padding: { top: 17 } }, plugins: { legend: { display: false }, tooltip: this.tooltip() }, scales: this.baseScales() }
    });
  }

  renderRanking(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    this.instances[id] = new Chart(ctx, {
      type: 'bar',
      plugins: [this.valueLabels((value) => this.formatValue(value), { fontSize: 11.2 })],
      data: { labels: data.labels || [], datasets: [{ label: 'Visitas', data: data.values || [], backgroundColor: color.green, borderRadius: 2, barPercentage: 0.58 }] },
      options: {
        indexAxis: 'y',
        layout: { padding: { right: 30 } },
        plugins: { legend: { display: false }, tooltip: this.tooltip() },
        scales: {
          x: { beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: color.muted, font: { size: 11.2 }, precision: 0 } },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: color.muted, font: { size: 11.2 }, autoSkip: false } }
        }
      }
    });
  }

  renderPortfolio(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    this.instances[id] = new Chart(ctx, {
      type: 'line',
      plugins: [this.valueLabels((value) => this.formatValue(value))],
      data: {
        labels: data.labels || [],
        datasets: [{ label: 'Produtores ativos', data: data.values || [], borderColor: color.dark, backgroundColor: 'rgba(79, 201, 176, 0.14)', fill: true, borderWidth: 2, pointRadius: 3, pointBackgroundColor: color.dark, tension: 0.3 }]
      },
      options: { layout: { padding: { top: 17 } }, plugins: { legend: { display: false }, tooltip: this.tooltip() }, scales: this.baseScales() }
    });
  }

  renderConsistencyHistory(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    this.instances[id] = new Chart(ctx, {
      type: 'line',
      plugins: [this.valueLabels((value) => this.formatValue(value, '%'), { fontSize: 11.2 })],
      data: {
        labels: data.labels || [],
        datasets: [
          { label: 'Consistência mensal', data: data.mensal || [], borderColor: color.dark, backgroundColor: color.dark, borderWidth: 2, pointRadius: 3, tension: 0.25 },
          { label: 'Consistência anual', data: data.anual || [], borderColor: color.mint, backgroundColor: color.mint, borderWidth: 2, pointRadius: 3, tension: 0.25 }
        ]
      },
      options: {
        layout: { padding: { top: 22, right: 14, left: 6, bottom: 4 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: this.tooltip() },
        scales: this.baseScales({
          y: {
            min: 0,
            max: 108,
            grid: { color: color.grid },
            border: { display: false },
            ticks: {
              color: color.muted,
              font: { size: 11.2 },
              callback: (value) => value <= 100 ? `${value}%` : ''
            }
          }
        })
      }
    });
  }

  renderQuality(id, data = {}) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    this.destroy(id);
    const color = this.colors();
    const values = data.values || [];
    const baseLabels = ['Registros aptos', 'Registros incompletos', 'Registros divergentes'];
    const centerTitle = id.toLowerCase().includes('annual') ? 'Anual' : 'Mensal';
    this.instances[id] = new Chart(ctx, {
      type: 'doughnut',
      plugins: [
        this.centerText(centerTitle, { fontSize: 13, color: color.ink }),
        this.valueLabels((value, context) => {
          const val = Number(value || 0);
          if (val === 0) return '';
          const pct = this.formatValue(context.percentage, '%');
          return `${this.formatValue(val)} (${pct})`;
        }, { minimumPercentage: 2, fontSize: 9.5 })
      ],
      data: {
        labels: baseLabels,
        datasets: [{
          data: values,
          backgroundColor: [color.dark, color.warning, color.danger],
          borderColor: color.surface,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '48%',
        radius: '90%',
        layout: { padding: { top: 4, bottom: 4, left: 4, right: 4 } },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            ...this.tooltip(),
            callbacks: {
              label: (context) => {
                const val = context.raw || 0;
                const total = (context.dataset.data || []).reduce((a, b) => a + Number(b || 0), 0);
                const pct = total > 0 ? ((val / total) * 100).toFixed(1).replace('.', ',') : '0,0';
                return ` ${context.label}: ${val} (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }

  applyTheme() {
    Object.entries(this.instances).forEach(([id, chart]) => {
      if (!chart) return;
      const type = chart.config.type;
      const data = JSON.parse(JSON.stringify(chart.data));
      if (id.includes('Coverage')) this.renderCoverage(id, {
        labels: data.labels,
        fazendasAtivas: data.datasets[0]?.data,
        fazendasVisitadas: data.datasets[1]?.data,
        percCobertura: data.datasets[2]?.data
      });
      else if (id.includes('Turnover')) this.renderTurnover(id, {
        labels: data.labels,
        entradas: data.datasets[0]?.data,
        saidas: data.datasets[1]?.data,
        porcentagens: data.datasets[2]?.data
      });
      else if (id.includes('Ranking')) this.renderRanking(id, { labels: data.labels, values: data.datasets[0]?.data });
      else if (id.includes('Portfolio')) this.renderPortfolio(id, { labels: data.labels, values: data.datasets[0]?.data });
      else if (id.includes('ConsistencyHistory')) this.renderConsistencyHistory(id, { labels: data.labels, mensal: data.datasets[0]?.data, anual: data.datasets[1]?.data });
      else if (id.includes('DataQuality')) this.renderQuality(id, { labels: data.labels, values: data.datasets[0]?.data });
      else if (type === 'bar') this.renderVisits(id, { labels: data.labels, values: data.datasets[0]?.data });
    });
  }
}

window.DashboardCharts = DashboardCharts;
