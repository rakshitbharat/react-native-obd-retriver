// Enums for clarity and type safety
/* eslint-disable no-unused-vars */
export enum ECUConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
}

export enum OBD_MODE {
  CURRENT_DTC = '03',
  PENDING_DTC = '07',
  PERMANENT_DTC = '0A',
  CLEAR_DTC = '04',
  VEHICLE_INFO = '09', // For VIN, etc.
  CURRENT_DATA = '01', // For Live Data, PIDs
}
/* eslint-enable no-unused-vars */

// Merge delays from OBDUtils.js DELAYS/STANDARD_DELAYS
// Using values from DELAYS in OBDUtils.js where applicable
export const DELAYS_MS = {
  RESET: 1000, // Delay after ATZ (from STANDARD_DELAYS)
  COMMAND_SHORT: 100, // Standard delay between commands (from DELAYS.STANDARD)
  COMMAND_MEDIUM: 200, // General purpose medium delay
  COMMAND_LONG: 500, // Longer delay for certain operations
  PROTOCOL_SWITCH: 1000, // Delay after ATPC or changing protocol (from STANDARD_DELAYS.PROTOCOL_CLOSE_DELAY)
  RETRY: 1000, // Base retry delay (from RETRY_CONFIG)
  ECU_RESPONSE: 300, // General wait time
  INIT: 100, // Delay during init sequence (from DELAYS.INIT)
  ADAPTIVE_START: 20, // from DELAYS.ADAPTIVE_START
  ADAPTIVE_MIN: 20, // from DELAYS.ADAPTIVE_MIN
  ADAPTIVE_MAX: 500, // from DELAYS.ADAPTIVE_MAX
  ADAPTIVE_INC: 20, // from DELAYS.ADAPTIVE_INC
  ADAPTIVE_DEC: 10, // from DELAYS.ADAPTIVE_DEC
  TIMEOUT_NORMAL_MS: 100, // From DELAYS.TIMEOUT_NORMAL='64' hex -> 100 decimal
  TIMEOUT_EXTENDED_MS: 200, // From DELAYS.TIMEOUT_EXTENDED='C8' hex -> 200 decimal
  // Add other DELAYS constants from OBDUtils.js if needed
  PROTOCOL: 100, // from DELAYS.PROTOCOL
  COMMAND: 100, // from DELAYS.COMMAND
  ADAPTIVE: 100, // from DELAYS.ADAPTIVE
  RETRY_BASE: 100, // from DELAYS.RETRY_BASE
  CAN_INIT: 100, // from DELAYS.CAN_INIT
  ECU_QUERY: 100, // from DELAYS.ECU_QUERY
  HEADER_CHANGE: 100, // from DELAYS.HEADER_CHANGE
} as const;

// Merge from OBDUtils.js RSP_ID and OBD_RESPONSES
export const RESPONSE_KEYWORDS = {
  PROMPT: '>',
  OK: 'OK',
  ELM_MODEL: 'ELM327', // From RSP_ID.MODEL
  NO_DATA: 'NO DATA', // From RSP_ID.NODATA / OBD_RESPONSES
  ERROR: 'ERROR', // From RSP_ID.ERROR / OBD_RESPONSES
  UNABLE_TO_CONNECT: 'UNABLE TO CONNECT', // Matches RSP_ID.NOCONN / NOCONN2 and OBD_RESPONSES
  CAN_ERROR: 'CAN ERROR', // From RSP_ID.CANERROR
  BUS_ERROR: 'BUS ERROR', // Covers BUSERROR, BUSINIERR*, from RSP_ID.BUSERROR
  BUS_INIT: 'BUS INIT', // Specific keyword for clarity, from RSP_ID.BUSINIERR
  BUS_BUSY: 'BUS BUSY', // From RSP_ID.BUSBUSY
  FB_ERROR: 'FB ERROR', // From RSP_ID.FBERROR
  DATA_ERROR: 'DATA ERROR', // From RSP_ID.DATAERROR
  BUFFER_FULL: 'BUFFER FULL', // From RSP_ID.BUFFERFULL
  RX_ERROR: 'RX ERROR', // Explicit name for '<' if needed, From RSP_ID.RXERROR='<'
  STOPPED: 'STOPPED', // From RSP_ID.STOPPED / OBD_RESPONSES
  SEARCHING: 'SEARCHING...', // From RSP_ID.SEARCHING
  UNKNOWN: 'UNKNOWN', // From RSP_ID.UNKNOWN
  VOLTAGE_SUFFIX: 'V', // From OBD_RESPONSES
  TIMEOUT: 'TIMEOUT', // Added for clarity, often indicated by null response
  QUESTION_MARK: '?', // From RSP_ID.QMARK
} as const;

