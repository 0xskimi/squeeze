import QRCode from 'qrcode';
import { SOLANA_USDC_ADDRESS, USDC_MINT } from './config';
import { haptic } from './haptics';

function usdcPaymentUri(address: string): string {
  return `solana:${address}?spl-token=${USDC_MINT}`;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function initUsdcTip() {
  const trigger = document.getElementById('tip-trigger') as HTMLButtonElement | null;
  const popover = document.getElementById('tip-popover') as HTMLDivElement | null;
  const qr = document.getElementById('tip-qr') as HTMLCanvasElement | null;
  const addressEl = document.getElementById('tip-address') as HTMLParagraphElement | null;
  const copyBtn = document.getElementById('tip-copy') as HTMLButtonElement | null;

  if (!SOLANA_USDC_ADDRESS || !trigger || !popover || !qr || !addressEl || !copyBtn) {
    trigger?.remove();
    popover?.remove();
    return;
  }

  addressEl.textContent = shortenAddress(SOLANA_USDC_ADDRESS);
  addressEl.title = SOLANA_USDC_ADDRESS;

  void QRCode.toCanvas(qr, usdcPaymentUri(SOLANA_USDC_ADDRESS), {
    width: 112,
    margin: 1,
    color: {
      dark: '#1a1a1a',
      light: '#ffffff',
    },
  });

  const close = () => {
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    haptic('light');
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover.hidden) open();
    else close();
  });

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(SOLANA_USDC_ADDRESS);
    haptic('success');
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    window.setTimeout(() => {
      copyBtn.textContent = original;
    }, 1400);
  });

  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target as Node) && e.target !== trigger) {
      close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
