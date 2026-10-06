// Payments Ledger Frontend Logic
let paymentsList = [];
let othersIncomeList = [];
let allClasses = [];

document.addEventListener('DOMContentLoaded', async () => {
  const curMonth = getCurrentMonthName();
  const payMonthSel = document.getElementById('modal-pay-month-select');
  if (payMonthSel) payMonthSel.value = curMonth;

  await loadClasses();
  await loadPayments();
  setupEventListeners();
  loadStudentsForModal();
});

let selectedPaymentStudent = null;

async function loadClasses() {
  try {
    const res = await api.get('/classes');
    allClasses = res.data;
    const sel = document.getElementById('pay-filter-class');
    if (sel) {
      sel.innerHTML = `
        <option value="">All Classes</option>
        ${allClasses.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      `;
    }

    // Modal class filter to separate each class students
    const modalCls = document.getElementById('modal-pay-filter-class');
    if (modalCls) {
      modalCls.innerHTML = `
        <option value="">All Classes</option>
        ${allClasses.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      `;
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadPayments() {
  const search = document.getElementById('pay-filter-search').value.trim();
  const classId = document.getElementById('pay-filter-class').value;
  const month = document.getElementById('pay-filter-month').value;
  const startDate = document.getElementById('pay-filter-start').value;
  const endDate = document.getElementById('pay-filter-end').value;

  try {
    const res = await api.get('/payments', {
      search,
      class_id: classId,
      month,
      startDate,
      endDate
    });

    paymentsList = res.data;
    othersIncomeList = await loadOthersIncome({ search, classId, month, startDate, endDate });
    renderKPIs(paymentsList, othersIncomeList);
    renderPaymentsTable(paymentsList, othersIncomeList);
  } catch (err) {
    showToast('Failed to load payments: ' + err.message, 'error');
  }
}

const OTHERS_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function escapeHtmlText(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Others Income has no student / class / billing month, so the filters apply like this:
// date range -> sent to the API; class filter -> hides Others rows;
// month filter -> matches the month of the collection date; search -> matches description / receipt / note.
async function loadOthersIncome({ search, classId, month, startDate, endDate }) {
  if (classId) return [];
  try {
    const res = await api.get('/others-income', { startDate, endDate });
    let items = (res && res.collections) || [];
    if (month && month !== 'all') {
      items = items.filter(i => OTHERS_MONTH_NAMES[parseInt(String(i.collection_date).slice(5, 7), 10) - 1] === month);
    }
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i =>
        String(i.description || '').toLowerCase().includes(q) ||
        String(i.receipt_no || '').toLowerCase().includes(q) ||
        String(i.note || '').toLowerCase().includes(q));
    }
    return items;
  } catch (err) {
    console.error('Failed to load Others income:', err);
    return [];
  }
}

function renderKPIs(payments, others = []) {
  let totalInflow = 0;
  let cashTotal = 0;
  let digitalTotal = 0;

  payments.forEach(p => {
    totalInflow += p.amount;
    if (p.payment_method === 'Cash') {
      cashTotal += p.amount;
    } else {
      digitalTotal += p.amount;
    }
  });

  // Others Income is collected in cash and counts toward the total inflow
  others.forEach(o => {
    totalInflow += o.amount;
    cashTotal += o.amount;
  });

  const voucherCount = payments.length + others.length;
  const avgFee = voucherCount > 0 ? (totalInflow / voucherCount) : 0;

  document.getElementById('stat-total-inflow').textContent = formatCurrency(totalInflow);
  document.getElementById('stat-receipts-count').textContent = `${voucherCount} Vouchers`;
  document.getElementById('stat-digital-share').textContent = formatCurrency(digitalTotal);
  document.getElementById('stat-digital-sub').textContent = `Cash: ${formatCurrency(cashTotal)}`;
  document.getElementById('stat-avg-ticket').textContent = formatCurrency(avgFee);
}

function renderPaymentsTable(payments, others = []) {
  const tbody = document.getElementById('payments-tbody');
  if (!tbody) return;

  if (payments.length === 0 && others.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 2.5rem;">No payment transactions found.</td></tr>`;
    return;
  }

  // Merge student fee payments and Others Income, newest first
  const rows = [
    ...payments.map(p => ({ kind: 'fee', date: p.payment_date || '', time: p.payment_time || '', id: p.id, data: p })),
    ...others.map(o => ({ kind: 'other', date: o.collection_date || '', time: o.collection_time || '', id: o.id, data: o }))
  ].sort((a, b) => (b.date + ' ' + b.time).localeCompare(a.date + ' ' + a.time) || (b.id - a.id));

  tbody.innerHTML = rows.map(row => {
    if (row.kind === 'other') return renderOthersIncomeRow(row.data);
    const p = row.data;
    const methodClass = (p.payment_method || 'Cash').toLowerCase();
    return `
      <tr>
        <td style="font-weight: 700; color: #004ac6; white-space: nowrap;">${p.receipt_no}</td>
        <td style="white-space: nowrap;">
          <div style="font-weight: 500;">${p.payment_date}</div>
          <div style="font-size: 0.72rem; color: #64748b;">${p.payment_time}</div>
        </td>
        <td>
          <a href="student-details.html?id=${p.student_id}" style="font-weight: 600; color: var(--on-surface); text-decoration: none;">
            #${p.roll_number} - ${p.student_name}
          </a>
          <div style="font-size: 0.72rem; color: #64748b;">${p.student_phone}</div>
        </td>
        <td><span class="badge-tag">${p.class_name}</span></td>
        <td style="font-weight: 600; color: #1e293b;">${p.month} ${p.year}</td>
        <td style="font-weight: 700; color: #16a34a; white-space: nowrap;">${formatCurrency(p.amount)}</td>
        <td>
          <span class="payment-method-badge ${methodClass}">
            ${p.payment_method}
          </span>
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <div style="display: flex; gap: 0.35rem; justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm" onclick="printReceiptDirect(${p.id})" title="Print Money Receipt">
              <span class="material-symbols-outlined" style="font-size: 1rem;">print</span>
              Receipt
            </button>
            <button class="btn btn-outline btn-sm" style="color: #dc2626; border-color: #fecaca; padding: 0.25rem 0.45rem;" onclick="deletePaymentRecord(${p.id}, '${p.receipt_no}')" title="Delete Payment Record">
              <span class="material-symbols-outlined" style="font-size: 1rem;">delete</span>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderOthersIncomeRow(o) {
  const monthIdx = parseInt(String(o.collection_date).slice(5, 7), 10) - 1;
  const cycle = `${OTHERS_MONTH_NAMES[monthIdx] || ''} ${String(o.collection_date).slice(0, 4)}`;
  const showNote = o.note && o.note !== o.description;
  return `
      <tr>
        <td style="font-weight: 700; color: #16a34a; white-space: nowrap;">${escapeHtmlText(o.receipt_no)}</td>
        <td style="white-space: nowrap;">
          <div style="font-weight: 500;">${escapeHtmlText(o.collection_date)}</div>
          <div style="font-size: 0.72rem; color: #64748b;">${escapeHtmlText(o.collection_time)}</div>
        </td>
        <td>
          <div style="font-weight: 600; color: var(--on-surface);">${escapeHtmlText(o.description)}</div>
          ${showNote ? `<div style="font-size: 0.72rem; color: #64748b;">${escapeHtmlText(o.note)}</div>` : ''}
        </td>
        <td><span class="badge-tag" style="background: #f0fdf4; color: #16a34a;">Others Income</span></td>
        <td style="font-weight: 600; color: #1e293b;">${escapeHtmlText(cycle)}</td>
        <td style="font-weight: 700; color: #16a34a; white-space: nowrap;">${formatCurrency(o.amount)}</td>
        <td><span class="payment-method-badge cash">Cash</span></td>
        <td style="text-align: right; white-space: nowrap;">
          <div style="display: flex; gap: 0.35rem; justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm" onclick="printOthersReceipt(${Number(o.id)})" title="Print Money Receipt">
              <span class="material-symbols-outlined" style="font-size: 1rem;">print</span>
              Receipt
            </button>
            <button class="btn btn-outline btn-sm" style="color: #dc2626; border-color: #fecaca; padding: 0.25rem 0.45rem;" onclick="deleteOthersIncomeRecord(${Number(o.id)}, '${escapeHtmlText(o.receipt_no)}')" title="Delete Others Income Record">
              <span class="material-symbols-outlined" style="font-size: 1rem;">delete</span>
            </button>
          </div>
        </td>
      </tr>
    `;
}

let currentOthersReceiptHtml = '';

function buildOthersReceiptHtml(o) {
  const brandEl = document.querySelector('.sidebar-brand h1');
  const instituteName = escapeHtmlText((brandEl && brandEl.textContent.trim()) || 'Coaching Center');
  const showNote = o.note && o.note !== o.description;
  return `
    <div class="others-receipt" style="font-family: Arial, Helvetica, sans-serif; color: #0f172a; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 22px 24px; background: #fff;">
      <div style="text-align: center; border-bottom: 2px solid #16a34a; padding-bottom: 10px; margin-bottom: 14px;">
        <div style="font-size: 20px; font-weight: 800; letter-spacing: 0.3px;">${instituteName}</div>
        <div style="font-size: 12px; font-weight: 700; color: #16a34a; margin-top: 4px; letter-spacing: 1.2px;">MONEY RECEIPT &mdash; OTHERS INCOME</div>
      </div>
      <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
        <tr>
          <td style="padding: 5px 0; color: #64748b;">Receipt No</td>
          <td style="padding: 5px 0; font-weight: 700; text-align: right;">${escapeHtmlText(o.receipt_no)}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0; color: #64748b;">Date &amp; Time</td>
          <td style="padding: 5px 0; font-weight: 600; text-align: right;">${escapeHtmlText(o.collection_date)} ${escapeHtmlText(o.collection_time)}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0; color: #64748b;">Received For</td>
          <td style="padding: 5px 0; font-weight: 600; text-align: right;">${escapeHtmlText(o.description)}</td>
        </tr>
        ${showNote ? `<tr>
          <td style="padding: 5px 0; color: #64748b;">Remarks</td>
          <td style="padding: 5px 0; text-align: right;">${escapeHtmlText(o.note)}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 5px 0; color: #64748b;">Payment Mode</td>
          <td style="padding: 5px 0; font-weight: 600; text-align: right;">Cash</td>
        </tr>
      </table>
      <div style="margin-top: 14px; padding: 10px 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: #166534;">Amount Received</span>
        <span style="font-size: 20px; font-weight: 800; color: #16a34a;">${formatCurrency(o.amount)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-top: 44px; font-size: 11px; color: #64748b;">
        <div style="border-top: 1px solid #94a3b8; padding-top: 4px; min-width: 130px; text-align: center;">Received By</div>
        <div style="border-top: 1px solid #94a3b8; padding-top: 4px; min-width: 130px; text-align: center;">Authorized Signature</div>
      </div>
    </div>
  `;
}

function printOthersReceipt(id) {
  const o = othersIncomeList.find(item => Number(item.id) === Number(id));
  if (!o) {
    showToast('Could not find this Others income record.', 'error');
    return;
  }
  currentOthersReceiptHtml = buildOthersReceiptHtml(o);

  const modalId = 'modal-print-others-receipt';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-dialog" style="max-width: 520px;">
      <div class="modal-header">
        <h3 class="modal-title" style="display: flex; align-items: center; gap: 0.4rem;">
          <span class="material-symbols-outlined" style="color: #16a34a;">receipt_long</span>
          Others Income Receipt
        </h3>
        <button class="modal-close" onclick="closeModal('${modalId}')">&times;</button>
      </div>
      <div class="modal-body">${currentOthersReceiptHtml}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeModal('${modalId}')">Close</button>
        <button type="button" class="btn btn-primary" style="background: #16a34a;" onclick="printOthersReceiptContent()">
          <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
          Print Receipt
        </button>
      </div>
    </div>
  `;
  openModal(modalId);
}

function printOthersReceiptContent() {
  if (!currentOthersReceiptHtml) return;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Others Income Receipt</title>
    <style>body { margin: 16px; } @page { margin: 12mm; }</style></head>
    <body>${currentOthersReceiptHtml}</body></html>`);
  doc.close();
  frame.onload = null;
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  }, 250);
}

async function deleteOthersIncomeRecord(id, receiptNo) {
  if (!confirm(`Are you sure you want to delete Others income record #${receiptNo}?`)) {
    return;
  }
  try {
    const res = await api.delete(`/others-income/${id}`);
    showToast(res.message || 'Others income record deleted successfully', 'success');
    await loadPayments();
  } catch (err) {
    showToast('Failed to delete Others income: ' + err.message, 'error');
  }
}

function setupEventListeners() {
  document.getElementById('pay-filter-search').addEventListener('input', debounce(loadPayments, 300));
  document.getElementById('pay-filter-class').addEventListener('change', loadPayments);
  document.getElementById('pay-filter-month').addEventListener('change', loadPayments);
  document.getElementById('pay-filter-start').addEventListener('change', loadPayments);
  document.getElementById('pay-filter-end').addEventListener('change', loadPayments);

  const formRecord = document.getElementById('form-modal-record-payment');
  if (formRecord) {
    formRecord.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      if (!selectedPaymentStudent) {
        showToast('Please locate and select a student first', 'error');
        return;
      }
      try {
        const todayDate = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
        const res = await api.post('/payments', {
          student_id: form.student_id.value,
          month: form.month.value,
          amount: form.amount ? form.amount.value : document.getElementById('modal-pay-amount')?.value,
          payment_method: form.payment_method.value,
          note: form.note.value,
          payment_date: form.payment_date.value || todayDate
        });
        showToast(res.message, 'success');
        closeModal('modal-payments-record');
        resetPaymentModal();
        await loadPayments();
        openPrintReceiptModal(res.data);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Student Search Input & Trigger
  const studentInput = document.getElementById('modal-pay-student-input');
  const btnFind = document.getElementById('btn-find-student-payment');
  const filterClass = document.getElementById('modal-pay-filter-class');
  const monthSelect = document.getElementById('modal-pay-month-select');
  const btnReset = document.getElementById('btn-reset-verified-student');

  if (studentInput) {
    studentInput.addEventListener('input', debounce(() => lookupStudents(false), 250));
    studentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupStudents(true);
      }
    });
  }

  if (btnFind) {
    btnFind.addEventListener('click', () => lookupStudents(true));
  }

  if (filterClass) {
    filterClass.addEventListener('change', () => {
      if (studentInput && studentInput.value.trim()) {
        lookupStudents(true);
      }
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', resetPaymentModal);
  }

  if (monthSelect) {
    monthSelect.addEventListener('change', () => {
      if (selectedPaymentStudent) {
        updatePaymentStatusBanner(selectedPaymentStudent, monthSelect.value);
      }
    });
  }
}

// Others Income Modal Handlers
document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('openOthersIncomeModalBtn');
  const othersForm = document.getElementById('form-modal-others-income');
  const MODAL_ID = 'modal-others-income';
  const ERR_ID = 'othersIncomeFormError';

  function todayDate() {
    if (typeof getTodayDhakaDate === 'function') return getTodayDhakaDate();
    if (typeof getLocalIsoDate === 'function') return getLocalIsoDate();
    return new Date().toLocaleDateString('en-CA');
  }

  function showError(msg) {
    const el = document.getElementById(ERR_ID);
    if (el) { el.textContent = msg; el.style.display = 'block'; }
    else alert(msg);
  }

  function clearError() {
    const el = document.getElementById(ERR_ID);
    if (el) { el.textContent = ''; el.style.display = 'none'; }
  }

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      clearError();
      if (othersForm) othersForm.reset();
      const dateInput = document.getElementById('othersDateInput');
      if (dateInput) dateInput.value = todayDate();
      openModal(MODAL_ID);
    });
  }

  if (othersForm) {
    othersForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError();

      const description = document.getElementById('othersDescriptionInput').value.trim();
      const amount = parseFloat(document.getElementById('othersAmountInput').value);
      const collection_date = document.getElementById('othersDateInput').value;
      const note = document.getElementById('othersNoteInput').value.trim();

      if (!description) { showError('Please enter a description for Others income.'); return; }
      if (isNaN(amount) || amount <= 0) { showError('Please enter a valid amount.'); return; }

      try {
        const res = await api.post('/others-income', { description, amount, collection_date, note });
        if (res && res.success) {
          showToast(res.message || 'Others income recorded successfully!', 'success');
          closeModal(MODAL_ID);
          othersForm.reset();
          await loadPayments();
        } else {
          showError((res && res.error) || 'Failed to record Others income.');
        }
      } catch (err) {
        console.error('Others income error:', err);
        showError(err.message || 'Failed to record Others income.');
      }
    });
  }
});

