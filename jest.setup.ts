// Shared Jest setup: in-memory AsyncStorage and quiet console noise from the
// app's intentional warn/error logging (tests that care spy on it themselves).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// CI runners start with a cold transform cache, so the first render-heavy test
// in a file can pass 5s without anything being wrong.
jest.setTimeout(20000);

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// lucide-react-native ships ESM-only (.mjs) which Jest does not transform; icons
// are irrelevant to behaviour, so every icon renders nothing.
jest.mock('lucide-react-native', () => {
  const React = require('react');
  return new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : () => React.createElement(React.Fragment)) });
});
