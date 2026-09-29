// Expenses Ledger & Category Management Frontend Logic
let expensesList = [];
let categoriesList = [];
let selectedCategoryId = '';

document.addEventListener('DOMContentLoaded', async () => {
  await loadCategories();
  await loadExpenses();
  setupEventListeners();
});

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

async function loadCategories() {
  try {
    const res = await api.get('/expenses/categories');
    categoriesList = sortCategoriesWithOtherLast(res.data);

    // Filter dropdown
    const filterSel = document.getElementById('expense-filter-cat');
    if (filterSel) {
      filterSel.innerHTML = `
        <option value="">All Categories</option>
        ${categoriesList.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      `;
    }

    // Modal category dropdown
    const modalSel = document.getElementById('modal-expense-cat');
    if (modalSel) {
      modalSel.innerHTML = categoriesList.map(c => `
        <option value="${c.id}">${c.name}</option>
      `).join('');
    }

    renderCategoryChips();
  } catch (err) {
    console.error(err);
  }
}

function renderCategoryChips() {
  const container = document.getElementById('category-chips-container');
  if (!container) return;

  container.innerHTML = `
    <button class="category-chip ${selectedCategoryId === '' ? 'active' : ''}" onclick="selectCategoryChip('')">
      All Categories
    </button>
    ${categoriesList.map(c => `
      <button class="category-chip ${selectedCategoryId == c.id ? 'active' : ''}" onclick="selectCategoryChip(${c.id})">
        ${c.name}
      </button>
    `).join('')}
  `;
}

function selectCategoryChip(id) {
  selectedCategoryId = id;
  const filterSel = document.getElementById('expense-filter-cat');
  if (filterSel) {
    filterSel.value = id;
  }
  renderCategoryChips();
  loadExpenses();
}

async function loadExpenses() {
  const search = document.getElementById('expense-filter-search').value.trim();
  const catId = document.getElementById('expense-filter-cat').value;
  const startDate = document.getElementById('expense-filter-start').value;
  const endDate = document.getElementById('expense-filter-end').value;

  try {
    const res = await api.get('/expenses', {
      search,
      category_id: catId,
      startDate,
      endDate
    });

    expensesList = res.data;
    renderKPIs(expensesList);
    renderExpensesTable(expensesList);
  } catch (err) {
    showToast('Failed to load expenses: ' + err.message, 'error');
  }
}

function renderKPIs(expenses) {
  let total = 0;
  const catMap = {};

  expenses.forEach(e => {
    total += e.amount;
    catMap[e.category_name] = (catMap[e.category_name] || 0) + e.amount;
  });

  let topCat = 'None';
  let topCatAmount = 0;
  Object.keys(catMap).forEach(cat => {
    if (catMap[cat] > topCatAmount) {
      topCatAmount = catMap[cat];
      topCat = cat;
    }
  });

  const avg = expenses.length > 0 ? (total / expenses.length) : 0;

  document.getElementById('stat-total-expenses').textContent = formatCurrency(total);
  document.getElementById('stat-expense-count').textContent = `${expenses.length} Vouchers`;
  document.getElementById('stat-top-category').textContent = topCat;
  document.getElementById('stat-top-cat-amount').textContent = `${formatCurrency(topCatAmount)} recorded`;
  document.getElementById('stat-avg-expense').textContent = formatCurrency(avg);
}

function renderExpensesTable(expenses) {
  const tbody = document.getElementById('expenses-tbody');
  if (!tbody) return;

  if (expenses.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 2.5rem;">No expense vouchers found.</td></tr>`;
    return;
  }

  tbody.innerHTML = expenses.map(e => `
    <tr>
      <td style="font-weight: 700; color: #004ac6; white-space: nowrap;">${e.voucher_no || ('EXP-' + String(e.id).padStart(4, '0'))}</td>
      <td style="white-space: nowrap;">${e.expense_date}</td>
      <td>
        <span class="badge-tag" style="background: #f1f5f9; color: #334155; font-weight: 600;">
          ${e.category_name}
        </span>
      </td>
      <td style="font-weight: 500; color: #1e293b;">${e.description}</td>
      <td style="font-weight: 700; color: #dc2626; white-space: nowrap;">${formatCurrency(e.amount)}</td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-secondary btn-sm" style="margin-right: 4px;" title="Print Voucher / Receipt" onclick="printExpenseReceiptDirect(${e.id})">
          <span class="material-symbols-outlined" style="font-size: 1rem;">receipt_long</span>
          Receipt
        </button>
        <button class="btn btn-secondary btn-sm" style="color: #dc2626; padding: 0.25rem 0.45rem;" title="Delete Voucher" onclick="deleteExpenseVoucher(${e.id})">
          <span class="material-symbols-outlined" style="font-size: 1rem;">delete</span>
        </button>
      </td>
    </tr>
  `).join('');
}

function printExpenseReceiptDirect(id) {
  const expense = expensesList.find(e => e.id === id);
  if (expense) {
    openPrintExpenseReceiptModal(expense);
  } else {
    api.get(`/expenses/${id}`).then(res => {
      openPrintExpenseReceiptModal(res.data);
    }).catch(err => {
      showToast('Could not load expense receipt: ' + err.message, 'error');
    });
  }
}

function setupEventListeners() {
  document.getElementById('expense-filter-search').addEventListener('input', debounce(loadExpenses, 300));
  document.getElementById('expense-filter-cat').addEventListener('change', (e) => {
    selectedCategoryId = e.target.value;
    renderCategoryChips();
    loadExpenses();
  });
  document.getElementById('expense-filter-start').addEventListener('change', loadExpenses);
  document.getElementById('expense-filter-end').addEventListener('change', loadExpenses);

  // Form Add Expense
  const formExp = document.getElementById('form-modal-add-expense');
  if (formExp) {
    formExp.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        const res = await api.post('/expenses', {
          category_id: form.category_id.value,
          amount: form.amount.value,
          description: form.description.value,
          expense_date: form.expense_date.value || ((typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA'))
        });
        showToast('Expense voucher recorded successfully', 'success');
        closeModal('modal-add-expense-dialog');
        form.reset();
        await loadExpenses();
        if (res && res.data) {
          openPrintExpenseReceiptModal(res.data);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Form Add Category
  const formCat = document.getElementById('form-modal-add-category');
  if (formCat) {
    formCat.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        await api.post('/expenses/categories', {
          name: form.category_name.value
        });
        showToast('New expense category added', 'success');
        closeModal('modal-add-category-dialog');
        form.reset();
        await loadCategories();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

async function deleteExpenseVoucher(id) {
  if (!confirm('Are you sure you want to delete this expense voucher? This action is permanent.')) return;
  try {
    await api.delete(`/expenses/${id}`);
    showToast('Expense voucher deleted', 'success');
    await loadExpenses();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportExpensesToExcel() {
  if (!expensesList || expensesList.length === 0) {
    showToast('No expenses to export', 'error');
    return;
  }

  const headers = ['Voucher ID', 'Date', 'Category', 'Description', 'Amount (BDT)'];
  const csvRows = [headers.join(',')];

  expensesList.forEach(e => {
    const row = [
      `"EXP-${String(e.id).padStart(4, '0')}"`,
      e.expense_date,
      `"${e.category_name.replace(/"/g, '""')}"`,
      `"${e.description.replace(/"/g, '""')}"`,
      e.amount
    ];
    csvRows.push(row.join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const todayIso = (typeof getLocalIsoDate === 'function') ? getLocalIsoDate() : new Date().toLocaleDateString('en-CA');
  link.download = `expenses-ledger-2026-${todayIso}.csv`;
  link.click();
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}
