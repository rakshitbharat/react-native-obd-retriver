import { log } from '../../utils/logger';
import { ProtocolManager } from '../protocols/ProtocolManager';
import { VINRetriever } from '../retrievers/VINRetriever'; // Import the new VINRetriever
import {
  DELAYS_MS,
  ELM_COMMANDS,
  OBD_MODE,
  RESPONSE_KEYWORDS,
  STANDARD_PIDS,
  PROTOCOL, // Import PROTOCOL enum
} from '../utils/constants';
import {
  cleanResponse,
  isResponseOk,
  isResponseError,
  extractProtocolNumber, // Keep for potential use elsewhere if needed
  extractVoltage,
  extractEcuAddresses,
  assembleMultiFrameResponse, // Keep helper, might be used elsewhere
  parseDtcsFromResponse,
} from '../utils/helpers';

import type {
  SendCommandFunction,
  SendCommandFunctionWithResponse,
  RawDTCResponse,
} from '../utils/types';

/**
 * Result type for ECU connection attempt
 *
 * This represents the result of a connection attempt to the vehicle's ECU,
 * including protocol information, vehicle voltage, and detected ECU addresses.
 *
 * @example
 * ```typescript
 * // Example of a successful connection result
 * const successResult: ConnectionResult = {
 *   success: true,
 *   protocol: PROTOCOL.ISO_15765_4_CAN_11BIT_500K,
 *   protocolName: "ISO 15765-4 CAN (11 bit ID, 500 kbaud)",
 *   voltage: "12.6V",
 *   detectedEcus: ["7E8", "7E9"]
 * };
 *
 * // Example of a failed connection result
 * const failedResult: ConnectionResult = {
 *   success: false,
 *   error: "No response from ECU after protocol initialization"
 * };
 * ```
 */
type ConnectionResult = {
  /** Whether the connection was successful */
  success: boolean;

  /**
   * Detected protocol identifier from the PROTOCOL enum
   * Only present on successful connection
   */
  protocol?: PROTOCOL | null;

  /**
   * Human-readable protocol name
   * Only present on successful connection
   */
  protocolName?: string | null;

  /**
   * Current vehicle voltage with unit (e.g., "12.6V")
   * May be present on successful connection
   */
  voltage?: string | null;

  /**
   * Error message describing why connection failed
   * Only present on failed connection
   */
  error?: string;

  /**
   * Array of detected ECU addresses (e.g., ["7E8", "7E9"])
   * Only present on successful connection
   */
  detectedEcus?: string[];
};

/**
 * Information about the OBD adapter
 *
 * Contains basic information retrieved from the OBD adapter,
 * such as battery voltage and identification.
 *
 * @example
 * ```typescript
 * const info = await getAdapterInfo();
 * console.log(`Adapter voltage: ${info.voltage || "Unknown"}`);
 * ```
 */
type AdapterInfo = {
  /** Current adapter/vehicle voltage with unit (e.g., "12.6V") */
  voltage: string | null;
  // Add other adapter info if needed in the future
};

/**
 * Delay function.
 */
const delay = (ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms);
  });

/**
 * Initializes the ELM327 adapter with standard settings
 *
 * This function performs the initial setup sequence for the OBD adapter:
 * 1. Resets the adapter to default settings with ATZ
 * 2. Disables echo with ATE0 (prevents commands from being echoed back)
 * 3. Disables linefeeds with ATL0 (cleaner responses)
 * 4. Disables spaces with ATS0 (more compact output)
 * 5. Verifies adapter responsiveness
 *
 * Note: Protocol-specific settings like headers are typically configured
 * *after* successful protocol detection.
 *
 * Based on logic in ElmProtocolInit.initializeProtocol and initializeDevice.
 *
 * @example
 * ```typescript
 * // Initialize adapter before attempting protocol detection
 * const initialized = await initializeAdapter(sendCommand);
 * if (initialized) {
 *   console.log("Adapter initialized successfully");
 *   // Proceed with protocol detection
 *   const protocolResult = await detectProtocol(sendCommand);
 * } else {
 *   console.error("Failed to initialize adapter");
 * }
 * ```
 *
 * @param sendCommand - Function to send commands to the adapter
 * @returns Promise resolving to true if initialization was successful, false otherwise
 */
