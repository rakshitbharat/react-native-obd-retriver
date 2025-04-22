import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Button, ScrollView } from 'react-native';

import { DTCRawDataViewer } from '../components/DTCRawDataViewer';
import { useDTCRetriever } from '../ecu/hooks/useDTCRetriever';
import { useECU } from '../ecu/hooks/useECU';
import { ECUConnectionStatus } from '../ecu/utils/constants';
import { Colors } from '../utils/colors';

import type { RawDTCResponse } from '../ecu/retrievers/BaseDTCRetriever';
import type { JSX } from 'react';

export const DTCManagerExample: React.FC = (): JSX.Element => {
  const { state, connectWithECU, disconnectECU } = useECU();
  const { get03DTCObject, get07DTCObject, get0ADTCObject } = useDTCRetriever();

  const [currentDTCs, setCurrentDTCs] = useState<RawDTCResponse | null>(null);
  const [pendingDTCs, setPendingDTCs] = useState<RawDTCResponse | null>(null);
  const [permanentDTCs, setPermanentDTCs] = useState<RawDTCResponse | null>(
    null,
  );

  const [loading, setLoading] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const fetchCurrentDTCs = useCallback(async () => {
    setLoading('current');
    setLastError(null);

    try {
      const result = await get03DTCObject();
      setCurrentDTCs(result);
    } catch (error) {
      setLastError(
        `Current DTCs Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLoading(null);
    }
  }, [get03DTCObject]);

  const fetchPendingDTCs = useCallback(async () => {
    setLoading('pending');
    setLastError(null);

    try {
      const result = await get07DTCObject();
      setPendingDTCs(result);
    } catch (error) {
      setLastError(
        `Pending DTCs Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLoading(null);
    }
  }, [get07DTCObject]);

  const fetchPermanentDTCs = useCallback(async () => {
    setLoading('permanent');
    setLastError(null);

    try {
      const result = await get0ADTCObject();
      setPermanentDTCs(result);
    } catch (error) {
      setLastError(
        `Permanent DTCs Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLoading(null);
    }
  }, [get0ADTCObject]);

  const fetchAllDTCs = useCallback(async () => {
    setLoading('all');
    setLastError(null);

    try {
      const [current, pending, permanent] = await Promise.all([
        get03DTCObject(),
        get07DTCObject(),
        get0ADTCObject(),
      ]);

      setCurrentDTCs(current);
      setPendingDTCs(pending);
      setPermanentDTCs(permanent);
    } catch (error) {
      setLastError(
        `All DTCs Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLoading(null);
    }
  }, [get03DTCObject, get07DTCObject, get0ADTCObject]);

  const isConnected = state.status === ECUConnectionStatus.CONNECTED;
  const isLoading = loading !== null;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>DTC Manager Example</Text>

      <View style={styles.statusContainer}>
        <Text style={styles.label}>Status:</Text>
        <Text style={styles.value}>{state.status}</Text>
      </View>

      {(state.lastError || lastError) && (
        <View style={styles.errorContainer}>
          {state.lastError && (
            <Text style={styles.errorText}>ECU Error: {state.lastError}</Text>
          )}
          {lastError && <Text style={styles.errorText}>{lastError}</Text>}
        </View>
      )}

      <View style={styles.connectionButtons}>
        <Button
          title={isConnected ? 'Disconnect ECU' : 'Connect ECU'}
          onPress={isConnected ? disconnectECU : connectWithECU}
          disabled={
            state.status === ECUConnectionStatus.CONNECTING || isLoading
          }
        />
      </View>

      <View style={styles.buttonsContainer}>
        <View style={styles.buttonRow}>
          <View style={styles.buttonItem}>
            <Button
              title="Get Current DTCs"
              onPress={fetchCurrentDTCs}
              disabled={!isConnected || isLoading}
            />
          </View>
          <View style={styles.buttonItem}>
            <Button
              title="Get Pending DTCs"
              onPress={fetchPendingDTCs}
              disabled={!isConnected || isLoading}
            />
          </View>
        </View>
        <View style={styles.buttonRow}>
          <View style={styles.buttonItem}>
            <Button
              title="Get Permanent DTCs"
              onPress={fetchPermanentDTCs}
              disabled={!isConnected || isLoading}
            />
          </View>
          <View style={styles.buttonItem}>
            <Button
              title="Get All DTCs"
              onPress={fetchAllDTCs}
              disabled={!isConnected || isLoading}
            />
          </View>
        </View>
      </View>

      {loading && (
        <Text style={styles.loadingText}>
          Loading {loading === 'all' ? 'all DTCs' : `${loading} DTCs`}...
        </Text>
      )}

      <DTCRawDataViewer
        title="Current DTCs (Mode 03)"
        data={currentDTCs}
        loading={loading === 'current' || loading === 'all'}
      />

      <DTCRawDataViewer
        title="Pending DTCs (Mode 07)"
        data={pendingDTCs}
        loading={loading === 'pending' || loading === 'all'}
      />

      <DTCRawDataViewer
        title="Permanent DTCs (Mode 0A)"
        data={permanentDTCs}
        loading={loading === 'permanent' || loading === 'all'}
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
  label: {
    fontWeight: 'bold',
    marginRight: 4,
  },
  value: {
    flex: 1,
  },
  errorContainer: {
    marginVertical: 8,
    padding: 8,
    backgroundColor: Colors.ERROR_BG,
    borderRadius: 4,
  },
  errorText: {
    color: Colors.ERROR_TEXT,
  },
  loadingText: {
    marginVertical: 8,
    fontStyle: 'italic',
    color: Colors.INFO_TEXT,
  },
  connectionButtons: {
    marginVertical: 12,
  },
  buttonsContainer: {
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  buttonItem: {
    flex: 1,
    marginHorizontal: 4,
  },
});