// Merge from OBDUtils.js PROT enum
/* eslint-disable no-unused-vars */
export enum PROTOCOL {
  AUTO = 0,
  SAE_J1850_PWM = 1, // J1850PWM
  SAE_J1850_VPW = 2, // J1850VPW
  ISO_9141_2 = 3, // ISO9141
  ISO_14230_4_KWP = 4, // ISO14230_4KW (5 baud)
  ISO_14230_4_KWP_FAST = 5, // ISO14230_4ST (fast)
  ISO_15765_4_CAN_11BIT_500K = 6, // ISO15765_11_500
  ISO_15765_4_CAN_29BIT_500K = 7, // ISO15765_29_500
  ISO_15765_4_CAN_11BIT_250K = 8, // ISO15765_11_250
  ISO_15765_4_CAN_29BIT_250K = 9, // ISO15765_29_250
  SAE_J1939_CAN_29BIT_250K = 10, // SAE_J1939 (A in JS)
  USER1_CAN_11BIT_125K = 11, // USER1_CAN (B in JS)
  USER2_CAN_11BIT_50K = 12, // USER2_CAN (C in JS)
  ISO_15765_4_CAN_11BIT_500K_4 = 13, // (D in JS)
  ISO_15765_4_CAN_29BIT_500K_4 = 14, // (E in JS)
  ISO_15765_4_CAN_11BIT_250K_4 = 15, // (F in JS)
  ISO_15765_4_CAN_29BIT_250K_4 = 16, // (10 in JS)
  ISO_15765_4_CAN_11BIT_500K_8 = 17, // (11 in JS)
  ISO_15765_4_CAN_29BIT_500K_8 = 18, // (12 in JS)
  ISO_15765_4_CAN_11BIT_250K_8 = 19, // (13 in JS)
  ISO_15765_4_CAN_29BIT_250K_8 = 20, // (14 in JS)
}
/* eslint-enable no-unused-vars */

// Merge from OBDUtils.js PROT_DESCRIPTIONS
export const PROTOCOL_DESCRIPTIONS: Record<number, string> = {
  [PROTOCOL.AUTO]: 'Automatic',
  [PROTOCOL.SAE_J1850_PWM]: 'SAE J1850 PWM (41.6 KBaud)',
  [PROTOCOL.SAE_J1850_VPW]: 'SAE J1850 VPW (10.4 KBaud)',
  [PROTOCOL.ISO_9141_2]: 'ISO 9141-2 (5 Baud Init)',
  [PROTOCOL.ISO_14230_4_KWP]: 'ISO 14230-4 KWP (5 Baud Init)',
  [PROTOCOL.ISO_14230_4_KWP_FAST]: 'ISO 14230-4 KWP (Fast Init)',
  [PROTOCOL.ISO_15765_4_CAN_11BIT_500K]:
    'ISO 15765-4 CAN (11 Bit ID, 500 KBit)',
  [PROTOCOL.ISO_15765_4_CAN_29BIT_500K]:
    'ISO 15765-4 CAN (29 Bit ID, 500 KBit)',
  [PROTOCOL.ISO_15765_4_CAN_11BIT_250K]:
    'ISO 15765-4 CAN (11 Bit ID, 250 KBit)',
  [PROTOCOL.ISO_15765_4_CAN_29BIT_250K]:
    'ISO 15765-4 CAN (29 Bit ID, 250 KBit)',
  [PROTOCOL.SAE_J1939_CAN_29BIT_250K]: 'SAE J1939 CAN (29 bit ID, 250* kbaud)',
  [PROTOCOL.USER1_CAN_11BIT_125K]: 'User1 CAN (11* bit ID, 125* kbaud)',
  [PROTOCOL.USER2_CAN_11BIT_50K]: 'User2 CAN (11* bit ID, 50* kbaud)',
  [PROTOCOL.ISO_15765_4_CAN_11BIT_500K_4]:
    'ISO 15765-4 CAN (11 bit ID, 500 kbps, 4 byte)',
  [PROTOCOL.ISO_15765_4_CAN_29BIT_500K_4]:
    'ISO 15765-4 CAN (29 bit ID, 500 kbps, 4 byte)',
  [PROTOCOL.ISO_15765_4_CAN_11BIT_250K_4]:
    'ISO 15765-4 CAN (11 bit ID, 250 kbps, 4 byte)',
  [PROTOCOL.ISO_15765_4_CAN_29BIT_250K_4]:
    'ISO 15765-4 CAN (29 bit ID, 250 kbps, 4 byte)',
  [PROTOCOL.ISO_15765_4_CAN_11BIT_500K_8]:
    'ISO 15765-4 CAN (11 bit ID, 500 kbps, 8 byte)',
  [PROTOCOL.ISO_15765_4_CAN_29BIT_500K_8]:
    'ISO 15765-4 CAN (29 bit ID, 500 kbps, 8 byte)',
  [PROTOCOL.ISO_15765_4_CAN_11BIT_250K_8]:
    'ISO 15765-4 CAN (11 bit ID, 250 kbps, 8 byte)',
  [PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8]:
    'ISO 15765-4 CAN (29 bit ID, 250 kbps, 8 byte)',
};

