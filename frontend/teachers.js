document.addEventListener('DOMContentLoaded', () => {
  // Central API client
  const apiClient = window.api || (typeof api !== 'undefined' ? api : null);

  // State
  let teachersList = [];
  let paymentsList = [];
  let selectedTeacherForDetail = null;
  let currentSelectedMonth = '';

  // DOM Elements - Tables & Badges
  const teachersTableBody = document.getElementById('teachersTableBody');
  const monthlyPaymentsTableBody = document.getElementById('monthlyPaymentsTableBody');
  const paymentHistoryTableBody = document.getElementById('paymentHistoryTableBody');
  const teacherCountBadge = document.getElementById('teacherCountBadge');

  // DOM Elements - Top KPIs
  const kpiTotalTeachers = document.getElementById('kpiTotalTeachers');
  const kpiTotalPayable = document.getElementById('kpiTotalPayable');
  const kpiTodayPayment = document.getElementById('kpiTodayPayment');
  const kpiMonthPayment = document.getElementById('kpiMonthPayment');
  const kpiMonthlyTitle = document.getElementById('kpiMonthlyTitle');
  const kpiMonthSub = document.getElementById('kpiMonthSub');

  // DOM Elements - Payment Summary Strip
  const summaryTodayPayment = document.getElementById('summaryTodayPayment');
  const summaryMonthLabel = document.getElementById('summaryMonthLabel');
  const summaryMonthPayment = document.getElementById('summaryMonthPayment');
  const summaryOverallPayment = document.getElementById('summaryOverallPayment');
  const footMonthName = document.getElementById('footMonthName');
  const footMonthTotal = document.getElementById('footMonthTotal');

  // DOM Elements - Filters & Inputs
  const teacherSearchInput = document.getElementById('teacherSearchInput');
  const paymentMonthFilter = document.getElementById('paymentMonthFilter');
  const paymentTeacherFilter = document.getElementById('paymentTeacherFilter');
  const activityTeacherSelect = document.getElementById('activityTeacherSelect');
  const globalSearchInput = document.getElementById('globalSearchInput');

  // Modals
  const teacherModal = document.getElementById('teacherModal');
  const activityModal = document.getElementById('activityModal');
  const teacherDetailModal = document.getElementById('teacherDetailModal');

  // Date Helpers
  function getTodayDhakaDate() {
    if (typeof window.getLocalIsoDate === 'function') {
      return window.getLocalIsoDate();
    }
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  }

  const todayStr = getTodayDhakaDate();
  const activityDateInput = document.getElementById('activityDateInput');
  if (activityDateInput) activityDateInput.value = todayStr;

  const topbarDate = document.getElementById('topbarDate');
  if (topbarDate) {
    const d = new Date();
    const options = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka' };
    topbarDate.textContent = d.toLocaleDateString('en-GB', options);
  }

  // Modal Helpers
  function showModal(id) {
    if (typeof window.openModal === 'function') {
      window.openModal(id);
    } else {
      const m = document.getElementById(id);
      if (m) {
        m.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
    }
  }

  function hideModal(id) {
    if (typeof window.closeModal === 'function') {
      window.closeModal(id);
    } else {
      const m = document.getElementById(id);
      if (m) {
        m.classList.remove('open');
        document.body.style.overflow = '';
      }
    }
  }

  // Close modals on backdrop click
  [teacherModal, activityModal, teacherDetailModal].forEach(modalEl => {
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          hideModal(modalEl.id);
        }
      });
    }
  });

  // Notification helper
  function notify(message, type = 'success') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else if (typeof showToast === 'function') {
      showToast(message, type);
    } else {
      alert(message);
    }
  }

  function showFormError(errorElementId, msg) {
    const el = document.getElementById(errorElementId);
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }

  function clearFormError(errorElementId) {
    const el = document.getElementById(errorElementId);
    if (el) {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  // Navigation tabs switching
  document.querySelectorAll('.teachers-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.teachers-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.style.display = 'block';
      }
    });
  });

  // Modal Open/Close Buttons
  const openAddTeacherModalBtn = document.getElementById('openAddTeacherModalBtn');
  if (openAddTeacherModalBtn) {
    openAddTeacherModalBtn.addEventListener('click', () => openTeacherModal());
  }

  const closeTeacherModalBtn = document.getElementById('closeTeacherModalBtn');
  if (closeTeacherModalBtn) {
    closeTeacherModalBtn.addEventListener('click', () => hideModal('teacherModal'));
  }

  const cancelTeacherModalBtn = document.getElementById('cancelTeacherModalBtn');
  if (cancelTeacherModalBtn) {
    cancelTeacherModalBtn.addEventListener('click', () => hideModal('teacherModal'));
  }

  const openActivityModalBtn = document.getElementById('openActivityModalBtn');
  if (openActivityModalBtn) {
    openActivityModalBtn.addEventListener('click', () => openActivityModal());
  }

  const closeActivityModalBtn = document.getElementById('closeActivityModalBtn');
  if (closeActivityModalBtn) {
    closeActivityModalBtn.addEventListener('click', () => hideModal('activityModal'));
  }

  const cancelActivityModalBtn = document.getElementById('cancelActivityModalBtn');
  if (cancelActivityModalBtn) {
    cancelActivityModalBtn.addEventListener('click', () => hideModal('activityModal'));
  }

  const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
  if (closeDetailModalBtn) {
    closeDetailModalBtn.addEventListener('click', () => hideModal('teacherDetailModal'));
  }

  const closeDetailBtn = document.getElementById('closeDetailBtn');
  if (closeDetailBtn) {
    closeDetailBtn.addEventListener('click', () => hideModal('teacherDetailModal'));
  }

  // Form Submissions
  const teacherForm = document.getElementById('teacherForm');
  if (teacherForm) {
    teacherForm.addEventListener('submit', handleSaveTeacher);
  }

  const activityForm = document.getElementById('activityForm');
  if (activityForm) {
    activityForm.addEventListener('submit', handleSaveActivity);
  }

  // Live calculation preview in activity modal
  ['classesTakenInput', 'khatasCheckedInput', 'guardDutiesInput', 'activityTeacherSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateActivityPreview);
      el.addEventListener('change', updateActivityPreview);
    }
  });

  // Filter events
  if (teacherSearchInput) {
    teacherSearchInput.addEventListener('input', renderTeachersList);
  }

  if (globalSearchInput) {
    globalSearchInput.addEventListener('input', (e) => {
      if (teacherSearchInput) {
        teacherSearchInput.value = e.target.value;
      }
      renderTeachersList();
    });
  }

  if (paymentMonthFilter) {
    paymentMonthFilter.addEventListener('change', (e) => {
      const selectedMonth = e.target.value;
      if (selectedMonth) {
        loadPaymentSummary(selectedMonth);
      }
    });
  }

  if (paymentTeacherFilter) {
    paymentTeacherFilter.addEventListener('change', renderPaymentHistory);
  }

  const payTeacherBtn = document.getElementById('payTeacherBtn');
  if (payTeacherBtn) {
    payTeacherBtn.addEventListener('click', handlePayTeacherFromDetailModal);
  }

  // Initial load
  loadAllData();

  // ====================================================
  // DATA LOADING FUNCTIONS
  // ====================================================

  async function loadAllData() {
    try {
      const [tRes, pRes] = await Promise.all([
        apiClient.get('/teachers'),
        apiClient.get('/teacher-payments')
      ]);

      if (tRes && tRes.success) teachersList = tRes.data || [];
      if (pRes && pRes.success) paymentsList = pRes.data || [];

      populateTeacherDropdowns();
      renderTeachersList();
      renderPaymentHistory();

      // Load summaries concurrently
      await Promise.all([
        loadDashboardSummary(),
        loadPaymentSummary(currentSelectedMonth)
      ]);
    } catch (error) {
      console.error('Failed to load teacher data:', error);
      notify('Unable to load teachers: ' + (error.message || 'Check database connection'), 'error');
    }
  }

  async function loadDashboardSummary() {
    try {
      const res = await apiClient.get('/teachers/dashboard-summary');
      if (res && res.success) {
        const d = res.data;
        if (kpiTotalTeachers) kpiTotalTeachers.textContent = d.totalTeachers || 0;
        if (kpiTotalPayable) kpiTotalPayable.textContent = `৳${(d.totalPayable || 0).toLocaleString()}`;
        if (teacherCountBadge) teacherCountBadge.textContent = `${d.totalTeachers || 0} Teachers`;
      }
    } catch (e) {
      console.warn('Dashboard summary error:', e);
    }
  }

  async function loadPaymentSummary(month = '') {
    try {
      const queryParam = month ? `?month=${encodeURIComponent(month)}` : '';
      const res = await apiClient.get(`/teachers/payment-summary${queryParam}`);

      if (!res || !res.success || !res.data) return;
      const d = res.data;
      currentSelectedMonth = d.selectedMonth;

      // Update KPI Cards
      if (kpiTodayPayment) kpiTodayPayment.textContent = `৳${(d.todayPaid || 0).toLocaleString()}`;
      if (kpiMonthPayment) kpiMonthPayment.textContent = `৳${(d.monthPaid || 0).toLocaleString()}`;
      if (kpiMonthlyTitle) kpiMonthlyTitle.textContent = `${d.selectedMonthName} Paid`;
      if (kpiMonthSub) kpiMonthSub.textContent = `Total paid in ${d.selectedMonthName}`;

      // Update Payment Summary Strip
      if (summaryTodayPayment) summaryTodayPayment.textContent = `৳${(d.todayPaid || 0).toLocaleString()}`;
      if (summaryMonthLabel) summaryMonthLabel.textContent = `${d.selectedMonthName} Total Paid`;
      if (summaryMonthPayment) summaryMonthPayment.textContent = `৳${(d.monthPaid || 0).toLocaleString()}`;
      if (summaryOverallPayment) summaryOverallPayment.textContent = `৳${(d.overallPaid || 0).toLocaleString()}`;

      // Update Month Selector dropdown
      if (paymentMonthFilter && d.availableMonths && d.availableMonths.length > 0) {
        const currentVal = paymentMonthFilter.value || d.selectedMonth;
        paymentMonthFilter.innerHTML = d.availableMonths.map(m => `
          <option value="${m.value}" ${m.value === currentVal ? 'selected' : ''}>${m.label}</option>
        `).join('');
      }

      // Update Monthly Teacher Breakdown Table
      renderMonthlyTeacherPaymentTable(d);
    } catch (e) {
      console.warn('Error loading teacher payment summary:', e);
    }
  }

  function renderMonthlyTeacherPaymentTable(d) {
    if (!monthlyPaymentsTableBody) return;

    if (footMonthName) footMonthName.textContent = d.selectedMonthName || 'Selected Month';
    if (footMonthTotal) footMonthTotal.textContent = `৳${(d.monthPaid || 0).toLocaleString()}`;

    if (!d.teachers || d.teachers.length === 0) {
      monthlyPaymentsTableBody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 1.75rem; color: #64748b;">
            No teacher payments recorded in <strong>${d.selectedMonthName}</strong>.
          </td>
        </tr>
      `;
      return;
    }

    monthlyPaymentsTableBody.innerHTML = d.teachers.map(t => `
      <tr>
        <td>
          <div style="font-weight: 700; color: #0f172a;">${t.teacher_name}</div>
        </td>
        <td style="color: #475569;">
          ${t.teacher_phone ? t.teacher_phone : '<span style="color: #94a3b8;">N/A</span>'}
        </td>
        <td style="text-align: center; font-weight: 600; color: #334155;">
          <span class="badge-tag" style="background: #f1f5f9; color: #334155; font-size: 0.74rem;">
            ${t.payment_count} ${t.payment_count === 1 ? 'Payment' : 'Payments'}
          </span>
        </td>
        <td style="text-align: right; font-weight: 700; color: #16a34a; font-size: 0.88rem;">
          ৳${(t.total_paid || 0).toLocaleString()}
        </td>
      </tr>
    `).join('');
  }

  function populateTeacherDropdowns() {
    const selects = [activityTeacherSelect, paymentTeacherFilter];
    selects.forEach(sel => {
      if (!sel) return;
      const currentVal = sel.value;
      const isFilter = sel === paymentTeacherFilter;

      sel.innerHTML = isFilter
        ? '<option value="">All Teachers</option>'
        : '<option value="">-- Choose Teacher --</option>';

      teachersList.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = isFilter
          ? t.name
          : `${t.name} (Cls: ৳${t.per_class_rate}, Khata: ৳${t.per_khata_rate}, Guard: ৳${t.per_guard_rate})`;
        sel.appendChild(opt);
      });

      sel.value = currentVal;
    });
  }

  // ====================================================
  // TEACHER LIST RENDERING (NO EDIT BUTTON)
  // ====================================================

  function renderTeachersList() {
    if (!teachersTableBody) return;

    const search = teacherSearchInput ? teacherSearchInput.value.toLowerCase().trim() : '';
    const filtered = teachersList.filter(t =>
      t.name.toLowerCase().includes(search) ||
      (t.phone && t.phone.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      teachersTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 2.25rem; color: #64748b;">
            ${teachersList.length === 0
              ? 'No teachers registered in the database yet. Click "Add New Teacher" above.'
              : 'No matching teachers found.'}
          </td>
        </tr>
      `;
      return;
    }

    teachersTableBody.innerHTML = filtered.map(t => {
      const payable = t.current_payable || 0;
      const hasPayable = payable > 0;

      return `
        <tr>
          <td>
            <div style="font-weight: 700; color: #0284c7; cursor: pointer;" class="view-teacher-ledger" data-id="${t.id}" title="Click to view work activity and payment history">
              ${t.name}
            </div>
          </td>
          <td style="color: #475569;">
            ${t.phone ? t.phone : '<span style="color: #94a3b8;">N/A</span>'}
          </td>
          <td>
            <div style="display: flex; gap: 0.35rem; flex-wrap: wrap;">
              <span class="rate-badge">Cls: <strong>৳${t.per_class_rate}</strong></span>
              <span class="rate-badge">Khata: <strong>৳${t.per_khata_rate}</strong></span>
              <span class="rate-badge">Guard: <strong>৳${t.per_guard_rate}</strong></span>
            </div>
          </td>
          <td>
            <span class="badge-tag" style="background: ${hasPayable ? '#fee2e2' : '#dcfce7'}; color: ${hasPayable ? '#dc2626' : '#15803d'}; font-weight: 700; font-size: 0.82rem; padding: 0.25rem 0.6rem;">
              ৳${payable.toLocaleString()}
            </span>
          </td>
          <td style="text-align: right;">
            <div class="action-btns" style="display: flex; gap: 0.35rem; justify-content: flex-end;">
              ${hasPayable ? `
                <button class="btn btn-sm btn-primary pay-direct-btn" data-id="${t.id}" title="Pay ৳${payable.toLocaleString()} to ${t.name}" style="background: #0284c7; border-color: #0284c7; font-weight: 600; padding: 0.25rem 0.65rem;">
                  Pay
                </button>
              ` : `
                <button class="btn btn-sm btn-secondary view-ledger-btn" data-id="${t.id}" title="View Ledger" style="padding: 0.25rem 0.60rem;">
                  Ledger
                </button>
              `}
              <button class="btn btn-sm btn-secondary delete-teacher-btn" data-id="${t.id}" title="Delete Teacher" style="color: #dc2626; border-color: #fecaca; padding: 0.25rem 0.60rem;">
                Delete
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Bind row action events
    teachersTableBody.querySelectorAll('.view-teacher-ledger, .view-ledger-btn').forEach(el => {
      el.addEventListener('click', () => openTeacherDetailModal(parseInt(el.getAttribute('data-id'), 10)));
    });

    teachersTableBody.querySelectorAll('.pay-direct-btn').forEach(el => {
      el.addEventListener('click', () => handleDirectPayTeacher(parseInt(el.getAttribute('data-id'), 10)));
    });

    teachersTableBody.querySelectorAll('.delete-teacher-btn').forEach(el => {
      el.addEventListener('click', () => handleDeleteTeacher(parseInt(el.getAttribute('data-id'), 10)));
    });
  }

  // ====================================================
  // PAYMENT HISTORY LOG RENDERING
  // ====================================================

  function renderPaymentHistory() {
    if (!paymentHistoryTableBody) return;

    const teacherIdFilter = paymentTeacherFilter ? paymentTeacherFilter.value : '';
    const filtered = paymentsList.filter(p => {
      if (teacherIdFilter && String(p.teacher_id) !== teacherIdFilter) return false;
      return true;
    });

    if (filtered.length === 0) {
      paymentHistoryTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 2rem; color: #64748b;">
            No cleared salary payment records found.
          </td>
        </tr>
      `;
      return;
    }

    paymentHistoryTableBody.innerHTML = filtered.map(p => `
      <tr>
        <td style="font-weight: 600; color: #334155;">${p.payment_date}</td>
        <td><strong style="color: #0f172a;">${p.teacher_name}</strong></td>
        <td style="color: #475569;">${p.teacher_phone || '<span style="color: #94a3b8;">N/A</span>'}</td>
        <td style="font-weight: 700; color: #16a34a;">৳${(p.amount || 0).toLocaleString()}</td>
        <td style="color: #475569; font-size: 0.78rem;">${p.note || 'Salary payment cleared'}</td>
      </tr>
    `).join('');
  }

  // ====================================================
  // ADD TEACHER (STRICTLY ADD ONLY - NO EDIT)
  // ====================================================

  function openTeacherModal() {
    clearFormError('teacherFormError');
    const title = document.getElementById('teacherModalTitle');
    const nameInput = document.getElementById('teacherNameInput');
    const phoneInput = document.getElementById('teacherPhoneInput');
    const pClassInput = document.getElementById('perClassRateInput');
    const pKhataInput = document.getElementById('perKhataRateInput');
    const pGuardInput = document.getElementById('perGuardRateInput');

    if (title) title.textContent = 'Add New Teacher';
    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (pClassInput) pClassInput.value = '100';
    if (pKhataInput) pKhataInput.value = '5';
    if (pGuardInput) pGuardInput.value = '150';

    showModal('teacherModal');
    if (nameInput) setTimeout(() => nameInput.focus(), 60);
  }

  async function handleSaveTeacher(e) {
    e.preventDefault();
    clearFormError('teacherFormError');

    const name = document.getElementById('teacherNameInput').value.trim();
    const phone = document.getElementById('teacherPhoneInput').value.trim();
    const pClass = parseFloat(document.getElementById('perClassRateInput').value);
    const pKhata = parseFloat(document.getElementById('perKhataRateInput').value);
    const pGuard = parseFloat(document.getElementById('perGuardRateInput').value);

    // Validation
    if (!name) {
      showFormError('teacherFormError', 'Please enter teacher name.');
      document.getElementById('teacherNameInput').focus();
      return;
    }

    if (isNaN(pClass) || pClass < 0) {
      showFormError('teacherFormError', 'Please enter a valid per-class rate (0 or higher).');
      document.getElementById('perClassRateInput').focus();
      return;
    }
    if (isNaN(pKhata) || pKhata < 0) {
      showFormError('teacherFormError', 'Please enter a valid per-khata rate (0 or higher).');
      document.getElementById('perKhataRateInput').focus();
      return;
    }
    if (isNaN(pGuard) || pGuard < 0) {
      showFormError('teacherFormError', 'Please enter a valid per-guard rate (0 or higher).');
      document.getElementById('perGuardRateInput').focus();
      return;
    }

    const payload = {
      name,
      phone,
      per_class_rate: pClass,
      per_khata_rate: pKhata,
      per_guard_rate: pGuard
    };

    const saveBtn = document.getElementById('saveTeacherBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    try {
      const res = await apiClient.post('/teachers', payload);
      if (res && res.success) {
        hideModal('teacherModal');
        notify(`Teacher "${name}" added successfully!`, 'success');
        await loadAllData();
      } else {
        showFormError('teacherFormError', (res && res.error) || 'Failed to save teacher');
      }
    } catch (err) {
      console.error('Error saving teacher:', err);
      showFormError('teacherFormError', err.message || 'Unable to add teacher. Please check database connection.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Teacher';
      }
    }
  }

  // ====================================================
  // DELETE TEACHER
  // ====================================================

  async function handleDeleteTeacher(id) {
    const t = teachersList.find(x => x.id === id);
    if (!t) return;

    const confirmMsg =
      `Are you sure you want to delete teacher "${t.name}"?\n\n` +
      `This will remove the teacher and their associated work and payment records.\n` +
      `Student, fee, and institutional expense records will NOT be deleted.\n\n` +
      `Click OK to proceed with deletion.`;

    if (!confirm(confirmMsg)) return;

    try {
      const res = await apiClient.delete(`/teachers/${id}`);
      if (res && res.success) {
        notify(`Teacher "${t.name}" deleted successfully.`, 'success');
        await loadAllData();
      } else {
        notify((res && res.error) || 'Failed to delete teacher', 'error');
      }
    } catch (e) {
      console.error('Delete error:', e);
      notify(e.message || 'Failed to delete teacher', 'error');
    }
  }

  // ====================================================
  // TEACHER PAYMENT & EXPENSE INTEGRATION
  // ====================================================

  async function handleDirectPayTeacher(teacherId) {
    const t = teachersList.find(x => x.id === idFromParam(teacherId));
    if (!t) return;

    const payable = t.current_payable || 0;
    if (payable <= 0) {
      notify(`Teacher ${t.name} has no outstanding payable balance.`, 'info');
      return;
    }

    const confirmMsg =
      `Confirm Salary Payment to ${t.name}\n\n` +
      `Amount: ৳${payable.toLocaleString()}\n\n` +
      `This will:\n` +
      `1. Record payment in ${t.name}'s payment history\n` +
      `2. Create an institutional expense under "Teacher Salary" with description: "Salary paid to ${t.name}"\n` +
      `3. Reset current payable to ৳0\n\n` +
      `Click OK to clear payment.`;

    if (!confirm(confirmMsg)) return;

    try {
      const res = await apiClient.post(`/teachers/${t.id}/pay`, {
        amount: payable,
        payment_date: getTodayDhakaDate(),
        note: `Salary paid to ${t.name}`
      });

      if (res && res.success) {
        notify(`Payment of ৳${payable.toLocaleString()} cleared for ${t.name}! Teacher Salary expense voucher created.`, 'success');
        await loadAllData();
      } else {
        notify((res && res.error) || 'Payment failed', 'error');
      }
    } catch (e) {
      console.error('Payment error:', e);
      notify(e.message || 'Payment processing error', 'error');
    }
  }

  function idFromParam(id) {
    return typeof id === 'number' ? id : parseInt(id, 10);
  }

  // ====================================================
  // RECORD DAILY WORK / ACTIVITY
  // ====================================================

  function openActivityModal() {
    clearFormError('activityFormError');
    const dateInput = document.getElementById('activityDateInput');
    const teacherSel = document.getElementById('activityTeacherSelect');
    const clsInput = document.getElementById('classesTakenInput');
    const khataInput = document.getElementById('khatasCheckedInput');
    const guardInput = document.getElementById('guardDutiesInput');

    if (dateInput) dateInput.value = todayStr;
    if (teacherSel && teacherSel.options.length > 1) {
      teacherSel.selectedIndex = 1;
    }
    if (clsInput) clsInput.value = '1';
    if (khataInput) khataInput.value = '0';
    if (guardInput) guardInput.value = '0';

    showModal('activityModal');
    updateActivityPreview();
  }

  function updateActivityPreview() {
    const teacherId = activityTeacherSelect ? activityTeacherSelect.value : '';
    const cls = parseInt(document.getElementById('classesTakenInput')?.value, 10) || 0;
    const khatas = parseInt(document.getElementById('khatasCheckedInput')?.value, 10) || 0;
    const guards = parseInt(document.getElementById('guardDutiesInput')?.value, 10) || 0;

    const teacher = teachersList.find(t => String(t.id) === String(teacherId));
    const pClass = teacher ? (teacher.per_class_rate || 0) : 0;
    const pKhata = teacher ? (teacher.per_khata_rate || 0) : 0;
    const pGuard = teacher ? (teacher.per_guard_rate || 0) : 0;

    const cAmt = cls * pClass;
    const kAmt = khatas * pKhata;
    const gAmt = guards * pGuard;
    const total = cAmt + kAmt + gAmt;

    const pClassEl = document.getElementById('previewClassCalc');
    const pKhataEl = document.getElementById('previewKhataCalc');
    const pGuardEl = document.getElementById('previewGuardCalc');
    const pTotalEl = document.getElementById('previewTotalCalc');

    if (pClassEl) pClassEl.textContent = `Classes: ${cls} × ৳${pClass} = ৳${cAmt.toLocaleString()}`;
    if (pKhataEl) pKhataEl.textContent = `Khatas: ${khatas} × ৳${pKhata} = ৳${kAmt.toLocaleString()}`;
    if (pGuardEl) pGuardEl.textContent = `Guards: ${guards} × ৳${pGuard} = ৳${gAmt.toLocaleString()}`;
    if (pTotalEl) pTotalEl.textContent = `Daily Total = ৳${total.toLocaleString()}`;
  }

  async function handleSaveActivity(e) {
    e.preventDefault();
    clearFormError('activityFormError');

    const teacherId = document.getElementById('activityTeacherSelect').value;
    const activityDate = document.getElementById('activityDateInput').value;
    const classesTaken = parseInt(document.getElementById('classesTakenInput').value, 10) || 0;
    const khatasChecked = parseInt(document.getElementById('khatasCheckedInput').value, 10) || 0;
    const guardDuties = parseInt(document.getElementById('guardDutiesInput').value, 10) || 0;

    if (!activityDate) {
      showFormError('activityFormError', 'Please choose an activity date.');
      return;
    }

    if (!teacherId) {
      showFormError('activityFormError', 'Please select a teacher.');
      return;
    }

    const payload = {
      teacher_id: teacherId,
      activity_date: activityDate,
      classes_taken: classesTaken,
      khatas_checked: khatasChecked,
      guard_duties: guardDuties
    };

    const saveBtn = document.getElementById('saveActivityBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    try {
      const res = await apiClient.post('/teacher-activities', payload);
      if (res && res.success) {
        hideModal('activityModal');
        notify('Daily activity recorded successfully!', 'success');
        await loadAllData();
      } else {
        showFormError('activityFormError', (res && res.error) || 'Failed to save activity');
      }
    } catch (err) {
      console.error('Error saving activity:', err);
      showFormError('activityFormError', err.message || 'Unable to save activity.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Activity';
      }
    }
  }

  // ====================================================
  // TEACHER DETAILED SUMMARY & LEDGER MODAL
  // ====================================================

  async function openTeacherDetailModal(teacherId) {
    try {
      const res = await apiClient.get(`/teachers/${teacherId}`);
      if (!res || !res.success) {
        notify((res && res.error) || 'Teacher not found', 'error');
        return;
      }
      selectedTeacherForDetail = res.data;
      const t = selectedTeacherForDetail;

      const dName = document.getElementById('detailTeacherName');
      const dWork = document.getElementById('detailWorkSummary');
      const dEarned = document.getElementById('detailTotalEarned');
      const dPayable = document.getElementById('detailCurrentPayable');

      if (dName) dName.textContent = `${t.name} • Ledger & Summary`;
      if (dWork) dWork.textContent = `${t.total_classes || 0} Cls | ${t.total_khatas || 0} Khatas | ${t.total_guards || 0} Guards`;
      if (dEarned) dEarned.textContent = `৳${(t.total_earned || 0).toLocaleString()}`;
      if (dPayable) dPayable.textContent = `৳${(t.current_payable || 0).toLocaleString()}`;

      const payBtn = document.getElementById('payTeacherBtn');
      const payLabel = document.getElementById('payBtnLabel');
      const payable = t.current_payable || 0;

      if (payable <= 0) {
        if (payLabel) payLabel.textContent = 'Pay Outstanding (৳0)';
        if (payBtn) {
          payBtn.setAttribute('disabled', 'true');
          payBtn.style.opacity = '0.5';
          payBtn.style.cursor = 'not-allowed';
        }
      } else {
        if (payLabel) payLabel.textContent = `Pay Outstanding (৳${payable.toLocaleString()})`;
        if (payBtn) {
          payBtn.removeAttribute('disabled');
          payBtn.style.opacity = '1';
          payBtn.style.cursor = 'pointer';
        }
      }

      // Populate recent activities in modal
      const actBody = document.getElementById('detailActivityHistoryBody');
      if (actBody) {
        if (!t.activities || t.activities.length === 0) {
          actBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 0.75rem; color: #64748b;">No activities recorded yet</td></tr>`;
        } else {
          actBody.innerHTML = t.activities.slice(0, 10).map(a => `
            <tr>
              <td>${a.activity_date}</td>
              <td>${a.classes_taken} (৳${a.per_class_rate})</td>
              <td>${a.khatas_checked} (৳${a.per_khata_rate})</td>
              <td>${a.guard_duties} (৳${a.per_guard_rate})</td>
              <td style="font-weight: 700; color: #0284c7;">৳${(a.daily_total || 0).toLocaleString()}</td>
            </tr>
          `).join('');
        }
      }

      // Populate payment history in modal
      const histBody = document.getElementById('detailPaymentHistoryBody');
      if (histBody) {
        if (!t.payments || t.payments.length === 0) {
          histBody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 0.75rem; color: #64748b;">No payment history recorded yet</td></tr>`;
        } else {
          histBody.innerHTML = t.payments.map(p => `
            <tr>
              <td style="font-weight: 500;">${p.payment_date}</td>
              <td style="font-weight: 700; color: #16a34a;">৳${(p.amount || 0).toLocaleString()}</td>
              <td style="color: #475569;">${p.note || 'Salary payment cleared'}</td>
            </tr>
          `).join('');
        }
      }

      showModal('teacherDetailModal');
    } catch (e) {
      console.error('Error opening teacher detail:', e);
      notify(e.message || 'Error loading teacher details', 'error');
    }
  }

  async function handlePayTeacherFromDetailModal() {
    if (!selectedTeacherForDetail) return;
    const t = selectedTeacherForDetail;
    const payable = t.current_payable || 0;

    if (payable <= 0) {
      notify('This teacher has no current payable balance (৳0).', 'info');
      return;
    }

    const confirmMsg =
      `Confirm Payment to ${t.name}\n\n` +
      `Amount: ৳${payable.toLocaleString()}\n\n` +
      `This will:\n` +
      `1. Record payment in ${t.name}'s payment history\n` +
      `2. Create an institutional expense under "Teacher Salary" with description: "Salary paid to ${t.name}"\n` +
      `3. Reset current payable balance to ৳0\n\n` +
      `Click OK to proceed.`;

    if (!confirm(confirmMsg)) return;

    const payBtn = document.getElementById('payTeacherBtn');
    if (payBtn) {
      payBtn.disabled = true;
      payBtn.textContent = 'Processing...';
    }

    try {
      const res = await apiClient.post(`/teachers/${t.id}/pay`, {
        amount: payable,
        payment_date: getTodayDhakaDate(),
        note: `Salary paid to ${t.name}`
      });

      if (res && res.success) {
        notify(`Payment of ৳${payable.toLocaleString()} cleared for ${t.name}! Teacher Salary expense voucher created.`, 'success');
        hideModal('teacherDetailModal');
        await loadAllData();
      } else {
        notify((res && res.error) || 'Payment failed', 'error');
      }
    } catch (e) {
      console.error('Payment error:', e);
      notify(e.message || 'Payment processing error', 'error');
    } finally {
      if (payBtn) payBtn.disabled = false;
    }
  }
});
