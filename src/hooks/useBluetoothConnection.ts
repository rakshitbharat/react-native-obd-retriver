import { useState, useEffect } from 'react';
import { useBluetooth } from 'react-native-bluetooth-obd-manager';
import type { ActiveDeviceConfig } from 'react-native-bluetooth-obd-manager';

interface BluetoothConnectionState {
  isReady: boolean;
  deviceConfig: ActiveDeviceConfig | null;
  error: string | null;
}

export const useBluetoothConnection = () => {
  const { connectedDevice, activeDeviceConfig } = useBluetooth();
  const [connectionState, setConnectionState] = useState<BluetoothConnectionState>({
    isReady: false,
    deviceConfig: null,
    error: null
  });

  useEffect(() => {
    const hasDevice = !!connectedDevice;
    const hasConfig = !!activeDeviceConfig;
    const hasRequiredService = activeDeviceConfig?.serviceUUID === 'fff0';
    const hasRequiredCharacteristics = 
      activeDeviceConfig?.writeCharacteristicUUID === 'fff2' &&
      activeDeviceConfig?.notifyCharacteristicUUID === 'fff1';

    setConnectionState({
      isReady: hasDevice && hasConfig && hasRequiredService && hasRequiredCharacteristics,
      deviceConfig: activeDeviceConfig,
      error: !hasDevice ? 'No device connected' :
             !hasConfig ? 'No device configuration' :
             !hasRequiredService ? 'Missing required service' :
             !hasRequiredCharacteristics ? 'Missing required characteristics' : null
    });
  }, [connectedDevice, activeDeviceConfig]);

  return connectionState;
};
