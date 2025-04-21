import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useECU } from '../ecu/hooks/useECU';
// ECUConnectionStatus is part of state, no longer directly used for conditional rendering here
import { ECUConnectionStatus } from '../ecu/utils/constants'; // Keep import if using status value
import { Colors } from '../utils/colors';

export const DTCManager: React.FC = () => {
  const { state } = useECU();

  return (
    <View>
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
  subTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 4,
  },
  notConnectedText: {
    color: Colors.LIGHT_MUTED_TEXT,
    fontStyle: 'italic',
    marginTop: 16,
  },
});
