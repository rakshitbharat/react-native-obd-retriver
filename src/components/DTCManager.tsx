import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useECU } from '../ecu/hooks/useECU';
// ECUConnectionStatus is part of state, no longer directly used for conditional rendering here
import { ECUConnectionStatus } from '../ecu/utils/constants'; // Keep import if using status value

export const DTCManager: React.FC = () => {
  const { state } = useECU();

  // Component rendering based on state
  // Removed explicit check for state.status === ECUConnectionStatus.CONNECTED
  // The component will render regardless of ECU connection status,
  // but might display different info based on available state data.

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Diagnostic Trouble Codes</Text>
      {/* Display available info from ECU state */}
      <Text>Status: {state.status}</Text>
      {state.status === ECUConnectionStatus.CONNECTED && (
        <>
          {state.activeProtocol && (
            <Text>Protocol: {state.protocolName ?? state.activeProtocol}</Text>
          )}
          {state.deviceVoltage && <Text>Voltage: {state.deviceVoltage}</Text>}
        </>
      )}
      {state.lastError && (
        <Text style={styles.errorText}>Last Error: {state.lastError}</Text>
      )}

      {/* Display DTC loading/clearing status */}
      {state.dtcLoading && <Text>Loading DTCs...</Text>}
      {state.dtcClearing && <Text>Clearing DTCs...</Text>}
      {state.rawDTCLoading && <Text>Loading Raw DTCs...</Text>}

      {/* Example: Display Current DTCs if available and connected */}
      {state.status === ECUConnectionStatus.CONNECTED && state.currentDTCs && (
        <View>
          <Text style={styles.subTitle}>Current DTCs:</Text>
          {state.currentDTCs.length === 0 ? (
            <Text>None</Text>
          ) : (
            state.currentDTCs.map(dtc => <Text key={dtc}>{dtc}</Text>)
          )}
        </View>
      )}

      {/* Add buttons or displays for other DTC types (Pending, Permanent) */}
      {/* ... */}

      {state.status !== ECUConnectionStatus.CONNECTED &&
        state.status !== ECUConnectionStatus.CONNECTING && (
          <Text style={styles.notConnectedText}>
            Please connect to Bluetooth and ECU first.
          </Text>
        )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#f5f5f7',
    borderRadius: 8,
    margin: 16,
    padding: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  subTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 4,
  },
  errorText: {
    color: 'red',
    marginTop: 8,
  },
  notConnectedText: {
    color: '#888',
    fontStyle: 'italic',
    marginTop: 16,
  },
});