export const initializeAdapter = async (
  sendCommand: SendCommandFunction,
): Promise<boolean> => {
  await log.debug('[connectionService] Initializing adapter...');

  const initCommands = [
    {
      cmd: ELM_COMMANDS.RESET,
      delay: DELAYS_MS.RESET,
      ignoreError: true,
      checkOk: false,
      timeout: 3000, // Longer timeout for reset
    },
    {
      cmd: ELM_COMMANDS.ECHO_OFF,
      delay: DELAYS_MS.INIT,
      ignoreError: false,
      checkOk: true,
      timeout: 2000,
    },
    {
      cmd: ELM_COMMANDS.LINEFEEDS_OFF,
      delay: DELAYS_MS.INIT,
      ignoreError: false,
      checkOk: true,
    },
    {
      cmd: ELM_COMMANDS.SPACES_OFF,
      delay: DELAYS_MS.INIT,
      ignoreError: false,
      checkOk: true,
    },
    // Headers OFF initially, will be turned ON by ProtocolManager if needed (e.g., for CAN)
    {
      cmd: ELM_COMMANDS.HEADERS_OFF,
      delay: DELAYS_MS.INIT,
      ignoreError: false,
      checkOk: true,
    },
    // Adaptive Timing OFF initially, ProtocolManager will set ATAT1/2 later
    {
      cmd: ELM_COMMANDS.ADAPTIVE_TIMING_OFF,
      delay: DELAYS_MS.INIT,
      ignoreError: false,
      checkOk: true,
    },
    // Set a default timeout (e.g., 100ms = 64 hex) - ProtocolManager might adjust later
    // const defaultTimeoutHex = DELAYS_MS.TIMEOUT_NORMAL_MS.toString(16).toUpperCase().padStart(2,'0');
    // { cmd: `${ELM_COMMANDS.SET_TIMEOUT}${defaultTimeoutHex}`, delay: DELAYS_MS.INIT, ignoreError: false, checkOk: true },
  ];

  /**
   * Helper function to check if response contains OK or variants
   */
  const isValidResponse = (response: string | null): boolean => {
    if (!response) return false;

    // Clean response by removing prompts, carriage returns, etc
    const cleaned = response
      .replace(/[\r\n>]/g, '')
      .trim()
      .toUpperCase();

    // Check for common valid responses (case insensitive)
    return [
      'OK',
      'ELM327',
      'ATZ',
      'ATE',
      'ATE0OK',
      'ATL',
      'ATL0OK',
      'ATS',
      'ATS0OK',
      'ATH',
      'ATH0OK',
      'ATAT',
      'ATAT0OK',
    ].some(validResponse => cleaned.includes(validResponse));
  };

  try {
    for (const {
      cmd,
      delay: cmdDelay,
      ignoreError,
      checkOk,
      timeout,
    } of initCommands) {
      await log.debug(`[connectionService] Sending init command: ${cmd}`);
      const response = await sendCommand(cmd, timeout);
      await delay(cmdDelay);

      if (!ignoreError) {
        if (response === null || isResponseError(response)) {
          await log.error(
            `[connectionService] Init command "${cmd}" failed. Response: ${response ?? 'null'}`,
          );
          return false;
        }

        if (checkOk && !isValidResponse(response)) {
          await log.error(
            `[connectionService] Init command "${cmd}" failed validation. Response: ${response}`,
          );
          return false;
        }
      } else {
        await log.debug(
          `[connectionService] Init command "${cmd}" response (errors ignored): ${response ?? 'null'}`,
        );
      }
    }

    // Final check: Read voltage to ensure adapter is responsive after init
    const voltageResponse = await sendCommand(ELM_COMMANDS.READ_VOLTAGE, 2000);
    const voltage = extractVoltage(voltageResponse);
    if (
      !voltageResponse ||
      isResponseError(voltageResponse) ||
      voltage === null
    ) {
      await log.error(
        `[connectionService] Adapter unresponsive after initialization (ATRV failed or returned invalid voltage). Response: ${voltageResponse ?? 'null'}`,
      );
      return false;
    }

    await log.info(
      `[connectionService] Adapter initialized successfully. Voltage: ${voltage}`,
    );
    return true;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log.error(
      '[connectionService] Critical error during adapter initialization:',
      { error: errorMsg },
    );
    return false;
  }
};

