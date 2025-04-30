import { ElmEcuConnector, ElmProtocols } from './ElmEcuConnector';
import { isCanProtocol } from '../protocols/config/protocolConfigs';
import {
  PROTOCOL,
  OBD_MODE,
  ELM_COMMANDS,
  RESPONSE_KEYWORDS,
} from '../utils/constants';
import type {
  RawDTCResponse,
  SendCommandFunction,
  SendCommandRawFunction,
  AdapterInfo,
} from '../utils/types';
import {
  isResponseError,
  extractVoltage,
  parseDtcsFromResponse, // Keep using the local helper
  cleanResponse,
} from '../utils/helpers';
import { VINRetriever } from '../retrievers/VINRetriever';
import { log } from '../../utils/logger';

// --- Constants ---
// Use correct OBD_MODE members from constants.ts
const DTC_REQUEST_COMMANDS = {
  [OBD_MODE.CURRENT_DTC]: '03',
  [OBD_MODE.PENDING_DTC]: '07',
  [OBD_MODE.PERMANENT_DTC]: '0A',
};

// --- Helper Functions ---

/**
 * Logger function with default level.
 */
const defaultLogger = (
  level: 'info' | 'warn' | 'error' | 'debug' = 'info',
  message: string,
  data?: unknown, // Use unknown instead of any
) => {
  log[level](`[connectionService] ${message}`, data);
};

/**
 * Parses a raw hex string response into an array of numbers.
 */
const parseHexResponseToNumbers = (response: string): number[] => {
  const cleaned = cleanResponse(response);
  // Remove any non-hex characters and spaces, then split into bytes
  const hexBytes = cleaned.replace(/[^0-9A-F\s]/gi, '').split(/\s+/);
  return hexBytes.map(byte => parseInt(byte, 16)).filter(num => !isNaN(num));
};

/**
 * Maps ElmProtocols enum (0-12) to PROTOCOL enum (0-20).
 * Returns null if no direct mapping exists.
 */
const mapElmProtocolToProtocol = (
  elmProtocol: ElmProtocols | null,
): PROTOCOL | null => {
  if (elmProtocol === null) return null;
  // Direct mapping for 0-12 as they align
  if (
    elmProtocol >= PROTOCOL.AUTO &&
    elmProtocol <= PROTOCOL.USER2_CAN_11BIT_50K
  ) {
    return elmProtocol as number as PROTOCOL;
  }
  // Add specific mappings if ElmProtocols had different values for A, B, C
  // Assuming direct mapping holds for 0-12 based on current definitions
  log.warn(
    `[connectionService] Cannot map ElmProtocol ${elmProtocol} to PROTOCOL enum.`,
  );
  return null;
};

// --- Public Service Functions ---

/**
 * Initializes the ELM adapter with basic settings.
 */
export const initializeAdapter = async (
  sendCommand: SendCommandFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown,
  ) => void = defaultLogger,
): Promise<boolean> => {
  await logger('debug', 'Initializing adapter...');
  const initCommands = [
    ELM_COMMANDS.RESET, // Start with reset
    ELM_COMMANDS.ECHO_OFF,
    ELM_COMMANDS.LINEFEEDS_OFF,
    ELM_COMMANDS.SPACES_OFF,
    ELM_COMMANDS.HEADERS_ON, // Keep headers on for now, might be needed
    ELM_COMMANDS.ADAPTIVE_TIMING_1, // Use ATAT1 instead of non-existent AUTO
    `${ELM_COMMANDS.SET_TIMEOUT}64`, // ~100ms timeout
  ];

  try {
    for (const cmd of initCommands) {
      const response = await sendCommand(
        cmd,
        cmd === ELM_COMMANDS.RESET ? 2000 : 1000,
      );
      if (response === null || isResponseError(response)) {
        // Allow reset to fail sometimes on clones, but log warning
        if (cmd === ELM_COMMANDS.RESET && response === null) {
          await logger(
            'warn',
            `Adapter reset (ATZ) might have failed (no response), continuing initialization...`,
          );
          continue; // Continue with other init commands
        }
        await logger(
          'error',
          `Failed to initialize adapter. Command: ${cmd}, Response: ${response ?? 'null'}`,
        );
        return false;
      }
      await logger('debug', `Adapter init command OK: ${cmd}`);
      // Add delay after reset
      if (cmd === ELM_COMMANDS.RESET) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Delay after ATZ
      }
    }
    await logger('info', 'Adapter initialized successfully.');
    return true;
  } catch (error: unknown) {
    // Use unknown instead of any
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', 'Error during adapter initialization:', {
      error: errorMsg,
    });
    return false;
  }
};

/**
 * Retrieves basic adapter information, primarily voltage.
 */
export const getAdapterInfo = async (
  sendCommand: SendCommandFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void = defaultLogger,
): Promise<AdapterInfo> => {
  await logger('debug', 'Getting adapter info (ATRV)...');
  try {
    const response = await sendCommand(ELM_COMMANDS.READ_VOLTAGE, 2000);
    const voltageString = extractVoltage(response);
    await logger('debug', `Voltage string received: ${voltageString}`);
    return { voltage: voltageString };
  } catch (error: unknown) {
    // Use unknown instead of any
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', 'Error reading adapter voltage (ATRV):', {
      error: errorMsg,
    });
    return { voltage: null };
  }
};

