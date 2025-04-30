import { PROTOCOL } from '../../utils/constants';
import type {
  CanProtocolConfig,
  KwpProtocolConfig,
  ProtocolConfig,
} from '../../utils/types';
import { TIMING_CONFIGS } from '../types/timing';

// CAN 11-bit 500k protocol configuration
const CAN_11BIT_500K: CanProtocolConfig & ProtocolConfig = {
  protocolNumber: PROTOCOL.ISO_15765_4_CAN_11BIT_500K,
  protocol: PROTOCOL.ISO_15765_4_CAN_11BIT_500K, // Required by both interfaces
  description: 'ISO 15765-4 CAN (11 bit ID, 500 kbps)',
  timing: {
    ...TIMING_CONFIGS.CAN_500K,
    adaptiveMode: TIMING_CONFIGS.CAN_500K.mode,
    responseTimeoutMs: TIMING_CONFIGS.CAN_500K.timeout,
  },
  baudRate: 500000,
  flowControlEnabled: true,
  header: '7DF',
  receiveFilter: '7E8',
  flowControlHeader: '7E0',
  isExtended: false,
  formatCommands: ['ATCAF1'],
  flowControlCommands: (fcHeader: string) => [
    `ATFCSH${fcHeader}`,
    'ATFCSD300000',
    'ATFCSM1',
  ],
};

// CAN 29-bit 500k protocol configuration
const CAN_29BIT_500K: CanProtocolConfig & ProtocolConfig = {
  ...CAN_11BIT_500K,
  protocolNumber: PROTOCOL.ISO_15765_4_CAN_29BIT_500K,
  protocol: PROTOCOL.ISO_15765_4_CAN_29BIT_500K,
  description: 'ISO 15765-4 CAN (29 bit ID, 500 kbps)',
  header: '18DB33F1',
  receiveFilter: '18DAF110',
  flowControlHeader: '18DA10F1',
  isExtended: true,
};

// KWP2000 Fast Init protocol configuration
const KWP2000_FAST: KwpProtocolConfig & ProtocolConfig = {
  protocolNumber: PROTOCOL.ISO_14230_4_KWP_FAST,
  protocol: PROTOCOL.ISO_14230_4_KWP_FAST,
  description: 'KWP2000 Fast Init',
  timing: {
    ...TIMING_CONFIGS.KWP,
    adaptiveMode: TIMING_CONFIGS.KWP.mode,
    responseTimeoutMs: TIMING_CONFIGS.KWP.timeout,
  },
  baudRate: 10400,
  flowControlEnabled: false,
  initType: 'fast',
  formatCommands: ['ATCAF0'],
  initSequence: ['ATZ', 'ATSP5', 'ATST64', 'ATAT2'],
};

// KWP2000 5-Baud Init protocol configuration
const KWP2000_5BAUD: KwpProtocolConfig & ProtocolConfig = {
  ...KWP2000_FAST,
  protocolNumber: PROTOCOL.ISO_14230_4_KWP,
  protocol: PROTOCOL.ISO_14230_4_KWP,
  description: 'KWP2000 5-Baud Init',
  initType: 'slow',
};

// Progressive Flow Control configurations for CAN protocols
export const CAN_FLOW_CONTROL_CONFIGS = [
  {
    blockSize: 0,
    separationTime: 0,
    flowControlMode: 1 as const,
    description: 'Standard (Auto FC)',
  },
  {
    blockSize: 0,
    separationTime: 0,
    flowControlMode: 0 as const,
    description: 'No Wait FC',
  },
  {
    blockSize: 0,
    separationTime: 8,
    flowControlMode: 1 as const,
    description: 'Extended Wait FC',
  },
  {
    blockSize: 4,
    separationTime: 0,
    flowControlMode: 1 as const,
    description: 'Block Size FC',
  },
];

// Protocol configuration map
export const PROTOCOL_CONFIGS = new Map<PROTOCOL, ProtocolConfig>([
  [PROTOCOL.ISO_15765_4_CAN_11BIT_500K, CAN_11BIT_500K],
  [PROTOCOL.ISO_15765_4_CAN_29BIT_500K, CAN_29BIT_500K],
  [PROTOCOL.ISO_14230_4_KWP_FAST, KWP2000_FAST],
  [PROTOCOL.ISO_14230_4_KWP, KWP2000_5BAUD],
]);

// Helper functions
export function getProtocolConfig(protocol: PROTOCOL): ProtocolConfig | null {
  return PROTOCOL_CONFIGS.get(protocol) ?? null;
}

export function isCanProtocol(protocol: PROTOCOL): boolean {
  return (
    protocol >= PROTOCOL.ISO_15765_4_CAN_11BIT_500K &&
    protocol <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8
  );
}

export function isKwpProtocol(protocol: PROTOCOL): boolean {
  return (
    protocol === PROTOCOL.ISO_14230_4_KWP ||
    protocol === PROTOCOL.ISO_14230_4_KWP_FAST
  );
}
