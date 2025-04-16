// Export necessary components for connection logic
export { ProtocolManager } from './ProtocolManager';
export { PROTOCOL } from '../utils/constants'; // Re-export for convenience if needed
export type {
  ProtocolConfig,
  TimingConfig,
  FlowControlConfig,
} from '../utils/types'; // Re-export types

// Can export specific protocol classes later if needed directly
// export * from './CAN';
// export * from './ISO9141';
// export * from './KWP';
