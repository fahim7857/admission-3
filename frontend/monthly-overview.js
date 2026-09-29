// Monthly Fee Overview & 12-Month Matrix Frontend Logic
let currentClassId = null;
let currentMonth = getCurrentMonthName();
let matrixData = null;
let allClasses = [];
let availableAcademicYears = [];
let selectedAy = null;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

document.addEventListener('DOMContentLoaded', async () => {
  selectedAy = getSelectedAcademicYear();
  await loadAcademicYears();
  populateMonthSelect();
  await loadClasses();
  await loadMatrix();
  await loadDueList();
  setupEventListeners();
});

async function loadAcademicYears() {
  try {
    const res = await api.get('/academic-years');
    availableAcademicYears = res.data || [];
  } catch (err) {
    console.error('Failed to load academic years', err);
    availableAcademicYears = [selectedAy || { id: 1, year: 2026, is_active: 1 }];
  }

  const aySelect = document.getElementById('matrix-academic-year-select');
  if (aySelect) {
    aySelect.innerHTML = availableAcademicYears.map(ay => `
      <option value="${ay.id}" ${ay.id === selectedAy.id ? 'selected' : ''}>
        AY ${ay.year}${ay.is_active ? ' (Active)' : ''}
      </option>
    `).join('');
  }
}

function populateMonthSelect() {
  const mSelect = document.getElementById('matrix-month-select');
  if (!mSelect) return;
  const currentYearNum = selectedAy ? selectedAy.year : new Date().getFullYear();
  mSelect.innerHTML = MONTH_NAMES.map(m => `
    <option value="${m}" ${m === currentMonth ? 'selected' : ''}>
      ${m} ${currentYearNum}
    </option>
  `).join('');
}