/**
 * Connects to the vehicle's ECU with automatic protocol detection
 *
 * This function performs the complete connection sequence:
 * 1. Initializes the OBD adapter with standard settings
 * 2. Detects the appropriate protocol for the vehicle
 * 3. Configures protocol-specific settings
 * 4. Retrieves adapter information (voltage)
 * 5. Identifies available ECU addresses
 *
 * This is the main entry point for establishing communication with a vehicle
 * and should be used before attempting to retrieve any vehicle data.
 *
 * Based on ECUConnector.connectToECU and ProtocolServiceBased.connectToECU flow.
 *
 * @example
 * ```typescript
 * // Connect to the vehicle's ECU
 * const result = await connectToECU(sendCommand);
 *
 * if (result.success) {
 *   console.log("Successfully connected to vehicle:");
 *   console.log(`Protocol: ${result.protocolName} (${result.protocol})`);
 *   console.log(`ECUs detected: ${result.detectedEcus?.join(', ')}`);
 *   console.log(`Vehicle voltage: ${result.voltage}`);
 *
 *   // Continue with vehicle diagnostics, data retrieval, etc.
 * } else {
 *   console.error(`Connection failed: ${result.error}`);
 *
 *   // Handle connection failure (e.g., retry, user notification)
 * }
 * ```
 *
 * @param sendCommand - Function to send commands to the OBD adapter
 * @returns Promise resolving to a ConnectionResult object with connection details
 */
