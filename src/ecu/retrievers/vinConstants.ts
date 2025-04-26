export const VIN_CONSTANTS = {
  COMMAND: '0902',
  DELAYS: {
    STANDARD: 100,
    PROTOCOL: 200,
    FLOW_CONTROL: 75,
  },
  HEADERS: {
    CAN_11BIT: '7DF',
    CAN_29BIT: '18DB33F1',
  },
  FLOW_CONTROL_CONFIGS: [
    { fcsh: '7E0', fcsd: '300000', fcsm: '1', desc: 'Standard Mode 1' },
    { fcsh: '7E0', fcsd: '300000', fcsm: '0', desc: 'Standard Mode 0' },
    { fcsh: '18DA10F1', fcsd: '300000', fcsm: '1', desc: '29-bit Mode 1' },
  ],
  INIT_COMMANDS: [
    { cmd: 'ATE0', desc: 'Echo off' },
    { cmd: 'ATL0', desc: 'Linefeeds off' },
    { cmd: 'ATH1', desc: 'Headers on' },
    { cmd: 'ATCAF0', desc: 'Formatting off' },
  ],
} as const;
