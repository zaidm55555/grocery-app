import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('demo mode: search, add to basket, export to Swiggy', async ({ app, device, screen }) => {
  await app.open();
  await device.openLink('exp://10.0.2.2:8081');
  await expect(screen.getByText('Compare', { exact: true })).toBeVisible({ timeout: 90000 });

  await screen.getByText('Milk', { exact: true }).tap();
  await expect(screen.getByText('Live Results for', { exact: false })).toBeVisible({ timeout: 90000 });
  await screen.getByText('options', { exact: false }).first().tap();
  await screen.getByText('ADD', { exact: false }).last().tap();
  // The match dialog only shows when the other store has a candidate.
  await new Promise((r) => setTimeout(r, 6000));
  if ((await screen.getByText('Confirm the matches', { exact: false }).count()) > 0) {
    await screen.getByText('Confirm', { exact: false }).last().tap();
  }
  console.log('shot', await app.screenshot('added'));

  await screen.getByText('Basket', { exact: true }).last().tap();
  await expect(screen.getByText('Optimized Basket Comparison', { exact: false })).toBeVisible({ timeout: 60000 });
  console.log('shot', await app.screenshot('basket'));
  const exportBtn = screen.getByText('Export Basket to Instamart', { exact: false });
  await screen.scrollUntilVisible(exportBtn, { timeout: 30000 });
  await exportBtn.tap();
  await new Promise((r) => setTimeout(r, 25000));
  console.log('shot', await app.screenshot('after-export-2'));
});
