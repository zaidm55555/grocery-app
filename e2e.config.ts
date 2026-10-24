import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';

const phone = mobile({ platform: 'android' });

export default {
  targets: [
    {
      engine: phone,
      // BasketBuddy runs inside Expo Go; Metro is already serving on 8081.
      app: { bundleId: 'host.exp.exponent' },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
