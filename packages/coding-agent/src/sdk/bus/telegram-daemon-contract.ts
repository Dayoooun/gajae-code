/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/**
 * Operational generation of the daemon lifecycle and ownership contract. Decoupled from
 * {@link NOTIFICATION_PROTOCOL_VERSION}: additive wire frames do not bump the generation,
 * but lifecycle, ownership, or capability enforcement changes do. A freshly-upgraded host
 * uses this value to identify and safely replace an older, still-live daemon.
 * The development baseline includes generation 4; fenced ownership began at generation 5,
 * durable tool-activity delivery and terminal shutdown continuation fencing are generation 6,
 * and the reconciled ownership transition contract is generation 7.
 */
export const DAEMON_GENERATION = 7;
