# React Native OBD Retriever

A React Native library for accessing raw OBD-II data from ELM327 adapters via Bluetooth Low Energy (BLE) connections. This library provides direct access to the raw bytes received from the ELM327 device without any interpretation or conversion.

## Features

- 🚗 Direct BLE communication with ELM327 OBD-II adapters
- 📊 Raw data access from OBD-II protocols
- 🔍 Direct access to raw DTC bytes
- 🔄 Raw command interface for ELM327
- 📱 iOS and Android support
- ⚡ TypeScript support

## Installation

```bash
npm install react-native-obd-retriver
# or
yarn add react-native-obd-retriver
```

### Dependencies

This library requires the following peer dependencies:

- `react-native-bluetooth-obd-manager`: For Bluetooth OBD communication
- `react-native-permissions`: For handling Bluetooth permissions

Install them using:

```bash
npm install react-native-bluetooth-obd-manager react-native-permissions
# or
yarn add react-native-bluetooth-obd-manager react-native-permissions
```

## Usage

1. Initialize the BLE connection:

```typescript
import { useECU } from 'react-native-obd-retriver';

const MyComponent = () => {
  const { connect, disconnect, isConnected } = useECU();

  // Connect to OBD adapter
  const handleConnect = async () => {
    try {
      await connect();
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };
};
```

2. Get raw DTC data:

```typescript
import { useDTCRetriever } from 'react-native-obd-retriver';

const DiagnosticsComponent = () => {
  const { getRawDTCResponse, sendRawCommand } = useDTCRetriever();

  const handleGetDTCs = async () => {
    try {
      // Returns raw bytes from Mode 03 (Current DTCs)
      const rawResponse = await getRawDTCResponse('03');
      console.debug('Raw DTC Response:', rawResponse);
    } catch (error) {
      console.error('Failed to retrieve raw DTC data:', error);
    }
  };
};
```

## API Reference

### Hooks

#### `useECU()`

Core hook for BLE connection management with ELM327.

- `connect()`: Initiates BLE connection to the OBD adapter
- `disconnect()`: Disconnects from the OBD adapter
- `isConnected`: Boolean indicating connection status
- `error`: Any connection-related error
- `sendRawCommand(command: string)`: Send raw command to ELM327

#### `useDTCRetriever()`

Hook for retrieving raw DTC data.

- `getRawDTCResponse(mode: string)`: Get raw bytes from DTC modes
- `sendRawCommand(command: string)`: Send raw command to ELM327

### Data Format

All data is returned as raw byte arrays exactly as received from the ELM327 device. No interpretation or conversion is performed. Users are responsible for parsing and interpreting the data according to OBD-II standards.

Example raw response format:

```typescript
{
  rawBytes: Uint8Array, // Raw bytes received from ELM327
  timestamp: number     // Timestamp of when data was received
}
```

## Troubleshooting

### Common Issues

1. Bluetooth Connection Problems

   - Ensure Bluetooth permissions are granted
   - Check if the device supports Bluetooth LE
   - Verify the OBD adapter is ELM327 compatible

2. Raw Data Issues
   - Ensure correct command format is used
   - Verify adapter response timing
   - Check ELM327 initialization parameters

## Supported Hardware

This library supports:

- ELM327 compatible adapters
- Bluetooth Low Energy (BLE) capable devices
