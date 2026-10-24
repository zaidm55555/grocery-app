import AsyncStorage from '@react-native-async-storage/async-storage';

// Fresh module per case: the flag lives in module state.
const loadDemo = () => {
  let mod: typeof import('../demo');
  jest.isolateModules(() => { mod = require('../demo'); });
  return mod!;
};

describe('demo mode default and persistence', () => {
  const prev = process.env.EXPO_PUBLIC_DEMO_MODE;
  beforeEach(async () => {
    await AsyncStorage.clear();
    delete process.env.EXPO_PUBLIC_DEMO_MODE;
  });
  afterAll(() => { process.env.EXPO_PUBLIC_DEMO_MODE = prev; });

  it('is on for a fresh install (nothing saved)', async () => {
    expect(await loadDemo().loadDemoMode()).toBe(true);
  });

  it('follows the last saved toggle after that', async () => {
    const first = loadDemo();
    await first.setDemoMode(false);
    expect(await loadDemo().loadDemoMode()).toBe(false);
    await first.setDemoMode(true);
    expect(await loadDemo().loadDemoMode()).toBe(true);
  });
});
