import React from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';

import type { RawDTCResponse } from '../ecu/retrievers/BaseDTCRetriever';
import { Colors } from '../utils/colors';

interface DTCRawDataViewerProps {
  title: string;
  data: RawDTCResponse | null;
  loading?: boolean;
}

export const DTCRawDataViewer: React.FC<DTCRawDataViewerProps> = ({
  title,
  data,
  loading = false,
}) => {
  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{title}</Text>
        <Text>Loading...</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.noData}>No data available</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <ScrollView style={styles.scrollView}>
        <View style={styles.dataContainer}>
          {/* Display raw string response if available */}
          <Text style={styles.label}>Raw String Response:</Text>
          <Text style={styles.value}>{data.rawString || 'N/A'}</Text>

          {/* Display raw numeric response if available */}
          <Text style={styles.label}>Raw Response:</Text>
          <Text style={styles.value}>
            {data.rawResponse ? JSON.stringify(data.rawResponse) : 'N/A'}
          </Text>

          {/* Display parsed response if available */}
          {data.response && (
            <>
              <Text style={styles.label}>Response:</Text>
              <Text style={styles.value}>{JSON.stringify(data.response)}</Text>
            </>
          )}

          {/* Display raw bytes response from send command */}
          <Text style={styles.label}>Raw Bytes Response:</Text>
          <Text style={styles.value}>
            {data.rawBytesResponseFromSendCommand
              ? JSON.stringify(data.rawBytesResponseFromSendCommand)
              : 'N/A'}
          </Text>

          {/* Display protocol information */}
          <Text style={styles.label}>Protocol Information:</Text>
          <Text style={styles.value}>
            Protocol: {data.protocolNumber || 'Unknown'}
            {'\n'}
            Is CAN: {data.isCan ? 'Yes' : 'No'}
            {'\n'}
            ECU Address: {data.ecuAddress || 'N/A'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.GRAY_BG,
    borderRadius: 8,
    margin: 8,
    padding: 12,
  },
  scrollView: {
    maxHeight: 200,
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  dataContainer: {
    marginTop: 4,
  },
  label: {
    fontWeight: '600',
    marginTop: 6,
  },
  value: {
    fontFamily: 'monospace',
    marginTop: 2,
    paddingHorizontal: 4,
    backgroundColor: Colors.DARK_GRAY_BG,
  },
  noData: {
    fontStyle: 'italic',
    color: Colors.MUTED_TEXT,
  },
});