export const connectToECU = async (
  sendCommand: SendCommandFunction,
): Promise<ConnectionResult> => {
  await log.info('[connectionService] Attempting to connect to ECU...');

  // 1. Initialize Adapter
  const initSuccess = await initializeAdapter(sendCommand);
  if (!initSuccess) {
    return { success: false, error: 'Adapter initialization failed' };
  }

  // 2. Detect and Set Protocol using ProtocolManager
  const protocolManager = new ProtocolManager(sendCommand);
  const protocolResult = await protocolManager.detectAndSetProtocol();

  if (!protocolResult || protocolResult.protocol === null) {
    // Attempt recovery if protocol detection fails? From ECUConnector retry logic
    // await log.warn('[connectionService] Protocol detection failed. Attempting recovery (ATPC, ATZ)...');
    // try {
    //     await sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE, 1000);
    //     await delay(DELAYS_MS.PROTOCOL_SWITCH);
    //     await sendCommand(ELM_COMMANDS.RESET, 1000); // Should be handled by next init attempt?
    // } catch { /* ignore recovery error */ }
    return { success: false, error: 'Protocol detection failed' };
  }

  const { protocol, name: protocolName } = protocolResult;

  // 3. Apply Protocol Specific Settings (e.g., Headers ON for CAN, ATAT1)
  await protocolManager.configureProtocolSettings(protocol);

  // 4. Get Adapter Info (Voltage) - confirms adapter is still responsive after protocol setup
  const adapterInfo = await getAdapterInfo(sendCommand);
  if (adapterInfo.voltage === null) {
    // Voltage read failed after protocol setup, consider this a connection failure
    await log.error(
      '[connectionService] Failed to read voltage after protocol setup. Connection unstable.',
    );
    return {
      success: false,
      error: 'Adapter unresponsive after protocol setup',
      protocol,
      protocolName,
    };
  }

  // 5. Final check / ECU discovery using a standard command (e.g., 0100)
  let detectedEcus: string[] = [];
  try {
    // Use the standard test command defined in constants
    const testCmd = STANDARD_PIDS.SUPPORTED_PIDS_1; // Usually 0100
    await log.debug(
      `[connectionService] Sending final test command: ${testCmd}`,
    );
    // Use a reasonable timeout for ECU response
    const testResponse = await sendCommand(testCmd, 5000);

    if (testResponse) {
      const cleaned = cleanResponse(testResponse).toUpperCase();

      // Check for valid response patterns
      const isValidResponse =
        cleaned.includes('41') || // Standard response prefix
        cleaned.includes('SEARCHING...41'); // Auto-detection response

      if (isValidResponse) {
        await log.info(
          `[connectionService] Test command successful with response: ${cleaned}`,
        );

        // Extract ECU address more reliably
        if (cleaned.match(/^7E[0-9A-F][0-9A-F]/)) {
          // For CAN responses starting with 7Ex
          detectedEcus = [cleaned.substring(0, 3)];
        } else {
          // Try standard extraction for other formats
          detectedEcus = extractEcuAddresses(cleaned);
        }

        await log.debug(
          `[connectionService] Detected ECU addresses: ${detectedEcus.join(', ')}`,
        );
      }
    } else {
      await log.warn(
        `[connectionService] Test command (${testCmd}) failed or returned error after protocol set. Response: ${testResponse ?? 'null'}`,
      );
      // Consider this potentially problematic, but proceed if voltage was read okay.
      // Maybe return success but with a warning? For now, proceed.
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log.warn(
      '[connectionService] Error during final ECU check command:',
      { error: errorMsg },
    );
  }

  await log.info(
    `[connectionService] Connection established. Protocol: ${protocolName} (${protocol}), Voltage: ${adapterInfo.voltage}, ECUs: ${detectedEcus.join(', ')}`,
  );

  // Connection successful
  return {
    success: true,
    protocol: protocol,
    protocolName: protocolName,
    voltage: adapterInfo.voltage,
    detectedEcus: detectedEcus.length > 0 ? detectedEcus : ['7E8'], // Fallback to default if none detected
  };
};

/**
 * Fetches basic adapter information like voltage using ATRV.
 * Based on logic in ElmProtocol.getVoltage and connectionService.
 * @param sendCommand Function to send commands to the adapter.
 * @returns AdapterInfo object containing retrieved information.
 */
export const getAdapterInfo = async (
  sendCommand: SendCommandFunction,
): Promise<AdapterInfo> => {
  await log.debug('[connectionService] Getting adapter info (ATRV)...');
  try {
    // Use a specific timeout for voltage read
    const voltageResponse = await sendCommand(ELM_COMMANDS.READ_VOLTAGE, 2000);
    const voltage = extractVoltage(voltageResponse);
    if (voltage === null) {
      await log.warn(
        `[connectionService] Failed to extract voltage from ATRV response: ${voltageResponse ?? 'null'}`,
      );
    }
    await log.debug(`[connectionService] Adapter Voltage: ${voltage ?? 'N/A'}`);
    return { voltage };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log.error(
      '[connectionService] Failed to get adapter voltage (ATRV):',
      { error: errorMsg },
    );
    return { voltage: null };
  }
};

/**
 * Disconnects from the ECU by closing the active protocol session
 *
 * This function sends the Protocol Close (ATPC) command to the adapter,
 * which terminates the current communication session with the vehicle's ECU.
 * This is important for proper cleanup before:
 * - Disconnecting from the adapter
 * - Switching to a different protocol
 * - Ending a diagnostic session
 *
 * The function handles errors gracefully and won't throw exceptions,
 * making it safe to call during application cleanup.
 *
 * Based on logic in ECUConnector.resetDevice (partial).
 *
 * @example
 * ```typescript
 * // After completing diagnostics, disconnect from the ECU
 * await disconnectFromECU(sendCommand);
 * console.log("ECU session closed");
 *
 * // Now safe to disconnect Bluetooth if needed
 * await bluetoothManager.disconnect();
 * ```
 *
 * @param sendCommand - Function to send commands to the adapter
 * @returns Promise that resolves when disconnection is complete
 */
export const disconnectFromECU = async (
  sendCommand: SendCommandFunction,
): Promise<void> => {
  await log.info(
    '[connectionService] Disconnecting from ECU (sending ATPC)...',
  );
  try {
    // Send ATPC without timeout, let adapter handle timing
    await sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE);
    await log.debug('[connectionService] Protocol close command (ATPC) sent.');
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log.warn(
      '[connectionService] Error sending protocol close command (ATPC) during disconnect:',
      { error: errorMsg },
    );
  }
};

// ==========================================================================
// --- NON-ECU FUNCTIONS (VIN, DTC, CLEAR, RAW DTC) ---
// --- These functions remain UNCHANGED as per the requirements.            ---
// --- Only logging and type annotations are updated for consistency.     ---
// --- VIN Retrieval is now updated to use VINRetriever                 ---
// ==========================================================================