/**
 * Retrieves the Vehicle Identification Number (VIN).
 */
export const getVIN = async (
  sendCommand: SendCommandFunction,
  sendCommandRaw: SendCommandRawFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void = defaultLogger,
): Promise<string | null> => {
  await logger('debug', 'Getting VIN...');

  // Create adapter to convert SendCommandRawFunction to SendCommandFunction
  const adaptedSendCommandRaw: SendCommandFunction = async (
    cmd: string,
  ): Promise<string | null> => {
    const result = await sendCommandRaw(cmd);
    if (!result) return null;

    // Convert chunks to string if array, otherwise ensure string type
    if (Array.isArray(result)) {
      // Handle array of bytes directly
      return result
        .map(chunk => Buffer.from(chunk).toString('hex').toUpperCase())
        .join('');
    }

    // Handle ChunkedResponse type
    if (result && typeof result === 'object' && 'data' in result) {
      // Convert Uint8Array chunks to hex string
      return (result as { data: Uint8Array[] }).data
        .map(chunk => Buffer.from(chunk).toString('hex').toUpperCase())
        .join('');
    }

    // For any other string-like response
    return String(result);
  };

  // Create VINRetriever instance with adapted function
  const vinRetriever = new VINRetriever(sendCommand, adaptedSendCommandRaw);
  try {
    const vin = await vinRetriever.retrieveVIN();
    await logger('debug', `VIN received: ${vin}`);
    return vin;
  } catch (error: unknown) {
    // Use unknown instead of any
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', 'Error getting VIN:', { error: errorMsg });
    return null;
  }
};

/**
 * Retrieves Diagnostic Trouble Codes (DTCs) based on the specified mode.
 */
export const getDTCs = async (
  // Use correct OBD_MODE members
  mode: OBD_MODE.CURRENT_DTC | OBD_MODE.PENDING_DTC | OBD_MODE.PERMANENT_DTC,
  ecuConnector: ElmEcuConnector, // Pass the connector instance
  sendCommand: SendCommandFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown,
  ) => void = defaultLogger,
): Promise<RawDTCResponse | null> => {
  const commandCode = DTC_REQUEST_COMMANDS[mode];
  if (!commandCode) {
    await logger('error', `Invalid mode specified for getDTCs: ${mode}`);
    return null;
  }

  await logger(
    'debug',
    `Getting DTCs for mode ${mode} (Command: ${commandCode})...`,
  );

  try {
    const responseStr = await sendCommand(commandCode, 5000); // Use a longer timeout for DTCs

    if (responseStr === null || isResponseError(responseStr)) {
      await logger(
        'error',
        `Failed to get DTCs for mode ${mode}. Response: ${responseStr ?? 'null'}`,
      );
      return null;
    }

    // Clean the response before parsing
    const cleanedResponse = cleanResponse(responseStr);

    // Determine if the protocol is CAN using the mapping function
    const elmProtocolNumber = ecuConnector.getCurrentProtocol();
    const protocolNumber = mapElmProtocolToProtocol(elmProtocolNumber);
    const isCan = protocolNumber !== null && isCanProtocol(protocolNumber);

    // Check for specific non-error but empty responses like "NODATA"
    if (cleanedResponse === RESPONSE_KEYWORDS.NO_DATA) {
      await logger('info', `No DTCs found for mode ${mode}.`);
      // Construct object matching RawDTCResponse
      return {
        codes: [],
        isCan: isCan,
        protocolNumber: elmProtocolNumber ?? -1,
        rawString: responseStr,
        rawResponse: responseStr
          ? Array.from(responseStr).map(c => c.charCodeAt(0))
          : null,
        response: null, // Placeholder
        rawBytesResponseFromSendCommand: [], // Placeholder
        ecuAddress: undefined, // Placeholder
      };
    }

    // Use the local helper function to parse codes
    const codes = parseDtcsFromResponse(cleanedResponse, commandCode);
    if (codes === null) {
      // Handle parsing failure
      await logger(
        'error',
        `Failed to parse DTCs for mode ${mode} from response: ${cleanedResponse}`,
      );
      return null;
    }
    await logger('debug', `Parsed DTCs for mode ${mode}:`, codes);

    // Construct the full RawDTCResponse object
    const rawResponseObject: RawDTCResponse = {
      codes,
      isCan,
      protocolNumber: elmProtocolNumber ?? -1,
      rawString: responseStr,
      rawResponse: responseStr
        ? Array.from(responseStr).map(c => c.charCodeAt(0))
        : null,
      // Provide default/empty values for other required fields
      // These might be populated more accurately by a dedicated retriever class
      response: null, // Placeholder - Requires parsing logic similar to BaseDTCRetriever
      rawBytesResponseFromSendCommand: [], // Placeholder
      ecuAddress: undefined, // Placeholder - Requires parsing logic
    };

    return rawResponseObject;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', `Error getting DTCs for mode ${mode}:`, {
      error: errorMsg,
    });
    return null;
  }
};

