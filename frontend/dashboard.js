// Dashboard Frontend Logic
let currentPeriod = 'today';
let dashboardData = null;
let currentTrxTab = 'all';

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof ensureAcademicYearContext === 'function') {
    await ensureAcademicYearContext();
  }
  await loadDashboard();
  setupEventListeners();
  loadClassesForModals();
  loadCategoriesForExpenseModal();
  checkSuperAdminRole();
});

async function checkSuperAdminRole() {
  try {
    const res = await api.get('/me');
    if (res && res.success && res.data && res.data.role === 'super_admin') {
      const adminLink = document.getElementById('nav-admin-link');
      if (adminLink) {
        adminLink.style.display = 'flex';
      }
    }
  } catch (err) {
    // Not super admin or unauthenticated
  }
}

window.addEventListener('academicYearChanged', async () => {
  await loadDashboard();
});

async function loadDashboard() {
  try {
    if (typeof ensureAcademicYearContext === 'function') {
      await ensureAcademicYearContext();
    }
    const selectedAy = getSelectedAcademicYear();
    const currentMonth = getCurrentMonthName();
    const localDate = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
    const [res, teacherSumRes] = await Promise.all([
      api.get('/dashboard', {
        period: currentPeriod,
        month: currentMonth,
        academic_year_id: selectedAy.id,
        client_date: localDate
      }),
      api.get('/teachers/dashboard-summary').catch(() => ({ success: true, data: { totalTeachers: 0, todayClasses: 0, todayKhatas: 0, todayGuards: 0, totalPayable: 0 } }))
    ]);
    dashboardData = res;

    const titleEl = document.getElementById('dash-ay-title');
    if (titleEl) {
      titleEl.textContent = `Academic Year ${res.academicYear || selectedAy.year}`;
    }
    const classOverviewBadge = document.getElementById('dash-class-overview-badge');
    if (classOverviewBadge) {
      classOverviewBadge.textContent = `AY ${res.academicYear || selectedAy.year}`;
    }

    renderAcademicYearFilter();
    renderKPIs(res);
    renderTeacherSummaryWidget(teacherSumRes.data);
    renderDueStudents(res.priorityDue, res.stats, res.dueUnpaidTotal);
    renderClassOverview(res.classOverview);
    renderRecentTransactions(res.recentTransactions);
    renderChart(res.chartData);
    requestAnimationFrame(() => renderChart(res.chartData));
  } catch (err) {
    showToast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function renderTeacherSummaryWidget(d) {
  if (!d) return;
  const totT = document.getElementById('dashTotalTeachers');
  const totP = document.getElementById('dashTotalPayable');

  if (totT) totT.textContent = d.totalTeachers || 0;
  if (totP) totP.textContent = `৳${(d.totalPayable || 0).toLocaleString()}`;
}

function renderAcademicYearFilter() {
  const ayFilter = document.getElementById('dashboard-ay-filter');
  if (!ayFilter) return;
  const currentAy = getSelectedAcademicYear();
  ayFilter.innerHTML = cachedAcademicYears.map(y => `
    <option value="${y.id}" ${y.id === currentAy.id ? 'selected' : ''}>
      AY ${y.year} ${y.is_active ? '● Active' : '(Archive)'}
    </option>
  `).join('');

  if (!ayFilter.dataset.bound) {
    ayFilter.dataset.bound = 'true';
    ayFilter.addEventListener('change', (e) => {
      const chosenId = parseInt(e.target.value, 10);
      const chosen = cachedAcademicYears.find(y => y.id === chosenId);
      if (chosen) {
        setSelectedAcademicYear(chosen, true);
      }
    });
  }
}

function renderKPIs(data) {
  const stats = data.stats;

  // 1. Active Register
  document.getElementById('kpi-total-students').textContent = `${stats.totalStudents} Students`;
  document.getElementById('kpi-students-sub').textContent = `${stats.activeClasses} Classes • Full Enrollment`;

  // 2. Inflow & Outflow Labels and Values
  const inflowLabelEl = document.getElementById('kpi-inflow-label');
  const outflowLabelEl = document.getElementById('kpi-outflow-label');
  const netLabelEl = document.getElementById('kpi-net-label');

  let periodLabel = 'Today';
  if (currentPeriod === 'week') {
    periodLabel = 'This Week';
    if (inflowLabelEl) inflowLabelEl.textContent = "THIS WEEK'S INFLOW";
    if (outflowLabelEl) outflowLabelEl.textContent = "THIS WEEK'S OUTFLOW";
    if (netLabelEl) netLabelEl.textContent = "NET WEEKLY BALANCE";
  } else if (currentPeriod === 'month') {
    periodLabel = 'This Month';
    if (inflowLabelEl) inflowLabelEl.textContent = "THIS MONTH'S INFLOW";
    if (outflowLabelEl) outflowLabelEl.textContent = "THIS MONTH'S OUTFLOW";
    if (netLabelEl) netLabelEl.textContent = "NET MONTHLY BALANCE";
  } else if (currentPeriod === 'overall') {
    periodLabel = 'All Time';
    if (inflowLabelEl) inflowLabelEl.textContent = "TOTAL INFLOW (AY)";
    if (outflowLabelEl) outflowLabelEl.textContent = "TOTAL OUTFLOW (AY)";
    if (netLabelEl) netLabelEl.textContent = "OVERALL NET BALANCE";
  } else {
    if (inflowLabelEl) inflowLabelEl.textContent = "TODAY'S INFLOW";
    if (outflowLabelEl) outflowLabelEl.textContent = "TODAY'S OUTFLOW";
    if (netLabelEl) netLabelEl.textContent = "NET DAILY BALANCE";
  }

  // Inflow
  let inflowVal = stats.today.income;
  let inflowCount = stats.today.paymentsCount;
  if (currentPeriod === 'month') {
    inflowVal = stats.monthly.income;
    inflowCount = stats.monthly.paymentsCount;
  } else if (currentPeriod === 'week') {
    inflowVal = stats.weekly.income;
    inflowCount = stats.weekly.paymentsCount;
  } else if (currentPeriod === 'overall') {
    inflowVal = stats.overall.income;
    inflowCount = stats.overall.paymentsCount;
  }
  document.getElementById('kpi-inflow-value').textContent = formatCurrency(inflowVal);
  document.getElementById('kpi-inflow-sub').textContent = `${inflowCount ?? 0} payments recorded (${periodLabel})`;

  // 3. Outflow
  let outflowVal = stats.today.expense;
  let outflowCount = stats.today.vouchersCount;
  if (currentPeriod === 'month') {
    outflowVal = stats.monthly.expense;
    outflowCount = stats.monthly.vouchersCount;
  } else if (currentPeriod === 'week') {
    outflowVal = stats.weekly.expense;
    outflowCount = stats.weekly.vouchersCount;
  } else if (currentPeriod === 'overall') {
    outflowVal = stats.overall.expense;
    outflowCount = stats.overall.vouchersCount;
  }
  document.getElementById('kpi-outflow-value').textContent = formatCurrency(outflowVal);
  document.getElementById('kpi-outflow-sub').textContent = `${outflowCount ?? 0} vouchers recorded (${periodLabel})`;

  // 4. Net Balance
  let netVal = stats.today.net;
  if (currentPeriod === 'month') {
    netVal = stats.monthly.net;
  } else if (currentPeriod === 'week') {
    netVal = stats.weekly.net;
  } else if (currentPeriod === 'overall') {
    netVal = stats.overall.net;
  }
  document.getElementById('kpi-net-value').textContent = formatCurrency(netVal);
  const marginVal = inflowVal > 0 ? ((netVal / inflowVal) * 100).toFixed(1) : '0';
  document.getElementById('kpi-net-sub').textContent = `${marginVal}% net margin • ${periodLabel}`;

  // Update sidebar net balance display on the left side of the page
  const sbNet = document.getElementById('sidebar-net-balance-val');
  if (sbNet) {
    sbNet.textContent = formatCurrency(netVal);
  }
}

function renderDueStudents(dueList, stats, unpaidTotal) {
  const tbody = document.getElementById('due-students-tbody');
  if (!tbody) return;

  const list = Array.isArray(dueList) ? dueList : [];
  const count = (stats && typeof stats.dueStudentsCount === 'number') ? stats.dueStudentsCount : list.length;
  const totalDue = typeof unpaidTotal === 'number'
    ? unpaidTotal
    : list.reduce((sum, st) => sum + (Number(st.monthly_fee) || 0), 0);

  const countBadge = document.getElementById('due-students-count-badge');
  if (countBadge) countBadge.textContent = `${count} Due`;

  const unpaidEl = document.getElementById('due-students-unpaid-total');
  if (unpaidEl) unpaidEl.textContent = `UNPAID: ${formatCurrency(totalDue)}`;

  const showingEl = document.getElementById('due-students-showing-label');
  if (showingEl) showingEl.textContent = count === 0 ? 'No outstanding dues' : `Showing all ${count} due students`;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 1.5rem;">No due students this month</td></tr>`;
    return;
  }

  const curMonth = getCurrentMonthName();
  const curShortMonth = curMonth.slice(0, 3);
  const curYear = new Date().getFullYear();

  tbody.innerHTML = list.map(st => `
    <tr>
      <td>
        <div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${st.name}</div>
        <div style="font-size: 0.72rem; color: #64748b;">#${st.roll_number}</div>
      </td>
      <td><span class="badge-tag">${st.class_name}</span></td>
      <td style="color: #64748b;">${curShortMonth} ${curYear}</td>
      <td style="font-weight: 700; color: #dc2626;">${formatCurrency(st.monthly_fee)}</td>
      <td style="text-align: right;">
        <button class="btn btn-primary btn-sm" onclick="quickCollect(${st.id}, '${st.name.replace(/'/g, "\\'")}', ${st.roll_number}, '${curMonth}', ${st.monthly_fee})">
          Collect
        </button>
      </td>
    </tr>
  `).join('');
}

function renderClassOverview(overview) {
  const tbody = document.getElementById('class-overview-tbody');
  if (!tbody || !overview) return;

  tbody.innerHTML = overview.classes.map(c => `
    <tr>
      <td style="font-weight: 600;">
        <a href="monthly-overview.html?class_id=${c.id}" style="color: var(--primary); text-decoration: none;">
          ${c.name}
        </a>
      </td>
      <td>${c.students}</td>
      <td>${formatShortCurrency(c.expected)}</td>
      <td style="font-weight: 600; color: #16a34a;">${formatShortCurrency(c.collected)}</td>
      <td style="font-weight: 600; color: #dc2626;">${formatShortCurrency(c.due)}</td>
      <td style="width: 130px;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <div class="progress-bar-container" style="flex: 1;">
            <div class="progress-bar-fill" style="width: ${c.recoveryRate}%;"></div>
          </div>
          <span style="font-size: 0.72rem; font-weight: 600;">${c.recoveryRate}%</span>
        </div>
      </td>
    </tr>
  `).join('');

  document.getElementById('total-projected-summary').textContent = `Total Projected: ${formatCurrency(overview.totalProjected)}`;
  document.getElementById('aggregate-efficiency-summary').textContent = `Aggregate Efficiency: ${overview.aggregateEfficiency}%`;
}

function renderRecentTransactions(transactions) {
  const container = document.getElementById('recent-transactions-container');
  if (!container) return;

  const list = Array.isArray(transactions) ? transactions : [];
  const filtered = list.filter(t => {
    if (currentTrxTab === 'all') return true;
    return String(t.type || '').toLowerCase() === currentTrxTab;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #64748b; padding: 2rem;">No ${currentTrxTab === 'all' ? '' : currentTrxTab + ' '}transactions found</div>`;
    return;
  }

  container.innerHTML = filtered.slice(0, 25).map(t => {
    const isIncome = String(t.type || '').toLowerCase() === 'income';
    const timeLabel = t.time ? ` ${t.time}` : '';
    return `
      <div class="trx-item">
        <div style="display: flex; align-items: center; min-width: 0;">
          <div class="trx-icon ${isIncome ? 'income' : 'expense'}">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">
              ${isIncome ? 'arrow_downward' : 'arrow_upward'}
            </span>
          </div>
          <div style="min-width: 0;">
            <div style="font-weight: 600; font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${t.title || ''}</div>
            <div style="font-size: 0.72rem; color: #64748b;">${t.subtitle || ''} • ${formatDate(t.date)}${timeLabel}</div>
          </div>
        </div>
        <div style="text-align: right; flex-shrink: 0; margin-left: 0.5rem;">
          <div style="font-weight: 700; font-size: 0.85rem; color: ${isIncome ? '#16a34a' : '#dc2626'};">
            ${isIncome ? '+' : '-'} ${formatCurrency(t.amount)}
          </div>
          <span class="status-pill ${isIncome ? 'paid' : 'due'}" style="font-size: 0.68rem; padding: 1px 6px;">
            ${isIncome ? 'Income' : 'Expense'}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

function renderChart(chartData) {
  const canvas = document.getElementById('overview-chart-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const series = Array.isArray(chartData) ? chartData : [];
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width || canvas.clientWidth || 400, 1);
  const h = Math.max(rect.height || canvas.clientHeight || 230, 1);

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (series.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('No income or expense data yet', 16, h / 2);
    return;
  }

  const padBottom = 30;
  const padTop = 20;
  const padLeft = 48;
  const padRight = 16;
  const chartH = h - padBottom - padTop;
  const chartW = w - padLeft - padRight;

  const maxRaw = Math.max(
    1,
    ...series.map(item => Math.max(Number(item.income) || 0, Number(item.expense) || 0, Number(item.net) || 0))
  );
  const mag = Math.pow(10, Math.floor(Math.log10(maxRaw)));
  const maxVal = Math.ceil(maxRaw / mag) * mag;

  const formatAxis = (val) => {
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}m`;
    if (val >= 1000) return `${Math.round(val / 1000)}k`;
    return String(Math.round(val));
  };

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px Inter, sans-serif';

  for (let i = 0; i <= 4; i++) {
    const y = padTop + (chartH * (4 - i)) / 4;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();
    ctx.fillText(formatAxis((i * maxVal) / 4), 8, y + 3);
  }

  const barGroupWidth = chartW / series.length;
  const barWidth = Math.min(14, Math.max(6, barGroupWidth / 3.2));
  const linePoints = [];

  const drawBar = (x, y, bw, bh, color) => {
    ctx.fillStyle = color;
    if (bh <= 0) return;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, bw, bh, [3, 3, 0, 0]);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, bw, bh);
    }
  };

  series.forEach((item, idx) => {
    const xCenter = padLeft + idx * barGroupWidth + barGroupWidth / 2;
    const income = Number(item.income) || 0;
    const expense = Number(item.expense) || 0;
    const incH = (income / maxVal) * chartH;
    const expH = (expense / maxVal) * chartH;

    drawBar(xCenter - barWidth - 2, padTop + chartH - incH, barWidth, incH, '#2563eb');
    drawBar(xCenter + 2, padTop + chartH - expH, barWidth, expH, '#94a3b8');

    ctx.fillStyle = '#475569';
    ctx.fillText(item.month, xCenter - 10, h - 10);

    const net = Number(item.net);
    const netVal = Number.isFinite(net) ? Math.max(0, net) : Math.max(0, income - expense);
    const netY = padTop + chartH - (netVal / maxVal) * chartH;
    linePoints.push({ x: xCenter, y: netY });
  });

  if (linePoints.length > 0) {
    ctx.strokeStyle = '#0d9488';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(linePoints[0].x, linePoints[0].y);
    for (let i = 1; i < linePoints.length; i++) {
      ctx.lineTo(linePoints[i].x, linePoints[i].y);
    }
    ctx.stroke();

    linePoints.forEach(p => {
      ctx.fillStyle = '#0d9488';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.75, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function setupEventListeners() {
  const periodSelect = document.getElementById('period-filter-select');
  if (periodSelect) {
    periodSelect.addEventListener('change', (e) => {
      currentPeriod = e.target.value;
      if (dashboardData) renderKPIs(dashboardData);
    });
  }

  window.addEventListener('resize', () => {
    if (dashboardData) renderChart(dashboardData.chartData);
  });

  // Transactions tabs
  document.querySelectorAll('.trx-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.trx-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTrxTab = btn.dataset.tab;
      if (dashboardData) renderRecentTransactions(dashboardData.recentTransactions);
    });
  });

  // Modal forms
  const addStudentForm = document.getElementById('form-add-student');
  if (addStudentForm) {
    addStudentForm.addEventListener('submit', handleAddStudent);
  }

  const recordPaymentForm = document.getElementById('form-record-payment');
  if (recordPaymentForm) {
    recordPaymentForm.addEventListener('submit', handleRecordPayment);
  }

  const addExpenseForm = document.getElementById('form-add-expense');
  if (addExpenseForm) {
    addExpenseForm.addEventListener('submit', handleAddExpense);
  }

  // Next roll auto calculation when class changes in Add Student modal
  const classSelect = document.getElementById('student-class-select');
  if (classSelect) {
    classSelect.addEventListener('change', updateNextRollPreview);
  }

  // Dashboard Payment Modal Student Lookup Listeners
  setupDashboardPaymentModal();
}

let selectedDashPaymentStudent = null;

function setupDashboardPaymentModal() {
  const input = document.getElementById('dash-pay-student-input');
  const btnFind = document.getElementById('btn-find-student-dash');
  const filterClass = document.getElementById('dash-pay-filter-class');
  const monthSelect = document.getElementById('dash-pay-month-select');
  const btnReset = document.getElementById('btn-reset-verified-dash');

  if (input) {
    input.addEventListener('input', debounce(() => lookupDashStudents(false), 250));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupDashStudents(true);
      }
    });
  }

  if (btnFind) {
    btnFind.addEventListener('click', () => lookupDashStudents(true));
  }

  if (filterClass) {
    filterClass.addEventListener('change', () => {
      lookupDashStudents(false);
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', resetDashPaymentModal);
  }

  if (monthSelect) {
    monthSelect.addEventListener('change', () => {
      if (selectedDashPaymentStudent) {
        updateDashPaymentStatusBanner(selectedDashPaymentStudent, monthSelect.value);
      }
    });
  }
}

async function lookupDashStudents(autoSelectIfSingle = false) {
  const input = document.getElementById('dash-pay-student-input');
  const filterClass = document.getElementById('dash-pay-filter-class');
  const suggestionsBox = document.getElementById('dash-pay-student-suggestions');
  const monthSelect = document.getElementById('dash-pay-month-select');

  if (!input) return;
  const query = input.value.trim();
  const classId = filterClass ? filterClass.value : '';
  const month = monthSelect ? monthSelect.value : getCurrentMonthName();

  if (!query && !classId) {
    if (suggestionsBox) suggestionsBox.style.display = 'none';
    return;
  }

  try {
    const res = await api.get('/students/lookup', { query, class_id: classId, month });
    const students = res.students || [];

    if (autoSelectIfSingle && res.exactMatch) {
      selectDashStudentForPayment(res.exactMatch);
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      return;
    }

    if (autoSelectIfSingle && students.length === 1) {
      selectDashStudentForPayment(students[0]);
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      return;
    }

    if (students.length === 0) {
      if (suggestionsBox) {
        suggestionsBox.innerHTML = `
          <div style="padding: 0.75rem 1rem; color: #dc2626; font-size: 0.8rem; display: flex; align-items: center; gap: 0.4rem;">
            <span class="material-symbols-outlined" style="font-size: 1rem;">person_off</span>
            No student found matching "${query}"${classId ? ' in this class' : ''}.
          </div>
        `;
        suggestionsBox.style.display = 'block';
      }
      return;
    }

    if (suggestionsBox) {
      suggestionsBox.innerHTML = students.map(s => `
        <div class="dash-student-item" 
             data-id="${s.id}" 
             style="padding: 0.55rem 0.85rem; border-bottom: 1px solid #f1f5f9; cursor: pointer; display: flex; align-items: center; justify-content: space-between; transition: background 0.15s ease;"
             onmouseover="this.style.background='#f8fafc'" 
             onmouseout="this.style.background='transparent'">
          <div>
            <div style="font-weight: 600; font-size: 0.85rem; color: #1e293b; display: flex; align-items: center; gap: 0.4rem;">
              <span>${s.name}</span>
              <span class="badge-tag" style="font-size: 0.7rem; padding: 1px 6px;">${s.class_name}</span>
              <span class="badge-tag" style="font-size: 0.7rem; padding: 1px 6px; background: #e0f2fe; color: #0369a1;">Roll #${s.roll_number}</span>
            </div>
            <div style="font-size: 0.73rem; color: #64748b; margin-top: 1px;">
              Guardian: ${s.father_name || 'N/A'} • Phone: ${s.phone || 'N/A'}
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: 700; font-size: 0.82rem; color: #004ac6;">৳${s.monthly_fee}</div>
            <span style="font-size: 0.68rem; color: ${s.current_month_status === 'Paid' ? '#16a34a' : '#d97706'}; font-weight: 600;">
              ${s.current_month_status}
            </span>
          </div>
        </div>
      `).join('');

      suggestionsBox.querySelectorAll('.dash-student-item').forEach(item => {
        item.addEventListener('click', () => {
          const stId = parseInt(item.dataset.id, 10);
          const st = students.find(x => x.id === stId);
          if (st) {
            selectDashStudentForPayment(st);
            suggestionsBox.style.display = 'none';
          }
        });
      });

      suggestionsBox.style.display = 'block';
    }
  } catch (err) {
    console.error('Error looking up student in dashboard:', err);
  }
}

function selectDashStudentForPayment(student) {
  selectedDashPaymentStudent = student;

  const hiddenId = document.getElementById('dash-pay-student-id');
  if (hiddenId) hiddenId.value = student.id;

  const amountInput = document.getElementById('dash-pay-amount-input');
  if (amountInput) amountInput.value = student.monthly_fee || 1000;

  const verifiedCard = document.getElementById('dash-pay-verified-student');
  const avatar = document.getElementById('dash-verified-avatar');
  const nameEl = document.getElementById('dash-verified-name');
  const classEl = document.getElementById('dash-verified-class');
  const rollEl = document.getElementById('dash-verified-roll');
  const phoneEl = document.getElementById('dash-verified-phone');
  const fatherEl = document.getElementById('dash-verified-father');
  const feeEl = document.getElementById('dash-verified-fee');
  const promptEl = document.getElementById('dash-pay-search-prompt');

  if (avatar) avatar.textContent = student.name.substring(0, 2).toUpperCase();
  if (nameEl) nameEl.textContent = student.name;
  if (classEl) classEl.textContent = student.class_name;
  if (rollEl) rollEl.textContent = `Roll #${student.roll_number} (ID: #${student.id})`;
  if (phoneEl) phoneEl.textContent = student.phone || 'No phone';
  if (fatherEl) fatherEl.textContent = `Father: ${student.father_name || 'N/A'}`;
  if (feeEl) feeEl.textContent = `৳${student.monthly_fee}/mo`;

  if (verifiedCard) verifiedCard.style.display = 'block';
  if (promptEl) promptEl.style.display = 'none';

  const monthSelect = document.getElementById('dash-pay-month-select');
  updateDashPaymentStatusBanner(student, monthSelect ? monthSelect.value : getCurrentMonthName());

  const step2 = document.getElementById('dash-payment-details-section');
  const submitBtn = document.getElementById('btn-submit-dash-payment');
  if (step2) {
    step2.style.opacity = '1';
    step2.style.pointerEvents = 'auto';
  }
  if (submitBtn) {
    submitBtn.disabled = false;
  }
}

async function updateDashPaymentStatusBanner(student, month) {
  const banner = document.getElementById('dash-verified-status-banner');
  if (!banner) return;

  try {
    const res = await api.get('/students/lookup', { query: String(student.id), month });
    const st = res.exactMatch || student;
    banner.style.display = 'block';

    if (st.current_month_status === 'Paid') {
      banner.style.background = '#fef2f2';
      banner.style.border = '1px solid #fecaca';
      banner.style.color = '#b91c1c';
      banner.innerHTML = `
        <strong>⚠️ Notice:</strong> ${student.name} has <strong>already paid</strong> for ${month} 
        (Receipt #${st.payment ? st.payment.receipt_no : 'N/A'}). Proceeding will record a secondary payment.
      `;
    } else {
      banner.style.background = '#f0fdf4';
      banner.style.border = '1px solid #bbf7d0';
      banner.style.color = '#15803d';
      banner.innerHTML = `
        <strong>✓ Verified:</strong> ${month} tuition fee is currently <strong>DUE (৳${student.monthly_fee})</strong>. Ready to collect fee.
      `;
    }
  } catch (err) {
    console.error(err);
  }
}

function resetDashPaymentModal() {
  selectedDashPaymentStudent = null;
  const input = document.getElementById('dash-pay-student-input');
  const hiddenId = document.getElementById('dash-pay-student-id');
  const verifiedCard = document.getElementById('dash-pay-verified-student');
  const suggestionsBox = document.getElementById('dash-pay-student-suggestions');
  const promptEl = document.getElementById('dash-pay-search-prompt');
  const step2 = document.getElementById('dash-payment-details-section');
  const submitBtn = document.getElementById('btn-submit-dash-payment');

  if (input) input.value = '';
  if (hiddenId) hiddenId.value = '';
  if (verifiedCard) verifiedCard.style.display = 'none';
  if (suggestionsBox) suggestionsBox.style.display = 'none';
  if (promptEl) promptEl.style.display = 'flex';
  if (step2) {
    step2.style.opacity = '0.45';
    step2.style.pointerEvents = 'none';
  }
  if (submitBtn) {
    submitBtn.disabled = true;
  }
}

async function loadClassesForModals() {
  try {
    const selectedAy = getSelectedAcademicYear();
    const res = await api.get('/classes', { academic_year_id: selectedAy.id });
    const classes = res.data;

    // Student modal class select
    const stClassSel = document.getElementById('student-class-select');
    if (stClassSel) {
      stClassSel.innerHTML = classes.map(c => `
        <option value="${c.id}" data-fee="${c.monthly_fee}" data-num="${c.class_number}">
          ${c.name} (৳${c.monthly_fee}/mo)
        </option>
      `).join('');
      updateNextRollPreview();
    }

    // Payment modal class filter to separate each class students
    const payClassFilter = document.getElementById('dash-pay-filter-class');
    if (payClassFilter) {
      payClassFilter.innerHTML = `
        <option value="">All Classes</option>
        ${classes.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      `;
    }
  } catch (err) {
    console.error('Failed to load classes for modals', err);
  }
}

async function updateNextRollPreview() {
  const classSelect = document.getElementById('student-class-select');
  if (!classSelect || !classSelect.value) return;

  try {
    const selectedAy = getSelectedAcademicYear();
    const res = await api.get('/students/next-roll', {
      class_id: classSelect.value,
      academic_year_id: selectedAy.id
    });
    document.getElementById('next-roll-preview-badge').textContent = `Next Roll: #${res.nextRoll}`;
    document.getElementById('next-roll-fee-badge').textContent = `Fee: ৳${res.classFee}/mo`;
  } catch (err) {
    console.error(err);
  }
}

function sortCategoriesWithOtherLast(cats) {
  if (!Array.isArray(cats)) return [];
  const regular = [];
  const others = [];
  cats.forEach(c => {
    const name = (c.name || '').trim().toLowerCase();
    if (name === 'other' || name === 'others') {
      others.push(c);
    } else {
      regular.push(c);
    }
  });
  return [...regular, ...others];
}

async function loadCategoriesForExpenseModal() {
  try {
    const res = await api.get('/expense-categories');
    const sorted = sortCategoriesWithOtherLast(res.data);
    const catSelect = document.getElementById('expense-category-select');
    if (catSelect) {
      catSelect.innerHTML = sorted.map(c => `
        <option value="${c.id}">${c.name}</option>
      `).join('');
    }
  } catch (err) {
    console.error(err);
  }
}

async function handleAddStudent(e) {
  e.preventDefault();
  const form = e.target;
  const selectedAy = getSelectedAcademicYear();
  const todayDate = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  const payload = {
    name: form.name.value,
    father_name: form.father_name.value,
    mother_name: form.mother_name.value,
    phone: form.phone.value,
    address: form.address.value,
    class_id: form.class_id.value,
    academic_year_id: selectedAy.id,
    admission_date: form.admission_date.value || todayDate
  };

  try {
    const res = await api.post('/students', payload);
    showToast(`Student ${res.data.name} admitted successfully with Roll #${res.data.roll_number}!`, 'success');
    closeModal('modal-add-student');
    form.reset();
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRecordPayment(e) {
  e.preventDefault();
  const form = e.target;
  if (!selectedDashPaymentStudent) {
    showToast('Please locate and select a student first', 'error');
    return;
  }
  const todayDate = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  const payload = {
    student_id: form.student_id.value,
    month: form.month.value,
    amount: form.amount ? form.amount.value : document.getElementById('dash-pay-amount-input')?.value,
    payment_method: form.payment_method.value,
    note: form.note.value,
    payment_date: form.payment_date.value || todayDate
  };

  try {
    const res = await api.post('/payments', payload);
    showToast(res.message, 'success');
    closeModal('modal-record-payment');
    resetDashPaymentModal();
    await loadDashboard();

    // Offer printable receipt
    openPrintReceiptModal(res.data);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleAddExpense(e) {
  e.preventDefault();
  const form = e.target;
  const todayDate = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  const payload = {
    category_id: form.category_id.value,
    amount: form.amount.value,
    description: form.description.value,
    expense_date: form.expense_date.value || todayDate
  };

  try {
    const res = await api.post('/expenses', payload);
    showToast(`Expense recorded under Voucher #${res.data.voucherNo}`, 'success');
    closeModal('modal-add-expense');
    form.reset();
    await loadDashboard();
    if (res && res.data) {
      openPrintExpenseReceiptModal(res.data);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function quickCollect(studentId, studentName, roll, month, fee) {
  openModal('modal-record-payment');
  const monthSel = document.getElementById('dash-pay-month-select');
  if (monthSel && month) {
    monthSel.value = month;
  }
  try {
    const res = await api.get(`/students/${studentId}`);
    if (res.data && res.data.student) {
      selectDashStudentForPayment(res.data.student);
    }
  } catch (err) {
    console.error('Failed to pre-select student for quick collect:', err);
    // Fallback minimal student object
    selectDashStudentForPayment({
      id: studentId,
      name: studentName,
      roll_number: roll,
      monthly_fee: fee,
      class_name: 'Enrolled Class'
    });
  }
}
