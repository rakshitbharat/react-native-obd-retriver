import { useContext } from 'react';

import { ECUContext } from '../context/ECUContext';

import type { ECUContextValue } from '../utils/types';

export const useECU = (): ECUContextValue => {
  const context = useContext(ECUContext);

  if (!context) {
    throw new Error('useECU must be used within an ECUProvider');
  }

  return context;
};