/**
 * Retrieves the Vehicle Identification Number (VIN)
 *
 * The VIN is a unique 17-character identifier assigned to every vehicle and
 * contains encoded information about the vehicle's manufacturer, features,
 * and specifications.
 *
 * This function uses the VINRetriever to handle:
 * - Sending the Mode 09 PID 02 request to the vehicle
 * - Managing flow control for multi-frame responses
 * - Retrying if needed for reliable retrieval
 * - Parsing and validating the VIN format
 *
 * Note: The ECU connection must be established before calling this function.
 *
 * @example
 * ```typescript
 * // First establish connection
 * const connectionResult = await connectToECU(sendCommand);
 *
 * if (connectionResult.success) {
 *   // Retrieve the VIN
 *   const vin = await getVehicleVIN(sendCommand);
 *
 *   if (vin) {
 *     console.log(`Vehicle VIN: ${vin}`);
 *     // Example: "1G1JC5444R7252367"
 *
 *     // First character (1) = Country of manufacture (USA)
 *     // Second character (G) = Manufacturer (General Motors)
 *     // Positions 4-8 = Vehicle attributes
 *     // Position 10 = Model year
 *     // Position 11 = Assembly plant
 *     // Last 6 digits = Sequential production number
 *   } else {
 *     console.error("Failed to retrieve VIN");
 *   }
 * }
 * ```
 *
 * @param sendCommand - Function to send commands to the OBD adapter
 * @returns Promise resolving to the VIN string or null if it could not be retrieved
 */
export const getVehicleVIN = async (
  sendCommand: SendCommandFunction,
  sendCommandRawChunked: SendCommandFunctionWithResponse,
): Promise<string | null> => {
  await log.debug(
    '[connectionService] Attempting to retrieve VIN using VINRetriever...',
  );
  try {
    // Create VINRetriever instance with both command functions
    const vinRetriever = new VINRetriever(sendCommand, sendCommandRawChunked);

    // Call the retriever's method to get the VIN
    const vin = await vinRetriever.retrieveVIN();

    if (vin) {
      await log.info(`[connectionService] VIN Retrieved successfully: ${vin}`);
    } else {
      await log.warn('[connectionService] Failed to retrieve VIN.');
    }
    return vin;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log.error(
      '[connectionService] Error during VIN retrieval via VINRetriever:',
      { error: errorMsg },
    );
    return null;
  }
};

/**
 * Retrieves Diagnostic Trouble Codes (DTCs) from the vehicle
 *
 * DTCs are standardized codes used by vehicle ECUs to indicate various
 * malfunctions and system issues. This function can retrieve three types of DTCs:
 *
 * - Current/Active DTCs (Mode 03): Currently active fault conditions
 * - Pending DTCs (Mode 07): Detected issues that haven't triggered the MIL yet
 * - Permanent DTCs (Mode 0A): Severe issues that cannot be cleared with basic tools
 *
 * The function handles multi-frame responses and proper DTC formatting.
 *
 * Note: ECU connection must be established before calling this function.
 *
 * @example
 * ```typescript
 * // Retrieve current DTCs (check engine light codes)
 * const currentDTCs = await getVehicleDTCs(sendCommand, OBD_MODE.CURRENT_DTC);
 *
 * if (currentDTCs === null) {
 *   console.error("Failed to retrieve DTCs");
 * } else if (currentDTCs.length === 0) {
 *   console.log("No DTCs present (vehicle reports no issues)");
 * } else {
 *   console.log(`Found ${currentDTCs.length} trouble codes:`);
 *   currentDTCs.forEach(dtc => {
 *     console.log(`- ${dtc}`); // Example: "P0300" (Random/Multiple Misfire)
 *   });
 * }
 *
 * // You can also retrieve pending DTCs
 * const pendingDTCs = await getVehicleDTCs(sendCommand, OBD_MODE.PENDING_DTC);
 * ```
 *
 * @param sendCommand - Function to send commands to the OBD adapter
 * @param mode - The DTC mode to use (CURRENT_DTC, PENDING_DTC, or PERMANENT_DTC)
 * @returns Promise resolving to an array of DTC strings, empty array if none, or null if retrieval failed
 */
