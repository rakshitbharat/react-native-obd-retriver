import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Button, ScrollView } from 'react-native';

import { useECU } from '../ecu/hooks/useECU';
import { ECUConnectionStatus } from '../ecu/utils/constants';
import { Colors } from '../utils/colors';

import type { JSX } from 'react';

export const VINRetrievalExample: React.FC = (): JSX.Element => {
  const { state, connectWithECU, disconnectECU, getVIN, getECUInformation } =
    useECU();

  const [vinResponse, setVinResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const fetchVIN = useCallback(async () => {
    setLoading(true);
    setLastError(null);

    try {
      const rawVIN = await getVIN();
      setVinResponse(rawVIN);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [getVIN]);

  const updateECUInfo = useCallback(async () => {
    setLoading(true);
    setLastError(null);

    try {
      await getECUInformation();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [getECUInformation]);

  const isConnected = state.status === ECUConnectionStatus.CONNECTED;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>VIN Retrieval Example</Text>

      <View style={styles.statusContainer}>
        <Text style={styles.label}>Status:</Text>
        <Text style={styles.value}>{state.status}</Text>
      </View>

      {isConnected && (
        <>
          <View style={styles.infoContainer}>
            <Text style={styles.infoTitle}>ECU Information:</Text>

            <View style={styles.infoRow}>
              <Text style={styles.label}>Protocol:</Text>
              <Text style={styles.value}>
                {state.protocolName || state.activeProtocol || 'Unknown'}
              </Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.label}>Voltage:</Text>
              <Text style={styles.value}>
                {state.deviceVoltage || 'Unknown'}
              </Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.label}>ECU Addresses:</Text>
              <Text style={styles.value}>
                {state.detectedEcuAddresses &&
                state.detectedEcuAddresses.length > 0
                  ? state.detectedEcuAddresses.join(', ')
                  : 'None detected'}
              </Text>
            </View>
          </View>

          <View style={styles.vinContainer}>
            <Text style={styles.infoTitle}>VIN Response:</Text>

            {loading ? (
              <Text>Loading...</Text>
            ) : vinResponse ? (
              <Text style={styles.vinValue}>{vinResponse}</Text>
            ) : (
              <Text style={styles.noData}>No VIN data retrieved</Text>
            )}
          </View>
        </>
      )}

      {state.lastError && (
        <Text style={styles.errorText}>Error: {state.lastError}</Text>
      )}

      {lastError && (
        <Text style={styles.errorText}>Operation Error: {lastError}</Text>
      )}

      <View style={styles.buttonsContainer}>
        <Button
          title={isConnected ? 'Disconnect ECU' : 'Connect ECU'}
          onPress={isConnected ? disconnectECU : connectWithECU}
          disabled={state.status === ECUConnectionStatus.CONNECTING}
        />
      </View>

      <View style={styles.buttonsContainer}>
        <Button
          title="Get VIN"
          onPress={fetchVIN}
          disabled={!isConnected || loading}
        />
        <Button
          title="Update ECU Info"
          onPress={updateECUInfo}
          disabled={!isConnected || loading}
        />
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: Colors.WHITE,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  statusContainer: {
    flexDirection: 'row',
    marginBottom: 8,
    alignItems: 'center',
  },
  infoContainer: {
    backgroundColor: Colors.GRAY_BG,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  infoRow: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  label: {
    fontWeight: 'bold',
    marginRight: 4,
    minWidth: 100,
  },
  value: {
    flex: 1,
  },
  vinContainer: {
    backgroundColor: Colors.GRAY_BG,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  vinValue: {
    fontFamily: 'monospace',
    padding: 8,
    backgroundColor: Colors.DARK_GRAY_BG,
  },
  noData: {
    fontStyle: 'italic',
    color: Colors.MUTED_TEXT,
  },
  errorText: {
    color: Colors.ERROR_TEXT,
    marginVertical: 8,
  },
  buttonsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 12,
  },
});