async function lookupStudents(autoSelectIfSingle = false) {
  const input = document.getElementById('modal-pay-student-input');
  const filterClass = document.getElementById('modal-pay-filter-class');
  const suggestionsBox = document.getElementById('modal-pay-student-suggestions');
  const monthSelect = document.getElementById('modal-pay-month-select');

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
      selectStudentForPayment(res.exactMatch);
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      return;
    }

    if (autoSelectIfSingle && students.length === 1) {
      selectStudentForPayment(students[0]);
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

    // Render suggestions
    if (suggestionsBox) {
      suggestionsBox.innerHTML = students.map(s => `
        <div class="student-suggestion-item" 
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

      suggestionsBox.querySelectorAll('.student-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          const stId = parseInt(item.dataset.id, 10);
          const st = students.find(x => x.id === stId);
          if (st) {
            selectStudentForPayment(st);
            suggestionsBox.style.display = 'none';
          }
        });
      });

      suggestionsBox.style.display = 'block';
    }
  } catch (err) {
    console.error('Error looking up student:', err);
  }
}

function selectStudentForPayment(student) {
  selectedPaymentStudent = student;

  // Set hidden input
  const hiddenId = document.getElementById('modal-pay-student-id');
  if (hiddenId) hiddenId.value = student.id;

  // Set Amount to student's class fee
  const amountInput = document.getElementById('modal-pay-amount');
  if (amountInput) amountInput.value = student.monthly_fee || 1000;

  // Render Verified Card
  const verifiedCard = document.getElementById('modal-pay-verified-student');
  const avatar = document.getElementById('modal-verified-avatar');
  const nameEl = document.getElementById('modal-verified-name');
  const classEl = document.getElementById('modal-verified-class');
  const rollEl = document.getElementById('modal-verified-roll');
  const phoneEl = document.getElementById('modal-verified-phone');
  const fatherEl = document.getElementById('modal-verified-father');
  const feeEl = document.getElementById('modal-verified-fee');
  const promptEl = document.getElementById('modal-pay-search-prompt');

  if (avatar) avatar.textContent = student.name.substring(0, 2).toUpperCase();
  if (nameEl) nameEl.textContent = student.name;
  if (classEl) classEl.textContent = student.class_name;
  if (rollEl) rollEl.textContent = `Roll #${student.roll_number} (ID: #${student.id})`;
  if (phoneEl) phoneEl.textContent = student.phone || 'No phone';
  if (fatherEl) fatherEl.textContent = `Father: ${student.father_name || 'N/A'}`;
  if (feeEl) feeEl.textContent = `৳${student.monthly_fee}/mo`;

  if (verifiedCard) verifiedCard.style.display = 'block';
  if (promptEl) promptEl.style.display = 'none';

  // Update Status Banner for selected month
  const monthSelect = document.getElementById('modal-pay-month-select');
  updatePaymentStatusBanner(student, monthSelect ? monthSelect.value : getCurrentMonthName());

  // Enable Step 2 & Submit Button
  const step2 = document.getElementById('modal-payment-details-section');
  const submitBtn = document.getElementById('btn-submit-fee-payment');
  if (step2) {
    step2.style.opacity = '1';
    step2.style.pointerEvents = 'auto';
  }
  if (submitBtn) {
    submitBtn.disabled = false;
  }
}

async function updatePaymentStatusBanner(student, month) {
  const banner = document.getElementById('modal-verified-status-banner');
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

function resetPaymentModal() {
  selectedPaymentStudent = null;
  const input = document.getElementById('modal-pay-student-input');
  const hiddenId = document.getElementById('modal-pay-student-id');
  const verifiedCard = document.getElementById('modal-pay-verified-student');
  const suggestionsBox = document.getElementById('modal-pay-student-suggestions');
  const promptEl = document.getElementById('modal-pay-search-prompt');
  const step2 = document.getElementById('modal-payment-details-section');
  const submitBtn = document.getElementById('btn-submit-fee-payment');
  const form = document.getElementById('form-modal-record-payment');

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

async function loadStudentsForModal() {
  // Maintained for backward compatibility, reset state
  resetPaymentModal();
}

function printReceiptDirect(id) {
  const p = paymentsList.find(item => item.id === id);
  if (p) {
    openPrintReceiptModal(p);
  }
}

async function deletePaymentRecord(id, receiptNo) {
  if (!confirm(`Are you sure you want to delete payment receipt #${receiptNo}? This will revert this student's monthly fee to Due.`)) {
    return;
  }
  try {
    const res = await api.delete(`/payments/${id}`);
    showToast(res.message || 'Payment voucher deleted successfully', 'success');
    await loadPayments();
  } catch (err) {
    showToast('Failed to delete payment: ' + err.message, 'error');
  }
}

function exportPaymentsToExcel() {
  if (!paymentsList || paymentsList.length === 0) {
    showToast('No payments to export', 'error');
    return;
  }

  const headers = ['Receipt No', 'Date', 'Time', 'Roll', 'Student Name', 'Phone', 'Class', 'Billing Month', 'Amount', 'Payment Mode', 'Remarks'];
  const csvRows = [headers.join(',')];

  paymentsList.forEach(p => {
    const row = [
      p.receipt_no,
      p.payment_date,
      p.payment_time,
      p.roll_number,
      `"${p.student_name.replace(/"/g, '""')}"`,
      `"${p.student_phone}"`,
      `"${p.class_name}"`,
      `"${p.month} ${p.year}"`,
      p.amount,
      p.payment_method,
      `"${(p.note || '').replace(/"/g, '""')}"`
    ];
    csvRows.push(row.join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const todayIso = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  link.download = `payments-ledger-2026-${todayIso}.csv`;
  link.click();
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}