export const getVehicleDTCs = async (
  sendCommand: SendCommandFunction,
  mode: OBD_MODE.CURRENT_DTC | OBD_MODE.PENDING_DTC | OBD_MODE.PERMANENT_DTC, // Ensure correct modes
): Promise<string[] | null> => {
  await log.debug('[connectionService] Requesting DTCs', { mode }); // Use logger

  const response = await sendCommand(mode, 8000); // Use appropriate timeout

  if (response === null) {
    await log.warn('[connectionService] No response for DTC request', { mode }); // Use logger
    return null;
  }

  if (isResponseError(response)) {
    await log.error('[connectionService] Error response for DTC request', {
      mode,
      response,
    }); // Use logger
    return null;
  }

  if (cleanResponse(response).includes(RESPONSE_KEYWORDS.NO_DATA)) {
    await log.debug(
      // Use logger
      `[connectionService] NO DATA response for DTC request (Mode ${mode}). Vehicle reports no DTCs.`,
    );
    return []; // Return empty array for NO DATA
  }

  // Need to assemble multi-frame responses correctly
  const assembledResponse = assembleMultiFrameResponse(response);
  await log.debug(
    `[connectionService] Assembled DTC response (Mode ${mode}): ${assembledResponse}`,
  );

  // Calculate expected response prefix (e.g., 03 -> 43)
  // Ensure mode is treated as hex for calculation
  const responsePrefix = (parseInt(mode, 16) + 0x40).toString(16).toUpperCase();
  const dtcs = parseDtcsFromResponse(assembledResponse, responsePrefix);

  if (dtcs === null) {
    await log.error(
      `[connectionService] Failed to parse DTCs from response (Mode ${mode})`,
      { assembledResponse },
    );
  }

  return dtcs; // Return parsed DTCs or null if parsing failed
};

/**
 * Clears Diagnostic Trouble Codes (DTCs) from the vehicle's memory
 *
 * This function sends the Mode 04 command to clear DTCs and reset the
 * Malfunction Indicator Light (MIL, commonly known as the Check Engine Light).
 * It also performs verification to confirm the DTCs were actually cleared.
 *
 * Important notes about DTC clearing:
 * - Requires the vehicle's ignition to be on (but engine not necessarily running)
 * - Some vehicles require specific security access before clearing DTCs
 * - Permanent DTCs (Mode 0A) typically cannot be cleared with this method
 * - Verification ensures the vehicle actually cleared the codes (not just the adapter)
 *
 * @example
 * ```typescript
 * // Clear DTCs with verification
 * const clearSuccess = await clearVehicleDTCs(sendCommand);
 *
 * if (clearSuccess) {
 *   console.log("DTCs successfully cleared and verified");
 *   // MIL (check engine light) should turn off if previously lit
 * } else {
 *   console.error("Failed to clear DTCs or verification failed");
 *   // Vehicle might require specific conditions or access rights
 * }
 *
 * // For faster clearing without verification:
 * const quickClear = await clearVehicleDTCs(sendCommand, true);
 * // Note: This is less reliable but faster
 * ```
 *
 * @param sendCommand - Function to send commands to the OBD adapter
 * @param skipVerification - Optional flag to skip verification step (defaults to false)
 * @returns Promise resolving to true if DTCs were successfully cleared (and verified if required)
 */
