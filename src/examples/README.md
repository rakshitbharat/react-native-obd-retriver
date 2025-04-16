# React Native OBD Retriever Examples

This folder contains working examples that demonstrate how to use the various hooks and functionality provided by the React Native OBD Retriever library. Each example focuses on a specific aspect of the library to provide clear guidance on implementation.

## Available Examples

### 1. DTC Manager Example (`DTCManagerExample.tsx`)

A comprehensive example for retrieving and displaying raw Diagnostic Trouble Code (DTC) data.

**Demonstrates:**

- Using the `useDTCRetriever` hook to retrieve raw DTC data
- Fetching DTCs from all three modes (03, 07, 0A)
- Handling loading states and errors
- Displaying raw DTC data properly without interpretation
- Fetching all DTC types simultaneously with Promise.all

**Key features:**

- Separate buttons for each DTC type
- Proper error handling and loading states
- Raw data display using DTCRawDataViewer component

### 2. Clear DTC Example (`ClearDTCExample.tsx`)

Demonstrates the workflow for clearing Diagnostic Trouble Codes and verifying the results.

**Demonstrates:**

- Using the `clearDTCs` function from useECU
- Verifying DTC clearance by re-checking current DTCs
- Proper state management during the clearing process
- Error handling for the clearing operation

**Key features:**

- Status tracking during clear operation
- Re-fetching DTCs to verify successful clearing
- Detailed operation logging

### 3. VIN Retrieval Example (`VINRetrievalExample.tsx`)

Shows how to retrieve and display Vehicle Identification Number data along with ECU information.

**Demonstrates:**

- Using the `getVIN` function from useECU
- Retrieving ECU information with `getECUInformation`
- Displaying protocol information, voltage, and ECU addresses
- Proper error handling for VIN retrieval

**Key features:**

- Raw VIN data display
- ECU information panel with protocol and voltage details
- ECU address display

### 4. Live Data Example (`LiveDataExample.tsx`)

Template for implementing real-time vehicle data monitoring.

**Demonstrates:**

- Implementation placeholder for live data monitoring
- Structure for handling real-time OBD data

### 5. Custom Commands Example (`CustomCommandExample.tsx`)

Template for sending custom commands to the ELM327 adapter.

**Demonstrates:**

- Implementation placeholder for custom command interface
- Structure for sending and receiving raw commands

## Component Overview

### DTCRawDataViewer Component

A reusable component for displaying raw DTC data with proper formatting.

**Features:**

- Displays all fields of the RawDTCResponse object
- Handles loading states
- Properly formats complex nested data (arrays, objects)
- Scrollable view for large responses

**Usage:**

```jsx
<DTCRawDataViewer
  title="Current DTCs (Mode 03)"
  data={currentDTCs}
  loading={loading}
/>
```

## Key Hooks Used

### `useECU()`

The main hook that provides access to all ECU-related functionality:

```typescript
const {
  state, // Current state of the ECU connection
  connectWithECU, // Function to connect to the ECU
  disconnectECU, // Function to disconnect from the ECU
  getECUInformation, // Function to update ECU information
  getVIN, // Function to get raw VIN data
  clearDTCs, // Function to clear DTCs
  sendCommand, // Function to send raw commands
  // ...other functions
} = useECU();
```

### `useDTCRetriever()`

A specialized hook for retrieving raw DTC data from different modes:

```typescript
const {
  get03DTCObject, // Function to get Mode 03 (current) DTCs
  get07DTCObject, // Function to get Mode 07 (pending) DTCs
  get0ADTCObject, // Function to get Mode 0A (permanent) DTCs
} = useDTCRetriever();
```

## Common Patterns

### Connection Management

All examples follow this pattern for connection management:

```jsx
const { state, connectWithECU, disconnectECU } = useECU();

// Determine if connected
const isConnected = state.status === ECUConnectionStatus.CONNECTED;

// In JSX:
<Button
  title={isConnected ? 'Disconnect ECU' : 'Connect ECU'}
  onPress={isConnected ? disconnectECU : connectWithECU}
  disabled={state.status === ECUConnectionStatus.CONNECTING}
/>;
```

### Error Handling

All examples handle errors consistently:

```jsx
// Display any errors from the ECU state
{
  state.lastError && (
    <Text style={styles.errorText}>Error: {state.lastError}</Text>
  );
}

// Display operation-specific errors
{
  lastError && (
    <Text style={styles.errorText}>Operation Error: {lastError}</Text>
  );
}
```

### Loading States

Loading states are managed with local state:

```jsx
const [loading, setLoading] = useState(false);

// Before operation
setLoading(true);

// After operation
setLoading(false);

// In JSX
{
  loading && <Text>Loading...</Text>;
}
```

## Best Practices

1. **Always check connection status** before attempting data retrieval
2. **Use try-catch blocks** to handle errors when calling async functions
3. **Maintain loading states** to provide visual feedback during operations
4. **Re-verify after clearing DTCs** to ensure successful operation
5. **Use the specialized hooks** for specific tasks rather than direct commands
6. **Implement proper cleanup** in useEffect hooks when needed

## Integration Guide

To use these examples in your own application:

1. Copy the components and structure
2. Ensure you have the proper provider setup:

```jsx
<BluetoothProvider>
  <ECUProvider>
    <YourApp />
  </ECUProvider>
</BluetoothProvider>
```

3. Import the necessary hooks:

```jsx
import { useECU, useDTCRetriever } from 'react-native-obd-retriver';
```

4. Adapt the examples to your specific UI requirements while keeping the core functionality intact
