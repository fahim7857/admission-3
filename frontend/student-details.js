// Student Details Dossier Frontend Logic
let currentStudentId = null;
let studentData = null;

document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  currentStudentId = urlParams.get('id');

  if (!currentStudentId) {
    // Look up Rahim Ahmed or first student
    const listRes = await api.get('/students');
    if (listRes.data && listRes.data.length > 0) {
      const rahim = listRes.data.find(s => s.name.includes('Rahim') && s.class_number === 5) || listRes.data[0];
      currentStudentId = rahim.id;
    }
  }

  await loadStudentProfile();
  setupEventListeners();
});

async function loadStudentProfile() {
  try {
    const res = await api.get(`/students/${currentStudentId}`);
    studentData = res.data;
    renderProfile(studentData.student, studentData.summary);
    renderMetrics(studentData.summary);
    renderLifecycleGrid(studentData.monthlyBreakdown, studentData.student);
    renderPaymentsLedger(studentData.payments, studentData.student);
  } catch (err) {
    showToast('Failed to load student dossier: ' + err.message, 'error');
  }
}

function renderProfile(student, summary) {
  document.getElementById('breadcrumb-roll-name').textContent = `Roll ${student.roll_number} - ${student.name}`;
  document.getElementById('breadcrumb-class').textContent = student.class_name;
  document.getElementById('profile-name').textContent = student.name;
  document.getElementById('profile-roll-badge').textContent = `Roll #${student.roll_number}`;
  document.getElementById('profile-class-batch').textContent = `${student.class_name} • Single Batch (AY 2026)`;
  document.getElementById('profile-father').textContent = student.father_name || 'N/A';
  document.getElementById('profile-mother').textContent = student.mother_name || 'N/A';
  document.getElementById('profile-phone').textContent = student.phone;
  document.getElementById('profile-address').textContent = student.address || 'Dhaka, Bangladesh';

  document.getElementById('meta-admission-date').textContent = student.admission_date;
  document.getElementById('meta-fixed-fee').textContent = `${formatCurrency(student.monthly_fee)} / mo`;
  document.getElementById('meta-system-id').textContent = `STU-2026-${String(student.roll_number).padStart(4, '0')}`;

  // Update button texts
  document.getElementById('btn-record-payment-top').textContent = `Record Payment for ${student.name.split(' ')[0]}`;
  const deactBtn = document.getElementById('btn-toggle-status');
  if (deactBtn) {
    deactBtn.textContent = student.status === 'Active' ? 'Deactivate' : 'Activate';
  }
}

function renderMetrics(summary) {
  document.getElementById('metric-total-paid').textContent = formatCurrency(summary.totalPaid);
  const percentPaid = (summary.totalPaid + summary.totalDue) > 0 ? ((summary.totalPaid / (summary.totalPaid + summary.totalDue)) * 100).toFixed(1) : '100';
  document.getElementById('metric-paid-sub').textContent = `${percentPaid}% of current obligations collected`;

  document.getElementById('metric-total-due').textContent = formatCurrency(summary.totalDue);
  document.getElementById('metric-due-sub').textContent = summary.dueCount > 0 ? `${summary.dueCount} billing cycles pending clearance` : 'All cycles cleared';

  document.getElementById('metric-months-paid').textContent = `${summary.paidCount} Months`;
  document.getElementById('metric-months-due').textContent = `${summary.dueCount} Months`;
}

function renderLifecycleGrid(months, student) {
  const container = document.getElementById('lifecycle-matrix-container');
  if (!container) return;

  container.innerHTML = months.map(m => {
    let cardClass = 'upcoming';
    let badgeHtml = '';
    let footerHtml = '';

    if (m.status === 'PAID') {
      cardClass = 'paid';
      badgeHtml = `<span class="status-pill paid" style="font-size: 0.68rem;">Paid ✓</span>`;
      footerHtml = `
        <div style="font-size: 0.72rem; color: #15803d; font-weight: 600;">
          ${m.payment.receipt_no}
        </div>
        <div style="font-size: 0.68rem; color: #64748b;">${m.payment.payment_date}</div>
      `;
    } else if (m.status === 'DUE') {
      cardClass = 'due';
      badgeHtml = `<span class="status-pill due" style="font-size: 0.68rem;">Due (${formatShortCurrency(m.fee)})</span>`;
      footerHtml = `
        <button class="btn btn-primary btn-sm" style="padding: 0.25rem 0.5rem; font-size: 0.72rem; width: 100%;" onclick="openPaymentForMonth('${m.month}')">
          Collect Fee
        </button>
      `;
    } else if (m.status === 'NOT_APPLICABLE') {
      cardClass = 'na';
      badgeHtml = `<span class="badge-tag" style="font-size: 0.68rem; background: #e2e8f0; color: #64748b;">Not Enrolled</span>`;
      footerHtml = `<div style="font-size: 0.7rem; color: #94a3b8;">Exempt (Pre-Admission)</div>`;
    } else {
      cardClass = 'upcoming';
      badgeHtml = `<span class="badge-tag" style="font-size: 0.68rem; background: #f1f5f9; color: #64748b;">Upcoming</span>`;
      footerHtml = `<div style="font-size: 0.7rem; color: #94a3b8;">${formatShortCurrency(m.fee)} expected</div>`;
    }

    return `
      <div class="month-lifecycle-card ${cardClass}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 0.85rem;">${m.month}</strong>
          ${badgeHtml}
        </div>
        <div style="margin-top: auto; padding-top: 0.4rem; border-top: 1px solid rgba(0,0,0,0.05);">
          ${footerHtml}
        </div>
      </div>
    `;
  }).join('');
}

