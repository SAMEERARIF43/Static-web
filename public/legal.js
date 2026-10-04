document.addEventListener('DOMContentLoaded', async () => {
  const statuses = document.querySelectorAll('[data-email-status]');
  if (!statuses.length) return;

  try {
    const response = await fetch('/api/site-config');
    if (!response.ok) throw new Error(`Site settings request failed: ${response.status}`);
    const config = await response.json();

    statuses.forEach(status => {
      const address = config[`${status.dataset.emailStatus}Email`];
      const link = status.parentElement.querySelector('[data-email-link]');
      if (address && link) {
        link.href = `mailto:${address}`;
        link.textContent = address;
        link.hidden = false;
        status.hidden = true;
      }
    });
  } catch (error) {
    console.error('Could not load contact settings:', error);
  }
});
