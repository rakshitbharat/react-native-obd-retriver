# React Native OBD Retriever Examples

This folder contains working examples that demonstrate how to use the various hooks and functionality provided by the React Native OBD Retriever library.

## Available Examples

### 1. DTC Manager Example (`DTCManagerExample.tsx`)

Demonstrates how to:

- Retrieve DTCs (Diagnostic Trouble Codes) using standard ECU hooks
- Use raw data retrieval with the useDTCRetriever hook
- Display both parsed and raw DTC data

### 2. Clear DTC Example (`ClearDTCExample.tsx`)

Demonstrates the complete workflow for clearing DTCs:

- Fetching current DTCs
- Clearing DTCs using the clearDTCs hook
- Verifying that DTCs were successfully cleared

### 3. VIN Retrieval Example (`VINRetrievalExample.tsx`)

Demonstrates how to:

- Retrieve the Vehicle Identification Number (VIN)
- Display ECU information like protocol, voltage, etc.

### 4. Live Data Example (`LiveDataExample.tsx`)

Demonstrates how to:

- Poll real-time data from the vehicle (RPM, Speed, etc.)
- Format and display the data in a dashboard-like interface

### 5. Custom Commands Example (`CustomCommandExample.tsx`)

Demonstrates how to:

- Use all available ECU hooks in one interface
- Execute various commands and see their responses
- Track command history

## Available Hooks

The library provides several custom hooks for interacting with a vehicle's ECU:

### `useECU()`

The main hook that provides access to:

- ECU connection state
- Connection methods: `connectWithECU()`, `disconnectECU()`
- Information retrieval: `getECUInformation()`, `getVIN()`, `getActiveProtocol()`
- DTC management: `getCurrentDTCs()`, `getPendingDTCs()`, `getPermanentDTCs()`, `clearDTCs()`
- Low-level communication: `sendCommand()`

### `useDTCRetriever()`

A specialized hook for retrieving raw DTC data:

- `get03DTCObject()` - For current DTCs (Mode 03)
- `get07DTCObject()` - For pending DTCs (Mode 07)
- `get0ADTCObject()` - For permanent DTCs (Mode 0A)

## Integration Example

To use these examples in your application:

1. Wrap your app with the required providers:

```jsx
<BluetoothProvider>
  <ECUProvider>
    <YourApp />
  </ECUProvider>
</BluetoothProvider>
```

2. Import and use the hooks in your components:

```jsx
const YourComponent = () => {
  const { state, connectWithECU, getCurrentDTCs } = useECU();

  // Use the hooks to interact with the vehicle's ECU
  // ...
};
```

## Best Practices

1. Always check connection status before sending commands
2. Handle errors appropriately
3. Clean up resources when components unmount
4. Use the high-level hooks instead of direct command sending when possible
5. Be mindful of battery drain when polling data continuously
