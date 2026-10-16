// Command implementations. Each one receives input that already passed its strict schema.
import { app } from 'electron';

import { PRODUCT_NAME } from '../../shared/constants/app-identity';
import type { CommandHandlers } from './router';

export function createCommandHandlers(): CommandHandlers {
  return {
    'app.getInfo': () => ({
      productName: PRODUCT_NAME,
      version: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
  };
}
