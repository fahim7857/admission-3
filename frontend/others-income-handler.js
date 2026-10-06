// Others Income Modal Handlers (self-contained replacement for the block in payment.js)
// Uses only things the shared frontend api.js already puts on window:
//   window.api, window.showToast, window.openModal, window.closeModal, window.getLocalIsoDate
// Everything else is defined locally, so it works wherever it is placed in payment.js.
document.addEventListener('DOMContentLoaded', () => {
    const openBtn = document.getElementById('openOthersIncomeModalBtn');
    const othersForm = document.getElementById('form-modal-others-income');
    const MODAL_ID = 'modal-others-income';
    const ERR_ID = 'othersIncomeFormError';

    function todayDate() {
        if (typeof window.getTodayDhakaDate === 'function') return window.getTodayDhakaDate();
        if (typeof window.getLocalIsoDate === 'function') return window.getLocalIsoDate();
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

    function toast(msg, type) {
        if (typeof window.showToast === 'function') window.showToast(msg, type);
        else alert(msg);
    }

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            clearError();
            if (othersForm) othersForm.reset();
            const dateInput = document.getElementById('othersDateInput');
            if (dateInput) dateInput.value = todayDate();
            window.openModal(MODAL_ID);
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
                const res = await window.api.post('/others-income', { description, amount, collection_date, note });
                if (res && res.success) {
                    toast(res.message || 'Others income recorded successfully!', 'success');
                    window.closeModal(MODAL_ID);
                    othersForm.reset();
                    // Refresh the payments list; fall back to a page reload if loadPayments is not reachable from here
                    if (typeof window.loadPayments === 'function') await window.loadPayments();
                    else if (typeof loadPayments === 'function') await loadPayments();
                    else window.location.reload();
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