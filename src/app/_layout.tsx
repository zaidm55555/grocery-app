import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import SwiggyBridgeWebView from '../components/SwiggyBridgeWebView';
import BlinkitBridgeWebView from '../components/BlinkitBridgeWebView';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="webview" options={{ presentation: 'modal' }} />
      </Stack>
      <SwiggyBridgeWebView />
      <BlinkitBridgeWebView />
    </SafeAreaProvider>
  );
}
