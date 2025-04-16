export interface BlePeripheral {
  id: string;
  name?: string;
  rssi?: number;
}

export interface Device extends BlePeripheral {
  advertising?: {
    isConnectable?: boolean;
    serviceUUIDs?: string[];
    manufacturerData?: Buffer;
    serviceData?: Record<string, Buffer>;
    txPowerLevel?: number;
  };
}

export interface UseBluetoothResult {
  // These parameters are part of the interface contract
  // eslint-disable-next-line no-unused-vars
  sendCommand: (command: string, timeout?: number) => Promise<string>;
  error: Error | null;
  isAwaitingResponse: boolean;
  isScanning: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isStreaming: boolean;
  lastSuccessfulCommandTimestamp: number | null;
  device: Device | null;
  discoveredDevices: Device[];
  disconnect: () => Promise<void>;
}

export interface BluetoothHookResult {
  // These parameters are part of the interface contract
  // eslint-disable-next-line no-unused-vars
  sendCommand: (command: string, timeout?: number) => Promise<string | null>;
  isConnected: boolean;
  device: Device | null;
}

export interface BluetoothDevice {
  id: string;
  name: string;
  isConnected: boolean;
}

export type BluetoothDeviceInfo = {
  id: string;
  name: string;
};

export type BluetoothDeviceResponse = {
  id: string;
  name: string;
};
