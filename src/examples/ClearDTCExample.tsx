import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Button, ScrollView } from 'react-native';

import { DTCRawDataViewer } from '../components/DTCRawDataViewer';
import { useDTCRetriever } from '../ecu/hooks/useDTCRetriever';
import { useECU } from '../ecu/hooks/useECU';
import { ECUConnectionStatus } from '../ecu/utils/constants';
import { Colors } from '../../utils/colors';

import type { RawDTCResponse } from '../ecu/retrievers/BaseDTCRetriever';
import type { JSX } from 'react';

export const ClearDTCExample: React.FC = (): JSX.Element => {
  const { state, connectWithECU, disconnectECU, clearDTCs } = useECU();
  const { get03DTCObject } = useDTCRetriever();

  const [currentDTCs, setCurrentDTCs] = useState<RawDTCResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastOperation, setLastOperation] = useState<string | null>(null);

  const fetchCurrentDTCs = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    setLastOperation('Fetching Current DTCs');

    try {
      const result = await get03DTCObject();
      setCurrentDTCs(result);
      setLastOperation('Current DTCs retrieved');
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [get03DTCObject]);

  const handleClearDTCs = useCallback(async () => {
    setClearing(true);
    setLastError(null);
    setLastOperation('Clearing DTCs');

    try {
      const success = await clearDTCs();
      setLastOperation(
        success ? 'DTCs cleared successfully' : 'DTC clear failed',
      );

      if (success) {
        // Re-fetch DTCs after clearing
        await fetchCurrentDTCs();
      }
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  }, [clearDTCs, fetchCurrentDTCs]);

  const isConnected = state.status === ECUConnectionStatus.CONNECTED;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Clear DTC Example</Text>

      <View style={styles.statusContainer}>
        <Text style={styles.statusLabel}>Status:</Text>
        <Text style={styles.statusValue}>{state.status}</Text>
      </View>

      {state.lastError && (
        <Text style={styles.errorText}>Error: {state.lastError}</Text>
      )}

      {lastError && (
        <Text style={styles.errorText}>Operation Error: {lastError}</Text>
      )}

      {lastOperation && (
        <Text style={styles.operationText}>Last Action: {lastOperation}</Text>
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
          title="Fetch Current DTCs"
          onPress={fetchCurrentDTCs}
          disabled={!isConnected || loading}
        />
        <Button
          title="Clear DTCs"
          onPress={handleClearDTCs}
          disabled={!isConnected || clearing || loading}
        />
      </View>

      <DTCRawDataViewer
        title="Current DTCs (Mode 03) Raw Data"
        data={currentDTCs}
        loading={loading}
      />
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
  },
  statusLabel: {
    fontWeight: 'bold',
    marginRight: 4,
  },
  statusValue: {
    flex: 1,
  },
  errorText: {
    color: Colors.ERROR_TEXT,
    marginVertical: 8,
  },
  operationText: {
    color: Colors.INFO_TEXT,
    marginVertical: 8,
  },
  buttonsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 12,
  },
});
