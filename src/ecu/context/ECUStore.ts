import { createSyncStore } from 'react-use-reducer-wth-redux';
import { initialState, ecuReducer } from './ECUReducer';
import type { ECUState, ECUAction } from '../utils/types';

export const ecuStore = createSyncStore<ECUState, ECUAction>(
  ecuReducer,
  initialState,
);

// Add helper functions for store interaction
export const { dispatch, getState } = ecuStore;

export const subscribe = (listener: (state: ECUState) => void) => {
  let currentState = getState();

  return ecuStore.subscribe(() => {
    const nextState = getState();
    if (nextState !== currentState) {
      currentState = nextState;
      listener(currentState);
    }
  });
};

export const waitForStateUpdate = (
  predicate: (state: ECUState) => boolean,
  timeout: number = 2000,
): Promise<boolean> => {
  return new Promise(resolve => {
    const startTime = Date.now();
    const unsubscribe = subscribe(state => {
      if (predicate(state) || Date.now() - startTime >= timeout) {
        unsubscribe();
        resolve(predicate(state));
      }
    });
  });
};