function renderPaymentsLedger(payments, student) {
  const tbody = document.getElementById('ledger-tbody');
  if (!tbody) return;

  if (!payments || payments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 2rem;">No fee transactions logged for this student.</td></tr>`;
    return;
  }

  tbody.innerHTML = payments.map(p => `
    <tr>
      <td style="font-weight: 600;">${p.month} ${p.year}</td>
      <td style="font-weight: 700; color: #16a34a;">${formatCurrency(p.amount)}</td>
      <td style="color: #334155;">${p.payment_date}</td>
      <td style="color: #64748b; font-size: 0.78rem;">${p.payment_time}</td>
      <td style="font-weight: 600; color: #004ac6;">${p.receipt_no}</td>
      <td><span class="badge-tag">${p.payment_method}</span></td>
      <td style="color: #64748b; font-size: 0.8rem;">Admin Cashier</td>
      <td style="text-align: right;">
        <button class="btn btn-secondary btn-sm" onclick="printReceiptDirect(${p.id})">
          <span class="material-symbols-outlined" style="font-size: 1rem;">print</span>
          Receipt
        </button>
      </td>
    </tr>
  `).join('');
}

function setupEventListeners() {
  const monthSelect = document.getElementById('pay-month-select');
  if (monthSelect) {
    monthSelect.addEventListener('change', checkDuplicatePayment);
  }

  const formPay = document.getElementById('form-record-student-payment');
  if (formPay) {
    formPay.addEventListener('submit', handleRecordPayment);
  }
}

function checkDuplicatePayment() {
  if (!studentData) return;
  const month = document.getElementById('pay-month-select').value;
  const existing = studentData.payments.find(p => p.month === month);

  const warnBanner = document.getElementById('duplicate-warning-banner');
  const submitBtn = document.getElementById('btn-submit-payment');

  if (existing) {
    warnBanner.style.display = 'block';
    warnBanner.innerHTML = `
      <div style="font-weight: 700;">DUPLICATE PAYMENT WARNING</div>
      <div>Fee for <strong>${month}</strong> was already paid on ${existing.payment_date} (Receipt: <strong>${existing.receipt_no}</strong>). Duplicate payment is strictly prohibited.</div>
    `;
    submitBtn.disabled = true;
  } else {
    warnBanner.style.display = 'none';
    submitBtn.disabled = false;
  }
}

function openPaymentForMonth(month) {
  openModal('modal-student-payment');
  const monthSelect = document.getElementById('pay-month-select');
  if (monthSelect) {
    monthSelect.value = month;
    checkDuplicatePayment();
  }
  if (studentData) {
    document.getElementById('pay-amount-input').value = studentData.student.monthly_fee;
  }
}

async function handleRecordPayment(e) {
  e.preventDefault();
  const form = e.target;
  const month = form.month.value;

  try {
    const res = await api.post('/payments', {
      student_id: currentStudentId,
      month: month,
      amount: form.amount ? form.amount.value : document.getElementById('pay-amount-input')?.value,
      payment_method: form.payment_method.value,
      note: form.note.value,
      payment_date: form.payment_date.value || ((typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA'))
    });

    showToast(res.message, 'success');
    closeModal('modal-student-payment');
    await loadStudentProfile();
    openPrintReceiptModal({
      ...res.data,
      student_name: studentData.student.name,
      roll_number: studentData.student.roll_number,
      class_name: studentData.student.class_name
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function printReceiptDirect(paymentId) {
  const p = studentData.payments.find(pay => pay.id === paymentId);
  if (p) {
    openPrintReceiptModal({
      ...p,
      student_name: studentData.student.name,
      roll_number: studentData.student.roll_number,
      class_name: studentData.student.class_name
    });
  }
}

function printStudentFeeCard() {
  window.print();
}

function openEditCurrentStudent() {
  if (!studentData || !studentData.student) return;
  const st = studentData.student;
  const form = document.getElementById('form-edit-student-details-modal');
  if (!form) return;

  form.student_id.value = st.id;
  form.roll_number.value = `#${st.roll_number}`;
  form.class_name.value = st.class_name;
  form.name.value = st.name || '';
  form.father_name.value = (st.father_name && st.father_name !== 'N/A' && st.father_name !== 'null') ? st.father_name : '';
  form.mother_name.value = (st.mother_name && st.mother_name !== 'N/A' && st.mother_name !== 'null') ? st.mother_name : '';
  form.phone.value = st.phone || '';
  form.address.value = (st.address && st.address !== 'N/A' && st.address !== 'null') ? st.address : '';
  form.admission_date.value = st.admission_date || '';

  openModal('modal-edit-student-details-dialog');
}

// Add submission listener for student details edit form
document.addEventListener('DOMContentLoaded', () => {
  const formEditDetails = document.getElementById('form-edit-student-details-modal');
  if (formEditDetails) {
    formEditDetails.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const id = form.student_id.value;
      try {
        await api.put(`/students/${id}`, {
          name: form.name.value,
          father_name: form.father_name.value,
          mother_name: form.mother_name.value,
          phone: form.phone.value,
          address: form.address.value,
          admission_date: form.admission_date.value
        });
        showToast('Student profile updated successfully', 'success');
        closeModal('modal-edit-student-details-dialog');
        await loadStudentProfile();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
});