export const clearVehicleDTCs = async (
  sendCommand: SendCommandFunction,
  skipVerification: boolean = false,
): Promise<boolean> => {
  const clearCommand = OBD_MODE.CLEAR_DTC; // Mode 04

  await log.debug(
    // Use logger
    `[connectionService] Starting DTC clearing sequence (Mode ${clearCommand})...`,
  );

  // Minimal setup: Ensure headers/spaces/etc. are off for clean response check? Maybe not necessary.
  // Let's try sending 04 directly first.

  await log.debug(
    // Use logger
    `[connectionService] Sending DTC clear command (${clearCommand})...`,
  );
  // Mode 04 can take longer
  const response = await sendCommand(clearCommand, 10000);

  if (response === null) {
    await log.error(
      // Use logger
      '[connectionService] No response received for Clear DTC command.',
    );
    return false;
  }

  // Successful response for Mode 04 is just "44" (or "OK" from ELM)
  const cleanedResponse = cleanResponse(response);
  // Need to handle multi-line responses which might contain "44" and other data/headers
  const isSuccessful = cleanedResponse.includes('44') || isResponseOk(response); // Check for 44 or OK

  if (!isSuccessful || isResponseError(response)) {
    await log.error(
      // Use logger
      `[connectionService] Clear command failed or returned error. Response: ${response}`,
    );
    return false;
  }

  await log.debug(
    // Use logger
    `[connectionService] Clear command received successful-looking response: ${cleanedResponse}`,
  );

  if (skipVerification) {
    await log.debug('[connectionService] Verification skipped as requested.'); // Use logger
    return true;
  }

  // Verification Steps
  await log.debug(`[connectionService] Clear command successful. Verifying...`);
  await delay(DELAYS_MS.COMMAND_LONG); // Wait a bit before verification

  // Verify using Mode 03 (Current DTCs)
  const mode03Response = await sendCommand(OBD_MODE.CURRENT_DTC, 5000);
  const isMode03Clear = checkMode03Response(mode03Response);
  if (isMode03Clear) {
    await log.debug(
      // Use logger
      '[connectionService] Mode 03 verification successful: Response indicates no current DTCs.',
    );
  } else {
    await log.warn(
      // Use logger
      '[connectionService] Mode 03 verification indicates DTCs might still be present.',
      { response: mode03Response },
    );
    // Consider returning false here if strict verification is needed
    // return false;
  }

  // Optional: Verify using Mode 01 PID 01 (Monitor Status)
  const mode0101Response = await sendCommand(
    STANDARD_PIDS.MONITOR_STATUS,
    5000,
  );
  const isMode0101Clear = checkMode0101Response(mode0101Response);
  if (isMode0101Clear) {
    await log.debug(
      // Use logger
      '[connectionService] Mode 01 PID 01 verification successful: MIL off, DTC count 0.',
    );
  } else {
    await log.warn(
      // Use logger
      '[connectionService] Mode 01 PID 01 verification indicates DTCs or MIL may still be active.',
      { response: mode0101Response },
    );
  }

  // Primarily rely on Mode 03 check for successful clear confirmation
  const allClear = isMode03Clear;
  if (allClear) {
    await log.info(
      '[connectionService] Verification successful: DTCs appear cleared.',
    ); // Use logger
    return true;
  } else {
    await log.warn(
      // Use logger
      '[connectionService] Verification suggests DTCs may not be fully cleared (Mode 03 check failed).',
    );
    return false; // Return false if Mode 03 verification fails
  }
};

/**
 * Checks if Mode 03 response indicates no DTCs.
 * Response should be "43" or "4300" or "430000..." or "NO DATA".
 * (Helper for clearVehicleDTCs - unchanged internally)
 */
function checkMode03Response(response: string | null): boolean {
  if (response === null) return false; // No response means failure

  // Assemble first in case it's multi-frame
  const assembledResponse = assembleMultiFrameResponse(response);
  const cleanedResponse = cleanResponse(assembledResponse);

  // Check for NO DATA first
  if (cleanedResponse.includes(RESPONSE_KEYWORDS.NO_DATA)) {
    return true;
  }

  // Check for "43" possibly followed only by zeros
  if (cleanedResponse.startsWith('43')) {
    const dataPart = cleanedResponse.substring(2);
    // Check if data part is empty or consists only of '0'
    if (dataPart.length === 0 || /^[0]+$/.test(dataPart)) {
      return true;
    }
  }

  // If none of the above, assume DTCs are present or response is invalid
  return false;
}

/**
 * Checks if Mode 01 PID 01 response indicates no DTCs and MIL is off.
 * Response format: 41 01 AA B1 B2 C1 D1
 * Byte A (AA): Bit 7 = MIL status (0=off, 1=on), Bits 0-6 = DTC count
 * (Helper for clearVehicleDTCs - unchanged internally)
 */
