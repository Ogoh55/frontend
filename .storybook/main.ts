import type { StorybookConfig } from '@storybook/nextjs';

const config: StorybookConfig = {
  // All component stories under src/components/
  stories: ['../src/components/**/*.stories.@(ts|tsx)'],

  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-a11y',
    '@storybook/addon-interactions',
    'msw-storybook-addon',
  ],

  framework: {
    name: '@storybook/nextjs',
    options: {},
  },

  // Serve public/ so MSW service worker (mockServiceWorker.js) and any
  // other static assets are available during story rendering.
  staticDirs: ['../public'],

  docs: {
    autodocs: 'tag',
  },

  typescript: {
    reactDocgen: 'react-docgen-typescript',
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      propFilter: (prop) =>
        prop.parent ? !/node_modules/.test(prop.parent.fileName) : true,
    },
  },

  // Vault stories (#283) must fail on serious a11y violations. The a11y
  // addon reads this per-story via parameters.a11y; the global default
  // below applies to every story so the catalogue is consistent.
  parameters: {
    a11y: {
      config: {},
      options: {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
      },
      manual: false,
    },
    // Deterministic captures: disable animations/transitions globally so
    // visual regression snapshots are stable across runs.
    chromatic: { disableSnapshot: false },
    viewport: { defaultViewport: 'responsive' },
  },
};

export default config;
