import { createSyncStore } from 'react-use-reducer-wth-redux';
import { initialState, ecuReducer } from './ECUReducer';
import type { ECUState, ECUAction } from '../utils/types';
import { ECUConnectionStatus } from '../utils/constants';

export const ecuStore = createSyncStore<ECUState, ECUAction>(
  ecuReducer,
  initialState,
);

// Helper functions for store interaction
export const dispatch = ecuStore.dispatch;

export const getStore = (): ECUState => ecuStore.getState();

export const subscribe = (listener: (state: ECUState) => void) => {
  let currentState = getStore();

  return ecuStore.subscribe(() => {
    const nextState = getStore();
    if (nextState !== currentState) {
      currentState = nextState;
      listener(currentState);
    }
  });
};

export const waitForStateCondition = (
  condition: (state: ECUState) => boolean,
  timeout: number = 5000,
): Promise<void> => {
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeout);

    const unsubscribe = subscribe(state => {
      if (condition(state)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
};

// Common state conditions
export const storeConditions = {
  isConnected: (state: ECUState) =>
    state.status === ECUConnectionStatus.CONNECTED,

  hasDetectedECUs: (state: ECUState) =>
    (state.detectedEcuAddresses?.length ?? 0) > 0,

  isConnectedWithECUs: (state: ECUState) =>
    state.status === ECUConnectionStatus.CONNECTED &&
    (state.detectedEcuAddresses?.length ?? 0) > 0,
};