// Define the order to try protocols during detection based on OBDUtils.PROTOCOL_TRY_ORDER and PROTOCOL_PRIORITIES
// Using the exact order from OBDUtils.PROTOCOL_TRY_ORDER
export const PROTOCOL_TRY_ORDER = [
  PROTOCOL.ISO_15765_4_CAN_11BIT_500K, // 6
  PROTOCOL.ISO_15765_4_CAN_11BIT_250K, // 8
  PROTOCOL.ISO_15765_4_CAN_29BIT_250K, // 9
  PROTOCOL.ISO_15765_4_CAN_29BIT_500K, // 7
  PROTOCOL.ISO_15765_4_CAN_11BIT_500K_4, // D (13)
  PROTOCOL.ISO_15765_4_CAN_29BIT_500K_4, // E (14)
  PROTOCOL.ISO_15765_4_CAN_11BIT_250K_4, // F (15)
  PROTOCOL.ISO_15765_4_CAN_29BIT_250K_4, // 10 (16)
  PROTOCOL.ISO_15765_4_CAN_11BIT_500K_8, // 11 (17)
  PROTOCOL.ISO_15765_4_CAN_29BIT_500K_8, // 12 (18)
  PROTOCOL.ISO_15765_4_CAN_11BIT_250K_8, // 13 (19)
  PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8, // 14 (20)
  PROTOCOL.SAE_J1939_CAN_29BIT_250K, // A (10)
  PROTOCOL.USER1_CAN_11BIT_125K, // B (11)
  PROTOCOL.USER2_CAN_11BIT_50K, // C (12)
  PROTOCOL.SAE_J1850_PWM, // 1
  PROTOCOL.SAE_J1850_VPW, // 2
  PROTOCOL.ISO_9141_2, // 3
  PROTOCOL.ISO_14230_4_KWP, // 4
  PROTOCOL.ISO_14230_4_KWP_FAST, // 5
] as const;

// Merge from OBDUtils.js ELM_COMMANDS and CMD
// Uses explicit names where possible, includes necessary AT commands from init sequences
export const ELM_COMMANDS = {
  // System commands
  RESET: 'ATZ', // From CMD.RESET / ELM_COMMANDS.RESET
  WARM_START: 'ATWS', // From CMD.WARMSTART
  DEFAULTS: 'ATD', // From CMD.DEFAULTS
  READ_INFO: 'ATI', // From CMD.INFO
  LOW_POWER: 'ATLP', // From CMD.LOWPOWER
  READ_VOLTAGE: 'ATRV', // Explicitly use RV / ELM_COMMANDS.READ_VOLTAGE

  // Protocol commands
  PROTOCOL_CLOSE: 'ATPC', // From CMD.PROTOCLOSE / ELM_COMMANDS.PROTOCOL_CLOSE
  GET_PROTOCOL: 'ATDP', // From CMD.GETPROT
  GET_PROTOCOL_NUM: 'ATDPN', // Explicit alias from ELM_COMMANDS / ELM_COMMANDS.GET_PROTOCOL
  SET_PROTOCOL_PREFIX: 'ATSP', // From CMD.SETPROT / ELM_COMMANDS.SET_PROTOCOL_PREFIX (takes parameter)
  AUTO_PROTOCOL: 'ATSP0', // Specific case of ATSP, From ELM_COMMANDS.AUTO_PROTOCOL
  TRY_PROTOCOL_PREFIX: 'ATTP', // From ELM_COMMANDS.TRY_PROTOCOL_PREFIX (takes parameter)
  MONITOR_ALL: 'ATMA', // From CMD.CANMONITOR

  // Communication settings
  ECHO_OFF: 'ATE0', // From CMD.ECHO=0 / ELM_COMMANDS.ECHO_OFF
  ECHO_ON: 'ATE1', // From CMD.ECHO=1
  LINEFEEDS_OFF: 'ATL0', // From CMD.SETLINEFEED=0 / ELM_COMMANDS.LINEFEEDS_OFF
  LINEFEEDS_ON: 'ATL1', // From CMD.SETLINEFEED=1
  SPACES_OFF: 'ATS0', // From CMD.SETSPACES=0 / ELM_COMMANDS.SPACES_OFF
  SPACES_ON: 'ATS1', // From CMD.SETSPACES=1
  HEADERS_OFF: 'ATH0', // From CMD.SETHEADER=0 / ELM_COMMANDS.HEADERS_OFF
  HEADERS_ON: 'ATH1', // From CMD.SETHEADER=1
  ADAPTIVE_TIMING_OFF: 'ATAT0', // From CMD.ADAPTTIMING=0
  ADAPTIVE_TIMING_1: 'ATAT1', // From CMD.ADAPTTIMING=1 (used in some init)
  ADAPTIVE_TIMING_2: 'ATAT2', // From CMD.ADAPTTIMING=2 / ELM_COMMANDS.ADAPTIVE_TIMING_2
  SET_TIMEOUT: 'ATST', // From CMD.SETTIMEOUT (param needed)
  SET_HEADER: 'ATSH', // From CMD.SETTXHDR (param needed)

  // CAN Specific (from JS CMD and direct usage)
  CAN_AUTO_FORMAT_OFF: 'ATCAF0',
  CAN_AUTO_FORMAT_ON: 'ATCAF1',
  CAN_RX_FILTER_CLEAR: 'ATCRA', // From CMD.CLRCANRXFLT (no param)
  CAN_RX_FILTER_SET: 'ATCF', // CMD.SETCANRXFLT uses ATCF <filter>
  CAN_RX_MASK_SET: 'ATCM', // CMD.SETCANRXFLT uses ATCM <mask>
  CAN_FLOW_CONTROL_HEADER: 'ATFCSH', // (param needed) - from ElmProtocolHelper
  CAN_FLOW_CONTROL_DATA: 'ATFCSD', // (param needed) - from ElmProtocolHelper
  CAN_FLOW_CONTROL_MODE: 'ATFCSM', // (param needed) - from ElmProtocolHelper

  // Common OBD commands (used in connection checks etc.)
  GET_SUPPORTED_PIDS_01_20: '0100', // Mode 01 PID 00 (STANDARD_PIDS.BASIC_INFO)
} as const;

