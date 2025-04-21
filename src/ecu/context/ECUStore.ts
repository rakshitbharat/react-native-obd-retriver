import { createSyncStore } from 'react-use-reducer-wth-redux';
import { log } from '../../utils/logger';
import { initialState, ecuReducer } from './ECUReducer';
import type { ECUState, ECUAction } from '../utils/types';

// Create store with synchronization
export const ecuStore = createSyncStore<ECUState, ECUAction>(
  ecuReducer,
  initialState
);

// Helper to get current state
export const getState = (): ECUState => {
  return ecuStore.getState();
};

// Helper to dispatch actions
export const dispatch = (action: ECUAction): void => {
  ecuStore.dispatch(action);
};

// Helper to check if state is fully updated
export const waitForStateUpdate = async (
  checkFn: (state: ECUState) => boolean,
  timeoutMs = 2000
): Promise<boolean> => {
  const startTime = Date.now();
  let lastState: ECUState | null = null;
  let checkCount = 0;
  
  while (Date.now() - startTime < timeoutMs) {
    const currentState = ecuStore.getState();
    checkCount++;
    
    // Log state changes
    if (!lastState || JSON.stringify(lastState) !== JSON.stringify(currentState)) {
      void log.debug('[ECUStore] State update check attempt:', { 
        attempt: checkCount,
        status: currentState.status,
        protocol: currentState.activeProtocol,
        elapsed: Date.now() - startTime
      });
      lastState = currentState;
    }
    
    if (checkFn(currentState)) {
      void log.debug('[ECUStore] State check passed:', {
        status: currentState.status,
        protocol: currentState.activeProtocol
      });
      return true;
    }
    
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  const finalState = ecuStore.getState();
  void log.warn('[ECUStore] State update timeout. Final state:', {
    status: finalState.status,
    protocol: finalState.activeProtocol,
    checks: checkCount,
    elapsed: Date.now() - startTime
  });
  
  return false;
};
