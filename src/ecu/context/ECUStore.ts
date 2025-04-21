import { createSyncStore } from 'react-use-reducer-wth-redux';
import { initialState, ecuReducer } from './ECUReducer';
import type { ECUState, ECUAction } from '../utils/types';

export const ecuStore = createSyncStore<ECUState, ECUAction>(
  ecuReducer,
  initialState,
);
