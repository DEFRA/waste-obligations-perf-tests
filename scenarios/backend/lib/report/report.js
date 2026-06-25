(function () {
  const data = (window.K6_DATA || []).slice();

  const fmtInt = (v) =>
    v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtMs = (v) => (v == null ? '—' : `${Math.round(v * 100) / 100} ms`);
  const fmtPct = (v) =>
    v == null ? '—' : `${(Math.round(v * 10000) / 100).toFixed(2)}%`;
  const fmtRate = (v) =>
    v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)}/s`;

  function renderCounters() {
    const el = document.getElementById('counters');
    if (!el) return;
    const total = data.length;
    const passed = data.filter((d) => d.pass).length;
    const failed = total - passed;
    const totalReqs = data.reduce((s, d) => s + (d.reqs || 0), 0);
    const totalFails = data.reduce(
      (s, d) => s + (d.reqs || 0) * (d.failRate || 0),
      0,
    );
    const overallFail = totalReqs > 0 ? totalFails / totalReqs : 0;
    const p95s = data.map((d) => d.p95).filter((v) => v != null);
    const avgP95 = p95s.length
      ? p95s.reduce((s, v) => s + v, 0) / p95s.length
      : null;
    const statusClass = failed === 0 ? 'pass' : 'fail';
    const statusSub = failed === 0 ? 'all passed' : `${failed} failed`;
    el.innerHTML = `
      <div class="panel counter ${statusClass}">
        <div class="label">Scenarios</div>
        <div class="value">${passed}/${total}</div>
        <div class="sub">${statusSub}</div>
      </div>
      <div class="panel counter">
        <div class="label">Total requests</div>
        <div class="value">${fmtInt(totalReqs)}</div>
      </div>
      <div class="panel counter">
        <div class="label">Mean p(95)</div>
        <div class="value">${fmtMs(avgP95)}</div>
      </div>
      <div class="panel counter">
        <div class="label">Overall fail rate</div>
        <div class="value">${fmtPct(overallFail)}</div>
      </div>
    `;
  }

  const colors = {
    avg: 'rgba(54, 130, 220, 0.55)',
    avgBorder: 'rgba(54, 130, 220, 1)',
    p95: 'rgba(54, 130, 220, 0.9)',
    p95Border: 'rgba(33, 90, 170, 1)',
    throughput: 'rgba(125, 90, 200, 0.8)',
    throughputBorder: 'rgba(90, 60, 160, 1)',
    fail: 'rgba(197, 37, 37, 0.8)',
    failBorder: 'rgba(150, 25, 25, 1)',
    check: 'rgba(10, 125, 50, 0.8)',
    checkBorder: 'rgba(8, 90, 35, 1)',
  };

  const baseOpts = (xLabel) => ({
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        title: { display: !!xLabel, text: xLabel },
        beginAtZero: true,
        grid: { color: '#eee' },
      },
      y: { grid: { display: false } },
    },
  });

  function renderCharts() {
    if (typeof Chart === 'undefined' || data.length === 0) return;
    const labels = data.map((d) => d.name);

    new Chart(document.getElementById('ch-latency'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'avg',
            data: data.map((d) => d.avg ?? 0),
            backgroundColor: colors.avg,
            borderColor: colors.avgBorder,
            borderWidth: 1,
          },
          {
            label: 'p(95)',
            data: data.map((d) => d.p95 ?? 0),
            backgroundColor: colors.p95,
            borderColor: colors.p95Border,
            borderWidth: 1,
          },
        ],
      },
      options: {
        ...baseOpts('milliseconds'),
        plugins: { legend: { display: true, position: 'bottom' } },
      },
    });

    new Chart(document.getElementById('ch-throughput'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'req/s',
            data: data.map((d) => d.reqRate ?? 0),
            backgroundColor: colors.throughput,
            borderColor: colors.throughputBorder,
            borderWidth: 1,
          },
        ],
      },
      options: baseOpts('requests / second'),
    });

    new Chart(document.getElementById('ch-fail'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'fail %',
            data: data.map((d) => (d.failRate ?? 0) * 100),
            backgroundColor: colors.fail,
            borderColor: colors.failBorder,
            borderWidth: 1,
          },
        ],
      },
      options: baseOpts('percent'),
    });

    new Chart(document.getElementById('ch-check'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'check pass %',
            data: data.map((d) => (d.checkRate ?? 0) * 100),
            backgroundColor: colors.check,
            borderColor: colors.checkBorder,
            borderWidth: 1,
          },
        ],
      },
      options: {
        ...baseOpts('percent'),
        scales: {
          ...baseOpts('percent').scales,
          x: { ...baseOpts('percent').scales.x, max: 100 },
        },
      },
    });
  }

  function init() {
    renderCounters();
    renderCharts();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