function checkMode0101Response(response: string | null): boolean {
  if (response === null) return false; // No response means failure

  // Assemble first in case it's multi-frame
  const assembledResponse = assembleMultiFrameResponse(response);
  const cleanedResponse = cleanResponse(assembledResponse).replace(/\s/g, ''); // Remove spaces

  // Expecting 4101 followed by at least 2 hex chars (Byte A)
  if (cleanedResponse.length >= 6 && cleanedResponse.startsWith('4101')) {
    try {
      const byteA = parseInt(cleanedResponse.substring(4, 6), 16);
      if (isNaN(byteA)) return false; // Invalid hex

      const isMilOff = (byteA & 0x80) === 0; // Check bit 7 (most significant bit)
      const dtcCount = byteA & 0x7f; // Mask out the MIL bit to get count
      return isMilOff && dtcCount === 0;
    } catch (error: unknown) {
      void log.error('[Helper] Error parsing Mode 0101 response byte A', {
        error: error instanceof Error ? error.message : String(error),
        response,
      });
      return false;
    }
  }
  return false; // Invalid format
}

/**
 * Internal function to get raw DTC response object.
 * (Function remains unchanged internally - marked as Non-ECU)
 */
export const getRawDTCs = async (
  sendCommand: SendCommandFunction,
  mode: OBD_MODE.CURRENT_DTC | OBD_MODE.PENDING_DTC | OBD_MODE.PERMANENT_DTC,
): Promise<RawDTCResponse | null> => {
  await log.debug(`[connectionService] Getting raw DTCs (Mode ${mode})...`);
  try {
    let protocolNum: number | null = null;
    let isCan: boolean = false;
    try {
      const protocolResponse = await sendCommand(
        ELM_COMMANDS.GET_PROTOCOL_NUM,
        1000,
      );
      const extractedNum = extractProtocolNumber(protocolResponse);
      if (extractedNum !== null) {
        protocolNum = extractedNum;
        // Use PROTOCOL enum for check
        isCan =
          extractedNum >= PROTOCOL.ISO_15765_4_CAN_11BIT_500K &&
          extractedNum <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8;
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.warn(
        '[connectionService] Could not get protocol number for raw DTCs',
        { error: errorMsg },
      );
    }

    const rawResponse = await sendCommand(mode, 8000); // Send the actual DTC request
    if (rawResponse === null) {
      await log.warn(
        `[connectionService] No response for raw DTC request (Mode ${mode})`,
      );
      return null;
    }

    if (isResponseError(rawResponse)) {
      await log.error(
        `[connectionService] Error response for raw DTC request (Mode ${mode}): ${rawResponse}`,
      );
      // Still return a structure indicating error? Or just null? Let's return null.
      return null;
    }

    // Process the raw response
    const ecuAddress = extractEcuAddresses(rawResponse)[0]; // Get first detected ECU address
    const rawBytes = Array.from(rawResponse).map(c => c.charCodeAt(0)); // Convert string to byte values

    // Split into potential frames based on newlines/CRs
    // Filter out prompts and empty lines
    // Keep spaces within lines as they might be part of data
    const responseFramesAsStrings = rawResponse
      .split(/[\r\n]+/)
      .map(line => line.trim())
      .filter(
        line => line.length > 0 && !line.startsWith(RESPONSE_KEYWORDS.PROMPT),
      );

    // Further split each line into hex bytes/words (assuming space separation)
    // This interpretation might be basic; assemblMultiFrameResponse is better for actual data
    const responseFramesAsHexArrays = responseFramesAsStrings
      .map(line => line.split(/\s+/).filter(hex => /^[0-9A-F]+$/i.test(hex))) // Split by space, keep only hex parts
      .filter(frame => frame.length > 0); // Filter out empty frames

    // Return the structured raw response
    return {
      rawString: rawResponse,
      rawResponse: rawBytes, // Raw byte values of the string
      response: responseFramesAsHexArrays, // Parsed into lines->hex parts (basic)
      rawBytesResponseFromSendCommand: responseFramesAsHexArrays, // Duplicate for compatibility? Review BaseDTCRetriever usage.
      isCan: isCan,
      protocolNumber: protocolNum ?? 0, // Default to 0 if unknown
      ecuAddress: ecuAddress ?? undefined, // Use undefined if not found
    };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log.error(
      `[connectionService] Error getting raw DTCs (Mode ${mode}):`,
      { error: errorMsg },
    );
    return null;
  }
};
