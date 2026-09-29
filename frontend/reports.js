// Financial Reports Frontend Logic
let currentPeriod = 'month';
let reportData = null;

document.addEventListener('DOMContentLoaded', async () => {
  await loadReports();
  setupEventListeners();
});

async function loadReports() {
  try {
    const res = await api.get('/reports/financial', { period: currentPeriod });
    reportData = res.data;
    renderFinancialKPIs(reportData);
    renderCategoryBreakdown(reportData.expenseCategories, reportData.totalExpense);
    renderClassRevenueBreakdown(reportData.classRevenue, reportData.totalIncome);
    renderMonthlyTrajectory(reportData.monthlyTrajectory);
  } catch (err) {
    showToast('Failed to load financial report: ' + err.message, 'error');
  }
}

function renderFinancialKPIs(data) {
  document.getElementById('rep-total-income').textContent = formatCurrency(data.totalIncome);
  document.getElementById('rep-income-sub').textContent = `${data.incomeCount} fee receipts`;

  document.getElementById('rep-total-expense').textContent = formatCurrency(data.totalExpense);
  document.getElementById('rep-expense-sub').textContent = `${data.expenseCount} expenditure vouchers`;

  document.getElementById('rep-net-balance').textContent = formatCurrency(data.netBalance);
  document.getElementById('rep-net-balance').style.color = data.netBalance >= 0 ? '#004ac6' : '#dc2626';

  const margin = data.totalIncome > 0 ? ((data.netBalance / data.totalIncome) * 100).toFixed(1) : '0';
  document.getElementById('rep-margin-val').textContent = `${margin}%`;
  document.getElementById('rep-margin-sub').textContent = data.netBalance >= 0 ? 'Surplus operating reserve' : 'Deficit position';
}

function renderCategoryBreakdown(categories, totalExpense) {
  const container = document.getElementById('expense-categories-list');
  if (!container) return;

  if (!categories || categories.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #64748b; padding: 1.5rem;">No expenditures in this period.</div>`;
    return;
  }

  container.innerHTML = categories.map(cat => {
    const pct = totalExpense > 0 ? ((cat.total / totalExpense) * 100).toFixed(1) : 0;
    return `
      <div style="margin-bottom: 0.85rem;">
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 4px;">
          <span style="font-weight: 600; color: #1e293b;">${cat.category}</span>
          <span style="font-weight: 700; color: #dc2626;">${formatCurrency(cat.total)} (${pct}%)</span>
        </div>
        <div style="height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
          <div style="height: 100%; width: ${pct}%; background: #dc2626; border-radius: 3px;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderClassRevenueBreakdown(classRev, totalIncome) {
  const container = document.getElementById('class-revenue-list');
  if (!container) return;

  if (!classRev || classRev.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #64748b; padding: 1.5rem;">No revenue in this period.</div>`;
    return;
  }

  container.innerHTML = classRev.map(cr => {
    const pct = totalIncome > 0 ? ((cr.total / totalIncome) * 100).toFixed(1) : 0;
    return `
      <div style="margin-bottom: 0.85rem;">
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 4px;">
          <span style="font-weight: 600; color: #1e293b;">${cr.className}</span>
          <span style="font-weight: 700; color: #16a34a;">${formatCurrency(cr.total)} (${pct}%)</span>
        </div>
        <div style="height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
          <div style="height: 100%; width: ${pct}%; background: #2563eb; border-radius: 3px;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderMonthlyTrajectory(months) {
  const tbody = document.getElementById('trajectory-tbody');
  if (!tbody) return;

  tbody.innerHTML = months.map(m => {
    const net = m.income - m.expense;
    return `
      <tr>
        <td style="font-weight: 600;">${m.month}</td>
        <td style="font-weight: 700; color: #16a34a;">${formatCurrency(m.income)}</td>
        <td style="font-weight: 700; color: #dc2626;">${formatCurrency(m.expense)}</td>
        <td style="font-weight: 700; color: ${net >= 0 ? '#004ac6' : '#dc2626'};">
          ${formatCurrency(net)}
        </td>
        <td>
          <span class="status-pill ${net >= 0 ? 'paid' : 'due'}" style="font-size: 0.7rem;">
            ${net >= 0 ? '● Surplus' : '● Deficit'}
          </span>
        </td>
      </tr>
    `;
  }).join('');
}

function setupEventListeners() {
  document.getElementById('report-period-select').addEventListener('change', (e) => {
    currentPeriod = e.target.value;
    loadReports();
  });
}

function printAuditReport() {
  window.print();
}

function exportAuditCsv() {
  if (!reportData) return;

  const headers = ['Month', 'Tuition Income (BDT)', 'Expenses (BDT)', 'Net Margin (BDT)'];
  const csvRows = [headers.join(',')];

  reportData.monthlyTrajectory.forEach(m => {
    const net = m.income - m.expense;
    csvRows.push([m.month, m.income, m.expense, net].join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const todayIso = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  link.download = `financial-audit-report-2026-${todayIso}.csv`;
  link.click();
}
