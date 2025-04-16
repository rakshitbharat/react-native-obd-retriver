import { useCallback } from 'react';

import {
  CurrentDTCRetriever,
  PendingDTCRetriever,
  PermanentDTCRetriever,
  type RawDTCResponse,
} from '../retrievers';

import { useECU } from './useECU';

/**
 * Hook for retrieving DTCs from the ECU
 */
export const useDTCRetriever = (): {
  get03DTCObject: () => Promise<RawDTCResponse | null>;
  get07DTCObject: () => Promise<RawDTCResponse | null>;
  get0ADTCObject: () => Promise<RawDTCResponse | null>;
} => {
  const { sendCommand } = useECU();

  const get03DTCObject = useCallback(async () => {
    const retriever = new CurrentDTCRetriever(sendCommand);
    return await retriever.retrieveRawDTCs();
  }, [sendCommand]);

  const get07DTCObject = useCallback(async () => {
    const retriever = new PendingDTCRetriever(sendCommand);
    return await retriever.retrieveRawDTCs();
  }, [sendCommand]);

  const get0ADTCObject = useCallback(async () => {
    const retriever = new PermanentDTCRetriever(sendCommand);
    return await retriever.retrieveRawDTCs();
  }, [sendCommand]);

  return {
    get03DTCObject,
    get07DTCObject,
    get0ADTCObject,
  };
};
