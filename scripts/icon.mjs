import { chromium } from '@playwright/test';
import fs from 'node:fs';
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    '<body style="margin:0">' + fs.readFileSync('plugins/nexo/assets/icon.svg', 'utf8'),
  );
  await page.screenshot({ path: 'plugins/nexo/assets/icon.png', omitBackground: true });
} finally {
  await browser.close();
}
