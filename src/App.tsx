import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  SafeAreaView,
  Text,
  Button,
  ScrollView,
} from 'react-native';
import { BluetoothProvider } from 'react-native-bluetooth-obd-manager';

import { ECUProvider } from './ecu/context/ECUContext';
import {
  ClearDTCExample,
  DTCManagerExample,
  LiveDataExample,
  VINRetrievalExample,
} from './examples';
import { Colors } from './utils/colors';

import type { JSX } from 'react';

// App component with example selector
export const App = (): JSX.Element => {
  const [activeExample, setActiveExample] = useState<string | null>(null);

  const renderExample = () => {
    switch (activeExample) {
      case 'dtc':
        return <DTCManagerExample />;
      case 'vin':
        return <VINRetrievalExample />;
      case 'livedata':
        return <LiveDataExample />;
      case 'cleardtc':
        return <ClearDTCExample />;
      case null:
        return (
          <View style={styles.selectionContainer}>
            <Text style={styles.title}>OBD-II Examples</Text>
            <Text style={styles.subtitle}>Select an example to run:</Text>

            <View style={styles.buttonContainer}>
              <Button
                title="DTC Manager Example"
                onPress={() => setActiveExample('dtc')}
              />
              <Button
                title="Clear DTCs Example"
                onPress={() => setActiveExample('cleardtc')}
              />
              <Button
                title="VIN Retrieval Example"
                onPress={() => setActiveExample('vin')}
              />
              <Button
                title="Live Data Example"
                onPress={() => setActiveExample('livedata')}
              />
              <Button
                title="Custom Commands Example"
                onPress={() => setActiveExample('custom')}
              />
            </View>
          </View>
        );
    }
    return null; // Ensure all code paths return a value
  };

  return (
    <BluetoothProvider>
      <ECUProvider>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView style={styles.scrollView}>
            {activeExample && (
              <View style={styles.backButtonContainer}>
                <Button
                  title="Back to Examples"
                  onPress={() => setActiveExample(null)}
                />
              </View>
            )}
            {renderExample()}
          </ScrollView>
        </SafeAreaView>
      </ECUProvider>
    </BluetoothProvider>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  selectionContainer: {
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 20,
  },
  buttonContainer: {
    width: '100%',
    gap: 15,
  },
  backButtonContainer: {
    padding: 10,
    backgroundColor: Colors.LIGHT_BG,
  },
});
