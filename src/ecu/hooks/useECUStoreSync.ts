import { useEffect } from 'react';
import { ecuStore } from '../context/ECUStore';
import { ECUActionType, type ECUState } from '../utils/types';

export const useECUStoreSync = (state: ECUState) => {
  useEffect(() => {
    const unsubscribe = ecuStore.subscribe(() => {
      const storeState = ecuStore.getState();
      if (storeState !== state) {
        ecuStore.dispatch({
          type: ECUActionType.SYNC_STATE,
          payload: state,
        });
      }
    });

    // Initial sync
    ecuStore.dispatch({
      type: ECUActionType.SYNC_STATE,
      payload: state,
    });

    return () => unsubscribe();
  }, [state]);

  return ecuStore;
};
