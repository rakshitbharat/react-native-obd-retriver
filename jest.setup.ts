// Define __DEV__ first
import '@testing-library/jest-native/extend-expect';
import { jest } from '@jest/globals';

global.__DEV__ = true;

// Mock react-native-permissions
jest.mock('react-native-permissions', () => ({
  check: jest.fn(() => Promise.resolve(true)),
  request: jest.fn(() => Promise.resolve(true)),
  PERMISSIONS: {
    ANDROID: { BLUETOOTH: 'android.permission.BLUETOOTH' },
    IOS: { BLUETOOTH_PERIPHERAL: 'ios.permission.BLUETOOTH_PERIPHERAL' },
  },
  RESULTS: {
    GRANTED: 'granted',
    DENIED: 'denied',
  },
}));

// Mock react-native-bluetooth-obd-manager
jest.mock('react-native-bluetooth-obd-manager', () => ({
  useBluetooth: () => ({
    isBluetoothOn: true,
    hasPermissions: true,
    isInitializing: false,
    isScanning: false,
    discoveredDevices: [],
    connectedDevice: null,
    isConnecting: false,
    isDisconnecting: false,
    error: null,
    isAwaitingResponse: false,
    isStreaming: false,
    lastSuccessfulCommandTimestamp: null,
    checkPermissions: jest.fn(() => Promise.resolve(true)),
    requestBluetoothPermissions: jest.fn(() => Promise.resolve(true)),
    promptEnableBluetooth: jest.fn(() => Promise.resolve(true)),
    scanDevices: jest.fn(() => Promise.resolve()),
    connectToDevice: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(() => Promise.resolve()),
    sendCommand: jest.fn(() => Promise.resolve('')),
    sendCommandRaw: jest.fn(() => Promise.resolve(new Uint8Array())),
    sendCommandRawChunked: jest.fn(() => Promise.resolve(new Uint8Array())),
    setStreaming: jest.fn(),
  }),
}));

// Setup timing mocks
jest.useFakeTimers();
jest.spyOn(global, 'setTimeout');
jest.spyOn(global, 'clearTimeout');
jest.spyOn(global, 'setInterval');
jest.spyOn(global, 'clearInterval');

// Add custom matchers
expect.extend({
  toBeValidBleDevice(received) {
    const pass =
      received &&
      typeof received.id === 'string' &&
      typeof received.name === 'string';

    return {
      pass,
      message: () => `expected ${received} to be a valid BLE device`,
    };
  },
});

// Cleanup after each test
afterEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});