async function loadClasses() {
  try {
    const res = await api.get('/classes', { academic_year_id: selectedAy.id });
    allClasses = res.data || [];

    // Check URL params
    const urlParams = new URLSearchParams(window.location.search);
    const urlCls = urlParams.get('class_id');

    // Default to Class 5 or first class
    const cls5 = allClasses.find(c => c.class_number === 5) || allClasses[0];
    currentClassId = urlCls ? parseInt(urlCls, 10) : (cls5 ? cls5.id : (allClasses[0] ? allClasses[0].id : 1));

    const sel = document.getElementById('matrix-class-select');
    if (sel) {
      if (allClasses.length === 0) {
        sel.innerHTML = '<option value="">No classes in this AY</option>';
      } else {
        sel.innerHTML = allClasses.map(c => `
          <option value="${c.id}" ${c.id === currentClassId ? 'selected' : ''}>
            ${c.name} (${c.student_count ?? 0} Students)
          </option>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load classes', err);
  }
}

async function loadMatrix() {
  if (!currentClassId) return;
  try {
    const res = await api.get('/overview/matrix', {
      academic_year_id: selectedAy.id,
      class_id: currentClassId,
      month: currentMonth
    });
    matrixData = res;
    renderTargetAnalysis(res.stats, res.classInfo, res.academicYear);
    renderMatrixTable(res.rows, res.classInfo);
  } catch (err) {
    showToast('Failed to load matrix: ' + err.message, 'error');
  }
}

async function loadDueList() {
  if (!currentClassId) return;
  try {
    const res = await api.get('/overview/due-list', {
      academic_year_id: selectedAy.id,
      class_id: currentClassId,
      month: currentMonth
    });
    renderDueListTable(res.data);
  } catch (err) {
    console.error(err);
  }
}

function renderTargetAnalysis(stats, classInfo, yearNum) {
  const ayYear = yearNum || (selectedAy ? selectedAy.year : 2026);
  const cycleTitle = document.getElementById('cycle-target-title');
  if (cycleTitle) {
    cycleTitle.textContent = `Target Cycle Analysis (${currentMonth} ${ayYear})`;
  }

  document.getElementById('stat-cycle-enrolled').textContent = `${stats.totalEnrolled} Students`;
  document.getElementById('stat-cycle-enrolled-sub').textContent = `${classInfo.name} active cohort`;

  document.getElementById('stat-cycle-cleared').textContent = `${stats.clearedCount} (${stats.clearedPercent}%)`;
  document.getElementById('stat-cycle-cleared-sub').textContent = 'Paid on schedule';

  document.getElementById('stat-cycle-due').textContent = `${stats.dueCount} (${stats.duePercent}%)`;
  document.getElementById('stat-cycle-due-sub').textContent = 'Defaulting this cycle';

  document.getElementById('stat-cycle-collected').textContent = formatCurrency(stats.grossCollected);
  document.getElementById('stat-cycle-collected-sub').textContent = `${stats.clearedPercent}% settled of target`;

  document.getElementById('stat-cycle-expected').textContent = formatCurrency(stats.expectedTarget);
  document.getElementById('stat-cycle-expected-sub').textContent = `Unsettled: ${formatCurrency(stats.unsettledAmount)}`;
}

function renderMatrixTable(rows, classInfo) {
  const tbody = document.getElementById('matrix-tbody');
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="14" style="text-align: center; color: #64748b; padding: 2rem;">No students enrolled in this class for AY ${selectedAy.year}.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const cells = MONTH_NAMES.map(mName => {
      const cell = r.months[mName];
      if (!cell || cell.status === 'NOT_APPLICABLE') {
        return `<td><span class="matrix-cell-na">—</span></td>`;
      }
      if (cell.status === 'PAID') {
        const noteEscaped = (cell.note || 'Monthly tuition fee').replace(/'/g, "\\'");
        const methodEscaped = (cell.payment_method || 'Cash').replace(/'/g, "\\'");
        return `
          <td>
            <span class="matrix-cell-paid" title="Paid on ${cell.date} (${cell.receipt})" onclick="viewReceiptFromMatrix('${cell.receipt}', '${r.name.replace(/'/g, "\\'")}', ${r.roll}, '${mName}', ${cell.amount}, '${classInfo.name.replace(/'/g, "\\'")}', '${noteEscaped}', '${methodEscaped}')">
              ${cell.label}
            </span>
          </td>
        `;
      }
      if (cell.status === 'DUE') {
        return `
          <td>
            <span class="matrix-cell-due" title="Due for ${mName}" onclick="openQuickPayMatrix(${r.id}, '${r.name.replace(/'/g, "\\'")}', ${r.roll}, '${mName}', ${cell.amount})">
              DUE
            </span>
          </td>
        `;
      }
      return `<td><span class="matrix-cell-na">—</span></td>`;
    }).join('');

    return `
      <tr>
        <td style="font-weight: 700; color: #004ac6;">
          <a href="student-details.html?id=${r.id}" style="color: inherit; text-decoration: none;">
            #${r.roll}
          </a>
        </td>
        <td style="font-weight: 600; text-align: left;">
          <a href="student-details.html?id=${r.id}" style="color: var(--on-surface); text-decoration: none;">
            ${r.name}
          </a>
        </td>
        ${cells}
      </tr>
    `;
  }).join('');
}

function renderDueListTable(dueStudents) {
  const tbody = document.getElementById('due-list-tbody');
  const countBadge = document.getElementById('due-list-count-badge');
  const dueTitle = document.getElementById('due-list-title');
  if (!tbody) return;

  const ayYear = selectedAy ? selectedAy.year : 2026;
  if (dueTitle) {
    dueTitle.textContent = `${currentMonth} ${ayYear} Due Students Register`;
  }

  if (countBadge) {
    countBadge.textContent = `${dueStudents ? dueStudents.length : 0} Defaulters`;
  }

  if (!dueStudents || dueStudents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #16a34a; font-weight: 600; padding: 2rem;">All students have cleared fees for ${currentMonth} ${ayYear}! 🎉</td></tr>`;
    return;
  }

  tbody.innerHTML = dueStudents.map(st => `
    <tr>
      <td style="font-weight: 700; color: #004ac6;">#${st.roll_number}</td>
      <td>
        <div style="font-weight: 600;">${st.name}</div>
        <div style="font-size: 0.72rem; color: #64748b;">Adm: ${st.admission_date}</div>
      </td>
      <td style="color: #334155; font-weight: 500;">${st.phone}</td>
      <td style="font-weight: 600; color: #dc2626;">${formatCurrency(st.monthly_fee)}</td>
      <td>
        ${st.unpaidMonthsCount > 1 ? `
          <span class="badge-tag" style="background: #fef2f2; color: #b91c1c; font-size: 0.7rem;">
            ${st.unpaidMonthsCount} Months Due (${st.unpaidMonths.join(', ')})
          </span>
        ` : `
          <span class="badge-tag" style="font-size: 0.7rem;">${currentMonth} Only</span>
        `}
      </td>
      <td style="font-weight: 700; color: #dc2626;">${formatCurrency(st.totalDueAmount)}</td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-primary btn-sm" onclick="openQuickPayMatrix(${st.id}, '${st.name.replace(/'/g, "\\'")}', ${st.roll_number}, '${currentMonth}', ${st.monthly_fee})">
          Collect Payment
        </button>
        <button class="btn btn-secondary btn-sm" onclick="sendReminderSMS('${st.name.replace(/'/g, "\\'")}', '${st.phone}', '${formatCurrency(st.totalDueAmount)}')">
          <span class="material-symbols-outlined" style="font-size: 1rem;">sms</span>
        </button>
      </td>
    </tr>
  `).join('');
}

