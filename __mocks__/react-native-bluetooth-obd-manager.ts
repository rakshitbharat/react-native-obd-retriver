// __mocks__/react-native-bluetooth-obd-manager.ts

import { jest } from '@jest/globals';

export const useBluetooth = () => ({
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
});
