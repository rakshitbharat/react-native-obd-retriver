import type { AdaptiveTimingConfig, TimingConfig } from '../../utils/types';

/**
 * Standard OBD timing parameters as defined by ISO 15765-4/ISO 14230-4
 */
interface BaseTimingParams {
  /** Maximum inter-byte time for ECU responses */
  p1Max: number;
  /** Maximum time between request and response */
  p2Max: number;
  /** Minimum time between responses and new requests */
  p3Min: number;
  /** Minimum inter-byte time for requests */
  p4Min: number;
}

/**
 * ISO-specific timing parameters
 */
interface ISOTimingParams {
  /** ISO protocol specific timing parameters */
  isoW1?: number;
  isoW2?: number;
  isoW3?: number;
  isoW4?: number;
  isoW5?: number;
}

/**
 * Combined timing configuration
 */
export type ExtendedTimingConfig = AdaptiveTimingConfig &
  TimingConfig &
  BaseTimingParams &
  ISOTimingParams;

/**
 * Timing configuration per protocol type
 */
export const TIMING_CONFIGS: { [key: string]: ExtendedTimingConfig } = {
  CAN_500K: {
    // Standard timing params
    p1Max: 5,
    p2Max: 50,
    p3Min: 55,
    p4Min: 5,
    // Adaptive timing settings
    mode: 2,
    timeout: 100,
    startDelay: 20,
    minDelay: 10,
    maxDelay: 100,
    increment: 4,
    decrement: 2,
    // Required by TimingConfig
    adaptiveMode: 2,
    responseTimeoutMs: 100,
  },
  ISO9141: {
    p1Max: 20,
    p2Max: 100,
    p3Min: 100,
    p4Min: 20,
    mode: 1,
    timeout: 120,
    startDelay: 24,
    minDelay: 24,
    maxDelay: 200,
    increment: 8,
    decrement: 4,
    adaptiveMode: 1,
    responseTimeoutMs: 120,
    // ISO specific timing
    isoW1: 60,
    isoW2: 20,
    isoW3: 20,
    isoW4: 50,
    isoW5: 300,
  },
  KWP: {
    p1Max: 10,
    p2Max: 75,
    p3Min: 75,
    p4Min: 10,
    mode: 2,
    timeout: 110,
    startDelay: 22,
    minDelay: 20,
    maxDelay: 150,
    increment: 6,
    decrement: 3,
    adaptiveMode: 2,
    responseTimeoutMs: 110,
  },
};
