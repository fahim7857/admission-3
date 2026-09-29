document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('application-form');
  const message = document.getElementById('application-message');

  function showMessage(text, type = 'error') {
    message.textContent = text;
    message.className = `auth-message visible ${type}`;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    showMessage('Creating account…', 'success');

    try {
      const fd = new FormData(form);
      await window.auth.signUpStaff({
        full_name: String(fd.get('full_name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
        notes: String(fd.get('notes') || '').trim()
      });
      form.reset();
      showMessage('Account created. You can log in once a Super Admin approves you.', 'success');
    } catch (error) {
      showMessage(error.message || 'Unable to create account.');
    } finally {
      submitButton.disabled = false;
    }
  });
});