/**
 * Clears Diagnostic Trouble Codes (DTCs).
 */
export const clearDTCs = async (
  sendCommand: SendCommandFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void = defaultLogger,
): Promise<boolean> => {
  await logger('debug', 'Clearing DTCs (Command: 04)...');
  try {
    // Use correct OBD_MODE member
    const response = await sendCommand(OBD_MODE.CLEAR_DTC, 5000); // Use a longer timeout

    if (response === null || isResponseError(response)) {
      await logger(
        'error',
        `Failed to clear DTCs. Response: ${response ?? 'null'}`,
      );
      return false;
    }

    // Check for 'OK' or similar positive confirmation
    const cleanedResponse = cleanResponse(response);
    if (cleanedResponse.includes(RESPONSE_KEYWORDS.OK)) {
      await logger('info', 'DTCs cleared successfully.');
      return true;
    } else {
      // Some adapters might just return the prompt or nothing on success
      if (cleanedResponse === '' || cleanedResponse === '>') {
        await logger('info', 'DTCs likely cleared (empty/prompt response).');
        return true;
      }
      await logger(
        'warn',
        `Unexpected response after clearing DTCs: ${response.trim()}`,
      );
      // Consider this success unless it's a known error pattern (already checked by isResponseError)
      return true;
    }
  } catch (error: unknown) {
    // Use unknown instead of any
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', 'Error clearing DTCs:', { error: errorMsg });
    return false;
  }
};

/**
 * Retrieves live data for a specific PID.
 */
export const getLiveData = async (
  pid: string,
  sendCommand: SendCommandFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void = defaultLogger,
): Promise<number[] | null> => {
  // Construct the command (Mode 01 + PID)
  // Use correct OBD_MODE member
  const command = `${OBD_MODE.CURRENT_DATA}${pid}`;
  await logger(
    'debug',
    `Getting live data for PID ${pid} (Command: ${command})...`,
  );

  try {
    const response = await sendCommand(command, 2000); // Standard timeout for live data

    if (response === null || isResponseError(response)) {
      await logger(
        'error',
        `Failed to get live data for PID ${pid}. Response: ${response ?? 'null'}`,
      );
      return null;
    }

    // Clean the response
    const cleanedResponse = cleanResponse(response);

    // Check for NO DATA specifically
    if (cleanedResponse === RESPONSE_KEYWORDS.NO_DATA) {
      await logger('warn', `No data received for PID ${pid}.`);
      return null;
    }

    // Expecting a response starting with 41 (Mode 01 response)
    if (!cleanedResponse.startsWith('41')) {
      await logger(
        'warn',
        `Unexpected response format for PID ${pid}: ${response.trim()}`,
      );
      // Attempt to parse anyway, might contain data without the header
      // return null;
    }

    // Parse the hex response into numbers
    // Example: "41 0C 0A F0" -> [65, 12, 10, 240]
    const dataBytes = parseHexResponseToNumbers(cleanedResponse);

    // Basic validation: check if we got at least the mode and PID back
    if (
      dataBytes.length < 2 ||
      dataBytes[0] !== 0x41 ||
      dataBytes[1] !== parseInt(pid, 16)
    ) {
      await logger(
        'warn',
        `Response for PID ${pid} seems incorrect after parsing: ${JSON.stringify(dataBytes)}`,
      );
      // Return the parsed bytes anyway, let the caller decide
      // return null;
    }

    await logger('debug', `Parsed live data for PID ${pid}:`, dataBytes);
    return dataBytes;
  } catch (error: unknown) {
    // Use unknown instead of any
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', `Error getting live data for PID ${pid}:`, {
      error: errorMsg,
    });
    return null;
  }
};

// --- Internal Helper for Protocol Detection (Example) ---
// This is a simplified version. Real detection is more complex.

/**
 * Attempts to determine the protocol by trying a standard command.
 * This is a VERY basic example and might not be reliable.
 * Proper protocol detection is handled by ElmEcuConnector.
 */
export const simpleProtocolCheck = async (
  sendCommand: SendCommandFunction,
  logger: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void = defaultLogger,
): Promise<string | null> => {
  await logger('debug', 'Performing simple protocol check (ATDP)...');
  try {
    const response = await sendCommand(ELM_COMMANDS.GET_PROTOCOL, 2000);
    if (response === null || isResponseError(response)) {
      await logger('warn', 'No response or error during protocol check.');
      return null;
    }

    const cleanedResponse = cleanResponse(response);
    await logger('debug', `Protocol check response: ${cleanedResponse}`);

    // Simple check: does the response contain a known protocol string?
    if (cleanedResponse.includes('ISO')) {
      await logger('info', 'ISO protocol detected.');
      return 'ISO';
    } else if (cleanedResponse.includes('CAN')) {
      await logger('info', 'CAN protocol detected.');
      return 'CAN';
    } else {
      await logger('warn', `Unknown protocol response: ${cleanedResponse}`);
      return null;
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logger('error', 'Error during simple protocol check:', {
      error: errorMsg,
    });
    return null;
  }
};