function setupEventListeners() {
  const aySel = document.getElementById('matrix-academic-year-select');
  if (aySel) {
    aySel.addEventListener('change', async (e) => {
      const selectedId = parseInt(e.target.value, 10);
      setSelectedAcademicYearId(selectedId);
      selectedAy = getSelectedAcademicYear();
      populateMonthSelect();
      await loadClasses();
      await loadMatrix();
      await loadDueList();
    });
  }

  const clsSel = document.getElementById('matrix-class-select');
  if (clsSel) {
    clsSel.addEventListener('change', (e) => {
      currentClassId = parseInt(e.target.value, 10);
      loadMatrix();
      loadDueList();
    });
  }

  const mSel = document.getElementById('matrix-month-select');
  if (mSel) {
    mSel.addEventListener('change', (e) => {
      currentMonth = e.target.value;
      loadMatrix();
      loadDueList();
    });
  }

  const formPay = document.getElementById('form-matrix-pay');
  if (formPay) {
    formPay.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const today = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
      try {
        const res = await api.post('/payments', {
          student_id: form.student_id.value,
          month: form.month.value,
          amount: form.amount.value,
          payment_method: form.payment_method.value,
          note: form.note.value,
          payment_date: form.payment_date.value || today
        });
        showToast(res.message, 'success');
        closeModal('modal-matrix-pay');
        await loadMatrix();
        await loadDueList();
        openPrintReceiptModal(res.data);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

function openQuickPayMatrix(id, name, roll, month, fee) {
  const form = document.getElementById('form-matrix-pay');
  form.student_id.value = id;
  form.student_name_display.value = `#${roll} - ${name}`;
  form.month.value = month;
  form.amount.value = fee;
  openModal('modal-matrix-pay');
}

function viewReceiptFromMatrix(receiptNo, studentName, roll, month, amount, className, note, paymentMethod) {
  openPrintReceiptModal({
    receipt_no: receiptNo,
    student_name: studentName,
    roll_number: roll,
    class_name: className,
    month: month,
    amount: amount,
    payment_date: (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA'),
    payment_method: paymentMethod || 'Cash',
    note: note || 'Monthly tuition fee clearance',
    remarks: note || 'Monthly tuition fee clearance',
    year: selectedAy ? selectedAy.year : 2026
  });
}

function sendReminderSMS(name, phone, amount) {
  const yr = selectedAy ? selectedAy.year : new Date().getFullYear();
  const msg = `Dear Guardian, fee payment of ${amount} for student ${name} for ${currentMonth} ${yr} is due. Please settle at coaching office.`;
  navigator.clipboard.writeText(msg);
  showToast(`SMS reminder copied to clipboard for ${phone}!`, 'success');
}

function exportMatrixToExcel() {
  if (!matrixData || !matrixData.rows) {
    showToast('No matrix data to export', 'error');
    return;
  }

  const headers = ['Roll', 'Student Name', ...MONTH_NAMES];
  const csvRows = [headers.join(',')];

  matrixData.rows.forEach(r => {
    const row = [
      r.roll,
      `"${r.name.replace(/"/g, '""')}"`,
      ...MONTH_NAMES.map(m => {
        const c = r.months[m];
        if (!c) return '—';
        if (c.status === 'PAID') return `PAID (${c.amount})`;
        if (c.status === 'DUE') return `DUE (${c.amount})`;
        return '—';
      })
    ];
    csvRows.push(row.join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const todayIso = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  link.download = `monthly-fee-matrix-${matrixData.classInfo.name}-${todayIso}.csv`;
  link.click();
}
