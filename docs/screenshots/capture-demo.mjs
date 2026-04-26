import { chromium } from 'playwright';

const baseUrl = 'http://127.0.0.1:5173';
const shots = new URL('.', import.meta.url).pathname;

function setStatus(document, id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  const icon = { idle: '○', pending: '⏳', success: '✅', error: '❌' }[kind] ?? '○';
  el.innerHTML = `<span class="status-badge ${kind}">${icon} ${text}</span>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 }, colorScheme: 'dark' });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${shots}step-1-connect.png`, fullPage: true });

  await page.evaluate(() => {
    setStatus(document, 'wallet-status', 'Connected: 0x7B35...72c0', 'success');
    setStatus(document, 'vc-status', 'Credential issued (expires 26/04/2027)', 'success');
    const birthDate = document.getElementById('birth-date');
    if (birthDate) birthDate.value = '1986-06-28';
    const proofLog = document.getElementById('proof-log');
    if (proofLog) {
      proofLog.style.display = 'block';
      proofLog.innerHTML = [
        '[15:20:32] Random secret generated (stays in browser)',
        '[15:20:32] Commitment: 5037504754449248...',
        '[15:20:32] Issuer signature received',
        '[15:20:55] Computing ZK proof (browser Wasm)...',
        '[15:20:56] ZK proof generated successfully!'
      ].map((line) => `<div class="entry info">${line}</div>`).join('');
    }
    setStatus(document, 'proof-status', 'Proof ready ✓', 'success');
    const submitButton = document.getElementById('btn-submit-proof');
    if (submitButton) submitButton.disabled = false;
  });
  await page.screenshot({ path: `${shots}step-2-proof.png`, fullPage: true });

  await page.evaluate(() => {
    const banner = document.getElementById('verified-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = '✅ Age verified on-chain! No birth date was revealed.';
    }
    const submitLog = document.getElementById('submit-log');
    if (submitLog) {
      submitLog.style.display = 'block';
      submitLog.innerHTML = [
        '[15:21:02] Sending transaction to AgeRegistry...',
        '[15:21:25] Transaction confirmed: 0x435a83325b6e8c07a3cd07f4da1460b4ce7270baea8961e4e6258a4a8c2ee8e0'
      ].map((line) => `<div class="entry ok">${line}</div>`).join('');
    }
    setStatus(document, 'submit-status', 'Age verified on-chain! 🎉', 'success');
  });
  await page.screenshot({ path: `${shots}step-3-verified.png`, fullPage: true });

  await browser.close();
})();