// Standard PIDs for common parameters (Merge from OBDUtils STANDARD_PIDS if needed)
// Includes PIDs used in protocol testing or basic info checks
export const STANDARD_PIDS = {
  // Mode 01 (current data)
  SUPPORTED_PIDS_1: '0100', // PIDs supported [01 - 20] (BASIC_INFO)
  MONITOR_STATUS: '0101', // Monitor status since DTCs cleared
  ENGINE_COOLANT_TEMP: '0105',
  SHORT_TERM_FUEL_TRIM_1: '0106',
  LONG_TERM_FUEL_TRIM_1: '0107',
  FUEL_PRESSURE: '010A', // From PID_MAP_FOR_DELAY_IN_SENT_COMMAND
  INTAKE_MAP: '010B', // Intake manifold absolute pressure
  ENGINE_RPM: '010C',
  VEHICLE_SPEED: '010D',
  TIMING_ADVANCE: '010E',
  INTAKE_TEMP: '010F', // Intake air temperature
  MAF_RATE: '0110', // Mass air flow rate
  THROTTLE_POS: '0111',
  OXYGEN_SENSORS_PRESENT_1: '0113', // From OBDUtils TEST_COMMANDS (placeholder)
  OXYGEN_SENSOR_1_VOLTAGE: '0114', // O2 Sensor 1, Bank 1 Voltage (from TEST_COMMANDS / PID_MAP)
  OBD_STANDARD: '011C', // OBD standards this vehicle conforms to
  SUPPORTED_PIDS_2: '0120', // PIDs supported [21 - 40]
  COMMANDED_EGR: '012C', // From PID_MAP_FOR_DELAY_IN_SENT_COMMAND (Commanded EGR)
  EGR_ERROR: '012D', // From PID_MAP_FOR_DELAY_IN_SENT_COMMAND (EGR Error)
  CATALYST_TEMP_B1S1: '013C', // From PID_MAP_FOR_DELAY_IN_SENT_COMMAND (Catalyst Temp Bank 1, Sensor 1)
  CATALYST_TEMP_B1S2: '013E', // From PID_MAP (Catalyst Temp Bank 1, Sensor 2)

  // Mode 09 (vehicle info)
  SUPPORTED_PIDS_9: '0900', // PIDs supported [01 - 20] for Mode 09
  VIN: '0902', // VIN Request
  VIN_MSG_COUNT: '0901', // From ElmProtocolHelper (VIN Message Count/VIN Data) - less common
  CALIBRATION_ID: '0904',
  ECU_NAME: '090A',
} as const;

// Common test command used during protocol validation
export const PROTOCOL_TEST_COMMAND = STANDARD_PIDS.SUPPORTED_PIDS_1; // '0100'
